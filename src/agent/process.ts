import type {
  ContentBlock,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'

// Implementations are responsible for spawning + supervising one
// underlying coding-agent subprocess and translating its protocol into
// `SessionUpdate` events on the provided emit callback.
//
// Lifecycle:
//   1. supervisor calls AgentFactory.spawn(session, deps)
//   2. impl returns an AgentProcess that's already initialized
//   3. supervisor stores the handle, hooks emit -> EventStore.append + bus.publish
//   4. supervisor calls process.prompt(...) on incoming user prompts
//   5. process emits events asynchronously through emit
//   6. supervisor calls process.close() on session destroy / shutdown
//
// Turn contract: `turnId` is minted by the supervisor per prompt. The
// adapter stamps it on the turn's boundary events (`user_message_chunk`,
// `stop`) and guarantees every prompt is answered by exactly one `stop`,
// however the turn ends. A prompt arriving while a turn is in flight
// supersedes it: the old turn ends with `stop { reason: 'cancelled' }`
// before the new turn starts. `cancel` names the turn it targets and is
// a no-op when that turn is no longer current — this is the adapter-side
// fence against abort/prompt races (the supervisor gates stale aborts
// before they ever reach the adapter).
export interface AgentProcess {
  prompt(turnId: string, content: ContentBlock[]): Promise<void>
  cancel(turnId: string): Promise<void>
  respondPermission(requestId: string, outcome: PermissionOutcome): Promise<void>
  // Optional — called by the route layer on PATCH /v1/sessions/:id when
  // the model field changes. Adapters that can hot-switch implement it;
  // others can no-op (the DB still reflects the new model for next spawn).
  setModel?(model: string): Promise<void>
  close(): Promise<void>
}

export interface AgentSpawnDeps {
  emit(update: SessionUpdate): void
  // Adapters call this when the underlying subprocess exits unexpectedly
  // (i.e. not via close()). Supervisor uses it to remove the dead handle
  // so the next prompt respawns cleanly, and emits a `subprocess_died`
  // event so clients can show a recover state.
  markDead(reason: string): void
  // Supervisor passes a logger so adapters can use the existing pino instance.
  log: {
    info(obj: object, msg?: string): void
    warn(obj: object, msg?: string): void
    error(obj: object, msg?: string): void
    debug(obj: object, msg?: string): void
  }
  // Wagent-side delegation MCP endpoint config. Adapters that support
  // MCP server injection (claude_sdk; pi_sdk would need a bridge —
  // pi has no native MCP) include this server in the harness's MCP
  // list so the running agent can call `delegate(...)`. Adapters that
  // don't support MCP just ignore it.
  delegate?: {
    url: string    // e.g. http://127.0.0.1:2468/mcp/delegate/<sessionId>
    token: string  // bearer token, scoped to this parent session
  }
}

export interface AgentFactory {
  spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess>
}
