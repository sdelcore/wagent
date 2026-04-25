# wagent — Research

A self-hosted control plane that exposes coding-agent harnesses (Claude Agent SDK first, others later) over the internet. Runs as a daemon on any number of personal PCs, manages any number of projects and sessions per PC, and serves a unified protocol that mobile clients (starting with an adaptation of [droidcode](https://github.com/sdelcore/droidcode)) can drive.

**Primary user:** the author, on his own machines, from his phone. Not a product. Not trying to grow an audience.

**Primary use case:** hands-off, mobile-first development while away from a desk — including starting new sessions remotely, switching between machines and projects, and occasionally using the agent to debug the host machine itself.

**Design stance:** optimizing for *right and future-proof*, not *easiest*. Willing to eat up-front complexity to avoid baking in decisions that will have to be torn out later.

---

## 1. Landscape

### 1.1 Official (Anthropic)

| Name | What it is | Notes |
|------|-----------|-------|
| **Claude Code Remote Control** (Feb 2026, research preview) | Built into the `claude` CLI. `claude remote-control` keeps a session running locally and bridges it to claude.ai/code, iOS, and Android via Anthropic's relay. Outbound HTTPS only, no inbound ports. | Free for Pro/Max/Team/Enterprise. API keys not supported. Closed protocol, all traffic through Anthropic. **Requires `claude` to already be running** — cannot start a session from your phone. Claude-only. |
| **Claude Agent SDK** (Python / TypeScript) | The official, supported way to embed Claude Code's agent loop in your own code. Renamed from "Claude Code SDK". | This is what wagent wraps. |
| **Hosting the Agent SDK** docs | Anthropic explicitly recommends running multiple agent processes in a container and exposing HTTP/WebSocket endpoints. | Blueprint we're following. |

### 1.2 Closest analog — Rivet `sandbox-agent`

[github.com/rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent) is the project most aligned with what we're building.

- Single Rust binary (~15MB, no runtime deps), runs inside a sandbox, exposes HTTP + SSE.
- One unified API across Claude Code, Codex, OpenCode, and Amp — the multi-harness story we want.
- Normalizes events into a consistent schema: `session.*`, `item.*`, `question.*`, `permission.*`.
- Designed for sandboxed deployment (Daytona, E2B, Vercel Sandboxes, Docker), not personal always-on PCs.

**Implication:** Rivet has already done the hard work of designing a harness-agnostic event schema. wagent should aim to be **wire-compatible** with it where practical, so tooling and clients from either side of that ecosystem interoperate. What wagent adds is a different *runtime target*: personal host, not cloud sandbox.

### 1.3 Self-hosted bridges & remote runners

| Project | Shape | What's interesting |
|---------|-------|--------------------|
| `willjackson/claude-code-bridge` | WebSocket bridge that lets local Claude Code do filesystem ops on remote machines. | Inverts the direction — local agent, remote files. |
| `ericvtheg/claude-code-runner` | Self-hosted remote prompting runner. Shares only OAuth creds with container. | Auth model worth studying. |
| `MatthewJamisonJS/claude-on-the-go` | WebSocket bridge: phone → Mac running `claude`. | Mobile-first UX. |
| `K9i-0/ccpocket` | Mobile client (Claude Code + Codex) over a WebSocket bridge. QR-code pairing. | Pairing flow. |
| `dzhng/claude-agent-server` | Runs Claude Agent in a sandbox, controlled via WebSocket. | Direct overlap. |
| `jackneil/Claude-websocket` | Web UI built on the reverse-engineered Claude Code WebSocket protocol (`--sdk-url` NDJSON). | Fragility signal — undocumented hidden flag. |
| `vultuk/claude-code-web` | Web UI for the CLI, multi-session, configurable auth tokens. | UI prior art. |
| `bfly123/claude_code_bridge` | Multi-AI collab: Claude + Codex + Gemini with shared context. | Multi-agent angle. |

### 1.4 SDK wrappers (adjacent)

- `RichardAtCT/claude-code-openai-wrapper` — exposes Claude Code as an OpenAI-compatible API.
- `cheolwanpark/claude-agent-toolkit` — Python framework, decorator-based tools, runtime isolation.
- `jamesrochabrun/ClaudeCodeSDK` — Swift wrapper over the Node SDK.
- `claude-runner` — 5-line TS wrapper over the official SDK.

These don't expose the agent over the internet; they make the SDK nicer to call locally. Useful for API-design inspiration.

---

## 2. Context — why wagent for me, specifically

- **New baby incoming.** I won't be at a desk for long stretches. "Hands-off mobile development" is a concrete need, not a cool idea.
- **I already have [droidcode](https://github.com/sdelcore/droidcode)** — a React Native client (Expo Router + Zustand + SQLite + SSE) with the right mental model: `/hosts → /projects → /sessions → /session-detail`. Currently OpenCode-specific. The client exists; what's missing is a harness-agnostic backend it can target across all my machines.
- **I want to cover multiple PCs, multiple projects per PC, multiple sessions per project, multiple harnesses.** Anthropic's Remote Control covers Claude-only, single-session, already-started-at-the-desk. That's not the shape of what I need.
- **I want to start sessions from my phone.** This is the single biggest concrete gap in every existing solution including Anthropic's.
- **I sometimes want the agent to touch the host directly** — e.g. diagnose why my desktop is acting up. Sandboxing has to be optional, not mandatory. That's the specific reason I can't just adopt Rivet wholesale.
- **I care about protecting external access, not about sandboxing for isolation.** Since the agent will have real host powers, the defense has to be at the network/auth/permission-prompt layer, done rigorously.
- **I'm optimizing for "right and future-proof," not "easiest."** I'd rather pay up front for a clean harness abstraction and a proper auth model than build a shortcut I have to tear out.

---

## 3. Architectural north star

The shape of the system wagent should grow into. Not everything here ships in v0; this is the target interfaces converge toward.

### 3.1 Event schema: Rivet-compatible

Adopt Rivet's event model (`session.*`, `item.*`, `question.*`, `permission.*`) as the wire format between daemon and client. Two reasons:

1. **Harness-agnostic by design.** The schema was built to normalize across Claude Code, Codex, OpenCode, Amp — exactly the set we care about.
2. **Free compatibility.** droidcode (or anything else) written against wagent can potentially target a Rivet daemon, and vice versa. The ecosystem, small as it is, stays unified rather than fragmenting.

Deviate from Rivet's schema only where personal-host needs require it (e.g. host-capability events, multi-machine discovery), and upstream the deltas as proposals rather than forks where feasible.

### 3.2 Execution modes: host-direct is first-class

Two peer execution modes, declared per session:

- **`exec_mode: host`** — agent runs in the daemon's own process context. Full filesystem, full shell, real `$HOME`. Use case: debugging the host, working on projects checked out in `~/src/*`, one-off system tasks.
- **`exec_mode: sandbox`** — agent runs in a container / namespace / chroot with a declared filesystem scope. Use case: running untrusted code, isolating experiments, working against an arbitrary git URL.

Both modes go through the same harness driver and emit the same event schema. The *only* difference the client sees is a capability declaration on the session.

### 3.3 Transport: outbound-only, two paths

No inbound listener on the host, ever. Two paths, both supported:

- **Tailscale / Cloudflare Tunnel / WireGuard** — mature, outbound-initiated, encrypted. This is the v0 path. The daemon binds to localhost; the tunnel handles reachability.
- **Outbound relay** (later) — the daemon dials out to a wagent relay service; clients dial the relay; relay stitches them together. Better UX (no VPN on the phone), more infra to run. Ship after v0 is stable.

On the wire: HTTP + SSE for event streams, plain HTTP for control. Follow Rivet's choice here. WebSocket adds bidirectionality we don't actually need — the client writes via POST, reads via SSE, and SSE survives more proxies.

### 3.4 Auth: per-device pairing, no shared tokens

- Each client device (phone, laptop, tablet) pairs with each host daemon **once**, producing a device-scoped keypair stored on both sides. mTLS or equivalent (signed JWTs tied to the device key) on every request.
- Pairing flow: host shows a QR code (one-time, short-TTL); client scans; mutual key exchange. Same UX as Tailscale / Syncthing.
- Revocation is per-device, from any paired device with admin scope.
- Audit log records every authenticated request with device ID.
- No shared bearer tokens. A leaked token is indistinguishable from a legitimate client; per-device keys make leaks attributable and revocable.
- Anthropic credentials (API key or OAuth) live only on the host, never transit the wire. Clients drive the agent; they never see the upstream auth.

### 3.5 Permission model: capability-scoped + tiered confirmation

- Every tool call becomes a `permission.requested` event. Clients approve / deny / allow-for-session.
- Sessions declare capabilities up front: filesystem scope (paths), network (on/off), shell (on/off/restricted), sudo (off by default, gated).
- "Dangerous tier" operations (writes outside project scope, anything as root, destructive shell ops, network egress to non-allowlisted hosts) require explicit mobile confirmation even inside an "allow-for-session" scope.
- Permission prompts fail **closed** on network drop — a mid-prompt disconnection denies the action, doesn't queue it.
- Every tool invocation is logged with enough detail to reconstruct after the fact (args, cwd, exit, stdout/stderr tail).

### 3.6 Harness abstraction: plugin from day one

A `Harness` interface with a small contract:

- `start_session(config) -> session_handle`
- `send_input(session, message)`
- `events(session) -> stream<Event>` (emits the normalized Rivet-compatible schema)
- `interrupt(session)`, `end_session(session)`
- `capabilities() -> {supports_images, supports_mcp, max_context, ...}`

v0 implements exactly one driver (Claude Agent SDK, Python or TS). But the interface is defined so the second driver is additive, not renovative. Drivers live in their own crates/modules with their own dependency trees — the Claude SDK does not get to bleed assumptions into the core.

### 3.7 Host model: daemons are first-class, not servers-as-afterthought

- Each host runs one `wagent` daemon. Multiple projects and sessions multiplex inside it.
- Hosts self-describe to paired clients: hostname, OS, accessible project roots, available harnesses, capabilities.
- A client sees the **union** of paired hosts and can cross-navigate: "sessions across all my hosts," "this project on desktop vs laptop," etc.
- No central coordinator. Hosts are peers from the client's perspective; the client library aggregates.

### 3.8 Non-goals (explicit)

Naming these so they don't creep in:

- **Not multi-tenant.** Single user, multiple devices. No user accounts, no orgs, no billing.
- **Not a hosted service.** No wagent-cloud. The optional outbound relay, when built, is self-hostable, not a SaaS.
- **Not a general sandbox platform.** Sandbox mode delegates to existing tech (Docker, bubblewrap) rather than reinventing.
- **Not an agent framework.** We drive harnesses, we don't replace them. No prompt engineering, no tool-definition layer above the harness.
- **Not a web UI** (for now). droidcode is the client. A minimal browser fallback is fine, but product-grade web UI is scope creep.

---

## 4. Design decisions (with leanings)

Open questions from the earlier draft, with the current leaning given §3.

| Question | Lean | Why |
|---|---|---|
| HTTP+SSE vs WebSocket | **HTTP + SSE** | Rivet-compatible, proxy-friendly, asymmetric traffic fits (client writes little, reads a lot). |
| Inbound vs outbound | **Outbound via Tailscale v0, relay later** | Zero inbound ports, no NAT story to solve. Relay adds UX polish once stable. |
| Auth | **Per-device keys + mTLS/JWT** | Attributable, revocable, no shared secrets. Higher up-front cost, correct long-term. |
| Anthropic creds | **Host-only, never on wire** | Clients control the agent; upstream auth stays on the host. |
| Permission prompts | **Events + tiered confirmation + fail-closed** | Network-first design; mobile UX has to handle drops gracefully. |
| Session persistence | **Resumable, durable log per session** | Reconnect should be boring. SQLite on the host for session state. |
| Sandboxing | **Optional, per-session, host-direct is first-class** | "Debug my PC" is a real use case; don't punish it with a sandbox tax. |
| Harness abstraction | **Plugin interface defined day one, one driver at v0** | The shape of the interface is the whole point. Don't bake Claude assumptions into it. |
| Host language | **Rust or Go (undecided)** | Single static binary, trivially deployable to every machine I own. TS/Python require runtime management per host. Rust matches Rivet; Go is faster to write. Decide when prototyping. |

---

## 5. Milestones

Scoped to reach "one-handed at 3am" usefulness fast, then harden.

1. **M1 — Single host, single harness, local network.** Daemon exposes HTTP+SSE, implements the Rivet-compatible event schema, drives one Claude Agent SDK session. Bearer token auth (device pairing comes in M3). Host-direct exec only.
2. **M2 — droidcode targets wagent.** Fork/branch droidcode; add wagent as a second "server type" alongside OpenCode. Validate the protocol against a real client. Expect to find gaps; this is where the schema gets its first stress test.
3. **M3 — Device pairing + Tailscale story.** Replace bearer tokens with per-device keypairs and QR-code pairing. Document the Tailscale/Cloudflare Tunnel setup. Now reachable from the phone over real internet.
4. **M4 — Permission events + mobile confirmation UX.** Every tool call surfaces as a permission event; droidcode gets an approval UI; dangerous-tier ops require explicit confirmation. Fail-closed semantics on network drop.
5. **M5 — Multi-host aggregation.** Daemon runs on desktop, laptop, home server. droidcode pairs with all of them, shows a unified sessions view. Start-new-session-from-phone works against any paired host.
6. **M6 — Second harness (OpenCode or Codex).** Validate that the plugin interface actually holds up. This is the load-bearing test of the whole architecture.
7. **M7 — Sandbox execution mode.** `exec_mode: sandbox` via Docker or bubblewrap, as a peer to host-direct. Capability declarations per session.
8. **M8 — Outbound relay (optional).** Replace Tailscale dependency with a self-hostable wagent relay for friends/family deployments if that ever becomes interesting.

v0 (useful for me) = M1–M4. Everything after is extension, not completion.

---

## 6. Critiques revisited

Re-scoring the earlier critical section now that the actual context is clear (personal use, droidcode exists, "right not easy," host-direct required).

### 6.1 "Anthropic Remote Control solves the 90% case" — **WEAKENED**

It's Claude-only, requires `claude` to already be running on the PC, and doesn't do multi-host navigation. For "start a session on my home desktop from my phone at the park," it literally does not work. The critique still applies to anyone whose use case *is* covered by Remote Control — but that's not this use case.

### 6.2 "Narrow 5-way wedge" — **IRRELEVANT**

Only mattered if we were chasing defensibility or market. Audience is 1. The wedge doesn't have to be defensible; it just has to be useful.

### 6.3 "Maintenance treadmill is brutal" — **STILL HOLDS, and worth mitigating deliberately**

This is the critique that should actually shape the plan, given a new baby. Mitigations baked into §3 and §5:

- One harness at v0. Multi-harness is M6, not M1. Don't pay that tax until there's demonstrated need.
- Plugin interface defined up front so harness drivers are isolated — a breaking change in the Claude SDK touches one file.
- Rivet-compatible schema means we borrow their normalization work instead of inventing our own.
- Avoid undocumented interfaces like `--sdk-url` entirely. Only use the Agent SDK's public API. If the public API is missing something, skip the feature rather than depend on internals.

### 6.4 "Security is genuinely hard" — **STRENGTHENED**

Host-direct execution (the whole point) removes sandboxing as a mitigation. Everything else has to be tighter:

- Per-device pairing, not shared tokens (§3.4).
- Outbound-only transport, never listen on an inbound port (§3.3).
- Tiered permission model with fail-closed semantics (§3.5).
- Scoped capabilities per session so "the agent can only touch `~/src/foo`" even when `exec_mode: host`.
- Audit log of every tool invocation.

This is non-trivial work. It's also non-negotiable — a leaked token on a shared-bearer system would be catastrophic given the blast radius. Pay the cost up front.

### 6.5 "Addressable audience is small" — **IRRELEVANT**

See 6.2.

### 6.6 "90% plumbing, 10% novel" — **WEAKENED**

droidcode is most of the plumbing (mobile UI, session state, SSE client, navigation model). The daemon side is also leaning on existing infrastructure (Tailscale for transport, SQLite for persistence, off-the-shelf HTTP+SSE stacks). The genuinely new work is the harness abstraction, the Rivet-compatible event emission, and the permission/auth model. That ratio is closer to 40% novel / 60% integration — tolerable.

### 6.7 New critique — "future-proof" is a seductive excuse not to ship

The failure mode of "optimizing for right" is indefinite deliberation on the interfaces while nothing runs. Counter-measures:

- M1 is deliberately narrow (one host, one harness, local network) so the schema gets validated by a real client (M2) before it calcifies.
- Every milestone produces something usable, not just a layer of abstraction.
- "Future-proof the interfaces, not the features." A clean harness plugin point is future-proof. A second harness at v0 is gold-plating.

### 6.8 Honest revised recommendation

Do it, but in this order:

1. **Spend half a day first** running Rivet's `sandbox-agent` binary on one desktop and pointing *something* at it. If it turns out to cover enough of the need that teaching droidcode to speak its protocol is all you actually want, you've saved yourself a project. (It probably won't, because of the sandbox-mandatory issue, but find out for sure.)
2. **If Rivet isn't enough, build M1–M4.** That's the "one-handed at 3am" MVP and the minimum useful personal tool.
3. **Stop there until usage reveals the next gap.** Don't build M5–M8 on speculation. Build them when you hit the specific pain they solve.

---

## 7. Build vs. adopt: is wagent justified over Rivet?

### 7.1 The case for "just use Rivet"

- Exists, funded team, already multi-harness, Apache 2.0.
- The binary runs on bare metal even though they say "dev only."
- You inherit future harness driver updates for free.
- Forking is less work than greenfield — in theory.

### 7.2 Actual differences

**Host-direct execution.** Rivet's security model is "the sandbox is the boundary." They don't need auth or permission prompts to be rigorous because a rogue agent just trashes a throwaway container. Host-direct breaks that assumption. But be honest: Rivet *could* add an unsandboxed mode. They might not want to, but it's not architecturally impossible — it's a policy decision, not a structural one. This is the strongest differentiator, but it's not as load-bearing as it first looks.

**Persistent daemon.** Rivet is ephemeral (start, use, stop). wagent wants always-on with session persistence across reconnects. This is a real difference but it's also just... a wrapper. You could run Rivet's binary inside a systemd service, add a SQLite layer for session state on top, and get most of the way there. Ugly, but feasible.

**Remote session start.** In Rivet's model something external creates the sandbox. In wagent's model the daemon is the orchestrator. Real difference, but again — a thin orchestration layer on top of Rivet could solve this. You'd be writing glue, not a new project.

**Multi-host.** Rivet is single-instance-scoped. Cross-host aggregation is a client-side concern though — droidcode could aggregate multiple Rivet instances without wagent existing at all.

**Security model.** Different threat model (network-layer vs sandbox-layer). Real, but only matters if you're actually doing host-direct. If you end up mostly using sandbox mode anyway, this collapses.

### 7.3 Counter-argument: the "thin glue" path

Here's what "just use Rivet" actually looks like in practice:

1. Run `sandbox-agent` on each PC via systemd.
2. Write a small orchestration shim that can start/stop Rivet sessions via its HTTP API.
3. Add session persistence (SQLite) in the shim.
4. Point droidcode at the shim.
5. Use Tailscale for connectivity.
6. For host-direct, just... run the agent outside Rivet (raw Claude Agent SDK call, same event schema).

That's maybe 2000 lines of glue code, not a new project. You get Rivet's harness drivers, event schema, and future updates for free. The glue handles orchestration, persistence, and host-direct as a separate path.

The downside: you're maintaining a shim that depends on Rivet's HTTP API staying stable, and the host-direct path is a completely separate code path that doesn't share anything with the sandboxed path except the event schema. Two systems duct-taped together.

### 7.4 Counter-counter-argument: when does "thin glue" become a project?

If the shim needs: auth, permission prompts for host-direct, session persistence, multi-host discovery, daemon lifecycle management, and a host-direct execution path that reimplements what Rivet does but without the sandbox — you've written most of wagent anyway, plus you have a Rivet dependency you don't control.

This is the honest tension. The "thin glue" path is cheaper at M1 but might cost more by M4 when you've accumulated enough glue that it's a project-sized shim that's harder to reason about than a clean build.

### 7.5 Where Nix fits

Nix is not the justification. The build-vs-adopt question stands with or without it.

On its own merits: Nix gives reproducible harness environments without Docker on bare metal. That's nice but not critical — you own 2-3 PCs and could just install Node and Go on them manually. The reproducibility argument is strongest at scale; at N=3 machines it's a convenience, not a necessity. bubblewrap gives you lightweight sandboxing without Docker, but only on Linux.

Nix is a good fit if you're already using it (you are). It's not a reason to build a project.

### 7.6 Verdict

Honestly uncertain. The "thin glue over Rivet" path is viable and cheaper short-term. The "clean build" path is cleaner long-term but is more work up front and you're a solo dev with a baby coming.

Recommended: try the glue path first. Run Rivet on one machine, write a minimal shim, point droidcode at it. If the glue stays thin, you saved yourself a project. If it grows into something ugly, you'll know exactly which parts need to be first-class and can build wagent with that knowledge instead of speculation.

The worst outcome is spending months on wagent and discovering that Rivet + 500 lines of glue would have been enough.

---

## 8. Potential differentiators — honest assessment

Research into actual pain points in the space. Scored by whether they're real value or wishful thinking.

### 8.1 Agent keeps working when phone disconnects — REAL

Anthropic Remote Control pauses when you disconnect. The session is live only while a client is attached. If your phone loses signal or you put it down for 20 minutes, the agent waits.

wagent's daemon model means the agent keeps running whether or not a client is connected. You reconnect and scroll back through what happened. For someone holding a baby who checks in sporadically, this is the single most valuable feature difference. It's also natural to the daemon architecture — not extra work.

Caveat: this only works for sessions that don't need frequent permission approvals. If the agent hits a permission prompt and no client is connected, it blocks (fail-closed). So this is most useful with scoped sessions where permissions are pre-approved for the project directory.

### 8.2 Session persistence and crash recovery — REAL

Rivet explicitly does not persist sessions. From their docs: events stream out and it's your job to store them in Postgres/ClickHouse/whatever. If the agent process crashes, the conversation history is gone.

Claude Code Remote Control: if your laptop sleeps, it reconnects, but if the `claude` process crashes, you're starting over.

wagent with SQLite-backed session state and event logs could offer: resume after crash, resume after daemon restart, resume after host reboot. For a long-running session on a personal PC that might get rebooted for updates, this matters.

Caveat: "resume" depends on the underlying harness supporting session resume. The Claude Agent SDK supports `session_id` for continuation. Other harnesses may not. The persistence layer is wagent's; the ability to actually resume depends on the harness.

### 8.3 Anthropic Remote Control is limited and janky — TEMPORARY

Real complaints from users:
- One session at a time.
- Disconnects frequently, requires manual restarts.
- Can't use `--dangerously-skip-permissions` — have to approve every action remotely.
- Subscription detection bugs blocking access.
- Scheduled tasks only run while computer is awake with app open.

These are real pain points *right now*. But it's a research preview from a funded company. They'll fix most of these. Don't build a project around complaints that'll be patched in 3 months. The structural limitations (Claude-only, can't start sessions remotely, closed protocol) are durable. The bugs aren't.

### 8.4 Cross-harness unified history — MAYBE

See all sessions across Claude, OpenCode, Codex in one timeline on your phone. Nobody does this because nobody runs multiple harnesses from a single control plane on personal PCs.

Sounds cool. Question: do you actually use multiple harnesses? Right now you use OpenCode. If you switch to Claude, will you really be running both simultaneously? If the answer is "honestly, probably just Claude for the next 6 months," this differentiator is speculative.

It becomes real if/when you're genuinely switching between harnesses per-project. Until then it's architecture for a future that might not arrive.

### 8.5 Cost/token observability — REAL but limited scope

Agents consume 3-10x more tokens than chatbots. Multi-model routing (Opus for planning, Sonnet for implementation, Haiku for file nav) can reportedly cut costs 60-80%.

wagent could track token usage per session, per project, per harness. Show cost trends on the phone. "This session cost $4.20 so far" is useful information when you're burning API credits.

But: actually *routing* between models requires intercepting the harness's API calls, which breaks the black-box plugin model. wagent can observe and report costs (if the harness exposes them via events), but it can't optimize them without becoming an inference layer. Keep this to observability, not optimization.

### 8.6 Audit trail for host-direct mode — TABLE STAKES, not differentiator

Every tool invocation logged with args, cwd, exit code, stdout/stderr tail. "What did the agent do to my machine while I was away?"

This is required for host-direct to be safe, not a selling point. But it's worth noting: nobody in the personal-PC space does this well. Rivet doesn't need to (sandbox boundary). Anthropic Remote Control doesn't expose it. If wagent has a clean, browsable audit log viewable from the phone, that's a quality-of-implementation advantage even if it's not architecturally novel.

### 8.7 Multi-agent orchestration — OUT OF SCOPE

Hot topic in 2026. Planner/worker/judge patterns, fleet coordination, parallel agents with separate worktrees. Interesting, but it's a different project. wagent manages sessions, not agent coordination. If you need multi-agent, use a dedicated orchestrator that talks to wagent's API. Don't absorb this.

### 8.8 Session adoption from existing instances — REAL

Inspired by [Happy Coder](https://happy.engineering/) (mobile Claude Code client). Happy wraps `claude` — you run `happy` instead. It doesn't attach to existing sessions.

But wagent could do something more useful. Claude stores all session data as `.jsonl` files in `~/.claude/projects/<encoded-cwd>/` with a `sessions-index.json` (summaries, timestamps, branch, message count). The Agent SDK supports resuming via `session_id`.

Concrete version:
- Daemon scans `~/.claude/projects/` on the host.
- Shows existing sessions in the mobile UI — including ones started via raw `claude` at the desk.
- User taps "adopt" — wagent starts a new Agent SDK process with that session ID, continuing the conversation.
- From that point, wagent manages it (persistence, disconnect-resilient, permissions).
- Not live-attaching to a running process. Starting a new process that picks up the conversation.

Why this matters: you don't have to commit to wagent from day one. Start at your desk with `claude`, walk away, pick it up from your phone. Low friction adoption path.

Caveats:
- Only works for Claude sessions (harness-specific, not generic). Other harnesses would need their own session discovery.
- The original `claude` process is unaware — if it's still running, you'd have two processes on the same session. wagent should check for running processes and warn.
- Resume depends on the session `.jsonl` being intact and the session being resumable (the SDK doesn't guarantee this for very old sessions).
- This is read-from-disk, not an API. If Claude changes its storage format, this breaks. It's the same fragility risk as `--sdk-url` — depending on undocumented internals.

Net: useful as a bridge feature, not as a core differentiator. Don't build the architecture around it.

### 8.9 Summary

| Differentiator | Value | Risk |
|---|---|---|
| Agent runs while disconnected | High | Only useful with pre-approved permissions |
| Session persistence / crash recovery | High | Depends on harness supporting resume |
| Session adoption from desk | Medium | Claude-specific, reads undocumented file format, bridge feature not core |
| Cross-harness unified history | Medium | Speculative until you actually use multiple harnesses |
| Cost/token observability | Medium | Read-only; can't optimize without breaking plugin model |
| Audit trail | Required | Table stakes for host-direct, not a differentiator |
| Remote Control bugs | Low | Temporary; don't build around patchable complaints |
| Multi-agent orchestration | None | Out of scope |

The two genuinely load-bearing differentiators are **agent-runs-while-disconnected** and **session persistence**. Both fall directly out of the daemon architecture — consequences of the core design, not extra features.

Session adoption is a nice bridge for getting started (low friction: start at desk, continue on phone) but depends on undocumented internals and only works for Claude. Don't build the architecture around it.

If disconnected-running and persistence aren't enough to justify the project, nothing else on this list saves it.

---

## 9. Still-open questions

- **Rust or Go for the daemon?** Both produce single static binaries. Rust matches Rivet (easier to study their code, potentially share crate-level abstractions). Go is faster to write and ships M1 sooner. Nix builds both well, so the Nix decision doesn't affect this. Probably decide after a one-day spike in each.
- **How close can we actually be to Rivet's wire schema?** Need to read their protocol spec carefully. Full compatibility is ideal; near-compatibility with documented deltas is acceptable; divergence is a last resort.
- **Which tunnel story to document first — Tailscale or Cloudflare Tunnel?** Both work. Tailscale is probably simpler for the "all my own machines" case; Cloudflare Tunnel is better if I ever want to let someone else connect. Start with Tailscale.
- **OAuth (plan auth) or API key for the Anthropic side?** API key is simpler and doesn't require the `claude` CLI installed. OAuth preserves plan quotas. Support both eventually; start with API key.
- **Where does droidcode fork/branch for wagent support?** Clean fork, feature branch, or plugin architecture inside droidcode? Leaning toward a clean abstraction in droidcode where "server type" is a first-class concept, with OpenCode and wagent as two implementations. Keeps one codebase.
- **How deep does Nix go?** Three levels of adoption, increasing commitment: (a) Nix flake for building/developing wagent itself (low risk, obvious win). (b) Nix flakes for harness environments — daemon spawns `nix develop` per project before starting harness (medium, big reproducibility gain). (c) Nix+bubblewrap as the sandbox backend for `exec_mode: sandbox` (higher, replaces Docker on Linux, needs Docker fallback on macOS). Could adopt incrementally: (a) at M1, (b) at M2, (c) at M7.

---

## Sources

- [Hosting the Agent SDK — Anthropic docs](https://platform.claude.com/docs/en/agent-sdk/hosting)
- [Securely deploying AI agents — Anthropic docs](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- [Agent SDK overview — Claude Code docs](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Code Remote Control — docs](https://code.claude.com/docs/en/remote-control)
- [Claude Code Remote Control — Simon Willison](https://simonwillison.net/2026/Feb/25/claude-code-remote-control/)
- [Rivet sandbox-agent — GitHub](https://github.com/rivet-dev/sandbox-agent)
- [Rivet sandbox-agent — launch post](https://www.rivet.dev/changelog/2026-01-28-sandbox-agent-sdk/)
- [Rivet sandbox-agent — InfoQ writeup](https://www.infoq.com/news/2026/02/rivet-agent-sandbox-sdk/)
- [droidcode — sdelcore](https://github.com/sdelcore/droidcode)
- [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper)
- [claude-code-bridge (willjackson)](https://github.com/willjackson/claude-code-bridge)
- [claude-code-runner (ericvtheg)](https://github.com/ericvtheg/claude-code-runner)
- [claude-on-the-go](https://github.com/MatthewJamisonJS/claude-on-the-go)
- [ccpocket](https://github.com/K9i-0/ccpocket)
- [claude-agent-server (dzhng)](https://github.com/dzhng/claude-agent-server)
- [Claude-websocket (jackneil)](https://github.com/jackneil/Claude-websocket)
- [claude-code-web (vultuk)](https://github.com/vultuk/claude-code-web)
- [claude_code_bridge (bfly123)](https://github.com/bfly123/claude_code_bridge)
- [claude-agent-toolkit (cheolwanpark)](https://github.com/cheolwanpark/claude-agent-toolkit)
- [ClaudeCodeSDK Swift (jamesrochabrun)](https://github.com/jamesrochabrun/ClaudeCodeSDK)
- [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)
- [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
