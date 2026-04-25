import { EventEmitter } from 'node:events'
import type { EventEnvelope } from './types.js'

// One in-memory pubsub per server, keyed by sessionId.
// SSE handlers subscribe; adapters call publish() after persisting.
export class SessionBus {
  private readonly emitters = new Map<string, EventEmitter>()

  subscribe(sessionId: string, listener: (event: EventEnvelope) => void): () => void {
    let emitter = this.emitters.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      // Default 10 listeners is fine for solo dev; bump for multi-client.
      emitter.setMaxListeners(50)
      this.emitters.set(sessionId, emitter)
    }
    emitter.on('event', listener)
    return () => {
      const e = this.emitters.get(sessionId)
      if (!e) return
      e.off('event', listener)
      if (e.listenerCount('event') === 0) this.emitters.delete(sessionId)
    }
  }

  publish(event: EventEnvelope): void {
    const emitter = this.emitters.get(event.sessionId)
    if (emitter) emitter.emit('event', event)
  }

  // Tear down all listeners for a session — used on session destroy.
  drop(sessionId: string): void {
    const emitter = this.emitters.get(sessionId)
    if (!emitter) return
    emitter.removeAllListeners('event')
    this.emitters.delete(sessionId)
  }
}
