# Decisions

Log of key decisions, most recent first. Each entry: what was decided, what alternative was rejected, and the reason.

## 2026-04-28 — Drop ACP, drive Claude in-process via the Claude Agent SDK

**Decision:** Replace the `claude-agent-acp` translator subprocess
with the official `@anthropic-ai/claude-agent-sdk`, called in-process
via `query({ prompt, options })`. Adapter file renamed
`src/agent/claude_acp.ts` → `src/agent/claude_sdk.ts`. ACP package
deps (`@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp`)
removed. Wire contract is unchanged.

**Rejected:**
- Keep ACP as a portable wire. We already deferred multi-agent
  support beyond Claude + pi (2026-04-25), so the portability
  premium ACP charges (an extra subprocess, an extra protocol layer,
  permission option-id table juggling) wasn't earning its keep.
- V2 SDK (`unstable_v2_createSession`). Multi-turn state is cleaner
  than the streaming-input pattern, but the API is marked `@alpha`
  and subject to change. Revisit when stable.

**Reason:** Concrete reductions in wagent's surface area:
- 1 subprocess instead of 2 (ACP translator → claude CLI). The
  Claude SDK still shells out to the `claude` binary, but the SDK
  manages it for us.
- ACP option-id mapping (`allow_once` / `allow_always` / `reject_*` →
  per-server option strings) collapses to a `canUseTool` callback
  that returns `{behavior: 'allow' | 'deny'}` directly.
- `unstable_setSessionModel` reflection gone; `model` is a typed
  option in the SDK (with the caveat that V1 streaming-input mode
  doesn't hot-swap mid-conversation — model changes apply on
  next session spawn, same as before).
- MCP injection becomes a typed config object (`mcpServers: {
  'wagent-delegate': { type: 'http', url, headers } }`) instead of
  ACP's `newSession({ mcpServers: [...] })` array.

**Implication:**
- `availability.probeClaude` now probes the `claude` binary on PATH
  (the SDK still depends on it). NixOS musl workaround moves from
  the spawn-args (`CLAUDE_CODE_EXECUTABLE` env var) to the SDK's
  typed `pathToClaudeCodeExecutable` option, with the same env-var
  fallback.
- Multi-turn state persists across `prompt()` calls via a
  streaming-input `AsyncIterable<SDKUserMessage>` pushed into
  `query()` once per session — the underlying `claude` process stays
  alive between turns, matching the previous ACP-era behavior.
- Permission outcomes `allow_once` and `allow_always` both map to
  `{behavior: 'allow'}` for now. The SDK's `updatedPermissions`
  affordance for "allow always" persistence is not wired through —
  v0.1 doesn't persist permission rules across sessions.
- `subprocess_died` events are still emitted for claude when the
  pump throws. The wire kind is unchanged; the underlying signal
  is now "SDK iterator threw" rather than "ACP child exited".

## 2026-04-28 — Drop `pi --mode rpc` subprocess, drive pi in-process via its SDK

**Decision:** Replace the `pi --mode rpc` child-process adapter with
an in-process driver built on `@mariozechner/pi-coding-agent`'s
`createAgentSession()` API. Pi is now a library dependency, not a
PATH binary. Adapter file renamed `src/agent/pi_rpc.ts` →
`src/agent/pi_sdk.ts`. Wire contract is unchanged.

**Rejected:**
- Keep the RPC subprocess and add a thin wrapper. Doesn't earn its
  keep — the JSONL framing, hand-rolled LF-only line splitter
  (because `readline` mishandles U+2028 inside JSON), request/response
  demuxer, and exit handler all exist solely to traverse a process
  boundary that has no security or isolation value here.
- Wait for an ACP adapter on the pi side. ACP would re-add the
  process hop without addressing the actual problem; pi's maintainer
  isn't planning ACP support.

**Reason:** ~150 lines of subprocess plumbing collapse to ~50 lines
of `session.subscribe(...)` event translation. The SDK exposes a
typed event union (`AgentEvent`) that maps 1:1 onto wagent's
`SessionUpdate` types we already emit, so the migration was a literal
event-name rename. Permission flow is unchanged (pi's coding agent
still runs without permission gating). Auth flow is unchanged
(SDK reads the same `~/.pi/agent/auth.json` the `pi` CLI writes).

**Implication:**
- Hosts no longer need `pi` installed; the SDK ships with wagent.
- `availability.probePi` now checks for the npm package under
  `node_modules/`, mirroring how `probeClaude` does it for
  `@agentclientprotocol/claude-agent-acp`.
- `subprocess_died` is no longer emitted for pi (no subprocess to
  die). Prompt errors flow through `stop` with `reason: 'error'`.
  Wire-stable: the event kind still exists for the claude adapter.
- The same pattern applies to claude. A follow-up PR will replace
  the `claude-agent-acp` translator with `@anthropic-ai/claude-agent-sdk`,
  collapsing the 2-process chain (translator → claude binary) to 1
  (claude binary, managed by SDK).

## 2026-04-26 — Cross-harness delegation as a wagent primitive

**Decision:** Add a single `delegate(harness, prompt, ...)` MCP tool
that lets a parent agent spawn a child wagent session of any installed
harness, supervised by wagent. Sessions gain `parent_session_id`,
`parent_tool_call_id`, `delegation_depth` (capped at 3), and
`delegation_mode` ('sync' | 'background'). Wagent injects a single
`wagent-delegate` HTTP MCP server into each spawned harness;
loopback-only, per-spawn bearer token, bypasses `WAGENT_TOKEN`. See
[delegation.md](./delegation.md).

**Rejected:**
- Stdio MCP subprocess per harness (more moving parts, env-var token
  leakage to harness env).
- Pure pass-through to Claude SDK's native `agents:` (intra-harness
  only — can't have a Claude parent dispatch to a pi child).
- Composio-style fleet of parallel worktrees (different problem;
  doesn't fit the "one user, one phone" UX).

**Reason:** Multi-harness was always the architectural promise of the
plugin abstraction (`AgentFactory`). Without delegation, that
abstraction is unexercised — each session is a silo. The HTTP MCP
endpoint is in-process, ~300 lines of new code, reuses existing
supervisor/event/permission flows, and validates the cross-harness
contract before a second harness driver lands.

**Implication / supersedes:**
- 2026-04-16 "Not automatic multi-agent orchestration. One session =
  one agent" — still holds for *automatic* (wagent doesn't decide).
  Reversed for *agent-initiated* delegation: one session is still
  one harness, but sessions can now be linked parent → child, and
  parallel children (background mode) are first-class.
- The architecture.md "MCP server orchestration. Agents pick it up
  from their own configs." — narrowed: user-configured MCP still
  comes from the agent's own config, but wagent injects exactly one
  server (`wagent-delegate`) into every spawned harness.

## 2026-04-25 — Reverse 2026-04-16: build wagent as our own daemon, drop Rivet

**Decision:** Build wagent as a Node + TypeScript daemon (Fastify, better-sqlite3, child-process supervision) that exposes coding agents over HTTP+SSE. Spawn `claude-agent-acp` (Claude) and `pi --mode rpc` (pi) as long-lived per-session subprocesses. Stable v1 wire contract, bearer-token auth, single-binary-feel deployment.

**Rejected:** The 2026-04-16 plan to deploy Rivet `sandbox-agent` unmodified.

**Reason:** Months of integrating with Rivet from droidcode produced a 20-row [SDK_LIMITATIONS](https://github.com/sdelcore/droidcode/blob/main/docs/SDK_LIMITATIONS.md) doc. Five parallel research agents pressure-tested the choices and found that ~17 of the 20 are structural Rivet design choices, not bugs: client-side session persistence, soft delete, no real interrupt primitive, "resume" that re-spawns the subprocess and re-primes via a JSON replay prefix, silent SSE stalls on mobile, etc. A fork doesn't fix them without a rewrite, and Rivet's roadmap is on cloud-sandbox providers (E2B, Daytona, Modal), not the personal-PC always-on use case wagent targets.

We already build a companion service in droidcode that does session listing, event mirroring, and projects — half the daemon's job. Owning the rest is cheaper than maintaining the workaround surface forever.

**Implication:**
- droidcode will eventually swap its `sandbox-agent` SDK use for a thin HTTP+SSE client against wagent. That work is separate (in droidcode's repo).
- Multi-agent support narrows to **Claude + pi**. No Codex, OpenCode, or Amp adapters in v1.
- The earlier Rust + learning-curriculum direction is also shelved (kept locally on the unpushed `rust-rewrite` branch). v1 ships in Node for speed.

## 2026-04-16 — Adopt Rivet `sandbox-agent` as the daemon unchanged

> **Superseded 2026-04-25.** Original entry kept for context.

**Decision:** Use Rivet's sandbox-agent binary as the host-side daemon. Do not fork, do not wrap, do not modify.

**Rejected:** Build a custom daemon ("wagent") from scratch with its own harness abstraction, event schema, and wire protocol.

**Reason:** Rivet already solves multi-harness orchestration, event normalization, and HTTP/SSE transport. The TypeScript SDK already handles session persistence (SQLite/IndexedDB), session restoration, reconnect-with-offset, permission events, and session listing. The remaining gaps (personal-PC deployment, systemd lifecycle, Tailscale connectivity) are configuration, not code. A custom daemon would be ~80% re-implementation of what Rivet does and 20% novel.

## 2026-04-16 — Client is a PWA, not React Native

**Decision:** Transition the mobile client from React Native (droidcode) to a PWA. Use the Rivet TS SDK in the browser.

**Rejected:** Keep droidcode on React Native and build an adapter layer to speak to Rivet.

**Reason:** The Rivet TS SDK works in browsers and includes a built-in IndexedDB persistence driver. Running the SDK directly eliminates an entire adapter layer. PWA also solves the "cross-platform" concern without maintaining a native build pipeline. Cost: loss of some native capabilities (push notifications are the notable one — solvable via web push).

## 2026-04-16 — Host-direct execution as first-class, sandbox as optional

**Decision:** Run sandbox-agent on bare metal (no container). Agents have full host access.

**Rejected:** Run sandbox-agent inside Docker/Podman for isolation.

**Reason:** The "debug my PC" use case requires the agent to touch the actual host (systemd services, network config, etc.). Sandboxing breaks that. For projects that benefit from isolation (running untrusted code, experimenting), per-session `exec_mode: sandbox` via bubblewrap or Docker can be added later. Host-direct is the default.

**Implication:** Blast radius protection shifts to the auth/permission layer. Tailscale handles network auth; Rivet's permission events handle per-action confirmation; API keys scope credential exposure.

## 2026-04-16 — Tailscale for transport, no custom relay

**Decision:** Use Tailscale (or equivalent — Cloudflare Tunnel, WireGuard) for connectivity. Daemon binds outbound-only semantics via the tailnet.

**Rejected:** Build a self-hosted outbound relay service that daemons dial out to and clients connect through.

**Reason:** Tailscale solves the same problem (NAT traversal, zero inbound ports, encrypted transport, per-device auth via ACLs) without us running infrastructure. A custom relay only makes sense if we want non-Tailscale users, which is not a personal-use requirement.

## 2026-04-16 — No custom auth layer

**Decision:** Rely on Tailscale ACLs for network-layer auth. Use Rivet's built-in bearer token as defense-in-depth. Don't build per-device key pairing.

**Rejected:** Build mTLS/JWT per-device pairing with QR-code-based provisioning.

**Reason:** Tailscale already provides per-device network auth, attributable and revocable. Adding another layer for "personal use on my own devices" is gold-plating. Revisit if the threat model changes (e.g. sharing with others).

## 2026-04-16 — Nix for environment management

**Decision:** Use Nix flakes (per-host for the daemon + per-project for agent environments). Adopt incrementally — flake for this repo at v0, per-project flakes when reproducibility pain surfaces.

**Rejected:** Rely on system-installed Node/Go/Python. Rejected: Docker for per-project isolation.

**Reason:** Already using Nix everywhere. Flakes give reproducible dependency graphs across multiple PCs without manual installs. Docker adds a daemon (`dockerd`) running 24/7 we don't want. Nix + bubblewrap is the right combination for bare-metal personal PCs where we want reproducibility *and* optional lightweight sandboxing.

## 2026-04-16 — Explicit non-goals

Recording these so scope creep has something to push against:

- **Not multi-tenant.** Single user, multiple devices.
- **Not hosted.** No wagent-cloud.
- **Not a harness framework.** We drive existing harnesses (Claude, OpenCode, Codex). We don't build another one.
- **Not a web UI replacement for Claude Code.** The PWA is a remote control, not a full IDE.
- **Not automatic multi-agent orchestration.** One session = one harness. Wagent doesn't decide when to spawn sub-agents — agents do, via the `delegate` tool. (Updated 2026-04-26: the original "parallel agents are the user's problem" no longer holds; cross-harness delegation is now a first-class primitive. See [delegation.md](./delegation.md).)
