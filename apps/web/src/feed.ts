import type { ArenaEvent } from './types';
import type { Store } from './store';

export interface Feed {
  stop(): void;
}

/** WebSocket client for /ws with exponential backoff. Every message is an ArenaEvent. */
export function connectLive(store: Store, path = '/ws'): Feed {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let timer: number | undefined;

  const url = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${path}`;
  };

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url());
    ws.onopen = () => {
      attempt = 0;
      store.setConnected(true);
    };
    ws.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data as string) as ArenaEvent | ArenaEvent[];
        if (Array.isArray(data)) data.forEach((e) => store.apply(e));
        else if (data && typeof data === 'object' && 't' in data) store.apply(data);
      } catch (err) {
        console.warn('[feed] bad message', err);
      }
    };
    ws.onclose = () => {
      store.setConnected(false);
      if (closed) return;
      const delay = Math.min(15_000, 500 * 2 ** attempt++) + Math.random() * 300;
      timer = window.setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    stop() {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    },
  };
}

export function isMock() {
  return new URLSearchParams(location.search).get('mock') === '1';
}

/** Picks the live socket or the scripted mock (`?mock=1`). */
export async function connectFeed(store: Store): Promise<Feed> {
  if (isMock()) {
    const { startMockFeed } = await import('./mock-feed');
    return startMockFeed(store);
  }
  return connectLive(store);
}
