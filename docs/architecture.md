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
│    GET    /v1/health                                        │
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
`subprocess_died`, `session_destroyed`, `usage_update`. Stable v1
contract — see `src/types.ts`.

Permission outcomes: `allow_always` / `allow_once` / `reject`.

Internal (wagent ↔ harness):

- **Claude** — `@anthropic-ai/claude-agent-sdk`'s `query({ prompt, options })`,
  in-process. The SDK manages the `claude` CLI child. Permissions
  flow through `canUseTool`. MCP servers are passed in `options.mcpServers`:
  the per-spawn `wagent-delegate` server plus any caller-supplied
  servers from `POST /v1/sessions { options: { mcpServers } }`.
- **Pi** — `@mariozechner/pi-coding-agent`'s `createAgentSession()`,
  fully in-process. Events arrive via `session.subscribe(...)` and
  prompts through `session.prompt(...)`.

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
  allowedTools?: string[]       // tool-name allowlist
  mcpServers?: Record<string, McpServerSpec>  // per-session MCP servers
}

// McpServerSpec mirrors the Claude Agent SDK's serializable shape:
type McpServerSpec =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse';  url: string; headers?: Record<string, string> }
```

Validation: each field passes through if provided, is omitted cleanly
if not — wagent does not synthesize defaults. Unknown fields and
non-string / non-array shapes are rejected with `400 invalid_options`.
The reserved server name `wagent-delegate` cannot be used as a key in
`mcpServers` — it's owned by wagent's per-spawn delegation channel and
collisions return `400 invalid_options`.

Per-adapter behavior:

| field | claude | pi | echo |
|---|---|---|---|
| `systemPrompt` | passes through to `query({ options: { systemPrompt } })` (replaces preset) | applied via a `DefaultResourceLoader` with `systemPrompt` set (replaces pi's preset) | ignored |
| `appendSystemPrompt` | wrapped as `{ type: 'preset', preset: 'claude_code', append }` | wrapped as `[appendSystemPrompt]` and passed to `DefaultResourceLoader.appendSystemPrompt` | ignored |
| `allowedTools` | passes straight through to `query({ options: { allowedTools } })` | passes through to `createAgentSession({ tools })` | ignored |
| `mcpServers` | merged into `query({ options: { mcpServers } })` alongside the per-spawn `wagent-delegate` server | ignored with a warn log — pi-coding-agent has no per-session MCP plumbing | ignored |

If both `systemPrompt` and `appendSystemPrompt` are set, the
replacement wins and the append is dropped with a warning log.
Future option fields not natively supported by an adapter are
ignored at that adapter only — the wire shape is the same for all
agents.

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
