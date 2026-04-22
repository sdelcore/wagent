# wagent

Self-hosted, mobile-first control for coding agents across multiple personal PCs.

## What this is

A setup for running coding agents (Claude Code, OpenCode, Codex, Amp) on one or more of your own machines and controlling them from a phone, tablet, or laptop over the internet.

Not a product. Not multi-tenant. One user, many devices.

## How it works

- **Each PC** runs [Rivet `sandbox-agent`](https://github.com/rivet-dev/sandbox-agent) as a systemd user service. It spawns and manages agent subprocesses, exposes HTTP + SSE, and normalizes events across harnesses.
- **Each client** (phone, laptop) runs a PWA that uses the `sandbox-agent` TypeScript SDK directly. IndexedDB for session persistence. Aggregates multiple hosts into one view.
- **Connectivity** is Tailscale. No inbound ports, no custom relay.
- **Environments** are reproducible via Nix flakes per host and per project.

The daemon is unmodified Rivet. We don't build or fork it. The PWA (a transition target for [droidcode](https://github.com/sdelcore/droidcode)) is the only thing we build.

## Why

- Mobile development while away from a desk.
- Start agent sessions remotely, not just resume them.
- Multiple PCs, multiple projects, multiple harnesses — one control plane.
- Agent keeps working when the phone disconnects.
- Host-direct execution so the agent can actually debug the machine it's running on.

See [docs/why.md](./docs/why.md) for the full motivation.

## Status

Pre-v0. This repo currently contains:

- `flake.nix` — Nix dev shell (Node 22)
- `src/test.ts` — smoke test using the Rivet TS SDK in embedded mode
- `docs/` — architecture, setup, decisions
- `docs/droidcode-migration.md` — guide for adapting droidcode to use the Rivet SDK instead of the OpenCode API

Client PWA is not yet written. Starting point is the existing [droidcode](https://github.com/sdelcore/droidcode) React Native app, which will migrate to Next.js + Tauri per droidcode's own migration plan.

## Quick start

```bash
cd ~/src/wagent
direnv allow
npm install
npm test    # runs src/test.ts against Claude
```

Requires `ANTHROPIC_API_KEY` or a logged-in Claude install at `~/.claude/.credentials.json`.

Full host setup: [docs/setup.md](./docs/setup.md).
