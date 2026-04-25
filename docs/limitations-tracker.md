# Rivet SDK_LIMITATIONS — wagent migration tracker

Mirrors the 20-row table in droidcode's
[`docs/SDK_LIMITATIONS.md`](https://github.com/sdelcore/droidcode/blob/main/docs/SDK_LIMITATIONS.md).
For each row, this table tracks **how wagent addresses it** and **the
commit that landed the fix**. Updated commit-by-commit so we don't have
to audit at the end.

Status legend:
- ✅ **fixed** — wagent's design eliminates the workaround.
- 📝 **carried over** — same defensive pattern, just owned by wagent now.
- ⚠️ **persists** — still needs a workaround somewhere; not solved by daemon swap.
- ⏳ **pending** — not yet addressed; will be handled in a future commit.

| # | Limitation | Status | wagent's answer | Commit |
|---|---|---|---|---|
| 1 | `sdk.listSessions()` reads client-side persist driver, no daemon endpoint | ⏳ | wagent owns the canonical session list in SQLite; `GET /v1/sessions` is the source of truth | TBD |
| 2 | `destroySession` is a soft delete | ⏳ | wagent's `DELETE /v1/sessions/:id` is a real DELETE with FK-cascading events | TBD |
| 3 | No `Session.interrupt()` method | ⏳ | first-class `POST /v1/sessions/:id/cancel` endpoint | TBD |
| 4 | `SessionRecord.sessionInit` strips `_meta` from the type | ⏳ | wagent owns its own `SessionRecord` shape; `_meta` is a first-class column | TBD |
| 5 | `_meta` only settable at session create time | ⏳ | wagent's `PUT /v1/sessions/:id` updates metadata anytime | TBD |
| 6 | `resumeSession` prepends a JSON replay-prefix prompt | ⏳ | wagent keeps the subprocess alive across client reconnects; replay path is unused. Cold reconnects (subprocess died) replay events from SQLite, not by re-priming the agent. | TBD |
| 7 | Rivet `mock` agent infinite-loops on `session/new` | ⚠️ | wagent doesn't ship `mock`; smoke tests use `claude` or `pi`. | TBD |
| 8 | `respondPermission` throws "permission not found" on duplicate | 📝 | wagent will return a 410 Gone idempotent response instead of throwing; client doesn't need a try/catch | TBD |
| 9 | `onPermissionRequest` may fire twice for the same permission on resume | 📝 | wagent dedupes server-side via permission id; client receives one notification | TBD |
| 10 | ACP errors come in two shapes (`AcpHttpError` / `AcpRpcError`) | ✅ (design) | wagent's wire returns one shape: `{ error: { code, message, details? } }` | TBD |
| 11 | `ContentChunk.messageId` absent → all agent chunks merge into one bubble | 📝 | wagent emits explicit `user_message_chunk` and a `stop` event at turn boundaries; no client guesswork | TBD |
| 12 | SDK does not emit `user_message_chunk` for client prompts | ✅ (design) | wagent emits `user_message_chunk` on every accepted prompt before forwarding to the agent | TBD |
| 13 | Daemon's `/v1/fs/entries?path=~` doesn't expand tilde | 📝 | wagent's `POST /v1/sessions` rejects `~`-prefixed and relative paths with a clear error code | TBD |
| 14 | Daemon `/v1/fs/*` is single-file PUT only | n/a | not relevant — wagent uses SQLite for state, never the daemon's filesystem | TBD |
| 15 | Daemon events POST requires `sessions(id)` row to exist (FK) | ✅ (design) | wagent owns both ends; events POSTed by clients are validated and rejected if no session, no auto-shell-row workaround needed | TBD |
| 16 | `crypto.randomUUID()` not in insecure contexts | n/a | client-side concern; wagent uses Node's `randomUUID` server-side which is always available | TBD |
| 17 | `sandbox-agent --cors-allow-origin '*'` is rejected | ✅ | Fastify `@fastify/cors` accepts `*` and explicit lists | scaffold commit |
| 18 | SSE silently stalls on mobile (no failure event, no auto-reconnect) | 📝 | wagent emits SSE keep-alive pings every 15s + supports `Last-Event-ID` for resume from SQLite. Client-side focus poll becomes optional. | TBD |
| 19 | ChatPane unmount → SDK `resumeSession` → reconnect storm + replay-prefix re-prime | ✅ | wagent has no `resumeSession` semantic — clients just open an SSE stream by session id. Subprocess stays alive regardless of client connection state. | TBD |
| 20 | `onPermissionRequest` fires on all subscribers; permission badge stuck without auto-accept | 📝 | wagent broadcasts permission requests; first response wins (idempotent). UI badge clears via the `permission_resolved` event wagent emits after the agent moves on. | TBD |

## How to update this file

When a commit lands that addresses a row:
1. Move its status to ✅ / 📝 / ⚠️ / n/a as appropriate.
2. Replace `TBD` with the commit short-hash.
3. If a row is partially addressed, leave it ⏳ but add a note.

When the table is fully populated, mirror the resolved rows back into
droidcode's `docs/SDK_LIMITATIONS.md` (strike-through with `~~…~~` and
note "fixed in wagent vX.Y").
