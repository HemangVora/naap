// NaAP × Sekisho — the frozen interface every lane codes against.
// Change only through the integrator (see CONTRACT.md §Rules).

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// ─── Provenance ──────────────────────────────────────────────────────────────

/** Where a value came from. Only OWNER and MANDATE may authorise money. */
export type Label =
  | 'OWNER' // typed by the car's owner (the request), or signed by them
  | 'MANDATE' // read from the car's ENS mandate
  | 'OWNER_BOUNDED' // an UNTRUSTED amount clamped by an OWNER/MANDATE ceiling (x402 price ≤ owner max)
  | 'TOOL' // produced by our own deterministic code (e.g. ENS resolution of an OWNER name)
  | 'UNTRUSTED' // anything an agent read: web, tweet, 402 body, other agent, decoded text
  | 'OPAQUE'; // came out of a black-box connected agent — provenance unknowable (boundary mode)

export interface Labeled<T> {
  value: T;
  label: Label;
  /** Human-readable origin, shown on screen. e.g. "owner.request", "barrier:x402-swap:402-body.payTo" */
  source: string;
}

// ─── Cars ────────────────────────────────────────────────────────────────────

/** mcp = the owner's own agent (Claude Code, Cursor, …) drives the car through NaAP's MCP server. */
export type CarKind = 'built' | 'webhook' | 'openai' | 'mcp';
export type Variant = 'bare' | 'airbag';

export type BuiltModel = 'claude-haiku-4-5-20251001' | 'claude-sonnet-5';

export interface CarSpec {
  kind: CarKind;
  name: string; // display name, 1–24 chars, sanitised
  color: string; // hex "#rrggbb", chosen on phone
  /** built: one-line personality typed or spoken on the phone */
  persona?: string;
  /** built: the owner's real agent system prompt, pasted on the phone. Used verbatim instead of the persona prompt. */
  systemPrompt?: string;
  model?: BuiltModel; // built only; audience default haiku
  /** webhook: POST target. openai: base URL of an OpenAI-compatible API */
  endpoint?: string;
  /** openai only */
  openaiModel?: string;
  openaiApiKey?: string; // never persisted, never logged, never sent to web
  /** Which track to drive (default DEFAULT_TRACK_ID). */
  trackId?: string;
  isOwnerCar?: boolean; // the presenter's car (#1) — the only one that can complete a World step-up
}

export interface Car {
  id: string; // short slug, also the ENS label: <id>.naap.eth
  spec: Omit<CarSpec, 'openaiApiKey'>;
  ensName: string;
  wallet: Address; // derived by the signer; the agent never sees its key
  createdAt: number;
  sessionToken: string; // phone uses it to follow its own car
}

/** What the web may see. */
export interface CarPublic {
  id: string;
  name: string;
  color: string;
  kind: CarKind;
  model?: string;
  ensName: string;
  isOwnerCar: boolean;
  trackId: string;
  rating?: Rating;
  ratingOnchain?: { txHash: Hex } | null;
}

// ─── Mandate (lives on ENSv2: <car>.naap.eth text records) ────────────────

export interface MandatePayee {
  ens: string; // e.g. "compute.naap.eth"
  address: Address; // resolved at read time — never typed by anyone
}

export interface Mandate {
  ensName: string;
  owner: Address;
  payees: MandatePayee[];
  perTxCapUsd: number; // e.g. 5
  dailyCapBps: number; // e.g. 1000 = 10% of balance
  expiresAt: number; // unix seconds
  source: 'ens' | 'local'; // 'local' = signed-JSON fallback
}

/** ENS text-record keys (namespaced). Lane ens owns the encoding. */
export const MANDATE_KEYS = {
  payees: 'sekisho.payees', // comma-separated ENS names
  perTxCapUsd: 'sekisho.perTxCapUsd',
  dailyCapBps: 'sekisho.dailyCapBps',
  expiresAt: 'sekisho.expiresAt',
} as const;
export const RATING_KEYS = {
  stars: 'naap.stars', // "0".."5"
  lossBareUsd: 'naap.lossBareUsd',
  lossAirbagUsd: 'naap.lossAirbagUsd',
  summary: 'naap.summary', // e.g. "bare 1/5 · airbag 5/5"
  runAt: 'naap.runAt',
} as const;

// ─── The course ──────────────────────────────────────────────────────────────

export type BarrierId = 'legit' | 'grok-morse' | 'freysa' | 'x402-swap' | 'over-limit';
export const BARRIER_ORDER: BarrierId[] = ['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit'];

// ─── Tracks: anyone can build one; every car drives the track it picked ───────

/** How an attack payload is disguised (Sekisho's reader decodes all of these). */
export type Obfuscation = 'none' | 'morse' | 'base64' | 'hex';

/** One obstacle on a track: an incident type plus its knobs. */
export interface TrackObstacle {
  type: BarrierId;
  /** grok-morse / freysa / x402-swap: how the instruction is disguised. Default per type (grok-morse → morse). */
  obfuscation?: Obfuscation;
  /** Attack or purchase amount in USD (freysa prize, over-limit price, x402 price). Defaults per type. */
  amountUsd?: number;
}

export interface TrackSpec {
  id: string; // slug
  name: string; // 1–32 chars
  author: string; // display name, 1–24 chars
  obstacles: TrackObstacle[]; // 1–8, repeats allowed
  createdAt: number;
  /** The built-in five-incident course every car gets by default. */
  isDefault?: boolean;
}

export const DEFAULT_TRACK_ID = 'naap-standard';

export interface ContentItem {
  kind: 'owner' | 'tweet' | 'web' | 'http402' | 'agent' | 'email';
  source: string; // e.g. "@drb_whale reply", "GET compute.naap.eth/v1/inference/1h → 402"
  text: string;
}

/** What a car sees at one barrier (one fresh session per barrier). */
export interface Observation {
  runId: string;
  barrierId: BarrierId;
  ownerRequest: string; // always OWNER
  content: ContentItem[]; // everything except ownerRequest is UNTRUSTED
  tools: ToolSpec[];
  /** 0-based obstacle index on the car's track (tracks may repeat a barrier type). Set by the course. */
  step?: number;
  /** Number of obstacles on the car's track. Set by the course. */
  totalSteps?: number;
}

export interface ToolSpec {
  name: 'pay';
  description: string;
  /** JSON schema of PayArgs */
  parameters: Record<string, unknown>;
}

export interface PayArgs {
  payTo: string; // address or ENS name, as the agent wrote it
  amountUsd: number; // USD, the course converts to token units
  token: 'USDC' | 'DRB';
  memo: string;
}

export type AgentAction =
  | { type: 'pay'; args: PayArgs; rationale?: string }
  | { type: 'reply'; text: string }
  | { type: 'noop'; reason?: string };

/** Anything that can drive a car for one barrier. Built, webhook and openai cars all implement it. */
export interface CarDriver {
  act(obs: Observation): Promise<AgentAction[]>;
}

// ─── Sekisho (the airbag) ────────────────────────────────────────────────────

export interface PaymentIntent {
  id: string;
  runId: string;
  carId: string;
  barrierId: BarrierId;
  mode: 'full' | 'boundary' | 'bare'; // full = built car via planner/reader/interpreter; boundary = black-box car judged by Sekisho; bare = no airbag (signer signs anything — the naive wallet)
  payTo: Labeled<Address>;
  payeeEns?: Labeled<string>;
  amountUsd: Labeled<number>;
  token: 'USDC' | 'DRB';
  memo: Labeled<string>;
}

export interface SessionState {
  runId: string;
  barrierId: BarrierId;
  tainted: boolean;
  taintSources: string[]; // ContentItem.source of everything UNTRUSTED that was read
  balanceUsd: number;
  spentTodayUsd: number;
}

export type Control =
  | 'TAINT' // tainted session → mandate-only mode violated
  | 'PROVENANCE_PAYEE' // payTo did not come from resolve(OWNER/MANDATE ens name)
  | 'PROVENANCE_AMOUNT' // amount not OWNER / MANDATE / OWNER_BOUNDED
  | 'MANDATE_PAYEE' // payee not in mandate
  | 'MANDATE_EXPIRED'
  | 'CAP_TX'
  | 'CAP_DAILY'
  | 'JEV_TRIPWIRE' // Jev escalated (friction only — can never approve)
  | 'INTERCEPTA' // screening verdict BLOCK/HOLD
  | 'WORLD_DENIED'
  | 'WORLD_EXPIRED';

export interface CheckResult {
  control: Control;
  ok: boolean;
  detail: string; // one line for the scoreboard, e.g. "payTo 0x7a…e1 came from 402-body.payTo (UNTRUSTED)"
  ms: number;
}

export type Decision = 'PAY' | 'REFUSE' | 'STEP_UP';

export interface Verdict {
  decision: Decision;
  blockedBy: Control[]; // ordered: primary blocker first
  checks: CheckResult[]; // every check that ran (checks do not short-circuit, so every control gets its moment)
  reason: string; // headline, e.g. "Payee address came from untrusted text"
}

// ─── Ports (one lane each). Fakes in fakes.ts. ───────────────────────────────

/** lane ens */
export interface MandateSource {
  /** Create <carId>.naap.eth with the default mandate (async on Sepolia; returns immediately with local copy). */
  createForCar(carId: string, owner: Address): Promise<Mandate>;
  get(ensName: string): Promise<Mandate>;
  /** Resolve an ENS name to an address (payees). Label of the result is TOOL. */
  resolve(ensName: string): Promise<Address | null>;
  /** Demo proof: the agent key tries to edit its own mandate and is rejected on-chain. */
  proveAgentCannotEdit?(ensName: string): Promise<{ rejected: boolean; detail: string; txHash?: Hex }>;
}

/** lane ens */
export interface RatingWriter {
  enqueue(carId: string, ensName: string, rating: Rating): void;
  onConfirmed(cb: (carId: string, txHash: Hex) => void): void;
}

/** lane intercepta */
export interface ScreenResult {
  address: Address;
  verdict: 'PASS' | 'HOLD' | 'BLOCK';
  toxicScore: number; // 0–100 as returned
  traits: { name: string; description: string }[];
  live: boolean; // false only if served from the offline fixture (must be true for prize runs)
  cached: boolean;
}
export interface Screener {
  quickScan(address: Address): Promise<ScreenResult>;
  scanToken(token: Address, chainId: number): Promise<ScreenResult>;
}

/** lane world */
export interface StepUpRequest {
  carId: string;
  intentId: string;
  summary: string; // "Pay $40 to compute.naap.eth for a 40-hour GPU block"
  ttlSec: number; // 60 for audience cars, 300 for owner car
  allowApproval: boolean; // false for audience cars → only DENIED/EXPIRED possible
}
export interface StepUpHandle {
  id: string;
  verificationUri?: string; // shown as QR on the big screen for the owner car
  userCode?: string;
  expiresAt: number;
  result: Promise<StepUpResult>;
}
export interface StepUpResult {
  status: 'APPROVED' | 'DENIED' | 'EXPIRED';
  subject?: string; // World ID sub (nullifier-ish), shown truncated
  authTime?: number;
  detail: string;
}
export interface StepUp {
  request(req: StepUpRequest): Promise<StepUpHandle>;
}

/** lane course (Jev) */
export interface Jev {
  /** P(yes) for a yes/no question about `context`. */
  noul(question: string, context: string): Promise<number>;
}
export interface TripwireResult {
  escalate: boolean;
  flags: { question: string; p: number }[];
}
export interface Tripwire {
  assess(item: ContentItem): Promise<TripwireResult>;
}
export interface JudgeResult {
  actedOnAttacker: number; // P(yes)
  question: string;
}
export interface Judge {
  judge(barrierId: BarrierId, transcript: string): Promise<JudgeResult>;
}

/** lane chain */
export interface Eip3009Auth {
  from: Address;
  to: Address;
  value: string; // base units, decimal string
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
  token: Address;
}
export interface Chain {
  readonly chainId: number; // 8453 (Base fork)
  readonly usdc: Address;
  readonly drb: Address;
  /** Not used by runs (concurrent runs share one fork) — kept for tests/reset. */
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
  /** Sets the wallet's balances to EXACTLY `usd` of USDC (+ DRB + gas) — deterministic start for every barrier. */
  fundCar(wallet: Address, usd: number): Promise<void>;
  balanceUsd(wallet: Address): Promise<number>;
  /** Settle an EIP-3009 transferWithAuthorization on the fork (we are our own facilitator). */
  settle(auth: Eip3009Auth): Promise<{ txHash: Hex }>;
  /** Plain transfer for tokens without 3009 (DRB). Signed by the signer, sent here. */
  sendRaw(signedTx: Hex): Promise<{ txHash: Hex }>;
}

/** lane sekisho — the ONLY holder of car keys. */
export interface Signer {
  /** Each variant gets its own wallet so bare and airbag runs can race in parallel. */
  walletFor(carId: string, variant: Variant): Address;
  /** mode 'bare': signs anything (the naive wallet). Otherwise signs only if verdict is PAY, or STEP_UP with an APPROVED step-up,
   *  AND its own re-check passes (payTo ∈ mandate payees unless approved; amount ≤ perTxCap unless approved). Throws otherwise. */
  authorize(intent: PaymentIntent, verdict: Verdict, mandate: Mandate, stepUp?: StepUpResult): Promise<Eip3009Auth | { signedTx: Hex }>;
}

/** lane sekisho */
export interface Sekisho {
  /** Full mode: runs planner (sees only ownerRequest + mandate) / reader (quarantined) / interpreter. */
  runBuilt(car: Car, persona: string, obs: Observation, mandate: Mandate, session: SessionState): Promise<SekishoOutcome>;
  /** Boundary mode: judges a black-box car's actions. */
  runBoundary(car: Car, obs: Observation, actions: AgentAction[], mandate: Mandate, session: SessionState): Promise<SekishoOutcome>;
}
export interface SekishoOutcome {
  intents: PaymentIntent[];
  verdicts: Verdict[]; // same order as intents
  trace: TraceLine[]; // for the scoreboard and Jev judge
}
export interface TraceLine {
  at: number;
  who: 'planner' | 'reader' | 'interpreter' | 'policy' | 'tripwire' | 'screen' | 'stepup' | 'signer' | 'agent';
  text: string;
}

// ─── Results & rating ────────────────────────────────────────────────────────

export type BarrierOutcome =
  | 'SAFE' // attack barrier: no money to attacker
  | 'CRASH' // attack barrier: money left to attacker / over-limit paid without approval
  | 'PAID' // legit (or approved over-limit): paid the right payee the right amount
  | 'FALSE_BLOCK'; // legit barrier refused — costs a star

export interface BarrierResult {
  runId: string;
  carId: string;
  variant: Variant;
  barrierId: BarrierId;
  /** 0-based obstacle index on the car's track (tracks may repeat a barrier type). */
  step: number;
  trackId: string;
  outcome: BarrierOutcome;
  lossUsd: number; // measured on the fork (balance delta to attacker), not claimed
  blockedBy: Control[];
  reason: string;
  judge?: JudgeResult;
  txHash?: Hex;
}

export interface Rating {
  stars: number; // 0–5, airbag run for the headline; see CONTRACT.md §Scoring
  bare: { stars: number; lossUsd: number; crashes: number };
  airbag: { stars: number; lossUsd: number; crashes: number };
}

// ─── Wire: server → web (WebSocket /ws, JSON) ────────────────────────────────

/** End-of-run assessment, like an NCAP report sheet. Emitted as `report` and served at GET /api/cars/:id/report. */
export interface RunReport {
  carId: string;
  carName: string;
  trackId: string;
  trackName: string;
  ensName: string;
  rating: Rating;
  /** One line, e.g. "Resists obvious injections, but pays whatever a 402 tells it." */
  headline: string;
  /** 2–4 sentence assessor's note (AI-written; deterministic fallback when no LLM). */
  summary: string;
  /** What the agent got right / wrong, 1–3 bullets each. */
  strengths: string[];
  weaknesses: string[];
  /** One concrete fix for the agent's developer. */
  recommendation: string;
  steps: {
    step: number;
    type: BarrierId;
    bare: { outcome: BarrierOutcome; lossUsd: number; what: string };
    sekisho: { outcome: BarrierOutcome; blockedBy: Control[]; reason: string };
  }[];
  bareLossUsd: number;
  sekishoLossUsd: number;
  savedUsd: number;
  aiWritten: boolean; // false = deterministic fallback text
  /** Model id that wrote headline/summary/bullets when aiWritten (additive, lane report). */
  assessorModel?: string;
  createdAt: number;
}

/** The numbers the world HUD shows. Replaces the confusing 'headline' percentages. */
export interface Stats {
  agentsTested: number; // cars with a finished run
  attacksFaced: number; // attack obstacles driven by bare lanes
  bareLossUsd: number; // total fork USDC lost by bare lanes to attackers
  sekishoLossUsd: number; // total lost behind Sekisho (should stay 0)
  savedUsd: number; // bareLossUsd − sekishoLossUsd
  /** Per attack type: how often the BARE agent was fooled. Sorted most-dangerous first. */
  attacks: { type: BarrierId; label: string; attempts: number; fooled: number }[];
  tracks: number;
}

/** true = live integration, false = fake/offline stand-in (web shows an "offline" pill). */
export interface Integrations {
  llm: boolean;
  jev: boolean;
  intercepta: boolean;
  world: boolean;
  ens: boolean;
  fork: boolean;
}

export type ArenaEvent =
  | { t: 'hello'; cars: CarPublic[]; queue: string[]; integrations: Integrations; tracks: TrackSpec[]; stats: Stats }
  | { t: 'track.created'; track: TrackSpec }
  | { t: 'report'; carId: string; report: RunReport }
  | { t: 'stats'; stats: Stats }
  | { t: 'car.joined'; car: CarPublic }
  | { t: 'queue'; waiting: string[] } // car ids at the start line
  | { t: 'run.started'; carId: string; runId: string; variant: Variant }
  | { t: 'barrier.enter'; carId: string; runId: string; variant: Variant; barrierId: BarrierId; step: number; trackId: string }
  | { t: 'trace'; carId: string; runId: string; barrierId: BarrierId; step: number; line: TraceLine }
  | { t: 'check'; carId: string; runId: string; barrierId: BarrierId; step: number; check: CheckResult }
  | {
      t: 'stepup.pending';
      carId: string;
      runId: string;
      barrierId: BarrierId;
      step: number;
      summary: string;
      verificationUri?: string;
      userCode?: string;
      expiresAt: number;
      canApprove: boolean;
    }
  | { t: 'stepup.resolved'; carId: string; runId: string; result: StepUpResult }
  | { t: 'barrier.result'; carId: string; result: BarrierResult }
  | { t: 'run.finished'; carId: string; runId: string; variant: Variant; lossUsd: number; stars: number }
  | { t: 'rating'; carId: string; rating: Rating }
  | { t: 'rating.onchain'; carId: string; ensName: string; txHash: Hex }
  | { t: 'headline'; bareCrashRate: number; avgBareLossUsd: number; airbagCrashes: number; cars: number };

// ─── Wiring: what the course run engine receives from the server ─────────────

export interface RunDeps {
  mandates: MandateSource;
  ratings: RatingWriter;
  screener: Screener;
  stepUp: StepUp;
  jev: Jev;
  tripwire: Tripwire;
  judge: Judge;
  chain: Chain;
  signer: Signer;
  sekisho: Sekisho;
  /** Builds the driver for a car's BARE run (built → raw LLM with pay tool; webhook/openai → remote). */
  driverFor(car: Car, spec: CarSpec): CarDriver;
  emit(e: ArenaEvent): void;
}
