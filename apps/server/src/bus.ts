import type { ArenaEvent } from '@crumple/core';

type Listener = (e: ArenaEvent) => void;

/** Fan-out of ArenaEvents to every WebSocket client (and the store). */
export class Bus {
  private listeners = new Set<Listener>();
  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit = (e: ArenaEvent) => {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[bus] listener failed', err);
      }
    }
  };
}
