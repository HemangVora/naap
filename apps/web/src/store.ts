import type {
  ArenaEvent,
  BarrierId,
  BarrierResult,
  CarPublic,
  CheckResult,
  Integrations,
  Rating,
  RunReport,
  Stats,
  StepUpResult,
  TrackSpec,
  Variant,
} from './types';
import { ATTACK_TYPES, BARRIER_INCIDENT, DEFAULT_TRACK_ID, STANDARD_TRACK } from './types';

export interface LaneState {
  runId?: string;
  current?: BarrierId;
  /** 0-based obstacle index on the car's track (from the event, or derived when the server omits it). */
  step?: number;
  results: Partial<Record<BarrierId, BarrierResult>>;
  /** Results by obstacle index (tracks may repeat a barrier type). */
  steps: BarrierResult[];
  finished?: { lossUsd: number; stars: number };
}

export interface StepUpState {
  runId: string;
  barrierId: BarrierId;
  summary: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt: number;
  canApprove: boolean;
  startedAt: number;
  result?: StepUpResult;
}

export interface CarState {
  car: CarPublic;
  joinedAt: number;
  order: number;
  lanes: Record<Variant, LaneState>;
  rating?: Rating;
  onchain?: { txHash: string; ensName: string };
  stepUp?: StepUpState;
}

/** One readable card per barrier verdict (replaces the raw per-check firehose on the projector). */
export interface VerdictCard {
  id: number;
  carId: string;
  barrierId: BarrierId;
  step: number;
  trackId: string;
  variant: 'bare' | 'airbag';
  outcome: string;
  reason: string;
  lossUsd: number;
  failed: CheckResult[];
  passed: number;
}

export interface CheckLine {
  id: number;
  at: number;
  carId: string;
  runId: string;
  barrierId: BarrierId;
  check: CheckResult;
}

export interface Headline {
  bareCrashRate: number;
  avgBareLossUsd: number;
  airbagCrashes: number;
  cars: number;
}

export interface State {
  cars: Map<string, CarState>;
  queue: string[];
  checks: CheckLine[];
  /** Every known track, keyed by id (always contains the standard track). */
  tracks: Map<string, TrackSpec>;
  /** AI-written report cards, by car id (arrive when a run finishes). */
  reports: Map<string, RunReport>;
  /** Server stats; undefined until the server sends them (the HUD then derives them locally). */
  serverStats?: Stats;
  /** Paced verdict cards, newest last. */
  cards: VerdictCard[];
  headline: Headline;
  /** Names of integrations running on an offline stand-in (from hello.integrations). */
  offline: Set<string>;
  integrations?: Integrations;
  connected: boolean;
  lastEventAt: number;
}

const CARD_GAP_MS = 1600;

type Listener = (e: ArenaEvent | null, s: State) => void;

const INTEGRATION_LABEL: Record<keyof Integrations, string> = {
  llm: 'LLM',
  jev: 'Jev',
  intercepta: 'Intercepta',
  world: 'World',
  ens: 'ENS',
  fork: 'Base fork',
};

export class Store {
  state: State = {
    cars: new Map(),
    queue: [],
    checks: [],
    cards: [],
    reports: new Map(),
    tracks: new Map([[DEFAULT_TRACK_ID, STANDARD_TRACK as TrackSpec]]),
    headline: { bareCrashRate: 0, avgBareLossUsd: 0, airbagCrashes: 0, cars: 0 },
    offline: new Set(),
    connected: false,
    lastEventAt: 0,
  };
  private listeners = new Set<Listener>();
  private cardQueue: VerdictCard[] = [];
  private cardTimer: ReturnType<typeof setTimeout> | null = null;
  /** Release at most one verdict card every CARD_GAP_MS so the projector stays readable. */
  private pumpCards() {
    if (this.cardTimer || !this.cardQueue.length) return;
    const next = this.cardQueue.shift()!;
    this.state.cards.push(next);
    if (this.state.cards.length > 12) this.state.cards.splice(0, this.state.cards.length - 12);
    for (const l of this.listeners) l(null, this.state);
    this.cardTimer = setTimeout(() => {
      this.cardTimer = null;
      this.pumpCards();
    }, CARD_GAP_MS);
  }
  private seq = 0;
  private order = 0;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(null, this.state);
    return () => this.listeners.delete(fn);
  }

  setConnected(v: boolean) {
    this.state.connected = v;
    this.emit(null);
  }

  car(id: string) {
    return this.state.cars.get(id);
  }

  private ensureCar(id: string, seed?: CarPublic): CarState {
    let c = this.state.cars.get(id);
    if (!c) {
      c = {
        car: { ...(seed ?? { id, name: id, color: '#f5c400', kind: 'built', ensName: `${id}.naap.eth`, isOwnerCar: false }), trackId: seed?.trackId || DEFAULT_TRACK_ID },
        joinedAt: Date.now(),
        order: this.order++,
        lanes: { bare: { results: {}, steps: [] }, airbag: { results: {}, steps: [] } },
      };
      this.state.cars.set(id, c);
    } else if (seed) {
      c.car = { ...c.car, ...seed, trackId: seed.trackId || c.car.trackId || DEFAULT_TRACK_ID };
    }
    return c;
  }

  private setIntegrations(i?: Integrations) {
    this.state.integrations = i;
    this.state.offline = new Set();
    if (!i) return;
    for (const k of Object.keys(INTEGRATION_LABEL) as (keyof Integrations)[]) if (i[k] === false) this.state.offline.add(INTEGRATION_LABEL[k]);
  }

  apply(e: ArenaEvent) {
    const s = this.state;
    s.lastEventAt = Date.now();
    switch (e.t) {
      case 'hello': {
        s.cars = new Map();
        s.checks = [];
        this.setIntegrations(e.integrations);
        this.order = 0;
        for (const c of e.cars) {
          const cs = this.ensureCar(c.id, c);
          if (c.rating) cs.rating = c.rating;
          if (c.ratingOnchain) cs.onchain = { txHash: c.ratingOnchain.txHash, ensName: c.ensName };
        }
        s.queue = e.queue;
        for (const t of e.tracks ?? []) s.tracks.set(t.id, t);
        if (e.stats) s.serverStats = e.stats;
        break;
      }
      case 'track.created':
        if (e.track?.id) s.tracks.set(e.track.id, e.track);
        break;
      case 'stats':
        if (e.stats) s.serverStats = e.stats;
        break;
      case 'report':
        if (e.report) {
          s.reports.set(e.carId, e.report);
          const c = this.ensureCar(e.carId);
          if (e.report.rating) c.rating = e.report.rating;
        }
        break;
      case 'car.joined':
        this.ensureCar(e.car.id, e.car);
        break;
      case 'queue':
        s.queue = e.waiting;
        break;
      case 'run.started': {
        const c = this.ensureCar(e.carId);
        c.lanes[e.variant] = { runId: e.runId, results: {}, steps: [] };
        s.queue = s.queue.filter((id) => id !== e.carId);
        break;
      }
      case 'barrier.enter': {
        const c = this.ensureCar(e.carId);
        const l = c.lanes[e.variant];
        l.runId = e.runId;
        l.current = e.barrierId;
        if (e.trackId && e.trackId !== c.car.trackId) c.car.trackId = e.trackId;
        l.step = this.stepOf(c, e.barrierId, e.step, l.step);
        break;
      }
      case 'trace':
        break;
      case 'check': {
        this.ensureCar(e.carId);
        s.checks.push({ id: this.seq++, at: Date.now(), carId: e.carId, runId: e.runId, barrierId: e.barrierId, check: e.check });
        if (s.checks.length > 400) s.checks.splice(0, s.checks.length - 400);
        break;
      }
      case 'stepup.pending': {
        const c = this.ensureCar(e.carId);
        c.stepUp = {
          runId: e.runId,
          barrierId: e.barrierId,
          summary: e.summary,
          verificationUri: e.verificationUri,
          userCode: e.userCode,
          expiresAt: e.expiresAt,
          canApprove: e.canApprove,
          startedAt: Date.now(),
        };
        break;
      }
      case 'stepup.resolved': {
        const c = this.ensureCar(e.carId);
        if (c.stepUp) c.stepUp.result = e.result;
        break;
      }
      case 'barrier.result': {
        const c = this.ensureCar(e.carId);
        const lane = c.lanes[e.result.variant];
        const step = this.stepOf(c, e.result.barrierId, e.result.step, lane.step);
        const r: BarrierResult = { ...e.result, step, trackId: e.result.trackId || c.car.trackId };
        lane.results[r.barrierId] = r;
        lane.steps[step] = r;
        const interesting = r.variant === 'airbag' || r.outcome === 'CRASH' || (r.barrierId === 'over-limit' && r.outcome === 'PAID');
        if (interesting) {
          const checks = s.checks.filter((l) => l.carId === r.carId && l.barrierId === r.barrierId && l.runId === r.runId).map((l) => l.check);
          this.cardQueue.push({
            id: this.seq++, carId: r.carId, barrierId: r.barrierId, step: r.step, trackId: r.trackId, variant: r.variant, outcome: r.outcome, reason: r.reason,
            lossUsd: r.lossUsd, failed: checks.filter((k) => !k.ok), passed: checks.filter((k) => k.ok).length,
          });
          this.pumpCards();
        }
        break;
      }
      case 'run.finished': {
        const c = this.ensureCar(e.carId);
        c.lanes[e.variant].finished = { lossUsd: e.lossUsd, stars: e.stars };
        c.lanes[e.variant].current = undefined;
        break;
      }
      case 'rating': {
        const c = this.ensureCar(e.carId);
        c.rating = e.rating;
        c.car.rating = e.rating;
        break;
      }
      case 'rating.onchain': {
        const c = this.ensureCar(e.carId);
        c.onchain = { txHash: e.txHash, ensName: e.ensName };
        c.car.ratingOnchain = { txHash: e.txHash };
        break;
      }
      case 'headline':
        s.headline = { bareCrashRate: e.bareCrashRate, avgBareLossUsd: e.avgBareLossUsd, airbagCrashes: e.airbagCrashes, cars: e.cars };
        break;
    }
    this.emit(e);
  }

  /** Step from the event, else the first obstacle of that type at or after the lane's current step (old server shape). */
  private stepOf(c: CarState, barrierId: BarrierId, step: number | undefined, from: number | undefined): number {
    if (typeof step === 'number' && step >= 0) return step;
    const obs = this.trackOf(c.car.trackId).obstacles;
    const start = Math.max(0, from ?? 0);
    for (let i = start; i < obs.length; i++) if (obs[i].type === barrierId) return i;
    const first = obs.findIndex((o) => o.type === barrierId);
    return first >= 0 ? first : start;
  }

  trackOf(id: string | undefined): TrackSpec {
    return this.state.tracks.get(id || DEFAULT_TRACK_ID) ?? this.state.tracks.get(DEFAULT_TRACK_ID)!;
  }

  /** Server stats, or the same numbers derived from what this client has seen. */
  stats(): Stats {
    const s = this.state;
    if (s.serverStats) return s.serverStats;
    let agentsTested = 0;
    let attacksFaced = 0;
    let bareLossUsd = 0;
    let sekishoLossUsd = 0;
    const by = new Map<BarrierId, { attempts: number; fooled: number }>();
    for (const c of s.cars.values()) {
      if (c.lanes.bare.finished || c.rating) agentsTested++;
      for (const r of c.lanes.bare.steps) {
        if (!r) continue;
        bareLossUsd += r.lossUsd;
        if (!ATTACK_TYPES.includes(r.barrierId)) continue;
        attacksFaced++;
        const a = by.get(r.barrierId) ?? { attempts: 0, fooled: 0 };
        a.attempts++;
        if (r.outcome === 'CRASH') a.fooled++;
        by.set(r.barrierId, a);
      }
      for (const r of c.lanes.airbag.steps) if (r) sekishoLossUsd += r.lossUsd;
    }
    const attacks = [...by.entries()]
      .map(([type, a]) => ({ type, label: BARRIER_INCIDENT[type], ...a }))
      .sort((x, y) => y.fooled / Math.max(1, y.attempts) - x.fooled / Math.max(1, x.attempts) || y.fooled - x.fooled);
    return { agentsTested, attacksFaced, bareLossUsd, sekishoLossUsd, savedUsd: bareLossUsd - sekishoLossUsd, attacks, tracks: s.tracks.size };
  }

  private emit(e: ArenaEvent | null) {
    for (const l of this.listeners) l(e, this.state);
  }

  /** Cars sorted by join order (leaderboard keeps everyone). */
  carsByOrder(): CarState[] {
    return [...this.state.cars.values()].sort((a, b) => a.order - b.order);
  }
}
