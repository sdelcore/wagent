import { randomBytes } from 'node:crypto'

interface TokenEntry {
  parentSessionId: string
  // Depth of the parent. Children minted via this token will be at depth+1.
  parentDepth: number
}

// In-memory only. Tokens are minted at parent-spawn time and revoked on
// parent close. Process restart invalidates everything — that's correct
// because the harness subprocesses die with us.
export class DelegateTokenStore {
  private readonly byToken = new Map<string, TokenEntry>()
  private readonly byParent = new Map<string, string>()

  mint(parentSessionId: string, parentDepth: number): string {
    // Reuse existing token if one already exists for this parent — keeps
    // re-spawn idempotent.
    const existing = this.byParent.get(parentSessionId)
    if (existing) return existing
    const token = randomBytes(24).toString('base64url')
    this.byToken.set(token, { parentSessionId, parentDepth })
    this.byParent.set(parentSessionId, token)
    return token
  }

  verify(parentSessionId: string, token: string): TokenEntry | null {
    const entry = this.byToken.get(token)
    if (!entry) return null
    if (entry.parentSessionId !== parentSessionId) return null
    return entry
  }

  revoke(parentSessionId: string): void {
    const token = this.byParent.get(parentSessionId)
    if (!token) return
    this.byToken.delete(token)
    this.byParent.delete(parentSessionId)
  }
}
