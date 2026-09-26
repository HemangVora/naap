import type {
  ArenaEvent,
  BarrierId,
  BarrierResult,
  CarPublic,
  CheckResult,
  Integrations,
  Rating,
  StepUpResult,
  Variant,
} from './types';

export interface LaneState {
  runId?: string;
  current?: BarrierId;
  results: Partial<Record<BarrierId, BarrierResult>>;
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

export interface CheckLine {
  id: number;
  at: number;
  carId: string;
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
  headline: Headline;
  /** Names of integrations running on an offline stand-in (from hello.integrations). */
  offline: Set<string>;
  integrations?: Integrations;
  connected: boolean;
  lastEventAt: number;
}

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
    headline: { bareCrashRate: 0, avgBareLossUsd: 0, airbagCrashes: 0, cars: 0 },
    offline: new Set(),
    connected: false,
    lastEventAt: 0,
  };
  private listeners = new Set<Listener>();
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
        car: seed ?? { id, name: id, color: '#f5c400', kind: 'built', ensName: `${id}.crumple.eth`, isOwnerCar: false },
        joinedAt: Date.now(),
        order: this.order++,
        lanes: { bare: { results: {} }, airbag: { results: {} } },
      };
      this.state.cars.set(id, c);
    } else if (seed) {
      c.car = { ...c.car, ...seed };
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
        break;
      }
      case 'car.joined':
        this.ensureCar(e.car.id, e.car);
        break;
      case 'queue':
        s.queue = e.waiting;
        break;
      case 'run.started': {
        const c = this.ensureCar(e.carId);
        c.lanes[e.variant] = { runId: e.runId, results: {} };
        s.queue = s.queue.filter((id) => id !== e.carId);
        break;
      }
      case 'barrier.enter': {
        const c = this.ensureCar(e.carId);
        const l = c.lanes[e.variant];
        l.runId = e.runId;
        l.current = e.barrierId;
        break;
      }
      case 'trace':
        break;
      case 'check': {
        this.ensureCar(e.carId);
        s.checks.push({ id: this.seq++, at: Date.now(), carId: e.carId, barrierId: e.barrierId, check: e.check });
        if (s.checks.length > 60) s.checks.splice(0, s.checks.length - 60);
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
        c.lanes[e.result.variant].results[e.result.barrierId] = e.result;
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

  private emit(e: ArenaEvent | null) {
    for (const l of this.listeners) l(e, this.state);
  }

  /** Cars sorted by join order (leaderboard keeps everyone). */
  carsByOrder(): CarState[] {
    return [...this.state.cars.values()].sort((a, b) => a.order - b.order);
  }
}
