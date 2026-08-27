import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Config,
  DEFAULT_CATALOG_RETRY_COOLDOWN_MS,
  NousAdapter,
  resolveAdapterOptions,
} from '../src/index.ts'
import type { Config as NousConfig } from '../src/index.ts'
import { MAX_CATALOG_RESPONSE_BYTES } from '../src/adapter.ts'
import type { NousAdapterOptions, NousConnectionOptions } from '../src/adapter.ts'
import { serializeRequest } from '../src/serialize.ts'
import { translate } from '../src/translate.ts'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

interface AdapterSeams {
  fetch?: typeof fetch
  now?: () => number
  resolveApiKey?: NousAdapterOptions['resolveApiKey']
}

function adapterFor(
  config: NousConfig = {},
  seams: AdapterSeams = {},
): { adapter: NousAdapter, connection: NousConnectionOptions } {
  const connection = resolveAdapterOptions(config)
  const adapter = new NousAdapter({
    options: () => connection,
    resolveApiKey: seams.resolveApiKey ?? (async () => 'test-api-key'),
    resolveUserId: () => 'test-user' as any,
    ...seams.fetch === undefined ? {} : { fetch: seams.fetch },
    ...seams.now === undefined ? {} : { now: seams.now },
  })
  return { adapter, connection }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function settleBeforeImmediate<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setImmediate(() => { reject(new Error('catalog lookup waited for a background refresh')) })
    }),
  ])
}

test('advertises the highest-usage OpenRouter models available through Nous', () => {
  const resolved = resolveAdapterOptions({})
  const models = resolved.models

  assert.equal(resolved.catalogMode, 'live')
  assert.equal(resolved.catalogCacheTtlMs, 3_600_000)
  assert.equal(resolved.catalogTimeoutMs, 5_000)
  assert.equal(resolved.catalogRetryCooldownMs, 60_000)
  assert.equal(DEFAULT_CATALOG_RETRY_COOLDOWN_MS, 60_000)

  assert.deepEqual(models.map(model => model.id), [
    'deepseek/deepseek-v4-flash-0731',
    'xiaomi/mimo-v2.5',
    'tencent/hy3',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-5.6-luna',
    'z-ai/glm-5.2',
    'google/gemini-3.7-flash',
    'deepseek/deepseek-v4-pro',
    'minimax/minimax-m3',
    'poolside/laguna-s-2.1:free',
    'anthropic/claude-opus-5',
    'openai/gpt-5.6-sol',
  ])
  assert.deepEqual(models.map(model => model.contextWindow), [
    1_310_720,
    1_050_000,
    262_144,
    1_048_576,
    1_050_000,
    1_048_576,
    1_048_576,
    1_048_576,
    1_048_576,
    262_144,
    1_000_000,
    1_050_000,
  ])
})

test('discovers, filters, normalizes, and orders the live Nous catalog', async () => {
  let requestedUrl: string | undefined
  let requestedHeaders: Headers | undefined
  const fetchStub: typeof fetch = async (input, init) => {
    requestedUrl = String(input)
    requestedHeaders = new Headers(init?.headers)
    return jsonResponse({
      data: [
        {
          id: ' pinned/model ',
          name: ' Live conflict ',
          description: 'Live detail',
          context_length: 999,
          max_output_tokens: 99,
          supported_parameters: ['tools'],
        },
        { id: 'z/model', name: ' Zulu ', context_window: 300, max_output_tokens: 30 },
        {
          id: 'a/model',
          name: ' Alpha ',
          context_length: 200,
          max_completion_tokens: 20,
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          supported_parameters: ['temperature', 'tools'],
        },
        { id: 'a/model', name: 'Duplicate', supported_parameters: ['tools'] },
        { id: 'batch/model:batch', supported_parameters: ['tools'] },
        { id: 'hidden/model~latest', supported_parameters: ['tools'] },
        { id: 'expired/model', expiration_date: '2020-01-01T00:00:00Z', supported_parameters: ['tools'] },
        { id: 'image-output/model', architecture: { output_modalities: ['image'] }, supported_parameters: ['tools'] },
        { id: 'image-input/model', architecture: { input_modalities: ['image'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
        { id: 'no-tools/model', supported_parameters: ['temperature'] },
        { id: 'malformed-no-tools/model', supported_parameters: [123] },
        { id: '', supported_parameters: ['tools'] },
        null,
      ],
    })
  }
  const { adapter } = adapterFor({
    baseURL: 'https://catalog.example/v1/',
    models: [{
      id: 'pinned/model',
      name: 'Pinned',
      description: 'Pinned detail',
      contextWindow: 42,
      maxTokens: 7,
    }],
  } as NousConfig, { fetch: fetchStub })

  const models = await adapter.listModels('nous')

  assert.equal(requestedUrl, 'https://catalog.example/v1/models')
  assert.equal(requestedHeaders?.get('authorization'), 'Bearer test-api-key')
  assert.match(requestedHeaders?.get('user-agent') ?? '', /DeepSeek-Harness/i)
  assert.deepEqual(models.map(model => [model.id, model.name, model.inputModalities]), [
    ['pinned/model', 'Pinned', ['text']],
    ['a/model', 'Alpha', ['text']],
    ['z/model', 'Zulu', ['text']],
  ])
  assert.deepEqual(await adapter.resolveModel('nous', 'pinned/model'), {
    provider: 'nous',
    id: 'pinned/model',
    name: 'Pinned',
    description: 'Pinned detail',
    inputModalities: ['text'],
    context: { contextWindow: 42 },
    defaultMaxTokens: 7,
    reasoning: {
      efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
      defaultEffort: 'high',
    },
  })
})

test('deduplicates equivalent ephemeral option snapshots by stable discovery facts', async () => {
  let calls = 0
  let credentialCalls = 0
  let now = 1_000
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  let activeConfig: NousConfig = {
    baseURL: 'https://catalog.example/v1/',
    apiKeyEnv: 'FIRST_CATALOG_KEY',
    models: [],
    catalogCacheTtlMs: 100,
  }
  const requests: string[] = []
  const fetchStub: typeof fetch = async (input, init) => {
    calls += 1
    requests.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
    if (calls === 1) return pending
    return jsonResponse({ data: [{ id: `live/model-${calls}`, supported_parameters: ['tools'] }] })
  }
  const adapter = new NousAdapter({
    options: () => resolveAdapterOptions(activeConfig),
    resolveApiKey: async (connection) => {
      credentialCalls += 1
      return `${String(connection.apiKeyEnv)}-value`
    },
    resolveUserId: () => 'test-user' as any,
    fetch: fetchStub,
    now: () => now,
  })

  const first = adapter.listModels('nous')
  const second = adapter.listModels('nous')
  const third = adapter.resolveModel('nous', 'live/model')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  release(jsonResponse({ data: [{ id: 'live/model', name: 'Live', supported_parameters: ['tools'] }] }))

  assert.deepEqual((await first).map(model => model.id), ['live/model'])
  assert.deepEqual((await second).map(model => model.id), ['live/model'])
  assert.equal((await third).name, 'Live')
  now = 1_099
  await adapter.listModels('nous')
  assert.equal(calls, 1)
  assert.equal(credentialCalls, 1)

  activeConfig = { ...activeConfig, baseURL: 'https://catalog.example/v1' }
  await adapter.listModels('nous')
  assert.equal(calls, 1)

  activeConfig = { ...activeConfig, apiKeyEnv: 'SECOND_CATALOG_KEY' }
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['live/model-2'])
  activeConfig = { ...activeConfig, baseURL: 'https://other-catalog.example/v1' }
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['live/model-3'])
  assert.equal(credentialCalls, 3)
  assert.deepEqual(requests, [
    'https://catalog.example/v1/models Bearer FIRST_CATALOG_KEY-value',
    'https://catalog.example/v1/models Bearer SECOND_CATALOG_KEY-value',
    'https://other-catalog.example/v1/models Bearer SECOND_CATALOG_KEY-value',
  ])
})

test('caller cancellation settles resolveModel without cancelling a shared catalog refresh', async () => {
  let fetchSignal: AbortSignal | undefined
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  const fetchStub: typeof fetch = async (_input, init) => {
    fetchSignal = init?.signal ?? undefined
    return await pending
  }
  const { adapter } = adapterFor({ models: [], catalogTimeoutMs: 1_000 } as NousConfig, {
    fetch: fetchStub,
  })
  const controller = new AbortController()

  const resolving = adapter.resolveModel('nous', 'dynamic/model', controller.signal)
  const listing = adapter.listModels('nous')
  await Promise.resolve()
  const cancellation = new Error('lookup cancelled')
  controller.abort(cancellation)

  await assert.rejects(Promise.race([
    resolving,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('resolveModel did not settle after abort')), 50)),
  ]), error => error === cancellation)
  assert.equal(fetchSignal?.aborted, false)

  release(jsonResponse({ data: [{ id: 'dynamic/model', name: 'Dynamic', supported_parameters: ['tools'] }] }))
  assert.deepEqual((await listing).map(model => model.id), ['dynamic/model'])
  assert.equal((await adapter.resolveModel('nous', 'dynamic/model')).name, 'Dynamic')
})

test('returns stale data immediately while one background refresh succeeds', async () => {
  let calls = 0
  let now = 0
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  const fetchStub: typeof fetch = async () => {
    calls += 1
    return calls === 1
      ? jsonResponse({ data: [{ id: 'stale/model', name: 'Stale', context_length: 321, supported_parameters: ['tools'] }] })
      : pending
  }
  const { adapter } = adapterFor({ models: [], catalogCacheTtlMs: 100 } as NousConfig, {
    fetch: fetchStub,
    now: () => now,
  })

  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['stale/model'])
  now = 101
  const staleList = adapter.listModels('nous')
  const staleResolution = adapter.resolveModel('nous', 'stale/model')
  const anotherStaleList = adapter.listModels('nous')
  assert.deepEqual((await settleBeforeImmediate(staleList)).map(model => model.id), ['stale/model'])
  assert.equal((await settleBeforeImmediate(staleResolution)).context.contextWindow, 321)
  assert.deepEqual((await settleBeforeImmediate(anotherStaleList)).map(model => model.id), ['stale/model'])
  assert.equal(calls, 2)

  release(jsonResponse({ data: [{ id: 'fresh/model', name: 'Fresh', supported_parameters: ['tools'] }] }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['fresh/model'])
  assert.equal(calls, 2)
})

test('failed stale refreshes use a bounded cooldown and retry after it', async () => {
  let now = 0
  let credentialCalls = 0
  let fetchCalls = 0
  let rejectRefresh!: (error: Error) => void
  const failedRefresh = new Promise<Response>((_resolve, reject) => { rejectRefresh = reject })
  let releaseRetry!: (response: Response) => void
  const retriedRefresh = new Promise<Response>((resolve) => { releaseRetry = resolve })
  const { adapter } = adapterFor({
    models: [],
    catalogCacheTtlMs: 100,
    catalogRetryCooldownMs: 1_000,
  } as NousConfig, {
    now: () => now,
    resolveApiKey: async () => {
      credentialCalls += 1
      return 'test-api-key'
    },
    fetch: async () => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return jsonResponse({ data: [{ id: 'stale/model', name: 'Stale', supported_parameters: ['tools'] }] })
      }
      return fetchCalls === 2 ? failedRefresh : retriedRefresh
    },
  })

  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['stale/model'])
  now = 101
  assert.deepEqual((await settleBeforeImmediate(adapter.listModels('nous'))).map(model => model.id), ['stale/model'])
  assert.equal(fetchCalls, 2)
  rejectRefresh(new Error('catalog unavailable'))
  await new Promise<void>(resolve => setImmediate(resolve))

  for (const lookup of [
    adapter.listModels('nous'),
    adapter.resolveModel('nous', 'stale/model'),
    adapter.listModels('nous'),
  ]) {
    await settleBeforeImmediate(lookup)
  }
  assert.equal(credentialCalls, 2)
  assert.equal(fetchCalls, 2)

  now = 1_100
  await settleBeforeImmediate(adapter.listModels('nous'))
  assert.equal(fetchCalls, 2)
  now = 1_101
  assert.deepEqual((await settleBeforeImmediate(adapter.listModels('nous'))).map(model => model.id), ['stale/model'])
  assert.equal(credentialCalls, 3)
  assert.equal(fetchCalls, 3)

  releaseRetry(jsonResponse({ data: [{ id: 'recovered/model', name: 'Recovered', supported_parameters: ['tools'] }] }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['recovered/model'])
})

test('times out catalog discovery and returns the curated fallback', async () => {
  let aborted = false
  const fetchStub: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(init.signal?.reason)
    }, { once: true })
  })
  const { adapter } = adapterFor({ catalogTimeoutMs: 5 } as NousConfig, { fetch: fetchStub })

  const models = await adapter.listModels('nous')

  assert.equal(aborted, true)
  assert.equal(models[0]?.id, 'deepseek/deepseek-v4-flash-0731')
  assert.equal(models.length, 12)
})

test('catalog timeout bounds credential resolution before fetch', async () => {
  let credentialCalls = 0
  let fetchCalls = 0
  const { adapter } = adapterFor({ catalogTimeoutMs: 5 } as NousConfig, {
    resolveApiKey: async () => {
      credentialCalls += 1
      return await new Promise<string>(() => {})
    },
    fetch: async () => {
      fetchCalls += 1
      throw new Error('must not fetch after credential timeout')
    },
  })

  const models = await Promise.race([
    adapter.listModels('nous'),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('catalog credential timeout did not settle')), 100)),
  ])

  assert.equal(credentialCalls, 1)
  assert.equal(fetchCalls, 0)
  assert.equal(models[0]?.id, 'deepseek/deepseek-v4-flash-0731')
  assert.equal(models.length, 12)
})

test('rejects malformed and oversized catalog responses without losing fallback models', async (t) => {
  await t.test('malformed envelope', async () => {
    const { adapter } = adapterFor({}, { fetch: async () => jsonResponse({ data: 'not-an-array' }) })
    assert.equal((await adapter.listModels('nous')).length, 12)
  })

  await t.test('non-2xx response body', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('non-2xx response body must not be read')
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const { adapter } = adapterFor({}, {
      fetch: async () => new Response(body, { status: 503 }),
    })

    assert.equal((await adapter.listModels('nous')).length, 12)
    assert.equal(cancelled, true)
  })

  await t.test('more than four MiB of actual response bytes', async () => {
    const validCatalog = new TextEncoder().encode(JSON.stringify({
      data: [{ id: 'oversize/model', name: 'Oversize', supported_parameters: ['tools'] }],
    }))
    const trailingWhitespace = new Uint8Array(MAX_CATALOG_RESPONSE_BYTES - validCatalog.byteLength + 1)
    trailingWhitespace.fill(0x20)
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(validCatalog)
          return
        }
        if (pulls === 2) {
          controller.enqueue(trailingWhitespace)
          return
        }
        throw new Error('catalog body was consumed past the byte cap')
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const { adapter } = adapterFor({}, { fetch: async () => new Response(body) })

    const models = await adapter.listModels('nous')

    assert.equal(cancelled, true)
    assert.equal(pulls, 2)
    assert.equal(models.some(model => model.id === 'oversize/model'), false)
    assert.equal(models.length, 12)
  })
})

test('isolates catalog cache entries by effective endpoint and credential reference', async () => {
  const firstConnection = resolveAdapterOptions({
    baseURL: 'https://first-catalog.example/v1',
    apiKeyEnv: 'FIRST_CATALOG_KEY',
    models: [],
  })
  const secondConnection = resolveAdapterOptions({
    baseURL: 'https://second-catalog.example/v1',
    apiKeyEnv: 'SECOND_CATALOG_KEY',
    models: [],
  })
  let current = firstConnection
  const requests: string[] = []
  const adapter = new NousAdapter({
    options: () => current,
    resolveApiKey: async connection => connection === firstConnection ? 'first-key' : 'second-key',
    resolveUserId: () => 'test-user' as any,
    now: () => 1_000,
    fetch: async (input, init) => {
      const url = String(input)
      requests.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
      const id = url.includes('first-catalog') ? 'first/model' : 'second/model'
      return jsonResponse({ data: [{ id, supported_parameters: ['tools'] }] })
    },
  })

  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['first/model'])
  current = secondConnection
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['second/model'])
  current = firstConnection
  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['first/model'])
  assert.deepEqual(requests, [
    'https://first-catalog.example/v1/models Bearer first-key',
    'https://second-catalog.example/v1/models Bearer second-key',
  ])
})

test('curated catalog mode never performs model discovery', async () => {
  let calls = 0
  const { adapter } = adapterFor({ catalogMode: 'curated' } as NousConfig, {
    fetch: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
  })

  assert.equal((await adapter.listModels('nous')).length, 12)
  await adapter.resolveModel('nous', 'deepseek/deepseek-v4-flash-0731')
  assert.equal(calls, 0)
})

test('missing credentials preserve configured fallback discovery during retry cooldown', async () => {
  let credentialCalls = 0
  let fetchCalls = 0
  const { adapter } = adapterFor({ models: [{ id: 'configured/model', contextWindow: 88 }] } as NousConfig, {
    fetch: async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    },
    resolveApiKey: async () => {
      credentialCalls += 1
      const error = new Error('missing') as Error & { code: string }
      error.code = 'MISSING_CREDENTIAL'
      throw error
    },
  })

  assert.deepEqual((await adapter.listModels('nous')).map(model => model.id), ['configured/model'])
  assert.equal((await adapter.resolveModel('nous', 'configured/model')).context.contextWindow, 88)
  assert.equal(credentialCalls, 1)
  assert.equal(fetchCalls, 0)
})

test('resolveModel uses dynamic catalog limits and preserves arbitrary route defaults', async () => {
  const { adapter } = adapterFor({ models: [], defaultContextWindow: 1_000, maxTokens: 100 } as NousConfig, {
    fetch: async () => jsonResponse({ data: [{
      id: 'dynamic/model',
      name: 'Dynamic',
      context_window: 456,
      max_output_tokens: 45,
      supported_parameters: ['tools'],
    }] }),
  })

  const dynamic = await adapter.resolveModel('nous', 'dynamic/model')
  const arbitrary = await adapter.resolveModel('nous', 'arbitrary/exact-id')

  assert.equal(dynamic.context.contextWindow, 456)
  assert.equal(dynamic.defaultMaxTokens, 45)
  assert.equal(dynamic.name, 'Dynamic')
  assert.equal(arbitrary.context.contextWindow, 1_000)
  assert.equal(arbitrary.defaultMaxTokens, 100)
  assert.equal(arbitrary.name, 'arbitrary/exact-id')
})

test('validates catalog mode, TTL, timeout, and retry cooldown bounds in programmatic config', () => {
  assert.throws(() => resolveAdapterOptions({ catalogMode: 'other' } as any), /catalogMode/)
  for (const value of [0, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => resolveAdapterOptions({ catalogCacheTtlMs: value } as any), /catalogCacheTtlMs/)
    assert.throws(() => resolveAdapterOptions({ catalogTimeoutMs: value } as any), /catalogTimeoutMs/)
    assert.throws(() => resolveAdapterOptions({ catalogRetryCooldownMs: value } as any), /catalogRetryCooldownMs/)
  }
})

test('publishes retry cooldown through the config schema and applies its default', () => {
  const defaultResult = Config['~standard'].validate({})
  assert.equal('issues' in defaultResult, false)
  assert.equal((defaultResult as { value: NousConfig }).value.catalogRetryCooldownMs, 60_000)

  const configuredResult = Config['~standard'].validate({ catalogRetryCooldownMs: 123 })
  assert.equal('issues' in configuredResult, false)
  assert.equal((configuredResult as { value: NousConfig }).value.catalogRetryCooldownMs, 123)

  const invalidResult = Config['~standard'].validate({ catalogRetryCooldownMs: 0 })
  assert.equal('issues' in invalidResult, true)
})

test('serializes generic OpenAI-compatible requests without DeepSeek-only fields', () => {
  const request = serializeRequest({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{}' }],
      },
    ],
    tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }],
  } as any)

  assert.equal('thinking' in request, false)
  assert.equal('reasoning_content' in request.messages[1], false)
  assert.equal(request.model, 'openai/gpt-oss-120b')
  assert.deepEqual(request.messages[1], {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  })
})

test('flushes a Nous stream at clean EOF after finish chunk', async () => {
  const payloads = (async function* () {
    yield JSON.stringify({ choices: [{ delta: { reasoning: 'think ' } }] })
    yield JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: {
      prompt_tokens: 10,
      completion_tokens: 3,
      completion_tokens_details: { reasoning_tokens: 1 },
    } })
  })()

  const chunks = await collect(translate(payloads))
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'usage', 'finish',
  ])
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('rejects a truncated stream with no finish reason', async () => {
  const payloads = (async function* () {
    yield JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })
  })()

  await assert.rejects(
    collect(translate(payloads)),
    (error: { code?: string }) => error.code === 'STREAM_CLOSED',
  )
})
