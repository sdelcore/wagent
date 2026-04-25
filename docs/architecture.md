# Architecture

## Current shape

```
┌─────────────────────┐
│   PWA (client)      │   Runs in browser on phone/laptop/tablet
│  - droidcode-PWA    │   Uses Rivet TS SDK directly
│  - IndexedDB persist│   Aggregates N hosts
└──────────┬──────────┘
           │  HTTP + SSE over Tailscale
           │
  ┌────────┴────────┐  ┌────────────────┐  ┌────────────────┐
  │  Host A (PC)    │  │  Host B (PC)   │  │  Host C (PC)   │
  │ sandbox-agent   │  │ sandbox-agent  │  │ sandbox-agent  │
  │ (systemd)       │  │ (systemd)      │  │ (systemd)      │
  │                 │  │                │  │                │
  │ spawns:         │  │                │  │                │
  │  claude, codex, │  │                │  │                │
  │  opencode ...   │  │                │  │                │
  └─────────────────┘  └────────────────┘  └────────────────┘
```

## Components

### Host daemon — Rivet `sandbox-agent` (unmodified)

Runs as a systemd user service on each PC. Exposes HTTP + SSE on localhost. Reachable from other devices over Tailscale.

- Spawns agent subprocesses (Claude, Codex, OpenCode, Amp) on demand.
- Normalizes events into a universal schema (`session.*`, `item.*`, `question.*`, `permission.*`).
- Handles ACP protocol translation per agent.
- No sandbox is imposed — when run on bare metal without a container, agents have host access (that's the point).

We do not modify or fork Rivet. We deploy it.

### Client — PWA using Rivet TS SDK

Successor to the React Native droidcode. Runs in the browser.

- Imports the `sandbox-agent` npm package in the browser.
- Connects to each host via `SandboxAgent.connect({ baseUrl })`.
- Uses the SDK's built-in IndexedDB `SessionPersistDriver` for client-side persistence.
- Aggregates sessions across hosts — the multi-host navigation lives here, not in the daemon.

The PWA is the only piece we actually build. Even then, it's adapting existing droidcode code.

### Connectivity — Tailscale

Each host and client is on the tailnet. The daemon binds to its Tailscale IP; the PWA connects directly. No inbound port forwarding, no relay server, no NAT traversal to solve.

### Nix — environment layer on each host

Each host has a Nix flake to pin:

- The sandbox-agent binary version.
- Agent runtimes (Node for Claude-ACP, etc.).
- Per-project `flake.nix` files the daemon activates before spawning an agent.

Optional but recommended. Without it, reproducibility across machines is manual.

## What we're not building

- **A custom daemon.** Rivet covers it.
- **A universal harness abstraction.** Rivet covers it.
- **A wire protocol.** Rivet's event schema is adopted as-is.
- **A persistence layer on the server.** SDK handles it client-side.
- **Auth and session orchestration.** Rivet's bearer-token auth + the TS SDK's session lifecycle is sufficient for personal use.
- **A native mobile app.** PWA is good enough and cross-platform.

## Data flow — creating a new session from the phone

1. PWA calls `sdk.createSession({ agent: "claude", cwd: "/home/me/src/project" })` against Host A.
2. Rivet on Host A spawns the Claude ACP agent process in that directory.
3. Event stream (SSE) flows back to the PWA.
4. PWA stores events in IndexedDB as they arrive.
5. Phone locks, network drops — agent keeps running on Host A.
6. Phone unlocks, PWA reconnects with the last-seen event offset.
7. Missed events flush in; live stream resumes.

## Data flow — permission prompt

1. Claude needs to run a shell command.
2. Rivet emits `permission.requested` event.
3. PWA renders an approval dialog.
4. User taps "allow once" / "allow always" / "reject".
5. PWA calls `session.respondPermission(id, reply)`.
6. Rivet forwards the decision to the agent.

Fail-closed semantics: if the PWA is not connected when a permission is requested, the agent blocks until it reconnects. No silent auto-approval on disconnect.

## What crashes look like

**Daemon restart (Rivet restarts, e.g. OS update):**
- In-flight agent conversations lose their live context window.
- PWA's IndexedDB retains all historical events.
- SDK's `resumeSession()` replays the last ~50 events as context into a fresh agent session.
- Lossy — the agent doesn't remember everything, but it has recent context.

**Client disconnect (phone offline):**
- Agent keeps running on the host.
- PWA reconnects with event offset, gets missed events.
- No state loss.

**Host reboot:**
- Same as daemon restart but worse — any pending tool operations in flight die.
- Recovery same as above: replay recent events into a new session.

## Open problems

- **True session resume.** The Claude Agent SDK supports `--resume <session-id>` with full conversation state. Rivet's restoration is replay-based. Gap: can Rivet pass a resume ID through to the underlying agent? Unknown. If not, full-state resume requires bypassing Rivet, which introduces a parallel code path.

- **OAuth TOS clarity.** Anthropic's policy language on OAuth tokens being "Claude Code only" is ambiguous when using Rivet (which actually launches the Claude binary). Using an API key avoids the question; using OAuth is practically safe but legally unclear.

- **Session adoption from `~/.claude/projects/`.** If sessions started via raw `claude` at the desk can be picked up from the phone, that's valuable. Requires reading Claude's on-disk session format (undocumented, fragile).
