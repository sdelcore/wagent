# Architecture

> **Direction reversed 2026-04-25:** wagent is now the daemon, not a
> Rivet wrapper. The earlier "Rivet unmodified + PWA only" architecture
> is preserved in commit `828fb6f` for context.
>
> **v0.1.0 reflects the contract below**, with two carve-outs flagged
> inline: the `/mcp/delegate/*` routes and `usage_update` events are
> design sketches that ship in a later release (see
> [delegation.md](./delegation.md)). Everything else is live as of
> tag `v0.1.0`.

## Shape

```
┌─────────────────────────────┐
│  Client(s)                  │   droidcode web, CLI scripts, future
│  - HTTP + SSE               │   tools. None are special-cased in
│  - Bearer-token auth        │   wagent — the wire is the contract.
└────────────┬────────────────┘
             │
             │  HTTP + SSE  (Tailscale or LAN; loopback for solo dev)
             │
┌────────────┴────────────────────────────────────────────────┐
│  wagent (Node + TS, single process per host)                │
├─────────────────────────────────────────────────────────────┤
│  Fastify HTTP routes                                        │
│    GET    /v1/health                                        │
│    GET    /v1/meta                                          │
│    GET    /v1/agents                                        │
│    GET    /v1/sessions[?destroyed=true]                     │
│    POST   /v1/sessions                                      │
│    GET    /v1/sessions/:id                                  │
│    PATCH  /v1/sessions/:id           (alias, model)         │
│    DELETE /v1/sessions/:id           (FK-cascades events)   │
│    GET    /v1/sessions/:id/events    (paged JSON history)   │
│    GET    /v1/sessions/:id/events/stream  (SSE)             │
│    POST   /v1/sessions/:id/message                          │
│    POST   /v1/sessions/:id/abort                            │
│    POST   /v1/sessions/:id/permissions/:requestId           │
│    GET    /v1/projects                                      │
│    POST   /v1/projects                (upsert)              │
│    DELETE /v1/projects?directory=...                        │
│    GET    /v1/fs/entries?path=...                           │
│    -- planned (delegation, see delegation.md) --            │
│    POST   /mcp/delegate/:parentSessionId  (loopback only)   │
│    GET    /mcp/delegate/:parentSessionId  (loopback only)   │
├─────────────────────────────────────────────────────────────┤
│  Subprocess supervisor                                      │
│    interface AgentProcess                                   │
│      prompt / cancel / events / respondPermission / close   │
│    impls:                                                   │
│      ClaudeAcp — spawns claude-agent-acp, ACP JSON-RPC      │
│      PiRpc     — spawns `pi --mode rpc`, native JSON-RPC    │
├─────────────────────────────────────────────────────────────┤
│  Event normalizer                                           │
│    Each adapter emits one internal SessionUpdate shape.     │
│    ACP envelopes do not leak past this layer.               │
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
       ┌────────────────────────┐    ┌────────────────────────┐
       │ claude-agent-acp child │    │ pi --mode rpc child    │
       │ (per session)          │    │ (per session)          │
       └────────────────────────┘    └────────────────────────┘
```

## Wire

External (client ↔ wagent):

- HTTP+JSON for the control plane.
- SSE for events. Each event carries an `id:` (monotonic per-session
  index) and a typed `event:` name. Reconnects send `Last-Event-ID: N`
  and the server replays from N+1 via SQLite.

```
event: session_update
id: 42
data: {"kind":"agent_message_chunk","sessionId":"...","eventIndex":42,
       "createdAt":1776889000000,"payload":{...}}
```

`kind` (v0.1.0) is one of: `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`user_message_chunk`, `permission_request`, `permission_resolved`,
`stop`, `subprocess_died`, `session_destroyed`. Stable v1 contract.

`usage_update` (cumulative token counts) is planned alongside the
delegation work; not emitted in v0.1.0.

Permission outcomes use ACP wire vocabulary:
`allow_always` / `allow_once` / `reject`.

Internal (wagent ↔ subprocess):

- `claude-agent-acp` — JSON-RPC over stdio per the ACP spec.
- `pi --mode rpc` — pi's own newline-JSON commands (`prompt`, `steer`,
  `abort`, `set_model`, `get_state`, …).

Normalizer fan-in means routes only see our `SessionUpdate` shape.

## Session lifecycle

1. Client `POST /v1/sessions { agent, cwd, model? }`.
2. wagent allocates an id, persists a row, spawns the subprocess, sends
   `initialize` (ACP) or equivalent.
3. Client `POST /v1/sessions/:id/message` and subscribes to
   `/v1/sessions/:id/events/stream` over SSE.
4. Subprocess emits ACP/RPC events → normalizer → SQLite append +
   broadcast → SSE consumers see them live.
5. Client disconnects: subprocess **stays alive**. SQLite keeps the
   event log. New connection picks up via `Last-Event-ID`.
6. `POST /v1/sessions/:id/abort` interrupts the current turn.
7. `DELETE /v1/sessions/:id` ends and removes the session (cascades
   events).

## API alignment

- REST verb/noun shape mirrors **OpenCode's** `/session` API
  (`POST /v1/sessions`, `POST /v1/sessions/:id/message`,
  `POST /v1/sessions/:id/abort`, `PATCH /v1/sessions/:id`).
- Permission vocabulary uses **ACP** wire terms (`allow_always` /
  `allow_once` / `reject`).
- Per-session SSE + `Last-Event-ID` resume + monotonic `eventIndex` +
  paged history endpoint — these are wagent-specific advantages over
  both references and not part of either's design.
- Not chasing ACP's draft Streamable-HTTP transport (`/acp` single-
  endpoint, JSON-RPC envelopes) until the RFD merges and a reference
  server ships.

## Auth

Optional bearer token via `WAGENT_TOKEN`. Loopback solo-dev with no
token is fine. Any non-loopback exposure (LAN / Tailnet) should set a
token. Token is checked in a single `onRequest` hook before routes run.

The `/mcp/delegate/*` path is exempt from `WAGENT_TOKEN` and uses its
own per-spawn token (loopback-only). See `delegation.md` for why.

## Delegation (planned — not in v0.1.0)

The design sketch lives in [delegation.md](./delegation.md). When it
ships, a wagent session will be able to spawn child sessions through
a `delegate` tool: the parent agent (any harness that consumes MCP)
connects to wagent's own MCP HTTP endpoint and calls
`delegate(harness, prompt, ...)`; wagent creates a child session and
runs it through the same supervisor + factory machinery as any
top-level session. Children linked by `parent_session_id`; depth
capped at 3; destroying a parent cascades. Sync mode blocks until the
child stops; background mode returns immediately with
`delegate_status` / `delegate_cancel` for follow-up.

## Why this is not the Rivet shape

| concern | Rivet | wagent |
|---|---|---|
| Session list | client-side persist driver | server-side SQLite, single source of truth |
| Destroy | soft (records keep `destroyedAt`) | real DELETE, FK-cascades events |
| Interrupt | `rawSend('session/cancel')` | first-class endpoint |
| Resume | new subprocess + replay-prefix prompt | subprocess stays alive; SSE Last-Event-ID |
| Mobile SSE stalls | client-only mitigation | server keep-alive + replay-on-resume |
| CORS `*` | rejected by binary | Fastify owns it |
| Two daemons to run | daemon + companion | one |

## Out of scope (v1)

- Cloud sandbox providers (E2B, Daytona, Modal). Local-only.
- Multi-user auth with scoped tokens.
- IDE integrations (ACP's home turf — wagent is a web/CLI daemon).
- Multiple agents in one session. (Cross-session delegation via parent/
  child links is in scope — see `delegation.md`. One session is still
  one harness.)
- General MCP-server orchestration on behalf of harnesses. Agents pick
  up user-configured MCP servers from their own configs as before.
  The one exception is wagent's `wagent-delegate` MCP server, which is
  injected at spawn time so the harness can call `delegate(...)`.
