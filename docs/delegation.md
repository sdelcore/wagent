# Delegation

Cross-harness agent-to-agent delegation. A parent session spawns a
child session through a `delegate` MCP tool; wagent supervises both;
the child's final result returns to the parent through the harness's
normal tool-call channel.

A Claude parent can dispatch to a pi child (or another Claude child)
without either harness knowing the other exists. Wagent owns the
cross-harness boundary.

## Primitive

A wagent session can have a parent session. When a parent agent calls
`delegate(...)`:

1. Wagent creates a child session of any installed harness with a
   `parentSessionId` foreign key.
2. The supervisor spawns the child like any other session.
3. The child runs to completion (sync) or in the background.
4. Wagent returns the child's final assistant message to the parent
   as the `delegate` tool result.

Children are first-class wagent sessions — same `AgentProcess`
contract, same event store, same SSE stream. Clients render them as
independent sessions linked by `parentSessionId`.

## Data model

Three columns on `sessions` carry the relationship:

| column              | type             | notes                                              |
|---------------------|------------------|----------------------------------------------------|
| `parentSessionId`   | TEXT NULL        | references `sessions(id)`. NULL for top-level.     |
| `parentToolCallId`  | TEXT NULL        | the parent's `tool_use` id that spawned the child. |
| `delegationDepth`   | INTEGER NOT NULL | 0 for top-level. Capped at 3.                      |
| `delegationMode`    | TEXT NULL        | `'sync'` or `'background'`.                        |

No new tables, no `SessionUpdate` schema changes — the parent's
`tool_call` / `tool_call_update` events already carry everything a
client needs to render a tree.

## delegate-MCP server

Wagent mounts a single MCP HTTP endpoint inside its own Fastify
server at `/mcp/delegate/:parentSessionId`. Harnesses connect to it
over loopback. No subprocess, no env-var token leakage.

- `src/routes/delegate_mcp.ts` — Fastify route implementing MCP
  Streamable-HTTP via `@modelcontextprotocol/sdk`. Handlers call
  `sessionStore`, `supervisor`, and `eventStore` directly.
- Per-spawn auth: when the supervisor spawns a parent harness, it
  mints a token bound to `(parentSessionId, depth)` and stores it
  in `DelegateTokenStore`. The MCP endpoint accepts only this token
  in `Authorization: Bearer …`, **bypassing the global `WAGENT_TOKEN`
  gate**. Loopback-only (rejects non-127.x source IPs).
- `src/agent/claude_sdk.ts` injects the server config into the
  Claude SDK via `mcpServers: { 'wagent-delegate': { type: 'http',
  url, headers: { authorization: 'Bearer <token>' } } }`.
- `src/agent/pi_sdk.ts` skips injection — pi has no native MCP
  support. Pi-as-child works fine; pi-as-parent is not supported
  (would need a pi extension or a `wagent-delegate` CLI exposed as
  a pi skill).

A leaked delegate token can only spawn children of one specific
parent, only from the same host.

## Tool contract

```ts
delegate({
  harness: 'claude' | 'pi' | 'echo',
  cwd?: string,                   // defaults to parent.cwd
  model?: string,
  prompt: string,                 // the only payload to the child
  mode: 'sync' | 'background',    // default 'sync'
  scope?: { paths?: string[]; network?: boolean; shell?: boolean },
  maxTurns?: number,
  options?: SessionOptions,       // per-child persona / tools / MCP / mode
}) → {
  childSessionId: string,
  status: 'completed' | 'running' | 'failed',
  result?: string,                // sync mode only
  error?: string,
}
```

- **Sync** — tool blocks until the child stops; returns the child's
  final assistant message as `result`.
- **Background** — returns immediately with
  `{ childSessionId, status: 'running' }`. Parent uses
  `delegate_status(id)` to poll, `delegate_cancel(id)` to abort.
- **`options`** — same shape, same validator, and same per-adapter
  forwarding rules as `POST /v1/sessions { options }`. See the
  *Per-session options* table in [architecture.md](./architecture.md#per-session-options).
  Useful when the parent wants to enforce a specific persona on the
  child (e.g. a tool allowlist, replacement system prompt, or a
  per-child MCP server set) without round-tripping through the
  session-create endpoint. Validation errors surface as
  `{ status: 'failed', error: 'delegate: options.<field> ...' }`,
  same `invalid_options` codes as the route layer.

The parent's own context only ever receives the final summary string
(or `running`). Child transcript streaming back into parent context
is intentionally not the default — token cost, fidelity loss, and the
child's full event stream is already visible to the client over its
own SSE subscription.

## Permissions and scope

- `delegate` is itself a tool call, so it goes through wagent's
  existing permission flow. One client prompt per delegation.
- The child session has its own independent permission stream.
  Clients should group prompts by `sessionId`, not by "currently
  visible session."
- Scope inheritance: child's declared `scope` must be a **subset** of
  parent's. Wagent enforces this server-side.

## Lifecycle

| event                          | behavior                                                           |
|--------------------------------|--------------------------------------------------------------------|
| Parent prompt cancelled        | Wagent cancels in-flight sync `delegate` calls; children get `cancel()`. |
| Parent session destroyed       | Cascade-destroy descendants.                                       |
| Child crashes                  | `delegate` tool result is `{ status: 'failed', error }`.           |
| Parent process crashes mid-sync| Child orphaned-but-running; `closeAll()` on shutdown still cleans it. |
| Depth cap exceeded             | `delegate` returns `{ status: 'failed', error: 'depth_cap_exceeded' }`. |

## API surface

- `POST /v1/sessions` accepts optional
  `{ parentSessionId, parentToolCallId, delegationMode }`. Parent
  must exist and not be destroyed; child's `delegationDepth` =
  parent's + 1, capped at 3.
- `GET /v1/sessions?parentSessionId=X` — list children of a session.
- `GET /v1/sessions/:id/descendants[?include=descendants_cost]` —
  full subtree. With `descendants_cost`, returns a token-cost rollup
  and `reportingSessionCount` so callers can tell partial coverage
  from zero (claude emits `usage_update`; pi/echo don't yet).
- `POST /v1/sessions/:id/fork { agent, model?, mode? }` — cross-
  harness context handoff. Creates a new session of the requested
  harness, linked via `parentSessionId`, seeded with a textual
  summary or transcript of the parent's events. Lossy by design —
  see [architecture.md](./architecture.md#forking). Children created
  this way show up in `descendants` like any other.
- `POST /mcp/delegate/:parentSessionId` (and GET) — MCP
  Streamable-HTTP endpoint. Auth: bearer = delegate token.
  Loopback-only.
