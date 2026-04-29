// Session options validation. Shared between `POST /v1/sessions` (the
// session-create route) and the `delegate` MCP tool — both accept the
// same `options` shape because `delegate` is sugar over child-session
// creation. Keeping a single validator means the wire contract stays
// uniform: same field names, same error codes, same messages.

import {
  RESERVED_MCP_SERVER_NAME,
  type McpServerSpec,
  type PermissionMode,
  type SessionOptions,
} from '../types.js'

const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'ask', 'bypass']

export type ValidatedOptions =
  | { ok: true; value: SessionOptions | null }
  | { ok: false; code: string; message: string }

// Validate the optional `options` payload from `POST /v1/sessions` or
// `delegate`. Each field passes through if provided, is omitted cleanly
// if not — wagent never synthesizes defaults here.
export function validateSessionOptions(raw: unknown): ValidatedOptions {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid_options', message: 'options must be an object' }
  }
  const obj = raw as Record<string, unknown>
  const out: SessionOptions = {}
  if (obj.systemPrompt !== undefined) {
    if (typeof obj.systemPrompt !== 'string') {
      return { ok: false, code: 'invalid_options', message: 'options.systemPrompt must be a string' }
    }
    out.systemPrompt = obj.systemPrompt
  }
  if (obj.appendSystemPrompt !== undefined) {
    if (typeof obj.appendSystemPrompt !== 'string') {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.appendSystemPrompt must be a string',
      }
    }
    out.appendSystemPrompt = obj.appendSystemPrompt
  }
  if (obj.allowedTools !== undefined) {
    if (!Array.isArray(obj.allowedTools) || !obj.allowedTools.every((t) => typeof t === 'string')) {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.allowedTools must be an array of strings',
      }
    }
    out.allowedTools = obj.allowedTools as string[]
  }
  if (obj.mcpServers !== undefined) {
    const validated = validateMcpServers(obj.mcpServers)
    if (!validated.ok) return validated
    // Collapse `mcpServers: {}` to absent — same treatment as the
    // empty-options-object → null collapse below.
    if (Object.keys(validated.value).length > 0) {
      out.mcpServers = validated.value
    }
  }
  if (obj.permissionMode !== undefined) {
    if (
      typeof obj.permissionMode !== 'string' ||
      !VALID_PERMISSION_MODES.includes(obj.permissionMode as PermissionMode)
    ) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.permissionMode must be one of ${VALID_PERMISSION_MODES.join(', ')}`,
      }
    }
    out.permissionMode = obj.permissionMode as PermissionMode
  }
  if (obj.resume !== undefined) {
    if (typeof obj.resume !== 'string' || obj.resume.length === 0) {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.resume must be a non-empty Claude Code session UUID string',
      }
    }
    out.resume = obj.resume
  }
  if (obj.forkSession !== undefined) {
    if (typeof obj.forkSession !== 'boolean') {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.forkSession must be a boolean',
      }
    }
    if (obj.forkSession && out.resume === undefined) {
      // forkSession is meaningful only alongside resume — without an
      // anchor session the SDK has nothing to fork from. Reject early
      // so the caller doesn't silently get a normal fresh session.
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.forkSession requires options.resume to be set',
      }
    }
    out.forkSession = obj.forkSession
  }
  // Empty object → null so we don't persist an empty JSON blob.
  if (
    out.systemPrompt === undefined &&
    out.appendSystemPrompt === undefined &&
    out.allowedTools === undefined &&
    out.mcpServers === undefined &&
    out.permissionMode === undefined &&
    out.resume === undefined &&
    out.forkSession === undefined
  ) {
    return { ok: true, value: null }
  }
  return { ok: true, value: out }
}

type ValidatedMcpServers =
  | { ok: true; value: Record<string, McpServerSpec> }
  | { ok: false; code: string; message: string }

// Validate options.mcpServers — a record keyed by server name with
// stdio / http / sse transports. Mirrors the Claude Agent SDK's
// serializable McpServerConfig shape; the non-serializable `sdk`
// instance variant is intentionally not accepted here (it has no wire
// representation). The reserved key `wagent-delegate` is rejected so
// callers can't shadow wagent's per-spawn delegation channel.
function validateMcpServers(raw: unknown): ValidatedMcpServers {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: 'options.mcpServers must be an object keyed by server name',
    }
  }
  const out: Record<string, McpServerSpec> = {}
  for (const [name, spec] of Object.entries(raw)) {
    if (name === RESERVED_MCP_SERVER_NAME) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${RESERVED_MCP_SERVER_NAME}"] is reserved by wagent`,
      }
    }
    const validated = validateMcpServer(name, spec)
    if (!validated.ok) return validated
    out[name] = validated.value
  }
  return { ok: true, value: out }
}

type ValidatedMcpServer =
  | { ok: true; value: McpServerSpec }
  | { ok: false; code: string; message: string }

function validateMcpServer(name: string, raw: unknown): ValidatedMcpServer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"] must be an object`,
    }
  }
  const spec = raw as Record<string, unknown>
  // Default transport when `type` is omitted is stdio (matches the SDK).
  const type = spec.type === undefined ? 'stdio' : spec.type
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].type must be one of stdio, http, sse`,
    }
  }
  if (type === 'stdio') {
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].command must be a non-empty string`,
      }
    }
    if (
      spec.args !== undefined &&
      (!Array.isArray(spec.args) || !spec.args.every((a) => typeof a === 'string'))
    ) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].args must be an array of strings`,
      }
    }
    if (spec.env !== undefined && !isStringRecord(spec.env)) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].env must be a string-to-string record`,
      }
    }
    const value: McpServerSpec = {
      type: 'stdio',
      command: spec.command,
      ...(spec.args !== undefined ? { args: spec.args as string[] } : {}),
      ...(spec.env !== undefined ? { env: spec.env as Record<string, string> } : {}),
    }
    return { ok: true, value }
  }
  // http or sse — same validation shape.
  if (typeof spec.url !== 'string' || spec.url.length === 0) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].url must be a non-empty string`,
    }
  }
  if (spec.headers !== undefined && !isStringRecord(spec.headers)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].headers must be a string-to-string record`,
    }
  }
  const value: McpServerSpec = {
    type,
    url: spec.url,
    ...(spec.headers !== undefined ? { headers: spec.headers as Record<string, string> } : {}),
  }
  return { ok: true, value }
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
}
