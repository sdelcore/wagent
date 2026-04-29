// Validated session creation. The single owner of agent / cwd /
// options / parent / depth / delegationMode rules and the agent
// availability probe. POST /v1/sessions, POST /v1/sessions/:id/fork,
// and the delegate MCP tool all funnel through this so the rules
// can't drift across entry points.

import {
  MAX_DELEGATION_DEPTH,
  type AgentKind,
  type DelegationMode,
  type Session,
} from '../types.js'
import type { SessionStore } from './store.js'
import { validateSessionOptions } from './options.js'

export const VALID_AGENTS: AgentKind[] = ['claude', 'pi', 'echo']
export const VALID_DELEGATION_MODES: DelegationMode[] = ['sync', 'background']

export interface CreateSessionInput {
  agent: unknown
  cwd: unknown
  alias?: unknown
  model?: unknown
  options?: unknown
  parentSessionId?: unknown
  parentToolCallId?: unknown
  // undefined → default to 'sync' when parent is set (POST / delegate).
  // null      → keep null (fork case — parent link is informational only).
  // 'sync' / 'background' → use as-is.
  delegationMode?: unknown
}

export interface ProbeResult {
  installed: boolean
  notes?: string
}

export interface CreateSessionDeps {
  sessionStore: SessionStore
  probeAgent: (id: AgentKind) => Promise<ProbeResult>
}

export type CreateSessionResult =
  | { ok: true; value: Session }
  | { ok: false; code: string; message: string }

export async function createSession(
  input: CreateSessionInput,
  deps: CreateSessionDeps,
): Promise<CreateSessionResult> {
  if (typeof input.agent !== 'string' || !VALID_AGENTS.includes(input.agent as AgentKind)) {
    return {
      ok: false,
      code: 'invalid_agent',
      message: `agent must be one of ${VALID_AGENTS.join(', ')}`,
    }
  }
  const agent = input.agent as AgentKind

  const cwdResult = validateAbsolutePath(input.cwd)
  if (!cwdResult.ok) return cwdResult
  const cwd = cwdResult.value

  const optionsResult = validateSessionOptions(input.options)
  if (!optionsResult.ok) return optionsResult

  const alias = typeof input.alias === 'string' ? input.alias : null
  const model = typeof input.model === 'string' ? input.model : null

  let parentSessionId: string | null = null
  let parentToolCallId: string | null = null
  let delegationDepth = 0
  let delegationMode: DelegationMode | null = null

  if (input.parentSessionId !== undefined && input.parentSessionId !== null) {
    if (typeof input.parentSessionId !== 'string') {
      return { ok: false, code: 'invalid_parent', message: 'parentSessionId must be a string' }
    }
    const parent = deps.sessionStore.get(input.parentSessionId)
    if (!parent) {
      return {
        ok: false,
        code: 'parent_not_found',
        message: `parent session ${input.parentSessionId} not found`,
      }
    }
    if (parent.destroyedAt !== null) {
      return { ok: false, code: 'parent_destroyed', message: 'parent session is destroyed' }
    }
    delegationDepth = parent.delegationDepth + 1
    if (delegationDepth > MAX_DELEGATION_DEPTH) {
      return {
        ok: false,
        code: 'depth_cap_exceeded',
        message: `delegationDepth ${delegationDepth} exceeds cap ${MAX_DELEGATION_DEPTH}`,
      }
    }
    parentSessionId = parent.id
    parentToolCallId =
      typeof input.parentToolCallId === 'string' ? input.parentToolCallId : null

    if (input.delegationMode === undefined) {
      delegationMode = 'sync'
    } else if (input.delegationMode === null) {
      delegationMode = null
    } else if (
      typeof input.delegationMode === 'string' &&
      VALID_DELEGATION_MODES.includes(input.delegationMode as DelegationMode)
    ) {
      delegationMode = input.delegationMode as DelegationMode
    } else {
      return {
        ok: false,
        code: 'invalid_delegation_mode',
        message: `delegationMode must be one of ${VALID_DELEGATION_MODES.join(', ')}`,
      }
    }
  }

  const availability = await deps.probeAgent(agent)
  if (!availability.installed) {
    return {
      ok: false,
      code: 'agent_not_available',
      message: availability.notes ?? `agent ${agent} is not available on this host`,
    }
  }

  const session = deps.sessionStore.create({
    agent,
    cwd,
    alias,
    model,
    parentSessionId,
    parentToolCallId,
    delegationDepth,
    delegationMode,
    options: optionsResult.value,
  })
  return { ok: true, value: session }
}

type AbsolutePathResult =
  | { ok: true; value: string }
  | { ok: false; code: string; message: string }

function validateAbsolutePath(raw: unknown): AbsolutePathResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'invalid_cwd',
      message: 'cwd must be an absolute path (no ~ expansion, no relative paths)',
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.startsWith('~') || !trimmed.startsWith('/')) {
    return {
      ok: false,
      code: 'invalid_cwd',
      message: 'cwd must be an absolute path (no ~ expansion, no relative paths)',
    }
  }
  return { ok: true, value: trimmed }
}
