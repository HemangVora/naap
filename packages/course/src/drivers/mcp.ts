// Connected car via MCP: the owner's OWN agent (Claude Code, Cursor, any MCP client) drives the car
// through NaAP's MCP server. The course calls act() for the bare lane AND the airbag lane at every
// barrier; the agent is asked exactly ONCE per barrier and both lanes get the same actions.
//
// Flow per barrier: act(obs) opens an entry → the agent's naap_next_barrier call takes it →
// naap_pay records actions → naap_done (or the next naap_next_barrier, or the timeout) settles
// the entry and resolves every act() promise waiting on it.
import type { AgentAction, BarrierId, Observation, Rating } from '@crumple/core';
import { BARRIER_ORDER } from '@crumple/core';
import type { CourseDriver } from './types.js';
import { MAX_ACTIONS, MAX_REPLY, sanitisePayArgs } from './sanitize.js';

/** How long the agent has to answer one barrier before the course moves on with a noop. */
export const MCP_AGENT_TIMEOUT_MS = 90_000;
/** How long one naap_next_barrier call may block before returning { status: 'waiting' }. */
export const MCP_POLL_MS = 45_000;

export interface McpBarrier {
  barrierId: BarrierId;
  /** 1-based position on the course. */
  step: number;
  total: number;
  ownerRequest: string;
  content: Observation['content'];
  /** Actions recorded so far in this turn (pay calls). */
  recorded: number;
}

export type NextBarrier =
  | ({ status: 'barrier' } & McpBarrier)
  | { status: 'waiting'; detail: string }
  | { status: 'finished'; rating: Rating | null; detail: string };

interface Entry {
  barrierId: BarrierId;
  obs: Observation;
  actions: AgentAction[];
  delivered: boolean;
  settled: boolean;
  promise: Promise<AgentAction[]>;
  resolve: (a: AgentAction[]) => void;
  timer: NodeJS.Timeout;
}

export interface McpDriverOptions {
  timeoutMs?: number;
  /** Called whenever a barrier opens or the run finishes (the server uses it for logging/telemetry). */
  onChange?: () => void;
}

export class McpDriver implements CourseDriver {
  readonly kind = 'mcp' as const;
  readonly offline = false;
  private readonly timeoutMs: number;
  private readonly onChange: () => void;
  /** One entry per barrier, in course order (keyed by barrierId — one driver instance = one car = one run). */
  private entries = new Map<BarrierId, Entry>();
  private waiters = new Set<() => void>();
  private finished: { rating: Rating | null; detail: string } | null = null;

  constructor(opts: McpDriverOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? MCP_AGENT_TIMEOUT_MS;
    this.onChange = opts.onChange ?? (() => {});
  }

  // ── course side ─────────────────────────────────────────────────────────

  /** Both lanes call this; the first call opens the barrier for the agent, the second gets the same promise. */
  act(obs: Observation): Promise<AgentAction[]> {
    const existing = this.entries.get(obs.barrierId);
    if (existing) return existing.promise;
    if (this.finished) return Promise.resolve([{ type: 'noop', reason: 'run ended' }]);
    let resolve!: (a: AgentAction[]) => void;
    const promise = new Promise<AgentAction[]>((r) => (resolve = r));
    const entry: Entry = {
      barrierId: obs.barrierId, obs, actions: [], delivered: false, settled: false, promise, resolve,
      timer: setTimeout(() => this.settle(entry, [{ type: 'noop', reason: 'agent timed out' }]), this.timeoutMs),
    };
    entry.timer.unref?.();
    this.entries.set(obs.barrierId, entry);
    this.wake();
    return promise;
  }

  /** The run is over (or failed). Wakes any agent still polling. */
  finish(rating: Rating | null, detail = rating ? 'run complete' : 'run ended without a rating'): void {
    this.finished = { rating, detail };
    for (const e of this.entries.values()) if (!e.settled) this.settle(e, [{ type: 'noop', reason: 'run ended' }]);
    this.wake();
  }

  get isFinished(): boolean {
    return this.finished !== null;
  }

  // ── agent side (MCP tools) ──────────────────────────────────────────────

  /** The barrier the agent is currently answering (delivered, not yet settled). */
  private open(): Entry | undefined {
    for (const e of this.entries.values()) if (e.delivered && !e.settled) return e;
    return undefined;
  }

  private view(e: Entry): McpBarrier {
    return {
      barrierId: e.barrierId,
      step: BARRIER_ORDER.indexOf(e.barrierId) + 1,
      total: BARRIER_ORDER.length,
      ownerRequest: e.obs.ownerRequest,
      content: e.obs.content,
      recorded: e.actions.length,
    };
  }

  /**
   * Blocks up to `waitMs` for the next barrier that needs the agent. Calling it while a barrier is still open
   * ends that turn with whatever was recorded (forgiving for agents that forget naap_done).
   */
  async nextBarrier(waitMs = MCP_POLL_MS): Promise<NextBarrier> {
    const open = this.open();
    if (open) this.settle(open, open.actions.length ? open.actions : [{ type: 'noop', reason: 'agent moved on without acting' }]);

    const deadline = Date.now() + waitMs;
    for (;;) {
      for (const e of this.entries.values()) {
        if (!e.settled && !e.delivered) {
          e.delivered = true;
          return { status: 'barrier', ...this.view(e) };
        }
      }
      if (this.finished) return { status: 'finished', ...this.finished };
      const left = deadline - Date.now();
      if (left <= 0) return { status: 'waiting', detail: 'The course has not reached a barrier that needs you yet. Call naap_next_barrier again.' };
      await this.waitForChange(left);
    }
  }

  /** Records a pay action for the open barrier. Throws with an agent-readable message when it cannot. */
  pay(raw: unknown): { recorded: number; action: AgentAction } {
    const e = this.open();
    if (!e) throw new Error('No barrier is open. Call naap_next_barrier first.');
    if (e.actions.filter((a) => a.type === 'pay').length >= MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} payments per barrier.`);
    const args = sanitisePayArgs(raw);
    if (!args) throw new Error('Invalid payment: payTo must be a 0x address or an ENS name, amountUsd a positive number ≤ 1,000,000.');
    const action: AgentAction = { type: 'pay', args };
    e.actions.push(action);
    return { recorded: e.actions.length, action };
  }

  /** Ends the agent's turn for the open barrier. */
  done(reply?: string): { barrierId: BarrierId; actions: AgentAction[] } {
    const e = this.open();
    if (!e) throw new Error('No barrier is open. Call naap_next_barrier first.');
    const text = typeof reply === 'string' ? reply.trim().slice(0, MAX_REPLY) : '';
    const actions = e.actions.slice();
    if (text) actions.push({ type: 'reply', text });
    if (!actions.length) actions.push({ type: 'noop', reason: 'agent chose not to act' });
    this.settle(e, actions);
    return { barrierId: e.barrierId, actions };
  }

  /** What the agent has answered so far (for naap_rating). */
  answers(): { barrierId: BarrierId; actions: AgentAction[] }[] {
    return [...this.entries.values()].filter((e) => e.settled).map((e) => ({ barrierId: e.barrierId, actions: e.actions }));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private settle(e: Entry, actions: AgentAction[]): void {
    if (e.settled) return;
    e.settled = true;
    e.actions = actions;
    clearTimeout(e.timer);
    e.resolve(actions);
    this.onChange();
  }

  private wake(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
    this.onChange();
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.waiters.delete(done);
        r();
      }, ms);
      const done = () => {
        clearTimeout(t);
        r();
      };
      this.waiters.add(done);
    });
  }
}
