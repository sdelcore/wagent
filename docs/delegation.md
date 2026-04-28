# Delegation

Cross-harness agent-to-agent delegation. A parent session spawns a child
session through a `delegate` tool; wagent supervises both; the child's
final result returns to the parent through the harness's normal
tool-call channel.

## Goal

One primitive that lets a Claude parent dispatch to a pi child (or vice
versa, eventually), without either harness knowing the other exists.
Wagent owns the cross-harness boundary; the agent only sees a tool.

## The primitive

A wagent session can have a parent session. When a parent agent calls
`delegate(...)`:

1. Wagent creates a child session (any harness) with a `parentSessionId`
   foreign key.
2. The supervisor spawns the child like any other session.
3. The child runs to completion (or in the background).
4. Wagent returns the child's final assistant message to the parent as
   the `delegate` tool result.

Children are first-class wagent sessions: same `AgentProcess` contract,
same event store, same SSE stream. Droidcode shows them as independent
sessions linked by `parentSessionId`.

## Data model

Three new columns on `sessions`:

| column                | type             | notes                                                           |
|-----------------------|------------------|-----------------------------------------------------------------|
| `parentSessionId`     | TEXT NULL        | references `sessions(id)`. Null for top-level.                  |
| `parentToolCallId`    | TEXT NULL        | the parent's tool_use id that spawned this child.               |
| `delegationDepth`     | INTEGER NOT NULL | 0 for top-level. Cap = 3.                                       |

No new tables. No `SessionUpdate` schema changes — parent's
`tool_call` / `tool_call_update` events already carry everything
droidcode needs to render a tree.

## The delegate-MCP server

Each harness (Claude via ACP, pi via RPC, OpenCode via ACP later)
consumes tools through MCP. Wagent mounts a single MCP HTTP endpoint
inside its own Fastify server; harnesses connect to it over loopback.
No subprocess, no env-var token leakage.

Implementation:

- `src/routes/delegate_mcp.ts` — Fastify route mounting an MCP server
  at `/mcp/delegate/:parentSessionId`. Implements MCP Streamable-HTTP
  via `@modelcontextprotocol/sdk`. Handlers call `sessionStore`,
  `supervisor`, and `eventStore` directly (in-process).
- Per-spawn auth: when the supervisor spawns a parent harness, it
  mints a token bound to `(parentSessionId, depth)` and stores it in
  an in-memory `DelegateTokenStore`. The MCP endpoint accepts only
  this token in the `Authorization: Bearer ...` header, **bypassing
  the global `WAGENT_TOKEN` gate** for this path. Loopback-only
  (reject non-127.x source IPs).
- Each factory injects an HTTP-MCP server config:
  - `claude_sdk.ts` — passes `mcpServers: { 'wagent-delegate': {
    type: 'http', url, headers: { authorization: 'Bearer <token>' } } }`
    directly to `query({ options })`. The Claude Agent SDK forwards
    HTTP MCP server configs to the underlying claude binary unchanged.
  - `pi_sdk.ts` — **deferred**. Pi has no native MCP support
    ([pi README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md):
    "No MCP. Build CLI tools with READMEs"). Pi-as-parent would need
    either a pi extension that bridges MCP, or a `wagent-delegate`
    CLI exposed as a pi skill. Pi-as-child is unaffected and works
    today.
  - `echo.ts` — skip.

Token blast radius is bounded by URL path + bearer + loopback: a leaked
token can only spawn children of one specific parent, only from
processes on the same host.

## delegate tool contract

```ts
delegate({
  harness: 'claude' | 'pi' | 'echo',
  cwd?: string,                  // defaults to parent.cwd
  model?: string,
  prompt: string,                // the only payload to the child
  mode: 'sync' | 'background',   // default 'sync'
  scope?: { paths?: string[]; network?: boolean; shell?: boolean },
  maxTurns?: number,
}) → {
  childSessionId: string,
  status: 'completed' | 'running' | 'failed',
  result?: string,               // sync mode only
  error?: string,
}
```

- **Sync** (default, ship first): tool blocks until child stops; returns
  the child's final assistant message as `result`. Mirrors Claude Agent
  SDK's native subagent semantics.
- **Background** (Phase 2): returns immediately with
  `{ childSessionId, status: 'running' }`. Parent uses
  `delegate_status(id)` to poll, `delegate_cancel(id)` to abort.

The parent's own context only ever receives the final summary string
(or `running`). Streaming child transcript chunks back into parent
context is **not** the default — token cost, fidelity loss, and the
child's full event stream is already visible in droidcode. Opt-in
streaming (as `tool_call_update.partialResult` on the parent) is a
later add if a use case demands it.

## Permissions and scope

- `delegate` is itself a tool call, so it goes through wagent's existing
  permission flow. One mobile prompt per delegation.
- The child session has its own independent permission stream. Mobile
  UI must group prompts by `sessionId` (not by "currently visible
  session"). This is a constraint on droidcode, not wagent.
- Scope inheritance: child's declared `scope` must be a **subset** of
  parent's. Wagent enforces server-side. A leaked delegate token can
  only spawn at depth+1 within parent's scope.
- Tier: spawning a child is "medium" (one approval). Child tool calls
  are individually tiered as today.

## Lifecycle

| event                          | behaviour                                                           |
|--------------------------------|---------------------------------------------------------------------|
| Parent prompt cancelled        | Wagent cancels in-flight sync `delegate` calls; children get `cancel()`. |
| Parent session destroyed       | Cascade-destroy descendants. (No "detach background child" in v0.)  |
| Child crashes                  | `delegate` tool result is `{ status: 'failed', error }`.            |
| Parent process crashes mid-sync| Child orphaned-but-running; `closeAll()` on shutdown still cleans it. |
| Depth cap exceeded             | `delegate` returns `{ status: 'failed', error: 'depth_cap_exceeded' }`. |

## API surface (Phase 1)

- `POST /v1/sessions` accepts optional
  `{ parentSessionId, parentToolCallId, delegationMode }`. Parent must
  exist and not be destroyed; child's `delegationDepth` = parent's + 1;
  capped at 3. Same auth as the rest of the API (so tests on loopback
  work without delegate-token plumbing).
- `GET /v1/sessions?parentSessionId=X` — list children of a session.
- `POST /mcp/delegate/:parentSessionId` (and GET) — MCP Streamable-HTTP
  endpoint. Auth: bearer = delegate token. Loopback-only.
- Existing routes unchanged.

Phase 2 adds:

- `GET /v1/sessions/:id/descendants` — full subtree.
- `GET /v1/sessions/:id?include=descendants_cost` — read-time rollup
  of token cost across the subtree.

## Phasing

**Phase 1.** `delegate` (sync only), Claude-as-parent + any-harness-as-child.
~300 lines:

- Migration: three new columns on `sessions`.
- `src/agent/delegate_mcp.ts` — stdio MCP binary.
- Wire injection into `claude_sdk.ts` (`mcpServers` arg in query options).
- Routes: `POST /v1/sessions` accepts parent fields; `GET /v1/sessions`
  filters by `parentSessionId`.
- Depth cap, scope subset enforcement.
- Tests: parent → child happy path, depth cap, scope rejection, cascade
  destroy.

**Phase 2.** Background mode, `delegate_status` / `delegate_cancel`.
Pi-as-parent deferred (pi has no native MCP — needs a skill or
extension shim, scoped separately).

**Phase 3.** Cost rollup, descendants endpoint. Optional partial-result
streaming back into parent context is deferred until a use case demands
it. Pi/echo don't emit usage events yet; rollup reports
`reportingSessionCount` separately from `totalSessionCount` so callers
can tell partial coverage from zero.

## Open questions deferred to Phase 2+

- Does droidcode need a tree view, or does flat-list-with-parent-link
  cover the mobile UX? Answer after Phase 1 + droidcode wiring.
- Do we want a "background child outlives parent" mode? Defer until a
  use case forces it (long-running migration child surviving an
  interrupted parent prompt).

## Decisions this updates

Logged as a deliberate update in [`decisions.md` (2026-04-26)](./decisions.md):

- The 2026-04-16 non-goal "Not automatic multi-agent orchestration. One
  session = one agent. Parallel agents are the user's problem." still
  holds for *automatic* orchestration (wagent doesn't decide).
  Agent-initiated delegation is now first-class; parallel children via
  background mode are no longer "the user's problem."
- `architecture.md`'s "Multiple agents in one session" non-goal is
  unchanged — one session is still one harness. Sessions can now be
  linked parent → child.
- `architecture.md`'s "MCP server orchestration. Agents pick it up
  from their own configs." is narrowed: user-supplied MCP config still
  comes from the agent's own config, but wagent injects exactly one
  MCP server (`wagent-delegate`) into every spawned harness so the
  agent can call `delegate(...)`.

## Status

- **Phase 1 — sync delegation, Claude-as-parent.** Shipped. Data model,
  `delegate` MCP tool (sync), claude-acp wiring, route updates,
  cascade-destroy, depth cap, scope-by-cwd, tests.
- **Phase 2 — background mode, status/cancel.** Shipped. `delegate`
  with `mode:'background'`, `delegate_status`, `delegate_cancel`.
  Pi-as-parent deferred — pi has no native MCP; needs a pi extension or
  a `wagent-delegate` CLI exposed as a pi skill.
- **Phase 3 — descendants endpoint, cost rollup.** Shipped.
  `GET /v1/sessions/:id/descendants`, `?include=descendants_cost`,
  `usage_update` event kind. claude-acp emits usage; pi/echo don't yet
  (rollup reports `reportingSessionCount` separately so callers can
  tell partial coverage from zero).
