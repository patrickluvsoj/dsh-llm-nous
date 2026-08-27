/**
 * `NousAdapter`: fetch + SSE against a Nous (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface NousCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link NousConnectionOptions.maxTokens}. */
  maxTokens?: number
}

/** Whether discovery reads Nous live or stays entirely on configured/curated entries. */
export type NousCatalogMode = 'live' | 'curated'

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface NousConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly NousCatalogModel[]
  /** Catalog source policy; live discovery is the default. */
  catalogMode: NousCatalogMode
  /** Successful live-catalog cache lifetime. */
  catalogCacheTtlMs: number
  /** Wall-clock bound for one live-catalog refresh, including credential lookup. */
  catalogTimeoutMs: number
  /** Delay before retrying a failed live-catalog refresh. */
  catalogRetryCooldownMs: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link NousAdapter}: the operation-local resolution hooks the plugin owns. */
export interface NousAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => NousConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: NousConnectionOptions) => Promise<string>
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Injectable transport seam for deterministic catalog tests. */
  fetch?: typeof globalThis.fetch
  /** Injectable clock seam for deterministic cache tests. */
  now?: () => number
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
// Generic Nous models vary widely; 256k is unsafe because many catalog
// entries expose a 256k total context window and Harness adds tool schemas.
export const DEFAULT_MAX_TOKENS = 8_192
/** Default lifetime of one successful live model-catalog response. */
export const DEFAULT_CATALOG_CACHE_TTL_MS = 3_600_000
/** Default wall-clock bound for one live model-catalog request. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 5_000
/** Default delay before retrying a failed live model-catalog refresh. */
export const DEFAULT_CATALOG_RETRY_COOLDOWN_MS = 60_000
/** Maximum accepted live model-catalog response size, measured from body bytes. */
export const MAX_CATALOG_RESPONSE_BYTES = 4 * 1024 * 1024
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const

function modelInfo(provider: string, model: NousCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

interface CatalogCacheEntry {
  models?: readonly NousCatalogModel[]
  refreshedAt?: number
  retryAfter?: number
  inflight?: Promise<readonly NousCatalogModel[]>
}

function catalogEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

function catalogCacheKey(connection: NousConnectionOptions): string {
  // The credential reference identifies the effective authorization plane
  // without retaining the resolved secret. Configured models are merged after
  // lookup, so they do not affect the identity of the discovered snapshot.
  return JSON.stringify([catalogEndpoint(connection.baseURL), String(connection.apiKeyEnv)])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => Number.isSafeInteger(value) && (value as number) > 0)
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value
    : undefined
}

function modalities(row: Record<string, unknown>, field: 'input_modalities' | 'output_modalities'): readonly string[] | undefined {
  const direct = stringArray(row[field])
  if (direct !== undefined) return direct
  return isRecord(row.architecture) ? stringArray(row.architecture[field]) : undefined
}

function isExpired(row: Record<string, unknown>, now: number): boolean {
  if (row.expired === true) return true
  const candidate = row.expiration_date ?? row.expires_at ?? row.expiration
  if (candidate === undefined || candidate === null) return false
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    const milliseconds = candidate < 1_000_000_000_000 ? candidate * 1_000 : candidate
    return milliseconds <= now
  }
  if (typeof candidate === 'string') {
    const milliseconds = Date.parse(candidate)
    return !Number.isFinite(milliseconds) || milliseconds <= now
  }
  return true
}

function normalizeCatalogRow(row: unknown, now: number): NousCatalogModel | undefined {
  if (!isRecord(row) || typeof row.id !== 'string') return undefined
  const id = row.id.trim()
  if (id.length === 0 || id.includes('~') || id.endsWith(':batch') || isExpired(row, now)) return undefined

  const inputs = modalities(row, 'input_modalities')
  if (inputs !== undefined && !inputs.includes('text')) return undefined
  const outputs = modalities(row, 'output_modalities')
  if (outputs !== undefined && !outputs.includes('text')) return undefined
  if (Array.isArray(row.supported_parameters) && !row.supported_parameters.includes('tools')) return undefined

  const name = typeof row.name === 'string' && row.name.trim().length > 0
    ? row.name.trim()
    : undefined
  const description = typeof row.description === 'string' && row.description.trim().length > 0
    ? row.description.trim()
    : undefined
  const contextWindow = positiveInteger(row.context_length, row.context_window)
  const topProvider = isRecord(row.top_provider) ? row.top_provider : undefined
  const maxTokens = positiveInteger(
    row.max_output_tokens,
    row.max_completion_tokens,
    row.output_token_limit,
    row.max_tokens,
    topProvider?.max_completion_tokens,
  )
  return {
    id,
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

function compareCatalogModels(left: NousCatalogModel, right: NousCatalogModel): number {
  const leftName = left.name ?? left.id
  const rightName = right.name ?? right.id
  if (leftName < rightName) return -1
  if (leftName > rightName) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

function mergeCatalog(
  configured: readonly NousCatalogModel[],
  discovered: readonly NousCatalogModel[],
): NousCatalogModel[] {
  const discoveredById = new Map(discovered.map(model => [model.id, model]))
  const preferred = configured.map((model) => {
    const live = discoveredById.get(model.id)
    discoveredById.delete(model.id)
    return live === undefined ? model : { ...live, ...model }
  })
  return [...preferred, ...[...discoveredById.values()].sort(compareCatalogModels)]
}

class CatalogWaitAborted {
  constructor(readonly reason: unknown) {}
}

function waitForCatalog<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new CatalogWaitAborted(signal.reason))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new CatalogWaitAborted(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    try {
      await response.body?.cancel()
    } catch {
      // HTTP status is the catalog outcome; cancellation is best-effort transport cleanup.
    }
    throw new Error(`Nous model catalog returned HTTP ${response.status}`)
  }
  if (response.body === null) throw new Error('Nous model catalog returned no response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_CATALOG_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The size violation is the catalog outcome; cancellation is best-effort transport cleanup.
        }
        throw new Error(`Nous model catalog exceeded ${MAX_CATALOG_RESPONSE_BYTES} bytes`)
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class NousAdapter extends LlmAdapter {
  private readonly catalogCache = new Map<string, CatalogCacheEntry>()
  private readonly catalogFetch: typeof globalThis.fetch
  private readonly now: () => number

  constructor(private readonly config: NousAdapterOptions) {
    super()
    this.catalogFetch = config.fetch ?? globalThis.fetch
    this.now = config.now ?? Date.now
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Nous' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options()
    const models = await this.resolveCatalog(connection)
    return models.map(model => modelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const catalog = await this.resolveCatalog(connection, signal)
    const configured = catalog.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return {
      // The chat-completions wire route is text-only regardless of catalog
      // membership, so the uncatalogued fallback declares the same negative
      // capability — "unknown" here would let the host accept and persist
      // images the serializer must then reject.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: connection.defaults.reasoningEffort === 'off'
          ? OFF_REASONING_EFFORT
          : connection.defaults.reasoningEffort === 'max'
            ? MAX_REASONING_EFFORT
            : HIGH_REASONING_EFFORT,
        },
    }
  }

  private async resolveCatalog(
    connection: NousConnectionOptions,
    signal?: AbortSignal,
  ): Promise<readonly NousCatalogModel[]> {
    if (connection.catalogMode === 'curated') return connection.models
    const key = catalogCacheKey(connection)
    let cache = this.catalogCache.get(key)
    if (cache === undefined) {
      cache = {}
      this.catalogCache.set(key, cache)
    }
    const now = this.now()
    if (cache.models !== undefined
      && cache.refreshedAt !== undefined
      && now - cache.refreshedAt < connection.catalogCacheTtlMs) {
      return mergeCatalog(connection.models, cache.models)
    }

    const coolingDown = cache.retryAfter !== undefined && now < cache.retryAfter
    if (cache.models !== undefined) {
      // Stale-while-revalidate: discovery must never block model selection once
      // there is a complete last-good snapshot. The shared refresh owns its
      // timeout and rejection handling independently of this caller.
      if (cache.inflight === undefined && !coolingDown) {
        this.startCatalogRefresh(connection, cache)
      }
      return mergeCatalog(connection.models, cache.models)
    }

    // Before the first success, retain the curated fallback and avoid repeated
    // credential or transport work while the last failure is cooling down.
    if (cache.inflight === undefined && coolingDown) return connection.models

    const refresh = cache.inflight ?? this.startCatalogRefresh(connection, cache)
    try {
      const discovered = await waitForCatalog(refresh, signal)
      return mergeCatalog(connection.models, discovered)
    } catch (error: unknown) {
      if (error instanceof CatalogWaitAborted) throw error.reason
      // Discovery is advisory. Preserve the last complete success, or the
      // configured/curated fallback before any success, without exposing keys,
      // response bodies, or transport details through discovery consumers.
      return mergeCatalog(connection.models, cache.models ?? [])
    }
  }

  private startCatalogRefresh(
    connection: NousConnectionOptions,
    cache: CatalogCacheEntry,
  ): Promise<readonly NousCatalogModel[]> {
    if (cache.inflight !== undefined) return cache.inflight
    const refresh = this.fetchCatalog(connection).then(
      (discovered) => {
        cache.models = discovered
        cache.refreshedAt = this.now()
        delete cache.retryAfter
        return discovered
      },
      (error: unknown) => {
        cache.retryAfter = this.now() + connection.catalogRetryCooldownMs
        throw error
      },
    )
    cache.inflight = refresh
    // Always observe background rejection and release the single-flight slot.
    void refresh.then(
      () => {
        if (cache.inflight === refresh) delete cache.inflight
      },
      () => {
        if (cache.inflight === refresh) delete cache.inflight
      },
    )
    return refresh
  }

  private async fetchCatalog(
    connection: NousConnectionOptions,
  ): Promise<readonly NousCatalogModel[]> {
    const signal = AbortSignal.timeout(connection.catalogTimeoutMs)
    const apiKey = await waitForSignal(this.config.resolveApiKey(connection), signal)
    const response = await this.catalogFetch(catalogEndpoint(connection.baseURL), {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json',
        ...attributionHeaders(),
      },
      signal,
    })
    const parsed = await readBoundedJson(response)
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
      throw new Error('Nous model catalog must be an object with a data array')
    }
    const seen = new Set<string>()
    const models: NousCatalogModel[] = []
    const now = this.now()
    for (const row of parsed.data) {
      const model = normalizeCatalogRow(row, now)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    return models
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Nous stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Nous request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Nous API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Nous stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: NousConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, connection.defaults)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy) in a bare `TypeError: fetch failed` whose actionable detail
      // lives on `cause`. Wrapping with the endpoint and chaining the cause
      // lets `errorChain` render the full diagnosis at every reporting boundary.
      throw new LlmError(
        `Nous API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `Nous API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('Nous API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}
