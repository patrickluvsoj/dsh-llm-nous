/**
 * Register a {@link NousAdapter} for the `nous` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-nous` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * base URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 * @module @deepseek-ai/dsh-llm-nous
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DEFAULT_CATALOG_CACHE_TTL_MS,
  DEFAULT_CATALOG_RETRY_COOLDOWN_MS,
  DEFAULT_CATALOG_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  NousAdapter,
} from './adapter.ts'
import type { NousCatalogModel, NousConnectionOptions } from './adapter.ts'

export {
  DEFAULT_CATALOG_CACHE_TTL_MS,
  DEFAULT_CATALOG_RETRY_COOLDOWN_MS,
  DEFAULT_CATALOG_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  NousAdapter,
} from './adapter.ts'
export type { NousAdapterOptions, NousCatalogMode, NousCatalogModel, NousConnectionOptions } from './adapter.ts'
export type { RequestDefaults } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-nous'
export const inject = ['llm']

const NS = settingsNamespace('llm-nous')
const DEFAULT_API_KEY_ENV = 'NOUS_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'nous'

// Exact Nous routes ordered by OpenRouter trailing-week token usage through
// 2026-08-25. OpenRouter-only variants and routes absent from Nous are omitted.
const DEFAULT_MODELS: NousCatalogModel[] = [
  { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731', contextWindow: 1_310_720 },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo-V2.5', contextWindow: 1_050_000 },
  { id: 'tencent/hy3', name: 'Hy3', contextWindow: 262_144 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash 0423', contextWindow: 1_048_576 },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 1_050_000 },
  { id: 'z-ai/glm-5.2', name: 'GLM 5.2', contextWindow: 1_048_576 },
  { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1_048_576 },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro 0423', contextWindow: 1_048_576 },
  { id: 'minimax/minimax-m3', name: 'MiniMax M3', contextWindow: 1_048_576 },
  { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1 (Free)', contextWindow: 262_144 },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 1_050_000 },
]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-nous` settings-section shape. Every field is optional in
 * yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load), and omitted reasoning effort lets the selected model use its
 * provider default.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `NOUS_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $NOUS_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Default reasoning effort; omitted lets each Nous model choose. */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Default per-request output cap (default 8,192); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to a usage-ranked curated catalog. */
  models?: NousCatalogModel[]
  /** Use live Nous discovery or only configured/curated entries (default live). */
  catalogMode?: 'live' | 'curated'
  /** Successful live-catalog cache lifetime in milliseconds (default one hour). */
  catalogCacheTtlMs?: number
  /** Wall-clock bound for one live-catalog refresh, including credential lookup (default five seconds). */
  catalogTimeoutMs?: number
  /** Delay before retrying a failed live-catalog refresh (default one minute). */
  catalogRetryCooldownMs?: number
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<NousCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  catalogMode: z.union(['live', 'curated']).default('live'),
  catalogCacheTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_CACHE_TTL_MS),
  catalogTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_TIMEOUT_MS),
  catalogRetryCooldownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_RETRY_COOLDOWN_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Public Nous Portal API base URL. */
export const PUBLIC_BASE_URL = 'https://inference-api.nousresearch.com/v1'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'NOUS_BASE_URL'

/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedNousOptions = NousConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly NousCatalogModel[] | undefined): NousCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-nous: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-nous: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-nous: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-nous: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-nous: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: the product trusts the
 * project it is launched in, so a checkout can point its own agent at the
 * gateway that checkout is meant to use.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedNousOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-nous: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-nous: maxTokens must be a positive safe integer')
  }
  const catalogMode = config.catalogMode ?? 'live'
  if (catalogMode !== 'live' && catalogMode !== 'curated') {
    throw new Error('llm-nous: catalogMode must be "live" or "curated"')
  }
  const catalogCacheTtlMs = config.catalogCacheTtlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS
  if (!Number.isSafeInteger(catalogCacheTtlMs)
    || catalogCacheTtlMs <= 0
    || catalogCacheTtlMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-nous: catalogCacheTtlMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const catalogTimeoutMs = config.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
  if (!Number.isSafeInteger(catalogTimeoutMs)
    || catalogTimeoutMs <= 0
    || catalogTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-nous: catalogTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const catalogRetryCooldownMs = config.catalogRetryCooldownMs ?? DEFAULT_CATALOG_RETRY_COOLDOWN_MS
  if (!Number.isSafeInteger(catalogRetryCooldownMs)
    || catalogRetryCooldownMs <= 0
    || catalogRetryCooldownMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-nous: catalogRetryCooldownMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-nous: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    defaults: { reasoningEffort: config.reasoningEffort },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    catalogMode,
    catalogCacheTtlMs,
    catalogTimeoutMs,
    catalogRetryCooldownMs,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-nous: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedNousOptions | undefined
  const options = (): ResolvedNousOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-nous: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedNousOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-nous', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-nous', ref)
      }
    }
    throw new LlmError(
      `llm-nous: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new NousAdapter({ options, resolveApiKey, resolveUserId })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Nous Portal', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
