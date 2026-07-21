// Unit tests for agent availability: the ProbeHealth consecutive-
// timeout tracker (pure) and the claude install probe against fake
// binaries (no real claude needed — CLAUDE_CODE_EXECUTABLE points at
// throwaway shell scripts, and WAGENT_CLAUDE_PROBE_TIMEOUT_MS keeps
// the timeout path fast).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearCache,
  probeAgent,
  ProbeHealth,
  type AgentAvailability,
} from '../src/agent/availability.js'

const TIMED_OUT: AgentAvailability = {
  id: 'claude',
  installed: false,
  reason: 'probe_failed',
  notes: 'claude --version timed out (>2s)',
}

const HEALTHY: AgentAvailability = {
  id: 'claude',
  installed: true,
  version: '9.9.9',
}

const EXIT_FAIL: AgentAvailability = {
  id: 'claude',
  installed: false,
  reason: 'probe_failed',
  notes: 'claude --version exit code 1',
}

test('ProbeHealth: fires exactly once at the threshold', () => {
  let fired = 0
  const health = new ProbeHealth(3, () => fired++)
  health.record(TIMED_OUT)
  health.record(TIMED_OUT)
  assert.equal(fired, 0)
  health.record(TIMED_OUT)
  assert.equal(fired, 1)
  // Further timeouts past the threshold don't re-fire.
  health.record(TIMED_OUT)
  assert.equal(fired, 1)
})

test('ProbeHealth: a healthy probe resets the counter', () => {
  let fired = 0
  const health = new ProbeHealth(3, () => fired++)
  health.record(TIMED_OUT)
  health.record(TIMED_OUT)
  health.record(HEALTHY)
  health.record(TIMED_OUT)
  health.record(TIMED_OUT)
  assert.equal(fired, 0)
  health.record(TIMED_OUT)
  assert.equal(fired, 1)
})

test('ProbeHealth: non-timeout failures do not count as degradation', () => {
  let fired = 0
  const health = new ProbeHealth(2, () => fired++)
  health.record(EXIT_FAIL)
  health.record(EXIT_FAIL)
  health.record({ id: 'claude', installed: false, reason: 'binary_missing' })
  assert.equal(fired, 0)
  // ...and they reset the streak.
  health.record(TIMED_OUT)
  health.record(EXIT_FAIL)
  health.record(TIMED_OUT)
  assert.equal(fired, 0)
})

test('ProbeHealth: can re-fire after a reset', () => {
  let fired = 0
  const health = new ProbeHealth(2, () => fired++)
  health.record(TIMED_OUT)
  health.record(TIMED_OUT)
  assert.equal(fired, 1)
  health.record(HEALTHY)
  health.record(TIMED_OUT)
  health.record(TIMED_OUT)
  assert.equal(fired, 2)
})

// ---------------------------------------------------------------------------
// Real probe against fake binaries
// ---------------------------------------------------------------------------

let dir: string
let savedExe: string | undefined
let savedTimeout: string | undefined

function fakeBin(name: string, script: string): string {
  const path = join(dir, name)
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wagent-avail-'))
  savedExe = process.env.CLAUDE_CODE_EXECUTABLE
  savedTimeout = process.env.WAGENT_CLAUDE_PROBE_TIMEOUT_MS
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedExe === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE
  else process.env.CLAUDE_CODE_EXECUTABLE = savedExe
  if (savedTimeout === undefined) delete process.env.WAGENT_CLAUDE_PROBE_TIMEOUT_MS
  else process.env.WAGENT_CLAUDE_PROBE_TIMEOUT_MS = savedTimeout
  clearCache()
})

test('probeClaude: healthy binary → installed with version', async () => {
  process.env.CLAUDE_CODE_EXECUTABLE = fakeBin('claude-ok', '#!/bin/sh\nprintf "9.9.9\\n"\n')
  clearCache()
  const result = await probeAgent('claude')
  assert.equal(result.installed, true)
  assert.equal(result.version, '9.9.9')
})

test('probeClaude: hanging binary → probe_failed with timeout note', async () => {
  process.env.CLAUDE_CODE_EXECUTABLE = fakeBin('claude-hang', '#!/bin/sh\nsleep 30\n')
  process.env.WAGENT_CLAUDE_PROBE_TIMEOUT_MS = '150'
  clearCache()
  const result = await probeAgent('claude')
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'probe_failed')
  assert.match(result.notes ?? '', /timed out/)
  delete process.env.WAGENT_CLAUDE_PROBE_TIMEOUT_MS
})

test('probeClaude: nonzero exit → probe_failed without timeout note', async () => {
  process.env.CLAUDE_CODE_EXECUTABLE = fakeBin('claude-bad', '#!/bin/sh\nexit 1\n')
  clearCache()
  const result = await probeAgent('claude')
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'probe_failed')
  assert.doesNotMatch(result.notes ?? '', /timed out/)
})
