// Unit tests for validateSessionOptions — the shared validator used by
// both POST /v1/sessions and the `delegate` MCP tool. Tests the
// validator in isolation so we catch regressions before they ship to
// either consumer.
//
// The full HTTP-level matrix (every field, every error code) lives in
// scripts/test-api.ts under "POST /v1/sessions ...". Tests here are a
// thin contract check — same shape, sharable across both call sites.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSessionOptions } from '../src/sessions/options.js'

test('null/undefined options → ok value: null', () => {
  assert.deepEqual(validateSessionOptions(null), { ok: true, value: null })
  assert.deepEqual(validateSessionOptions(undefined), { ok: true, value: null })
})

test('empty object → ok value: null (no JSON blob persisted for empty)', () => {
  assert.deepEqual(validateSessionOptions({}), { ok: true, value: null })
})

test('non-object scalar → invalid_options', () => {
  const res = validateSessionOptions('hello')
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'invalid_options')
})

test('array → invalid_options (Array.isArray check)', () => {
  const res = validateSessionOptions([])
  assert.equal(res.ok, false)
})

test('happy path: every supported field passes through', () => {
  const res = validateSessionOptions({
    systemPrompt: 'replace',
    appendSystemPrompt: 'append',
    allowedTools: ['Read', 'Edit'],
    mcpServers: {
      recall: { type: 'http', url: 'http://localhost:9000/mcp' },
    },
    permissionMode: 'bypass',
    resume: '00000000-0000-0000-0000-000000000000',
    forkSession: true,
  })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.deepEqual(res.value, {
      systemPrompt: 'replace',
      appendSystemPrompt: 'append',
      allowedTools: ['Read', 'Edit'],
      mcpServers: { recall: { type: 'http', url: 'http://localhost:9000/mcp' } },
      permissionMode: 'bypass',
      resume: '00000000-0000-0000-0000-000000000000',
      forkSession: true,
    })
  }
})

test('forkSession: true without resume → invalid_options', () => {
  const res = validateSessionOptions({ forkSession: true })
  assert.equal(res.ok, false)
  if (!res.ok) assert.match(res.message, /forkSession requires options.resume/)
})

test('reserved mcpServers key wagent-delegate → invalid_options', () => {
  const res = validateSessionOptions({
    mcpServers: { 'wagent-delegate': { type: 'http', url: 'http://x/mcp' } },
  })
  assert.equal(res.ok, false)
  if (!res.ok) assert.match(res.message, /wagent-delegate.*reserved/)
})

test('unknown permissionMode → invalid_options', () => {
  const res = validateSessionOptions({ permissionMode: 'banana' })
  assert.equal(res.ok, false)
  if (!res.ok) assert.match(res.message, /permissionMode/)
})

test('mcpServers: empty record collapses to absent (does not persist {})', () => {
  const res = validateSessionOptions({ mcpServers: {} })
  assert.equal(res.ok, true)
  // Empty mcpServers + no other fields → null overall (the empty-object collapse).
  if (res.ok) assert.equal(res.value, null)
})
