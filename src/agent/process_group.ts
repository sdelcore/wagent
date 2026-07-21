import type { ChildProcess } from 'node:child_process'

export function signalProcessGroup(
  pgid: number,
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false
    if (child.exitCode !== null || child.signalCode !== null) return false
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

export function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function reapProcessGroup(
  pgid: number,
  child: ChildProcess,
  graceMs: number,
): Promise<boolean> {
  if (!processGroupExists(pgid)) return true
  signalProcessGroup(pgid, child, 'SIGTERM')
  if (await waitForGroupExit(pgid, graceMs)) return true
  signalProcessGroup(pgid, child, 'SIGKILL')
  return waitForGroupExit(pgid, graceMs)
}

async function waitForGroupExit(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (processGroupExists(pgid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, ms)))
  }
  return true
}
