# Why

## The specific problem

Hands-off, mobile-first access to coding agents running on my own PCs.

Concretely, I want to:

- Start a new agent session on my desktop from my phone (not just resume one I already started).
- See sessions across multiple machines (desktop, laptop, home server) from one client.
- Have the agent keep working when I put my phone down and come back 20 minutes later.
- Occasionally let the agent touch the host directly, not just a sandbox — for debugging a PC that's acting up.
- Not be locked into one harness. Primary is Claude Code today, but I also use OpenCode and may use others.

## Why this isn't solved by existing tools

| Tool | Why it doesn't fit |
|---|---|
| **Anthropic Claude Code Remote Control** | Can't start sessions remotely (requires `claude` already running). One session per machine. Claude only. Closed protocol. |
| **Rivet `sandbox-agent`** (vanilla) | Assumes you deploy it inside a cloud sandbox (E2B, Daytona, etc.). Sessions don't persist across daemon restarts. No multi-host aggregation. |
| **Tailscale + SSH + tmux** | Works, but the UX on a phone while holding a baby is miserable. |
| **Happy Coder, ccpocket, etc.** | Claude-only, wrap the `claude` CLI, single-session, no multi-host. |

## Why now

A baby is incoming. I won't be at a desk for long stretches. "Mobile dev while holding an infant" is a real, imminent need, not a hypothetical.

## Design stance

- **Right and future-proof over easiest.** I'm willing to pay up-front complexity to avoid decisions I'd have to tear out.
- **Personal use only.** Single user, multiple devices. Not a product, not hosted, no multi-tenant.
- **Lean on existing infrastructure.** Don't rebuild what Rivet, Nix, Tailscale, and Claude's own SDK already do well.
- **One genuinely novel piece.** The daemon + client + persistence model for personal PCs. Everything else is integration.
