import { homedir, hostname } from 'node:os'
import { resolve } from 'node:path'

export interface Config {
  host: string
  port: number
  dbPath: string
  token: string | undefined
  corsOrigins: string[] | true
  logLevel: string
  hostname: string
  home: string
  // Consecutive claude-probe timeouts before the daemon self-exits so
  // its supervisor (systemd) restarts it and the cgroup kill reaps any
  // leaked subprocess trees. 0 disables.
  probeDegradedThreshold: number
}

function parseOrigins(raw: string | undefined): string[] | true {
  if (!raw || raw.trim() === '*') return true
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function loadConfig(): Config {
  return {
    host: process.env.WAGENT_HOST ?? '0.0.0.0',
    port: Number.parseInt(process.env.WAGENT_PORT ?? '2468', 10),
    dbPath:
      process.env.WAGENT_DB ??
      resolve(homedir(), '.local/share/wagent/wagent.sqlite'),
    token: process.env.WAGENT_AUTH_TOKEN,
    corsOrigins: parseOrigins(process.env.WAGENT_CORS),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    hostname: hostname(),
    home: homedir(),
    probeDegradedThreshold: parseThreshold(process.env.WAGENT_PROBE_DEGRADED_THRESHOLD),
  }
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return 5
  if (!/^\d+$/.test(raw)) return 5
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : 5
}
