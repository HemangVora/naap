/** FIFO run queue with a concurrency cap. */
export class RunQueue {
  private waiting: { id: string; job: () => Promise<void> }[] = [];
  private running = new Set<string>();
  constructor(private max: number, private onChange: (waiting: string[]) => void) {}
  add(id: string, job: () => Promise<void>) {
    if (this.running.has(id) || this.waiting.some((w) => w.id === id)) return;
    this.waiting.push({ id, job });
    this.pump();
  }
  ids() {
    return this.waiting.map((w) => w.id);
  }
  private pump() {
    while (this.running.size < this.max && this.waiting.length) {
      const { id, job } = this.waiting.shift()!;
      this.running.add(id);
      job()
        .catch((err) => console.error(`[queue] run ${id} failed`, err))
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
    this.onChange(this.ids());
  }
}

/** Per-phone cooldown (Q16). Keyed by client id cookie, falling back to IP. */
export class Cooldown {
  private last = new Map<string, number>();
  constructor(private sec: number) {}
  check(key: string): number {
    const wait = (this.last.get(key) ?? 0) + this.sec * 1000 - Date.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }
  mark(key: string) {
    this.last.set(key, Date.now());
  }
}
