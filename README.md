# wagent

Self-hosted daemon that runs coding agents on a host and exposes them
over HTTP+SSE so any client (web, CLI, mobile) can drive them
remotely.

Not a product. Not multi-tenant. One user, many devices.

## What it is

A small Node + TypeScript service that:

- Drives coding-agent harnesses on the host, in-process via vendor
  SDKs:
  [Claude](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
  (still shells out to the `claude` CLI, but the SDK manages it),
  and [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
  (fully in-process). Plus an `echo` stub for testing.
- Speaks JSON over HTTP for control + Server-Sent Events for
  streaming.
- Persists sessions and event history in SQLite so reconnecting
  clients don't lose state.
- Handles permissions, cancellation, and per-session model switching.
- Lets a parent agent dispatch focused subtasks to a child session of
  any installed harness via a `delegate` MCP tool — sync or
  background, depth-capped, cascade-destroyed. See
  [docs/delegation.md](./docs/delegation.md).
- Ships as a single Node entry point, packaged via Nix.

## Why

Hands-off, mobile-first access to coding agents running on my own
PCs. Concretely: start a new session on my desktop from my phone,
see sessions across multiple machines from one client, have the
agent keep working when I put my phone down for 20 minutes, let it
touch the host directly when needed, and not be locked into one
harness.

What didn't fit:

| Tool | Why it doesn't fit |
|---|---|
| **Anthropic Claude Code Remote Control** | Can't start sessions remotely (requires `claude` already running). One session per machine. Claude only. Closed protocol. |
| **Rivet `sandbox-agent`** (vanilla) | Assumes you deploy it inside a cloud sandbox (E2B, Daytona, etc.). Sessions don't persist across daemon restarts. No multi-host aggregation. |
| **Tailscale + SSH + tmux** | Works, but the UX on a phone while holding a baby is miserable. |
| **Happy Coder, ccpocket, etc.** | Claude-only, wrap the `claude` CLI, single-session, no multi-host. |

Stance: personal use only, lean on existing infrastructure (Rivet's
schema where it fits, Nix, Tailscale, vendor SDKs), one genuinely
novel piece — the daemon + persistence model for personal PCs.
Everything else is integration.

## Quick start

```bash
cd ~/src/wagent
direnv allow            # first time only — nix flake → node 22
npm install
npm run dev             # Fastify on :2468
```

```bash
SID=$(curl -s -X POST http://localhost:2468/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"echo","cwd":"/tmp"}' | jq -r .id)

curl -N http://localhost:2468/v1/sessions/$SID/events/stream &
curl -X POST http://localhost:2468/v1/sessions/$SID/message \
  -H 'content-type: application/json' \
  -d '{"content":[{"type":"text","text":"hi"}]}'
```

For real deployment (NixOS module, ad-hoc Nix, plain Linux + systemd
user unit) see **[docs/setup.md](./docs/setup.md)**.

## Docs

- [architecture.md](./docs/architecture.md) — current shape, wire
  contract, session lifecycle.
- [setup.md](./docs/setup.md) — install + run on any host.
- [delegation.md](./docs/delegation.md) — cross-harness `delegate`
  MCP tool.
- [CLAUDE.md](./CLAUDE.md) — codebase orientation for AI agents
  working in this repo.

## Repo

```
src/
  server.ts        Fastify entry, routes, lifecycle
  config.ts        env parsing
  db.ts            better-sqlite3 + schema
  bus.ts           per-session in-memory pubsub
  types.ts         wire types (stable v1)
  agent/           AgentProcess interface, factories, supervisor
  events/          event store
  projects/        project store
  routes/          HTTP routes
  sessions/        session store
scripts/
  smoke.ts                 minimal echo end-to-end
  test-api.ts              full v1 API suite
  pi-sdk.test.ts           pi adapter unit tests
  claude-sdk.test.ts       claude adapter unit tests
flake.nix          Nix dev shell + NixOS module + package
```

## License

MIT.
