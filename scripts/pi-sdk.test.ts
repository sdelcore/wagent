// Unit tests for the pi SDK adapter's event-translation function.
//
// These exercise the pure `translatePiEvent` function with synthetic
// pi AgentSessionEvent payloads — no API key, no real session, no
// network. CI runs them on every PR.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPiErrorMessage,
  errorPayloadToUpdate,
  translatePiEvent,
  type PiTranslationContext,
} from '../src/agent/pi_sdk.js'
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent'

function ctx(): PiTranslationContext {
  return { messageId: null }
}

test('message_start mints a messageId and emits no wire event', () => {
  const c = ctx()
  const out = translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  assert.equal(out, null)
  assert.ok(c.messageId, 'messageId should be set after message_start')
  assert.match(c.messageId!, /^[0-9a-f-]{36}$/, 'messageId should look like a uuid')
})

test('message_update text_delta → agent_message_chunk with current messageId', () => {
  const c = ctx()
  translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  const id = c.messageId
  const out = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as AgentSessionEvent,
    c,
  )
  assert.deepEqual(out, {
    kind: 'agent_message_chunk',
    messageId: id,
    text: 'hello',
  })
})

test('message_update thinking_delta → agent_thought_chunk', () => {
  const c = ctx()
  translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  const out = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
    } as AgentSessionEvent,
    c,
  )
  assert.equal((out as { kind: string }).kind, 'agent_thought_chunk')
  assert.equal((out as { text: string }).text, 'pondering')
})

test('message_update with non-delta inner event is ignored', () => {
  const c = ctx()
  const out = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    } as AgentSessionEvent,
    c,
  )
  assert.equal(out, null)
})

test('tool_execution_start → tool_call (running)', () => {
  const out = translatePiEvent(
    {
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: { command: 'ls' },
    } as AgentSessionEvent,
    ctx(),
  )
  assert.deepEqual(out, {
    kind: 'tool_call',
    toolCallId: 'tc-1',
    name: 'bash',
    input: { command: 'ls' },
    status: 'running',
  })
})

test('tool_execution_update → tool_call_update with partialResult', () => {
  const out = translatePiEvent(
    {
      type: 'tool_execution_update',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: { command: 'ls' },
      partialResult: { stdout: 'file' },
    } as AgentSessionEvent,
    ctx(),
  )
  assert.deepEqual(out, {
    kind: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'running',
    partialResult: { stdout: 'file' },
  })
})

test('tool_execution_end success → tool_call_update complete', () => {
  const out = translatePiEvent(
    {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'bash',
      result: { stdout: 'done' },
      isError: false,
    } as AgentSessionEvent,
    ctx(),
  )
  assert.deepEqual(out, {
    kind: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'complete',
    result: { stdout: 'done' },
  })
})

test('tool_execution_end error → tool_call_update error', () => {
  const out = translatePiEvent(
    {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'bash',
      result: 'boom',
      isError: true,
    } as AgentSessionEvent,
    ctx(),
  )
  assert.equal((out as { status: string }).status, 'error')
})

test('agent lifecycle events (turn_end, agent_end, etc.) emit nothing', () => {
  const c = ctx()
  for (const type of ['agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_end'] as const) {
    const out = translatePiEvent({ type } as AgentSessionEvent, c)
    assert.equal(out, null, `${type} should not surface on the wire`)
  }
})

test('session-management events (queue_update, compaction_*, auto_retry_end) emit nothing', () => {
  const c = ctx()
  const noisyEvents = [
    { type: 'queue_update', steering: [], followUp: [] },
    { type: 'compaction_start', reason: 'manual' },
    {
      type: 'compaction_end',
      reason: 'manual',
      result: undefined,
      aborted: false,
      willRetry: false,
    },
    { type: 'auto_retry_end', success: true, attempt: 1 },
  ] as unknown as AgentSessionEvent[]
  for (const event of noisyEvents) {
    const out = translatePiEvent(event, c)
    assert.equal(out, null, `${event.type} should not surface on the wire`)
  }
})

test('messageId persists across multiple message_update events in the same message', () => {
  const c = ctx()
  translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  const firstId = c.messageId
  const a = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'foo' },
    } as AgentSessionEvent,
    c,
  )
  const b = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'bar' },
    } as AgentSessionEvent,
    c,
  )
  assert.equal((a as { messageId: string }).messageId, firstId)
  assert.equal((b as { messageId: string }).messageId, firstId)
})

test('messageId rotates on the next message_start', () => {
  const c = ctx()
  translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  const first = c.messageId
  translatePiEvent({ type: 'message_start' } as AgentSessionEvent, c)
  const second = c.messageId
  assert.ok(first && second)
  assert.notEqual(first, second, 'messageId should change between assistant messages')
})

// ---------------------------------------------------------------------------
// Error classification + emission
// ---------------------------------------------------------------------------

test('classifyPiErrorMessage: rate-limit substring → rate_limit, retryable', () => {
  const p = classifyPiErrorMessage('Anthropic rate limit exceeded, try again later')
  assert.equal(p.category, 'rate_limit')
  assert.equal(p.retryable, true)
})

test('classifyPiErrorMessage: 429 in message → rate_limit', () => {
  const p = classifyPiErrorMessage('HTTP 429 from upstream')
  assert.equal(p.category, 'rate_limit')
})

test('classifyPiErrorMessage: quota substring → quota, not retryable', () => {
  const p = classifyPiErrorMessage('Out of credit, please top up')
  assert.equal(p.category, 'quota')
  assert.equal(p.retryable, false)
})

test('classifyPiErrorMessage: 401 / unauthorized → auth', () => {
  assert.equal(classifyPiErrorMessage('401 Unauthorized').category, 'auth')
  assert.equal(classifyPiErrorMessage('Invalid API key').category, 'auth')
})

test('classifyPiErrorMessage: overloaded / 5xx → upstream_5xx, retryable', () => {
  const p = classifyPiErrorMessage('Anthropic overloaded')
  assert.equal(p.category, 'upstream_5xx')
  assert.equal(p.retryable, true)
})

test('classifyPiErrorMessage: ECONNRESET / network → transport', () => {
  assert.equal(classifyPiErrorMessage('ECONNRESET').category, 'transport')
  assert.equal(classifyPiErrorMessage('fetch failed').category, 'transport')
})

test('classifyPiErrorMessage: unknown text → internal', () => {
  const p = classifyPiErrorMessage('something weird happened')
  assert.equal(p.category, 'internal')
  assert.equal(p.retryable, false)
})

test('classifyPiErrorMessage: empty / undefined → internal with default message', () => {
  assert.equal(classifyPiErrorMessage(undefined).category, 'internal')
  assert.equal(classifyPiErrorMessage('').category, 'internal')
})

test('translatePiEvent: message_update error → typed error event', () => {
  const c = ctx()
  const out = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'rate limit exceeded',
        },
      },
    } as unknown as AgentSessionEvent,
    c,
  )
  assert.ok(out)
  assert.equal((out as { kind: string }).kind, 'error')
  assert.equal((out as { category: string }).category, 'rate_limit')
})

test('translatePiEvent: message_update aborted does NOT emit error (clean cancel)', () => {
  const out = translatePiEvent(
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'error',
        reason: 'aborted',
        error: { role: 'assistant', content: [], stopReason: 'aborted' },
      },
    } as unknown as AgentSessionEvent,
    ctx(),
  )
  assert.equal(out, null)
})

test('translatePiEvent: auto_retry_start emits a retryable error event', () => {
  const out = translatePiEvent(
    {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'overloaded',
    } as unknown as AgentSessionEvent,
    ctx(),
  )
  assert.ok(out)
  assert.equal((out as { kind: string }).kind, 'error')
  assert.equal((out as { category: string }).category, 'upstream_5xx')
  assert.equal((out as { retryable: boolean }).retryable, true)
})

test('errorPayloadToUpdate (pi) shape matches wire contract', () => {
  const u = errorPayloadToUpdate({
    category: 'rate_limit',
    retryable: true,
    message: 'slow down',
  })
  assert.equal(u.kind, 'error')
  assert.equal(u.category, 'rate_limit')
  assert.equal(u.retryable, true)
  assert.equal(u.message, 'slow down')
})
