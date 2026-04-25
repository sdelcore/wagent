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
    token: process.env.WAGENT_TOKEN,
    corsOrigins: parseOrigins(process.env.WAGENT_CORS),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    hostname: hostname(),
    home: homedir(),
  }
}
