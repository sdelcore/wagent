# Migrating droidcode from OpenCode API to Rivet `sandbox-agent` TS SDK

**Audience:** an agent with access to both `~/src/droidcode` and the Rivet TS SDK docs.

**Goal:** replace droidcode's OpenCode REST/SSE client with calls to the `sandbox-agent` npm package, so droidcode can drive Claude Code, Codex, OpenCode, and Amp through a single backend.

This guide assumes droidcode has already (or is in the process of) migrating from React Native + Expo to a Next.js PWA + Tauri setup per `droidcode/migration.md`. If you're doing the RN→PWA and API migrations in one pass, do them in this order: **stack migration first, then API replacement**. The SDK is browser-compatible; it is not React-Native compatible.

---

## What's changing

| Layer | Before | After |
|---|---|---|
| Backend on host | OpenCode server on `http://localhost:4096` | Rivet `sandbox-agent` on `http://<tailscale-name>:2468` |
| Transport | REST + SSE via `axios` + `react-native-sse` | SDK over HTTP + SSE (internal) |
| Client library | Hand-rolled `apiClient.ts` + `sseClient.ts` | `sandbox-agent` npm package |
| Session persistence | `expo-sqlite` wrappers | SDK's built-in `IndexedDBSessionPersistDriver` |
| Multi-agent | OpenCode only | Claude, Codex, OpenCode, Amp — agent selected per session |

Anything NOT in this table stays the same. Zustand stores, routing, UI, slash commands, streaming UI — all unchanged conceptually. The replacement is at the services boundary.

---

## 1. Install the SDK

```bash
npm install sandbox-agent@0.4.x
```

The SDK works in browsers. No native deps needed for the client side.

---

## 2. New service — `services/sandboxAgent/client.ts`

Replaces `services/api/apiClient.ts` and wraps the SDK's connection management.

```typescript
import {
  SandboxAgent,
  type SandboxAgentSdk,
  type SessionHandle,
} from "sandbox-agent";
import { IndexedDBSessionPersistDriver } from "sandbox-agent/persist/indexeddb"; // see note below

type HostRecord = { id: number; host: string; port: number; isSecure: boolean; token?: string };

class SandboxAgentClientManager {
  private sdks = new Map<number, SandboxAgentSdk>();
  private persist = new IndexedDBSessionPersistDriver();

  async connect(host: HostRecord): Promise<SandboxAgentSdk> {
    const cached = this.sdks.get(host.id);
    if (cached) return cached;

    const baseUrl = `${host.isSecure ? "https" : "http"}://${host.host}:${host.port}`;
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token: host.token,
      persist: this.persist,
    });
    this.sdks.set(host.id, sdk);
    return sdk;
  }

  async disconnect(hostId: number) {
    const sdk = this.sdks.get(hostId);
    if (sdk) {
      await sdk.dispose();
      this.sdks.delete(hostId);
    }
  }

  async disconnectAll() {
    await Promise.all(Array.from(this.sdks.values()).map((s) => s.dispose()));
    this.sdks.clear();
  }
}

export const sandboxAgentClient = new SandboxAgentClientManager();
```

**Note on `IndexedDBSessionPersistDriver`:** Rivet ships the implementation as example code. Copy from the [Inspector source](https://github.com/rivet-dev/sandbox-agent/tree/main/frontend/packages/inspector/src/persist-indexeddb.ts) into `services/sandboxAgent/persist-indexeddb.ts` and import from there. This is explicitly the recommended pattern in their docs.

---

## 3. Method-by-method mapping

Replace each method in the old `apiClient.ts`. Some collapse into SDK primitives; some require small adapter logic.

### Sessions

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `getSessions(hostId)` | `const sdk = await sandboxAgentClient.connect(host); const { items } = await sdk.listSessions({ limit: 100 });` |
| `getSession(hostId, sessionId)` | `const session = await sdk.resumeSession(sessionId);` |
| `createSession(hostId, directory?)` | `await sdk.createSession({ agent: "claude", cwd: directory, mode: "default" });` |
| `deleteSession(hostId, sessionId)` | `await sdk.destroySession(sessionId);` |
| `forkSession(...)` | Not directly supported; simulate by creating a new session with `_meta.sandboxagent.dev.requestedSessionId` pointing at the source, or skip for v1. |
| `revertSession(...)` | Not directly supported by Rivet; feature-flag off for v1 unless you implement it client-side via event replay. |
| `abortSession(hostId, sessionId)` | `await session.interrupt();` |
| `updateSession(...)` | `await session.setModel(...)`, `await session.setMode(...)`, `await session.setThoughtLevel(...)`, or `await session.setConfigOption(id, value)` for generic options. |

### Messages

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `sendMessage(hostId, sessionId, request)` | `await session.prompt([{ type: "text", text: request.message }]);` — attachments via `{ type: "image", ... }` etc. |
| `getMessages(hostId, sessionId)` | `const page = await sdk.getEvents({ sessionId, limit: 200 });` — note: this returns events, not messages. Reconstruct message view from events (same as current `MessageAccumulator` logic). |

### Events / streaming

Old: `sseClient.connect(host, '/event')` with its own reconnect logic.

New: attach listeners directly to the session handle:

```typescript
const session = await sdk.resumeSession(sessionId);

const unsubscribeEvents = session.onEvent((event) => {
  chatStore.handleRivetEvent(event); // adapt existing handleSseEvent
});

const unsubscribePermissions = session.onPermissionRequest((req) => {
  permissionStore.show(req);
});

// ... later
unsubscribeEvents();
unsubscribePermissions();
```

The SDK handles reconnect, offset management, and event replay internally. Delete `sseConnectionManager.ts`, `ConnectionStateMachine.ts`, and most of `EventQueue.ts`. Keep anything that sequences events for the message accumulator.

### Permissions

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `listQuestions(hostId)` | N/A — events come through `session.onPermissionRequest` |
| `respondToPermission(hostId, permissionId, response)` | `await session.respondPermission(permissionId, "once" \| "always" \| "reject");` |
| `replyToQuestion(hostId, questionId, optionId)` | Same event mechanism via `session.onQuestionRequest` (if exposed) or route through permission handler. |

### Provider / agent metadata

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `getAgents(hostId)` | `await sdk.listAgents({ config: true });` — returns Claude, Codex, OpenCode, Amp, etc. with mode/model options. |
| `getProviders(hostId)` | Derived from `listAgents` — each agent has its own provider. |
| `getProviderStatus(hostId)` | Derived from `listAgents` — each entry has install/availability status. |

### Commands

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `getCommands(hostId)` | Agent-specific. For v1, hardcode `/undo /redo /compact /clear` client-side. Rivet doesn't centralize these. |
| `executeCommand(...)` | Send as a normal prompt with the command as text, or use agent-specific session methods if the SDK exposes them. |

### Filesystem / health / misc

| OpenCode API method | Rivet SDK equivalent |
|---|---|
| `checkHealth(hostId)` | Hit `/v1/health` directly (not in SDK): `fetch(\`${baseUrl}/v1/health\`)`. |
| `listFiles(hostId, path)` | Hit `/v1/fs/entries?path=...` directly. Not in SDK. |
| `runShellCommand(...)` | `/v1/processes/run` direct HTTP. Not in SDK. |
| `getTodos(...)` | Not in SDK. Derive from events (agents emit `plan` event updates) or drop. |
| `getDiffs(...)` | Same — derive from events. |

Anything not in the SDK but present in Rivet's HTTP API can be hit directly with `fetch`. Keep a thin `rivetHttp.ts` helper for these.

---

## 4. Store layer changes

**hostStore:** add an optional `agent` field to sessions so the client remembers which agent each session was created with. The OpenCode model assumed one agent per host; Rivet can have many.

**chatStore.handleSseEvent → handleRivetEvent:** rename and rewrite to handle Rivet's event schema. The sessionUpdate types largely match what droidcode already handles (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, etc.). Main differences:
- `usage_update` is more structured
- Permission events are separate from the event stream (come via `onPermissionRequest`)
- Token counts / thinking blocks may have different payload shapes

Preserve the accumulator logic; just adapt the field mappings.

**configStore:** drop the "provider/model tree" UI that came from `getProviders`. Rebuild as a two-step picker: choose agent (from `listAgents`), then choose model/mode/thought from that agent's `configOptions`.

---

## 5. Things that go away entirely

- Custom SSE reconnect logic (`ConnectionStateMachine`, `sseConnectionManager`).
- `axios` and `react-native-sse` dependencies (already going away in the PWA migration).
- Host/port plumbing for "OpenCode spawns per project on port 4100+." Rivet is one port per host; all projects run through one daemon.
- `opencode.json` config file in droidcode repo (replaced by host config in the settings UI).

---

## 6. Things that are new

- **Agent selector in session creation UI.** Because `createSession` needs an `agent` field (`"claude"`, `"codex"`, etc.).
- **Per-session mode/model/thought-level.** Use `session.getModes()` and `session.getConfigOptions()` to populate UI.
- **Multi-host aggregation.** droidcode already navigates hosts → projects → sessions. The new surface: a cross-host sessions view ("all sessions across all my hosts, sorted by last activity"). Low priority for v1 but natural once the SDK manages multiple connections.

---

## 7. Migration order

Do this in phases, matching droidcode's existing migration plan:

1. **Phase 2 (domain layer port)** — add `services/sandboxAgent/` alongside old `services/api/`. Don't delete the old one yet. Write the SDK wrapper and unit-test it against a local `sandbox-agent server`.
2. **Phase 3 (hosts/projects screens)** — wire the new screens to `sandboxAgent`. Add "agent type" to the host form (for v1, only "rivet" is valid; "opencode" can stay as a legacy option if you want side-by-side).
3. **Phase 5 (chat screen)** — this is where the big rewrite lives. Port `chatStore.handleSseEvent` to `handleRivetEvent`.
4. **Phase 10 (cutover)** — delete `services/api/*`, `services/sse/*`, and all OpenCode-specific code.

Do NOT try to keep OpenCode backend support "just in case." Rivet has an `/opencode/*` compatibility layer if you ever need to talk to a native OpenCode server again — point the SDK at a Rivet daemon and let it delegate.

---

## 8. Testing

Run Rivet locally for development:

```bash
# Install once
curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh
sandbox-agent install-agent claude

# Run during dev
sandbox-agent server --no-token --host 127.0.0.1 --port 2468 \
  --cors-allow-origin http://localhost:3000
```

Existing integration tests in `__tests__/integration/` that spin up an OpenCode server need the equivalent for Rivet. Use Rivet's `mock` agent in tests — it's fast and deterministic and doesn't burn real tokens.

---

## 9. Reference

- [Rivet SDK overview](https://sandboxagent.dev/docs/sdks/typescript)
- [Agent sessions](https://sandboxagent.dev/docs/agent-sessions) — primary reference for `createSession`, `prompt`, `onEvent`, etc.
- [Manage sessions](https://sandboxagent.dev/docs/manage-sessions) — persistence patterns, reconnect with offset.
- [Session persistence](https://sandboxagent.dev/docs/session-persistence) — IndexedDB, SQLite drivers.
- [Session restoration](https://sandboxagent.dev/docs/session-restoration) — how the SDK handles reconnects and replays events.
- [OpenAPI spec](https://sandboxagent.dev/docs/api-reference) — for the bits not in the SDK.

---

## 10. What to NOT do

- Don't wrap the SDK in another abstraction "for flexibility." The SDK is already the abstraction. Speak to it directly from stores.
- Don't re-implement persistence on top of the SDK's built-in driver. Use `IndexedDBSessionPersistDriver` as-is.
- Don't try to preserve exact OpenCode API parity in the new client. The shapes are different; adapt the stores to the SDK's shapes.
- Don't keep `opencode.json`, `opencode-compat` branches, or dual-protocol support. Rivet can talk to OpenCode servers if needed via its own compat layer.
- Don't add features during the migration. Parity first.
