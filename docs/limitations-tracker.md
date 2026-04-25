# Rivet SDK_LIMITATIONS — wagent migration tracker

Mirrors the 20-row table in droidcode's
[`docs/SDK_LIMITATIONS.md`](https://github.com/sdelcore/droidcode/blob/main/docs/SDK_LIMITATIONS.md).
For each row: how wagent addresses it and the commit that landed the fix.

Status legend:
- ✅ **fixed** — wagent's design eliminates the workaround.
- 📝 **carried over** — same defensive pattern, just owned by wagent now.
- ⚠️ **persists** — still needs a workaround somewhere.
- 🚧 **n/a** — not relevant (client-side concern, deprecated path).

| # | Limitation | Status | wagent's answer | Commit |
|---|---|---|---|---|
| 1 | `sdk.listSessions()` reads client-side persist driver | ✅ | `GET /v1/sessions` is the authoritative server-side list backed by SQLite | `203289d` |
| 2 | `destroySession` is a soft delete | ✅ | `DELETE /v1/sessions/:id` real-deletes; FK cascades event rows | `203289d` |
| 3 | No `Session.interrupt()` method | ✅ | First-class `POST /v1/sessions/:id/cancel` endpoint | `24e1dc0` |
| 4 | `SessionRecord.sessionInit` strips `_meta` from the type | ✅ | wagent's `Session` is its own shape; alias / model are first-class columns | `203289d` |
| 5 | `_meta` only settable at session create time | ✅ | `PUT /v1/sessions/:id` updates alias and model anytime | `203289d` |
| 6 | `resumeSession` prepends a JSON replay-prefix prompt | ✅ | wagent keeps the agent subprocess alive across client SSE reconnects; reconnects are pure SSE re-subscribes via `Last-Event-ID`, no agent re-priming | `24e1dc0`, `a6d8ca0`, `74fbd24` |
| 7 | Rivet `mock` agent infinite-loops on `session/new` | 🚧 | wagent doesn't ship a mock agent; the `echo` stub is what we use for smoke tests | `24e1dc0` |
| 8 | `respondPermission` throws "permission not found" on duplicate | ✅ | claude adapter dedupes via a pending-resolver `Map`; the route returns `{ status: "noop" }` instead of throwing | `24e1dc0`, `a6d8ca0` |
| 9 | `onPermissionRequest` may fire twice for the same permission on resume | ✅ | wagent broadcasts each request once and the resolver Map de-dupes responses | `a6d8ca0` |
| 10 | ACP errors come in two shapes (`AcpHttpError` / `AcpRpcError`) | ✅ | wagent's wire returns one shape: `{ error: { code, message, details? } }` everywhere | `203289d` |
| 11 | `ContentChunk.messageId` absent → all agent chunks merge into one bubble | 📝 | wagent emits a `user_message_chunk` before forwarding the prompt and a `stop` event when the turn ends, giving clients explicit turn boundaries without relying on `messageId`. Pi adapter additionally synthesizes a `messageId` per `message_start`. | `24e1dc0`, `74fbd24` |
| 12 | SDK does not emit `user_message_chunk` for client prompts | ✅ | All adapters emit `user_message_chunk` on every accepted prompt before forwarding to the agent | `24e1dc0`, `a6d8ca0`, `74fbd24` |
| 13 | Daemon's `/v1/fs/entries?path=~` doesn't expand tilde | ✅ | wagent rejects `~`-prefixed and relative cwds at `POST /v1/sessions` (and `PUT /v1/projects`) with `invalid_cwd` / `invalid_directory` codes | `203289d`, `987a24d` |
| 14 | Daemon `/v1/fs/*` is single-file PUT only | 🚧 | wagent doesn't use the daemon's filesystem for state; SQLite is the canonical store | n/a |
| 15 | Daemon events POST requires `sessions(id)` row to exist (FK) | ✅ | wagent owns event ingestion: events are only ever appended in-process by the supervisor, after the session row is confirmed | `7e90a93` |
| 16 | `crypto.randomUUID()` not in insecure contexts | 🚧 | Server-side concern; Node's `randomUUID` is always available. Clients still need their own fallback. | n/a |
| 17 | `sandbox-agent --cors-allow-origin '*'` is rejected | ✅ | Fastify `@fastify/cors` accepts both `*` and explicit lists; `WAGENT_CORS=*` is the default | `f90f527` |
| 18 | SSE silently stalls on mobile | ✅ | wagent emits a `: keep-alive` SSE comment every 15s and supports `Last-Event-ID` resume from SQLite, so the client doesn't need a focus-poll workaround | `7e90a93` |
| 19 | ChatPane unmount → `resumeSession` → reconnect storm + replay-prefix | ✅ | wagent has no `resumeSession` semantic. SSE clients reconnect by re-opening the stream; the subprocess is unaffected | `24e1dc0`, `a6d8ca0` |
| 20 | `onPermissionRequest` fires on all subscribers; permission badge stuck without auto-accept | ✅ | wagent broadcasts each request to all SSE consumers as a single `permission_request` event and a `permission_resolved` event when the agent moves on, so the badge clears server-side | `24e1dc0`, `a6d8ca0` |

## How to update this file

When a future commit lands that addresses a row:
1. Move the status to ✅ / 📝 / ⚠️ / 🚧.
2. Replace `TBD` with the commit short-hash.
3. If a row is partially addressed, note which sub-cases remain.

When droidcode swaps from Rivet to wagent, mirror the resolved rows
back into droidcode's `docs/SDK_LIMITATIONS.md` — strike them through
with `~~…~~` and add `fixed in wagent vX.Y, commit XXXXXXX`.
