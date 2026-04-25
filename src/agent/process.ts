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
export interface AgentProcess {
  prompt(content: ContentBlock[]): Promise<void>
  cancel(): Promise<void>
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
}

export interface AgentFactory {
  spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess>
}
