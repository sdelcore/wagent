// Unit tests for createSession — the validated session-creation pipeline
// shared by POST /v1/sessions, POST /v1/sessions/:id/fork, and the
// `delegate` MCP tool. Tests run against an in-memory SQLite + a stub
// probeAgent so every error code can be exercised without spinning up
// the HTTP server or any harness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/db.js'
import { SessionStore } from '../src/sessions/store.js'
import { createSession } from '../src/sessions/create.js'
import type { AgentKind } from '../src/types.js'

function setup(opts: { installed?: boolean; notes?: string } = {}) {
  const db = openDatabase(':memory:')
  const sessionStore = new SessionStore(db)
  const probeAgent = async (_id: AgentKind) => ({
    installed: opts.installed ?? true,
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
  })
  return { db, sessionStore, probeAgent }
}

test('happy path: minimal valid input → ok session', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp/work' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.agent, 'echo')
    assert.equal(result.value.cwd, '/tmp/work')
    assert.equal(result.value.delegationDepth, 0)
    assert.equal(result.value.delegationMode, null)
    assert.equal(result.value.parentSessionId, null)
  }
})

test('agent missing → invalid_agent', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: undefined, cwd: '/tmp' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_agent')
})

test('agent unknown string → invalid_agent', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'gemini', cwd: '/tmp' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_agent')
})

test('cwd not a string → invalid_cwd', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: 42 },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_cwd')
})

test('cwd starts with ~ → invalid_cwd', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '~/work' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_cwd')
})

test('cwd relative → invalid_cwd', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: 'work/sub' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_cwd')
})

test('cwd is trimmed', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '  /tmp/work  ' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.cwd, '/tmp/work')
})

test('options invalid shape → invalid_options', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', options: 'not an object' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_options')
})

test('agent not installed → agent_not_available with probe notes', async () => {
  const { sessionStore, probeAgent } = setup({ installed: false, notes: 'binary missing' })
  const result = await createSession(
    { agent: 'claude', cwd: '/tmp' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'agent_not_available')
    assert.equal(result.message, 'binary missing')
  }
})

test('agent not installed without notes → fallback message', async () => {
  const { sessionStore, probeAgent } = setup({ installed: false })
  const result = await createSession(
    { agent: 'pi', cwd: '/tmp' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'agent_not_available')
    assert.match(result.message, /pi is not available/)
  }
})

test('parent missing → parent_not_found', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: 'does-not-exist' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'parent_not_found')
})

test('parentSessionId not a string → invalid_parent', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: 42 },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_parent')
})

test('parent destroyed → parent_destroyed', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  // Mark parent destroyed via raw SQL — store has no public 'destroy'.
  ;(sessionStore as unknown as { db: { raw: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } } }).db.raw
    .prepare('UPDATE sessions SET destroyed_at = ? WHERE id = ?')
    .run(Date.now(), parent.id)
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'parent_destroyed')
})

test('depth cap exceeded at level 4', async () => {
  const { sessionStore, probeAgent } = setup()
  const root = sessionStore.create({ agent: 'echo', cwd: '/tmp', delegationDepth: 0 })
  const l1 = sessionStore.create({
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
    delegationDepth: 1,
  })
  const l2 = sessionStore.create({
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: l1.id,
    delegationDepth: 2,
  })
  const l3 = sessionStore.create({
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: l2.id,
    delegationDepth: 3,
  })
  // l3 is at depth 3 (cap). A child at depth 4 must be rejected.
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: l3.id },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'depth_cap_exceeded')
})

test('delegationMode defaults to "sync" when parent set + mode undefined', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.delegationMode, 'sync')
})

test('delegationMode null is preserved (fork case)', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id, delegationMode: null },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.delegationMode, null)
})

test('delegationMode "background" passes through', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id, delegationMode: 'background' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.delegationMode, 'background')
})

test('delegationMode unknown string → invalid_delegation_mode', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id, delegationMode: 'parallel' },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'invalid_delegation_mode')
})

test('child computes delegationDepth = parent.depth + 1', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({
    agent: 'echo',
    cwd: '/tmp',
    delegationDepth: 1,
  })
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', parentSessionId: parent.id },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.delegationDepth, 2)
    assert.equal(result.value.parentSessionId, parent.id)
  }
})

test('alias and model pass through; model coerced from non-string to null', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    { agent: 'echo', cwd: '/tmp', alias: 'work', model: 42 },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.alias, 'work')
    assert.equal(result.value.model, null)
  }
})

test('options validated and persisted on the session row', async () => {
  const { sessionStore, probeAgent } = setup()
  const result = await createSession(
    {
      agent: 'echo',
      cwd: '/tmp',
      options: { systemPrompt: 'be concise' },
    },
    { sessionStore, probeAgent },
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.value.options, { systemPrompt: 'be concise' })
  }
})

test('parentToolCallId passes through when string, else null', async () => {
  const { sessionStore, probeAgent } = setup()
  const parent = sessionStore.create({ agent: 'echo', cwd: '/tmp' })
  const r1 = await createSession(
    {
      agent: 'echo',
      cwd: '/tmp',
      parentSessionId: parent.id,
      parentToolCallId: 'tc-123',
    },
    { sessionStore, probeAgent },
  )
  assert.equal(r1.ok, true)
  if (r1.ok) assert.equal(r1.value.parentToolCallId, 'tc-123')

  const r2 = await createSession(
    {
      agent: 'echo',
      cwd: '/tmp',
      parentSessionId: parent.id,
      parentToolCallId: 42,
    },
    { sessionStore, probeAgent },
  )
  assert.equal(r2.ok, true)
  if (r2.ok) assert.equal(r2.value.parentToolCallId, null)
})
