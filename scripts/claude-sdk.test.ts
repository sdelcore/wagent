// Unit tests for the claude SDK adapter's pure translation functions.
//
// Synthetic SDKMessage payloads — no claude binary, no API key, no
// network. CI runs them on every PR.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  translateClaudeMessage,
  translateStopReason,
  type ClaudeTranslationState,
} from '../src/agent/claude_sdk.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

function state(): ClaudeTranslationState {
  return { messageId: null }
}

test('stream_event message_start mints messageId, no wire output', () => {
  const s = state()
  const out = translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  assert.deepEqual(out, [])
  assert.ok(s.messageId, 'messageId should be set after message_start')
  assert.match(s.messageId!, /^[0-9a-f-]{36}$/)
})

test('content_block_delta text_delta → agent_message_chunk', () => {
  const s = state()
  translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  const id = s.messageId
  const out = translateClaudeMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    } as unknown as SDKMessage,
    s,
  )
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    kind: 'agent_message_chunk',
    messageId: id,
    text: 'hello',
  })
})

test('content_block_delta thinking_delta → agent_thought_chunk', () => {
  const s = state()
  translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  const out = translateClaudeMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      },
    } as unknown as SDKMessage,
    s,
  )
  assert.equal(out.length, 1)
  assert.equal((out[0] as { kind: string }).kind, 'agent_thought_chunk')
  assert.equal((out[0] as { text: string }).text, 'pondering')
})

test('content_block_delta with unrelated delta types is dropped', () => {
  const s = state()
  const out = translateClaudeMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":1' },
      },
    } as unknown as SDKMessage,
    s,
  )
  assert.deepEqual(out, [])
})

test('assistant message with tool_use blocks → tool_call events', () => {
  const out = translateClaudeMessage(
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read the file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/etc/hosts' } },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
    state(),
  )
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    kind: 'tool_call',
    toolCallId: 'tool-1',
    name: 'Read',
    input: { path: '/etc/hosts' },
    status: 'pending',
  })
})

test('user message tool_result success → tool_call_update complete', () => {
  const out = translateClaudeMessage(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'file contents',
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
    state(),
  )
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    kind: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'complete',
    result: 'file contents',
  })
})

test('user message tool_result error → tool_call_update error', () => {
  const out = translateClaudeMessage(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'permission denied',
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
    state(),
  )
  assert.equal((out[0] as { status: string }).status, 'error')
})

test('result message is suppressed (handled by adapter for stop emission)', () => {
  const out = translateClaudeMessage(
    {
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: 'done',
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: 'x',
      session_id: 'x',
    } as unknown as SDKMessage,
    state(),
  )
  assert.deepEqual(out, [])
})

test('translateStopReason: success/end_turn → end_turn', () => {
  const r = translateStopReason(
    { type: 'result', subtype: 'success', stop_reason: 'end_turn' } as never,
    false,
  )
  assert.equal(r, 'end_turn')
})

test('translateStopReason: success/max_tokens → max_tokens', () => {
  const r = translateStopReason(
    { type: 'result', subtype: 'success', stop_reason: 'max_tokens' } as never,
    false,
  )
  assert.equal(r, 'max_tokens')
})

test('translateStopReason: success/refusal → refusal', () => {
  const r = translateStopReason(
    { type: 'result', subtype: 'success', stop_reason: 'refusal' } as never,
    false,
  )
  assert.equal(r, 'refusal')
})

test('translateStopReason: aborted overrides everything → cancelled', () => {
  const r = translateStopReason(
    { type: 'result', subtype: 'success', stop_reason: 'end_turn' } as never,
    true,
  )
  assert.equal(r, 'cancelled')
})

test('translateStopReason: error subtypes → error', () => {
  for (const subtype of [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ] as const) {
    const r = translateStopReason(
      { type: 'result', subtype, stop_reason: null } as never,
      false,
    )
    assert.equal(r, 'error', `${subtype} should map to error`)
  }
})

test('messageId persists across multiple deltas in one assistant message', () => {
  const s = state()
  translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  const id = s.messageId
  const a = translateClaudeMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'foo' },
      },
    } as unknown as SDKMessage,
    s,
  )
  const b = translateClaudeMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'bar' },
      },
    } as unknown as SDKMessage,
    s,
  )
  assert.equal((a[0] as { messageId: string }).messageId, id)
  assert.equal((b[0] as { messageId: string }).messageId, id)
})

test('messageId rotates on the next message_start', () => {
  const s = state()
  translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  const first = s.messageId
  translateClaudeMessage(
    { type: 'stream_event', event: { type: 'message_start' } } as unknown as SDKMessage,
    s,
  )
  const second = s.messageId
  assert.ok(first && second)
  assert.notEqual(first, second)
})

test('system messages (compact_boundary, status, etc.) emit nothing', () => {
  const out = translateClaudeMessage(
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 1000 },
      uuid: 'x',
      session_id: 'x',
    } as unknown as SDKMessage,
    state(),
  )
  assert.deepEqual(out, [])
})
