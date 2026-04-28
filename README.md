# wagent

Self-hosted daemon that runs coding agents on a host and exposes them over
HTTP+SSE so any client (web, CLI, mobile) can drive them remotely.

Not a product. Not multi-tenant. One user, many devices.

## What it is

A small Node + TypeScript service that:

- Drives coding-agent harnesses on the host
  (Claude via [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
  as a child subprocess; pi in-process via the
  [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
  SDK).
- Speaks JSON over HTTP for control + Server-Sent Events for streaming.
- Persists sessions and event history in SQLite so reconnecting clients
  don't lose state.
- Handles permissions, cancellation, and per-session model switching.
- Lets a parent agent dispatch focused subtasks to a child session of
  any installed harness (`delegate` tool over loopback MCP). Sync or
  background, depth-capped, cascade-destroyed. See
  [docs/delegation.md](./docs/delegation.md).
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

**v0.1 — feature-complete for solo use.** Sessions, events with SSE,
prompts, cancel, permissions, projects, cross-harness delegation.
Adapters for `echo` (stub), `claude-agent-acp`, and the in-process pi
SDK. Smoke test runs end-to-end.

| | |
|---|---|
| Sessions CRUD | `203289d` |
| Events log + SSE | `7e90a93` |
| AgentProcess + echo + prompts | `24e1dc0` |
| claude-agent-acp adapter | `a6d8ca0` |
| pi --mode rpc adapter | `74fbd24` |
| Projects CRUD | `987a24d` |
| Delegation (`delegate` MCP tool) | unreleased |
| pi SDK adapter (in-process, replaces RPC) | unreleased |

Of droidcode's 20 documented Rivet workarounds, **17 are eliminated by
wagent's design**, 3 are n/a (client-side concerns or features wagent
doesn't ship). See [docs/limitations-tracker.md](./docs/limitations-tracker.md)
for the full table.

## Quick start

```bash
cd ~/src/wagent
direnv allow            # nix flake → node 22 (sandbox-agent dep stays in PATH during transition)
npm install
npm run dev             # tsx watch, Fastify on :2468
```

Then:

```bash
curl http://localhost:2468/v1/health
curl http://localhost:2468/v1/meta

# create a session
SID=$(curl -s -X POST http://localhost:2468/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"echo","cwd":"/tmp"}' | jq -r .id)

# subscribe to events (separate terminal)
curl -N http://localhost:2468/v1/sessions/$SID/events/stream

# send a prompt
curl -X POST http://localhost:2468/v1/sessions/$SID/message \
  -H 'content-type: application/json' \
  -d '{"content":[{"type":"text","text":"hi"}]}'

# abort an in-flight turn
curl -X POST http://localhost:2468/v1/sessions/$SID/abort
```

## Smoke test

```bash
npm run smoke                      # echo only — no external deps required
SMOKE_AGENTS=echo,claude npm run smoke   # also exercise claude-agent-acp
                                          # (needs ANTHROPIC_API_KEY or `claude /login`)
SMOKE_AGENTS=echo,pi npm run smoke        # also exercise pi (needs `pi` on PATH)
```

Boots the server in-process with a temp SQLite, creates a session per
agent, opens an SSE stream, sends a prompt, asserts a `stop` event
arrives with monotonic event indices.

## Deployment (NixOS)

Add the flake input and enable the module — Nix builds wagent for you,
hosts run no `npm install`.

```nix
# In your flake.nix:
inputs.wagent.url = "github:sdelcore/wagent";

# In your NixOS config:
imports = [ inputs.wagent.nixosModules.default ];

services.wagent = {
  enable = true;
  host = "0.0.0.0";              # or "127.0.0.1" for loopback only
  port = 2468;
  cors = "https://droidcode.example.ts.net";
  openFirewall = true;
  environmentFile = "/run/agenix/wagent.env";  # WAGENT_TOKEN, ANTHROPIC_API_KEY
};
```

That's it. `nixos-rebuild switch` builds wagent (Node + better-sqlite3
compiled from source against the host's exact V8 headers via
`npm_config_nodedir`), then the systemd service comes up.

To run wagent ad-hoc on a NixOS box without enabling the service:

```
nix run github:sdelcore/wagent
```

## Deployment (non-NixOS)

```bash
nix run github:sdelcore/wagent#wagent
```

If you don't have Nix, install via `npm pack` tarball:

```bash
# On a build host:
git clone https://github.com/sdelcore/wagent && cd wagent
npm ci && npm run build && npm pack

# On the target host:
mkdir -p ~/.local/share/wagent && cd ~/.local/share/wagent
npm install /path/to/wagent-0.1.0.tgz
```

Then write a systemd user unit:

```ini
# ~/.config/systemd/user/wagent.service
[Unit]
Description=wagent
After=network.target

[Service]
ExecStart=%h/.local/share/wagent/node_modules/.bin/wagent
Restart=on-failure
Environment=WAGENT_HOST=127.0.0.1
Environment=WAGENT_PORT=2468

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now wagent
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
  bus.ts           per-session in-memory pubsub
  types.ts         wire types (stable v1)
  agent/           AgentProcess interface, factories, supervisor, delegate tokens
  events/          event store
  projects/        project store
  routes/          HTTP routes (sessions, events, prompts, projects,
                   agents, fs, delegate_mcp)
  sessions/        session store
docs/
  why.md, setup.md, nixos-setup.md, architecture.md, decisions.md,
  delegation.md, droidcode-migration.md, limitations-tracker.md
flake.nix          Nix dev shell — node 22
```

## License

MIT.
