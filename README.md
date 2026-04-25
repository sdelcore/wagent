# wagent

Self-hosted daemon that runs coding agents on a host and exposes them over
HTTP+SSE so any client (web, CLI, mobile) can drive them remotely.

Not a product. Not multi-tenant. One user, many devices.

## What it is

A small Node + TypeScript service that:

- Spawns and supervises coding-agent subprocesses on the host
  (Claude via [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  pi via [`pi --mode rpc`](https://github.com/badlogic/pi-mono)).
- Speaks JSON over HTTP for control + Server-Sent Events for streaming.
- Persists sessions and event history in SQLite so reconnecting clients
  don't lose state.
- Handles permissions, cancellation, and per-session model switching.
- Ships as a single Node entry point, packaged via Nix.

Replaces [Rivet `sandbox-agent`](https://github.com/rivet-dev/sandbox-agent)
as the host-side daemon. The wire is wagent's own — clients talk to it
directly without an intermediate SDK.

## Why not Rivet?

Rivet is well-engineered but optimized for cloud-sandbox deployment
(E2B / Daytona / Modal). Using it for "personal-PC always-on daemon"
piled up 20+ workarounds in [droidcode](https://github.com/sdelcore/droidcode)'s
SDK_LIMITATIONS doc — most of them structural to Rivet's design (sessions
are client-persisted, resume re-spawns the subprocess and replays a JSON
prefix, no real interrupt primitive, etc.). At that point we own enough
of the integration that owning the daemon is cheaper than maintaining
the workarounds. See [docs/decisions.md](./docs/decisions.md).

## Status

**v0.1 — scaffold.** Fastify server with `/v1/health` and `/v1/meta`,
SQLite schema for sessions + events + projects. Subprocess adapters
(`claude-agent-acp`, `pi --mode rpc`) and the prompt/cancel/permission
endpoints land in subsequent commits.

## Quick start

```bash
cd ~/src/wagent
direnv allow            # nix flake → node 22 + sandbox-agent on PATH (legacy, will drop)
npm install
npm run dev             # tsx watch, Fastify on :2468
```

Then:

```bash
curl http://localhost:2468/v1/health
curl http://localhost:2468/v1/meta
```

## Configuration

| env | default | purpose |
|---|---|---|
| `WAGENT_HOST` | `0.0.0.0` | listen host |
| `WAGENT_PORT` | `2468` | listen port (same as Rivet for drop-in compatibility during migration) |
| `WAGENT_DB` | `~/.local/share/wagent/wagent.sqlite` | SQLite path |
| `WAGENT_TOKEN` | *(unset)* | bearer token; clients send `Authorization: Bearer <token>` |
| `WAGENT_CORS` | `*` | comma-separated origin allowlist for the daemon's HTTP API |
| `LOG_LEVEL` | `info` | Fastify logger level |

## Repo

```
src/
  server.ts        Fastify entry, routes, lifecycle
  config.ts        env parsing
  db.ts            better-sqlite3 + schema
  (agent/, http/, etc. — land in upcoming commits)
docs/
  why.md, setup.md, nixos-setup.md, architecture.md, decisions.md
flake.nix          Nix dev shell — node 22, packages sandbox-agent (transition only)
```

## License

MIT.
