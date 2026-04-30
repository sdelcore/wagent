# Architecture

wagent is a single Node + TypeScript process per host. It exposes
coding-agent harnesses (Claude, pi, echo) over HTTP+SSE. Sessions
and events live in SQLite.

## Shape

```
┌─────────────────────────────┐
│  Client(s)                  │   droidcode, CLI scripts. None are
│  - HTTP + SSE               │   special-cased — the wire is the
│  - Bearer-token auth        │   contract.
└────────────┬────────────────┘
             │
             │  HTTP + SSE  (Tailscale, LAN, or loopback)
             │
┌────────────┴────────────────────────────────────────────────┐
│  wagent (one process per host)                              │
├─────────────────────────────────────────────────────────────┤
│  Fastify HTTP routes                                        │
│    GET    /v1/health[?deep=1]                               │
│    GET    /v1/meta                                          │
│    GET    /v1/agents                                        │
│    GET    /v1/sessions[?destroyed=true&parentSessionId=…]   │
│    POST   /v1/sessions                                      │
│    GET    /v1/sessions/:id                                  │
│    PATCH  /v1/sessions/:id           (alias, model)         │
│    DELETE /v1/sessions/:id           (FK-cascades events)   │
│    GET    /v1/sessions/:id/events    (paged JSON history)   │
│    GET    /v1/sessions/:id/events/stream  (SSE)             │
│    GET    /v1/sessions/:id/descendants                      │
│    POST   /v1/sessions/:id/fork      (cross-harness handoff) │
│    POST   /v1/sessions/:id/message                          │
│    POST   /v1/sessions/:id/abort                            │
│    POST   /v1/sessions/:id/permissions/:requestId           │
│    GET    /v1/projects                                      │
│    POST   /v1/projects                (upsert)              │
│    DELETE /v1/projects?directory=...                        │
│    GET    /v1/fs/entries?path=...                           │
│    POST   /mcp/delegate/:parentSessionId  (loopback)        │
│    GET    /mcp/delegate/:parentSessionId  (loopback)        │
├─────────────────────────────────────────────────────────────┤
│  Agent supervisor                                           │
│    interface AgentProcess                                   │
│      prompt / cancel / events / respondPermission / close   │
│    impls:                                                   │
│      EchoAgent   — built-in stub                            │
│      ClaudeSdk   — @anthropic-ai/claude-agent-sdk           │
│      PiSdk       — @mariozechner/pi-coding-agent            │
├─────────────────────────────────────────────────────────────┤
│  Event normalizer                                           │
│    Each adapter emits one internal SessionUpdate shape.     │
│    Vendor envelopes do not leak past this layer.            │
├─────────────────────────────────────────────────────────────┤
│  Persistence (better-sqlite3)                               │
│    sessions, events (append-only), projects.                │
│    WAL, foreign keys ON, single writer.                     │
├─────────────────────────────────────────────────────────────┤
│  Per-session broadcaster                                    │
│    in-memory pub/sub. SSE handlers subscribe; reconnects    │
│    replay from SQLite via `Last-Event-ID`.                  │
└─────────────────────────────────────────────────────────────┘

       on the same host:
       ┌──────────────────────┐    ┌──────────────────────┐
       │ `claude` CLI         │    │ pi AgentSession      │
       │ (managed by SDK,     │    │ (in-process,         │
       │  per session)        │    │  per session)        │
       └──────────────────────┘    └──────────────────────┘
```

## Health

`GET /v1/health` is shallow by default — it returns `{"status":"ok"}` as
soon as Fastify has accepted the request, with no agent or DB probe.
Pass `?deep=1` to run a one-shot **echo** round-trip (spawn the
in-process `EchoAgent`, send a trivial prompt, wait for the `stop`
event) before responding; this verifies the supervisor's factory
wiring is reachable end-to-end without persisting a session row or
events. The deep probe runs synchronously per request, has a 2s
budget, and returns `503` with `{ status: "fail", deep: { stage,
error, durationMs } }` on timeout or spawn failure. Use the deep mode
as a `systemd` `After=` gate for downstream services that need wagent
genuinely ready, not just listening.

## Wire

External (client ↔ wagent):

- HTTP+JSON for the control plane.
- SSE for events. Each event carries an `id:` (monotonic per-session
  index) and a typed `event:` name. Reconnects send `Last-Event-ID: N`
  and the server replays from N+1 via SQLite. A `: keep-alive`
  comment ships every 15s.

```
event: session_update
id: 42
data: {"kind":"agent_message_chunk","sessionId":"...","eventIndex":42,
       "createdAt":1776889000000,"payload":{...}}
```

`kind` is one of: `agent_message_chunk`, `agent_thought_chunk`,
`tool_call`, `tool_call_update`, `plan`, `user_message_chunk`,
`permission_request`, `permission_resolved`, `stop`,
`subprocess_died`, `session_destroyed`, `usage_update`, `error`.
Stable v1 contract — see `src/types.ts`.

Permission outcomes: `allow_always` / `allow_once` / `reject`.

`error` events carry a typed classification so callers can branch
without string-matching adapter stderr. Payload:

```ts
{
  kind: 'error',
  category: 'rate_limit' | 'auth' | 'quota' | 'upstream_5xx' | 'transport' | 'internal',
  retryable: boolean,
  retryAfterMs?: number,
  message: string,
}
```

`error` is informational — it sits next to the terminal event
(`stop` / `subprocess_died`), it does not replace it. Adapters
classify what they can confidently recognise and default to
`internal`. The claude adapter maps the SDK's typed
`SDKAssistantMessageError` enum (`rate_limit`, `authentication_failed`,
`billing_error`, `server_error`, …) and reads `retry-after` headers
from any thrown HTTP error. The pi adapter classifies on
best-effort string match against `errorMessage`; everything else
is `internal`. echo never emits `error`.

Internal (wagent ↔ harness):

- **Claude** — `@anthropic-ai/claude-agent-sdk`'s `query({ prompt, options })`,
  in-process. The SDK manages the `claude` CLI child. By default every
  tool call routes through wagent's `canUseTool` callback and surfaces
  as a `permission_request` event that the caller must resolve — i.e.
  the SDK's `--permission-mode bypassPermissions` short-circuit is
  *not* enabled by default, so wagent owns the permission round-trip.
  Callers that enforce policy upstream can opt out per session via
  `options.permissionMode: 'bypass'` (see "Per-session options" below),
  which hands the SDK `bypassPermissions` and skips the gate. MCP
  servers are passed in `options.mcpServers`: the per-spawn
  `wagent-delegate` server plus any caller-supplied servers from
  `POST /v1/sessions { options: { mcpServers } }`.
- **Pi** — `@mariozechner/pi-coding-agent`'s `createAgentSession()`,
  fully in-process. Events arrive via `session.subscribe(...)` and
  prompts through `session.prompt(...)`. Pi runs without a permission
  gate, so it never emits `permission_request` events regardless of
  `options.permissionMode`.

Both adapters translate vendor events into the same `SessionUpdate`
shape (see `translateClaudeMessage` / `translatePiEvent`), so routes
only ever see wagent's wire types.

## Session lifecycle

1. Client `POST /v1/sessions { agent, cwd, model?, options? }`.
2. wagent allocates an id, persists a row, returns it.
3. Client `POST /v1/sessions/:id/message`. Supervisor lazily spawns
   the underlying harness on first prompt and subscribes to its
   events. The persisted `options` are forwarded into the harness at
   spawn time — see "Per-session options" below.
4. Harness emits events → normalizer → SQLite append + broadcast →
   SSE consumers see them live.
5. Client disconnects: harness **stays alive**. SQLite keeps the event
   log. New connection picks up via `Last-Event-ID`.
6. `POST /v1/sessions/:id/abort` interrupts the current turn.
7. `DELETE /v1/sessions/:id` ends and removes the session
   (FK-cascades events; cascade-destroys delegation descendants).

## Per-session options

`POST /v1/sessions` accepts an optional `options` object that mirrors
the Claude Agent SDK's `query({ options })` shape. It's persisted on
the session row and forwarded into the underlying harness at spawn
time:

```ts
options?: {
  systemPrompt?: string         // replaces the harness's default prompt
  appendSystemPrompt?: string   // layered onto the harness's default
  allowedTools?: string[]       // auto-allow list (NOT a hard restriction)
  disallowedTools?: string[]    // hard deny — survives bypassPermissions
  tools?:                       // base built-in set; [] strips all built-ins
    | string[]
    | { type: 'preset'; preset: 'claude_code' }
  mcpServers?: Record<string, McpServerSpec>  // per-session MCP servers
  permissionMode?:              // gate every tool call, or bypass entirely
    | 'default'
    | 'ask'
    | 'bypass'
  resume?: string               // resume an existing Claude Code transcript
  forkSession?: boolean         // fork the resumed transcript instead of appending
}

// McpServerSpec mirrors the Claude Agent SDK's serializable shape:
type McpServerSpec =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse';  url: string; headers?: Record<string, string> }
```

Validation: each field passes through if provided, is omitted cleanly
if not — wagent does not synthesize defaults. Unknown fields,
non-string / non-array shapes, or an unknown `permissionMode` value
are rejected with `400 invalid_options`. The reserved server name
`wagent-delegate` cannot be used as a key in `mcpServers` — it's
owned by wagent's per-spawn delegation channel and collisions return
`400 invalid_options`.

Per-adapter behavior:

| field | claude | pi | echo |
|---|---|---|---|
| `systemPrompt` | passes through to `query({ options: { systemPrompt } })` (replaces preset) | applied via a `DefaultResourceLoader` with `systemPrompt` set (replaces pi's preset) | ignored |
| `appendSystemPrompt` | wrapped as `{ type: 'preset', preset: 'claude_code', append }` | wrapped as `[appendSystemPrompt]` and passed to `DefaultResourceLoader.appendSystemPrompt` | ignored |
| `allowedTools` | passes straight through to `query({ options: { allowedTools } })`. Note: this is an *auto-allow* list, not a hard restriction — `permissionMode: 'bypass'` relaxes its enforcement. Use `disallowedTools` or `tools` for hard restrictions. | passes through to `createAgentSession({ tools })` | ignored |
| `disallowedTools` | passes straight through to `query({ options: { disallowedTools } })`. Hard filter — listed tools are removed from the model's context entirely, even under `permissionMode: 'bypass'`. Useful when a parent (e.g. ARIA's orchestrator) needs to forbid the SDK's native `Task` / `Agent` so the model is forced into `mcp__wagent-delegate__delegate`. | ignored with a warn log — pi-coding-agent has no equivalent | ignored |
| `tools` | passes straight through. `[]` strips every built-in (Read/Edit/Bash/Agent/...); `{ type: 'preset', preset: 'claude_code' }` opts back into the full default set; an explicit `string[]` declares the base built-ins. Combine with `mcpServers` for routing-only personas that should only reach MCP tools. | ignored | ignored |
| `mcpServers` | merged into `query({ options: { mcpServers } })` alongside the per-spawn `wagent-delegate` server | ignored with a warn log — pi-coding-agent has no per-session MCP plumbing | ignored |
| `permissionMode` | `'bypass'` → SDK `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, no `canUseTool`. `'default'` / `'ask'` / unset keep wagent's `canUseTool` gate. | ignored (pi has no gate) | ignored |
| `resume` | passes straight through to `query({ options: { resume } })` — the SDK loads `~/.claude/projects/<encoded cwd>/<uuid>.jsonl` and the wagent session continues from that transcript. The wagent session's `cwd` must match the cwd of the original CLI invocation, otherwise the SDK can't locate the file. | ignored (pi has no transcript-resume primitive) | ignored |
| `forkSession` | passes through to `query({ options: { forkSession } })` alongside `resume`. When true, the SDK forks the resumed transcript to a new session id rather than appending to the original CLI session's JSONL. The route layer rejects `forkSession: true` without `resume`. | ignored | ignored |

`permissionMode` defaults to `'default'` (wagent-managed gate) when
omitted — `'default'` and `'ask'` are aliases for that baseline, so
every tool call surfaces as a `permission_request` event that callers
resolve via `POST /v1/sessions/:id/permissions/:requestId`. Set
`'bypass'` only when an upstream caller (e.g. ARIA) is enforcing
tool-use policy itself; tool calls then run without a wagent
round-trip and no `permission_request` events are emitted for that
session.

If both `systemPrompt` and `appendSystemPrompt` are set, the
replacement wins and the append is dropped with a warning log.
Future option fields not natively supported by an adapter are
ignored at that adapter only — the wire shape is the same for all
agents.

## Forking

`POST /v1/sessions/:id/fork { agent, model?, mode?: "summary" | "transcript" }`

Creates a new session of the requested harness, linked to the parent
via `parentSessionId`, and seeds its first user message with context
derived from the parent's events. Use this for failover (claude → pi
when claude is rate-limited) or "switch model mid-conversation"
without re-creating from scratch.

- **`summary`** (default) — interleaved user + assistant text plus
  one-line summaries of each tool call (`[used <name> (<status>)
  with input <…>: <result snippet>]`). Tool inputs and outputs are
  truncated to a bounded budget per item; the seed is conversational
  context, not a wire replay.
- **`transcript`** — verbatim concatenation of assistant text only.
  No tool calls, no user text. Useful when the new harness can't
  sensibly run prior tool history.

Lossy by design: events do not replay, only context. The fork is a
real session with its own event stream; the parent's event log is
left intact.

The new session is queryable through `GET /v1/sessions/:id/descendants`
on the parent — same machinery delegated children use. Depth cap
applies (`MAX_DELEGATION_DEPTH`). `delegationMode` is `null` on a
fork: that field is for the delegate-MCP wait semantics, which a
fork doesn't have.

If you want a fresh session of harness X linked to a parent but with
no carry-over context, use `POST /v1/sessions { parentSessionId }`
instead — there is no `mode: "none"` variant of `/fork`.

## Auth

Optional bearer token via `WAGENT_TOKEN`. Loopback solo-dev with no
token is fine; any non-loopback exposure (LAN / Tailnet) should set
one. Checked in a single `onRequest` hook before routes run.

`/mcp/delegate/*` is exempt from `WAGENT_TOKEN` and uses its own
per-spawn token, loopback-only. See [delegation.md](./delegation.md).

## Out of scope

- Cloud sandbox providers (E2B, Daytona, Modal). Local-only.
- Multi-user auth with scoped tokens.
- IDE integrations.
- Multiple harnesses inside one session. (Cross-session delegation
  via parent/child links is in scope — see [delegation.md](./delegation.md).
  One session is still one harness.)
- General MCP-server orchestration on behalf of harnesses. Harnesses
  pick up user-configured MCP servers from their own configs. wagent
  forwards two narrow categories on top of that: (a) the per-spawn
  `wagent-delegate` server, injected so the harness can call
  `delegate(...)`; (b) caller-supplied servers via
  `options.mcpServers` on `POST /v1/sessions`, for the MCP-capable
  harnesses that accept per-session injection (claude today). wagent
  does not manage long-lived MCP server lifecycles.
