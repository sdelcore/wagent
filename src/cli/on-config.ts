// Host registry loader for `wagent-on`. Reads
// `${XDG_CONFIG_HOME:-$HOME/.config}/wagent/hosts.toml` and resolves
// the auth token for a given host entry from either env or file.
//
// Token resolution order (per host):
//   1. `auth_token_env` is set AND that env var is present → use it
//   2. `auth_token_file` is set AND the file is readable → read it
//      (trailing whitespace trimmed)
//   3. otherwise → no Authorization header is sent (fine for loopback)

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'

export interface HostEntry {
  url: string
  default_cwd?: string
  auth_token_env?: string
  auth_token_file?: string
}

export interface HostsConfig {
  hosts: Record<string, HostEntry>
}

export interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string
  existsSync(path: string): boolean
}

export interface EnvLike {
  get(name: string): string | undefined
}

const realFs: FsLike = {
  readFileSync: (p, e) => readFileSync(p, e),
  existsSync: (p) => existsSync(p),
}

const realEnv: EnvLike = {
  get: (name) => process.env[name],
}

export function defaultHostsPath(env: EnvLike = realEnv): string {
  const xdg = env.get('XDG_CONFIG_HOME')
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'wagent', 'hosts.toml')
}

// Validate a single `[hosts.<name>]` table. Throws on shape errors so
// the CLI can surface a clear "your config is wrong" message rather
// than crashing later with a confusing "fetch failed".
function parseEntry(name: string, raw: unknown): HostEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`hosts.${name}: must be a table`)
  }
  const obj = raw as Record<string, unknown>
  const url = obj.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`hosts.${name}: missing required string \`url\``)
  }
  const entry: HostEntry = { url }
  if (obj.default_cwd !== undefined) {
    if (typeof obj.default_cwd !== 'string') {
      throw new Error(`hosts.${name}: \`default_cwd\` must be a string`)
    }
    entry.default_cwd = obj.default_cwd
  }
  if (obj.auth_token_env !== undefined) {
    if (typeof obj.auth_token_env !== 'string') {
      throw new Error(`hosts.${name}: \`auth_token_env\` must be a string`)
    }
    entry.auth_token_env = obj.auth_token_env
  }
  if (obj.auth_token_file !== undefined) {
    if (typeof obj.auth_token_file !== 'string') {
      throw new Error(`hosts.${name}: \`auth_token_file\` must be a string`)
    }
    entry.auth_token_file = obj.auth_token_file
  }
  return entry
}

export function parseHostsToml(text: string): HostsConfig {
  const parsed = TOML.parse(text) as Record<string, unknown>
  const hostsRaw = parsed.hosts
  if (hostsRaw === undefined) return { hosts: {} }
  if (!hostsRaw || typeof hostsRaw !== 'object') {
    throw new Error('top-level `hosts` must be a table')
  }
  const hosts: Record<string, HostEntry> = {}
  for (const [name, raw] of Object.entries(hostsRaw as Record<string, unknown>)) {
    hosts[name] = parseEntry(name, raw)
  }
  return { hosts }
}

export function loadHostsConfig(opts: {
  path?: string
  fs?: FsLike
  env?: EnvLike
} = {}): HostsConfig {
  const fs = opts.fs ?? realFs
  const env = opts.env ?? realEnv
  const path = opts.path ?? defaultHostsPath(env)
  if (!fs.existsSync(path)) {
    throw new Error(`wagent hosts config not found at ${path}`)
  }
  const text = fs.readFileSync(path, 'utf8')
  return parseHostsToml(text)
}

export interface ResolvedHost {
  url: string
  cwd: string | undefined
  authToken: string | undefined
}

// Combine a host registry entry, the optional --cwd override, and the
// caller's environment / filesystem into the bundle of values
// `wagent-on` actually needs at request time. Returns null for a
// missing host so the caller can format a "known hosts:" message.
export function resolveHost(
  config: HostsConfig,
  hostName: string,
  cwdOverride: string | undefined,
  opts: { fs?: FsLike; env?: EnvLike } = {},
): ResolvedHost | null {
  const fs = opts.fs ?? realFs
  const env = opts.env ?? realEnv
  const entry = config.hosts[hostName]
  if (!entry) return null
  const cwd = cwdOverride ?? entry.default_cwd
  const authToken = resolveAuthToken(entry, fs, env)
  return {
    url: entry.url.replace(/\/+$/, ''),
    cwd,
    authToken,
  }
}

function resolveAuthToken(entry: HostEntry, fs: FsLike, env: EnvLike): string | undefined {
  if (entry.auth_token_env) {
    const v = env.get(entry.auth_token_env)
    if (v && v.length > 0) return v
  }
  if (entry.auth_token_file) {
    if (fs.existsSync(entry.auth_token_file)) {
      const raw = fs.readFileSync(entry.auth_token_file, 'utf8')
      const trimmed = raw.replace(/\s+$/, '')
      if (trimmed.length > 0) return trimmed
    }
  }
  return undefined
}

export function knownHosts(config: HostsConfig): string[] {
  return Object.keys(config.hosts).sort()
}
