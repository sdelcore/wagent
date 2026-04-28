# Codebase orientation

For an AI agent working in this repo. Pairs with `docs/architecture.md`
(the user-facing version of the same picture).

## What this is

wagent is a single Node + TypeScript daemon (`src/server.ts`) that
runs coding-agent harnesses on a host and exposes them over HTTP+SSE.
One process per host, SQLite for state, no IPC, no extra services.

Three harnesses ship: `echo` (built-in stub), `claude`
(`@anthropic-ai/claude-agent-sdk` — in-process, SDK shells out to
the `claude` CLI), and `pi` (`@mariozechner/pi-coding-agent` — fully
in-process).

## Where things live

```
src/
  server.ts         Fastify entry — routes, lifecycle, factory wiring
  config.ts         env parsing
  types.ts          STABLE v1 wire contract — touch with care
  db.ts             better-sqlite3 + schema migrations
  bus.ts            per-session in-memory pubsub
  agent/
    process.ts      AgentProcess interface + AgentSpawnDeps + AgentFactory
    supervisor.ts   owns one AgentProcess per session, lazy spawn, markDead
    echo.ts         stub agent
    claude_sdk.ts   Claude SDK adapter + translateClaudeMessage (pure)
    pi_sdk.ts       pi SDK adapter + translatePiEvent (pure)
    availability.ts probeClaude / probePi for GET /v1/agents
    delegate_tokens.ts  per-spawn bearer tokens for the delegate-MCP route
  events/store.ts   append-only event log with FK cascade on session delete
  sessions/store.ts session CRUD + delegation cols
  projects/store.ts project upsert
  routes/           sessions, events, prompts, projects, agents, fs,
                    delegate_mcp
scripts/
  smoke.ts                  one-turn echo smoke
  test-api.ts               full v1 API e2e (CLAUDE_E2E=1 also exercises claude)
  pi-sdk.test.ts            translatePiEvent unit tests
  claude-sdk.test.ts        translateClaudeMessage unit tests
```

## The interface seam

All harness work goes through one shape (`src/agent/process.ts`):

```ts
interface AgentProcess {
  prompt(content: ContentBlock[]): Promise<void>
  cancel(): Promise<void>
  respondPermission(requestId: string, outcome: PermissionOutcome): Promise<void>
  setModel?(model: string): Promise<void>
  close(): Promise<void>
}
```

Adapters emit `SessionUpdate` events to `deps.emit`. The supervisor
wires `emit` to SQLite append + bus broadcast — adapters never touch
either directly. If a harness dies unexpectedly, adapters call
`deps.markDead(reason)` so the next prompt respawns cleanly.

## Pure translation helpers

Both SDK adapters split into two pieces:

- A pure function that takes a vendor event and a small mutable
  state object, returns wagent `SessionUpdate`(s):
  - `translateClaudeMessage(msg, state)` — `src/agent/claude_sdk.ts`
  - `translatePiEvent(event, state)` — `src/agent/pi_sdk.ts`
- A thin class around the SDK that owns I/O (subscriptions, prompt
  queue, abort) and calls the pure function.

The pure functions are unit-tested with synthetic events
(`scripts/{pi,claude}-sdk.test.ts`). When fixing event-translation
bugs, write the test first against the synthetic payload, then fix
the function — no real harness or API key required.

## Wire contract

`src/types.ts` is the v1 wire contract. Clients mirror these types
directly. Touching `SessionUpdateKind`, `Session` fields, or
`PermissionOutcome` is a breaking wire change — don't do it without
explicit instruction.

`SessionUpdate` is `{ kind, …variant }` — the variant payload is
intentionally weakly typed (`[key: string]: unknown`) so adapters can
add fields without churning the type. Document the per-kind shape in
the relevant adapter's translation function.

## Tests

```bash
npm run typecheck         # tsc --noEmit
npm run test:unit         # pi-sdk + claude-sdk pure-function tests
npm test                  # unit + full v1 API suite (echo path)
CLAUDE_E2E=1 npm test     # also drive a real claude session
npm run smoke             # minimal echo end-to-end against a temp DB
```

CI runs typecheck + build + unit + API + smoke on every PR. All five
must be green to merge.

## Conventions

- Match the existing style. Two-space indent, single quotes, no
  semicolons (TypeScript). Prettier is implicit; no formatter config
  ships with the repo.
- Don't add comments that just describe what the code does. Reserve
  comments for non-obvious *why* — a hidden constraint, a workaround
  for a specific upstream bug, or a subtle invariant.
- No backwards-compat shims for code we own. If you change something,
  delete the old version. The wire contract is the boundary; behind
  it, tear up and replace.
- Don't introduce new abstractions without two concrete consumers
  already needing them.
- New deps are a real cost — prefer using stdlib or what's already in
  the tree. Native modules in particular need a Nix-rebuild (the
  flake's `npmDeps` hash regenerates from `lib.fakeHash`).

## Git workflow

- Never commit on `main`. Branch with a short kebab-case name.
- One feature per branch; one focused commit per branch (squash on
  merge). PR body explains the *why*.
- After landing, `git pull origin main` before starting the next
  branch.
- The flake only sees git-tracked files — `git add` new files before
  `nix build` or anything that touches the flake.

## NixOS quirks

The Claude SDK shells out to a `claude` binary. The bundled native
module prefers the musl variant on Linux; on NixOS that misses
glibc. `availability.probeClaude` and `claude_sdk.ts` both honor
`CLAUDE_CODE_EXECUTABLE` (auto-detected via `which claude` if unset)
to redirect to a working binary.

`better-sqlite3` is rebuilt from source against `nodejs_22`'s exact
V8 headers in the flake (`npm rebuild --build-from-source` with
`npm_config_nodedir`). If you bump the Node version, `flake.nix`
needs to follow.
