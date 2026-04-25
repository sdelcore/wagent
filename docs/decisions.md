# Decisions

Log of key decisions, most recent first. Each entry: what was decided, what alternative was rejected, and the reason.

## 2026-04-16 — Adopt Rivet `sandbox-agent` as the daemon unchanged

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
- **Not automatic multi-agent orchestration.** One session = one agent. Parallel agents are the user's problem.
