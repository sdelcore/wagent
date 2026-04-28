# Codebase orientation

For an AI agent working in this repo. Pairs with
[docs/architecture.md](./docs/architecture.md) (system shape, wire
contract, lifecycle) — read that first if you don't already have the
big picture.

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

Adapters emit `SessionUpdate` events via `deps.emit`. The supervisor
wires `emit` to SQLite append + bus broadcast — adapters never touch
either directly. If a harness dies unexpectedly, adapters call
`deps.markDead(reason)` so the next prompt respawns cleanly.

The three live adapters: `src/agent/echo.ts` (built-in stub),
`src/agent/claude_sdk.ts` (Claude Agent SDK, in-process; SDK shells
out to `claude` CLI), `src/agent/pi_sdk.ts` (pi-coding-agent SDK,
fully in-process).

## Pure translation helpers

Both SDK adapters split into two pieces:

- A pure function that takes a vendor event and a small mutable
  state object, returns wagent `SessionUpdate`(s):
  - `translateClaudeMessage(msg, state)` — `src/agent/claude_sdk.ts`
  - `translatePiEvent(event, state)` — `src/agent/pi_sdk.ts`
- A thin class around the SDK that owns I/O (subscriptions, prompt
  queue, abort) and calls the pure function.

When fixing event-translation bugs: write the failing test against a
synthetic payload in `scripts/{pi,claude}-sdk.test.ts`, then fix the
function. No real harness or API key required.

## Wire contract

`src/types.ts` is the v1 wire contract. Clients mirror it directly.
Touching `SessionUpdateKind`, `Session` fields, or `PermissionOutcome`
is a breaking wire change — don't do it without explicit instruction.

`SessionUpdate` is `{ kind, …variant }` — the variant payload is
intentionally weakly typed (`[key: string]: unknown`) so adapters can
add fields without churning the type. The per-kind shape lives next
to the translation function in the relevant adapter.

## Tests

```bash
npm run typecheck         # tsc --noEmit
npm run test:unit         # pure-function tests for both adapters
npm test                  # unit + full v1 API suite (echo path)
CLAUDE_E2E=1 npm test     # also drive a real claude session
npm run smoke             # minimal echo end-to-end against a temp DB
```

CI runs typecheck + build + unit + API + smoke on every PR. All five
must be green to merge.

## Conventions

- Match the existing style. Two-space indent, single quotes, no
  semicolons.
- Don't add comments that just describe what the code does. Reserve
  comments for non-obvious *why* — a hidden constraint, a workaround
  for a specific upstream bug, or a subtle invariant.
- No backwards-compat shims for code we own. If you change something,
  delete the old version. The wire contract is the boundary; behind
  it, tear up and replace.
- Don't introduce new abstractions without two concrete consumers
  already needing them.
- New deps are a real cost. Native modules in particular need a Nix
  rebuild (regenerate the flake's `npmDeps` hash via `lib.fakeHash`,
  capture the value from the build error).

## Git workflow

- Never commit on `main`. Branch with a short kebab-case name.
- One feature per branch; squash on merge. PR body explains the *why*.
- After landing, `git pull origin main` before starting the next
  branch.
- The flake only sees git-tracked files — `git add` new files before
  `nix build` or anything that touches the flake.

## NixOS quirks

Claude Code's bundled launcher prefers the musl native binary, which
fails on glibc-only distros. `availability.probeClaude` and
`claude_sdk.ts` both honor `CLAUDE_CODE_EXECUTABLE` (auto-detected
via `which claude` if unset) to redirect to a working binary.

`better-sqlite3` is rebuilt from source against `nodejs_22`'s exact
V8 headers in the flake (`npm rebuild --build-from-source` with
`npm_config_nodedir`). If you bump the Node version, `flake.nix`
needs to follow.
