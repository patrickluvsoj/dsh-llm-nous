import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeRequest } from '../src/serialize.ts'
import { translate } from '../src/translate.ts'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

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
