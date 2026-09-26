import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_TRACK, DEFAULT_TRACK_ID, INCIDENT_ENS_KEYS, INCIDENT_LIMITS, MAX_CONCURRENT_RUNS, PARENT_ENS, RUN_COOLDOWN_PER_PHONE_SEC, skinFor,
  type ArenaEvent, type Car, type CarSpec, type CustomIncident, type Rating, type Stats, type TrackSpec,
} from '@crumple/core';
import { publicTrack, toPublic, type CarStore } from './public.js';
import { Bus } from './bus.js';
import { Cooldown, RunQueue } from './queue.js';
import { carId, randomSuffix, trackSlug, validateSpec, validateTrack, type SpecInput, type TrackInput } from './validate.js';
import { computeStats } from './stats.js';
import { McpRegistry, mountMcp, type Admitted, type AdmitMeta } from './mcp.js';
import { buildReport, reportLlmFromEnv, type ReportLlm } from './report.js';
import { draftIncident, incidentHash, incidentId, validateIncident } from './incidents.js';
import { createGuardEngine, GUARD_PRESETS, type GuardReport } from '@crumple/guard';
import { draftContract, GUARD_LIMITS } from './guard.js';

/** Global bound on waiting cars (each run costs LLM credit). */
const MAX_QUEUED_CARS = Number(process.env.MAX_QUEUED_CARS ?? 12);
/** One new track per client per this many seconds; and a global ceiling on the registry. */
const TRACK_COOLDOWN_SEC = Number(process.env.TRACK_COOLDOWN_SEC ?? 30);
const MAX_TRACKS = Number(process.env.MAX_TRACKS ?? 500);
/** Upper bound on one Deploy Guard audit (compile + fork deploy + probes) before it degrades to the static scan. */
const GUARD_AUDIT_TIMEOUT_MS = 60_000;
/** How many tracks `hello` carries. */
const HELLO_TRACKS = 100;
import type { Wiring } from './wiring.js';

export interface AppOptions {
  /** Writes the end-of-run report prose. Default: Claude Haiku from env (none under vitest); null = deterministic text. */
  reportLlm?: ReportLlm | null;
}

/** `store` defaults to the SQLite Store (loaded lazily so node:sqlite is only touched when needed). */
export async function buildApp(w: Wiring, store?: CarStore, opts: AppOptions = {}) {
  const db: CarStore = store ?? new (await import('./store.js')).Store();
  const reportLlm = opts.reportLlm !== undefined ? opts.reportLlm : process.env.VITEST ? null : reportLlmFromEnv();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // /join?owner=<token> is a page URL; strip every query string from logs.
      serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url.split('?')[0] }) },
    },
    trustProxy: true,
    // Long-lived /ws and /mcp (SSE) connections would otherwise keep close() waiting while clients auto-reconnect.
    forceCloseConnections: true,
  });
  const bus = new Bus();
  const cooldown = new Cooldown(RUN_COOLDOWN_PER_PHONE_SEC);
  const queue = new RunQueue(MAX_CONCURRENT_RUNS, (waiting) => bus.emit({ t: 'queue', waiting }));
  /** Connected-agent keys live only here, only until the run ends. */
  const secrets = new Map<string, string>();
  /** MCP cars: carId ⇄ the McpDriver its session drives. */
  const mcp = new McpRegistry();

  const trackCooldown = new Cooldown(TRACK_COOLDOWN_SEC);
  /** Custom incidents: one publish per client per 20 s (≤ 10 a minute across everyone), one draft per 8 s (≤ 20 a minute across everyone). */
  const incidentCooldown = new Cooldown(20);
  const publishWindow: number[] = [];
  const draftCooldown = new Cooldown(8);
  const draftWindow: number[] = [];
  /** Deploy Guard: fork deploy + probes when the fork is up, static scan otherwise. Draft and audit each: one per 8 s per client, ≤ 20 a minute across everyone. */
  const guard = createGuardEngine({ rpcUrl: w.guardRpcUrl });
  const staticGuard = w.guardRpcUrl ? createGuardEngine({}) : guard;
  const guardDraftCooldown = new Cooldown(8);
  const guardDraftWindow: number[] = [];
  const guardAuditCooldown = new Cooldown(8);
  const guardAuditWindow: number[] = [];
  /** Audits share one fork, so they run one at a time (snapshot/revert of one must not interleave with another's deploy). */
  let guardChain: Promise<unknown> = Promise.resolve();
  /**
   * Publishes `inc-<id>.naap.eth` in the background under a per-process budget (≤ 1 registration per 60 s, ≤ 40 total):
   * each registration is a relayer transaction. Never blocks or fails the publish; over budget or ENS off → off-chain.
   */
  let lastOnchain = 0;
  let onchainCount = 0;
  const publishOnChain = (i: CustomIncident) => {
    const ens = w.incidentsEns;
    if (!ens || onchainCount >= 40 || Date.now() - lastOnchain < 60_000) return;
    lastOnchain = Date.now();
    onchainCount++;
    const label = `inc-${i.id}`;
    const ensName = `${label}.${PARENT_ENS}`;
    void (async () => {
      try {
        await ens.register(label);
        const r = await ens.writeText(ensName, [
          { key: INCIDENT_ENS_KEYS.title, value: i.title },
          { key: INCIDENT_ENS_KEYS.author, value: i.author },
          { key: INCIDENT_ENS_KEYS.cls, value: i.cls },
          { key: INCIDENT_ENS_KEYS.hash, value: incidentHash(i) },
          { key: INCIDENT_ENS_KEYS.url, value: `${process.env.PUBLIC_URL ?? ''}/api/incidents/${i.id}` },
        ]);
        if (r.status !== 'success') throw new Error(`reverted ${r.hash}`);
        db.setIncidentEns(i.id, ensName, r.hash);
        bus.emit({ t: 'incident.onchain', id: i.id, ensName, txHash: r.hash });
      } catch (e) {
        app.log.warn({ err: String(e) }, `incident ENS publish failed for ${ensName}`);
      }
    })();
  };
  const stats = (): Stats => computeStats(db.allResults(), db.ratings().length, db.trackCount());
  /** Deferred so listeners see `barrier.result` / `rating` before the stats it caused. */
  const emitStats = () => queueMicrotask(() => bus.emit({ t: 'stats', stats: stats() }));

  bus.on((e) => {
    if (e.t === 'barrier.result') {
      db.putResult(e.result);
      // Author credit: an unaided (bare-lane) agent fell for this visitor's incident.
      if (e.result.variant === 'bare' && e.result.outcome === 'CRASH' && e.result.incidentId) db.bumpFooled(e.result.incidentId);
      emitStats();
    }
    if (e.t === 'rating') {
      db.setRating(e.carId, e.rating);
      emitStats(); // agentsTested moved
    }
  });
  w.deps.ratings.onConfirmed((id, txHash) => {
    db.setRatingTx(id, txHash);
    const car = db.getCar(id);
    if (car) bus.emit({ t: 'rating.onchain', carId: id, ensName: car.ensName, txHash });
  });

  const deps = {
    ...w.deps,
    emit: bus.emit,
    // mcp cars are driven by the agent bound to their MCP session; both lanes get the same driver instance.
    driverFor: (car: Car, spec: CarSpec) => (spec.kind === 'mcp' ? mcp.driverFor(car.id) : w.deps.driverFor(car, spec)),
  };

  /** After `rating`: assessment sheet → reports table → `report` event. Never throws; runs off the queue slot. */
  async function produceReport(car: Car, track: TrackSpec, rating: Rating): Promise<void> {
    try {
      const report = await buildReport(car, track, db.results(car.id), rating, reportLlm, { log: (l) => app.log.warn(l) });
      db.putReport(report);
      bus.emit({ t: 'report', carId: car.id, report });
    } catch (e) {
      app.log.error(`report ${car.id}: ${(e as Error).message}`);
    }
  }

  async function startRun(car: Car, spec: CarSpec) {
    const track = db.getTrack(spec.trackId ?? DEFAULT_TRACK_ID) ?? DEFAULT_TRACK;
    queue.add(car.id, async () => {
      let rating: Rating | null = null;
      let report: Promise<void> | null = null;
      try {
        rating = await w.runCar(car, spec, deps, track);
        db.setRating(car.id, rating);
        report = produceReport(car, track, rating); // not awaited: the queue slot frees now
      } finally {
        secrets.delete(car.id);
        // MCP agents get "finished" once the report exists (≤ ~8 s later), so it can carry the verdict.
        if (spec.kind === 'mcp') {
          const r = rating;
          if (report) void report.then(() => mcp.finish(car.id, r));
          else mcp.finish(car.id, r);
        }
      }
    });
  }

  /**
   * The one admission path for every car (phone form and MCP tool alike): validation, owner token, cooldown,
   * queue cap, ENS mandate, `car.joined`, queue. `beforeQueue` lets the caller bind resources (an MCP driver) first.
   */
  async function admit(input: SpecInput, meta: AdmitMeta, beforeQueue?: (car: Car) => void): Promise<Admitted> {
    const body: SpecInput = { ...input, ownerToken: meta.ownerToken };
    const spec = validateSpec(body, process.env.OWNER_TOKEN);
    if (typeof spec === 'string') return { ok: false, code: 400, error: spec };
    if ((body as { isOwnerCar?: boolean }).isOwnerCar && !spec.isOwnerCar) return { ok: false, code: 403, error: 'owner token does not match' };
    spec.trackId ??= DEFAULT_TRACK_ID;
    if (!db.getTrack(spec.trackId)) return { ok: false, code: 400, error: `unknown track "${spec.trackId}"` };
    // Cooldown keyed by IP + client id: the id alone is client-controlled, and IP alone would lock out a whole venue NAT.
    // The hard cost bound is the global queue cap below, which a spoofed id cannot bypass.
    const key = `${meta.ip}|${meta.clientId.slice(0, 64)}`;
    const wait = spec.isOwnerCar ? 0 : cooldown.check(key);
    if (wait) return { ok: false, code: 429, error: `One car per minute — try again in ${wait}s` };
    if (!spec.isOwnerCar && queue.ids().length >= MAX_QUEUED_CARS) return { ok: false, code: 429, error: 'The start line is full — try again in a minute' };
    cooldown.mark(key);

    let id = carId(spec.name);
    while (db.getCar(id)) id = carId(spec.name);
    const { openaiApiKey, ...publicSpec } = spec;
    const car: Car = {
      id,
      spec: publicSpec,
      ensName: `${id}.${PARENT_ENS}`,
      wallet: w.deps.signer.walletFor(id, 'airbag'),
      createdAt: Date.now(),
      sessionToken: randomBytes(12).toString('hex'),
    };
    const mandate = await w.deps.mandates.createForCar(id, w.ownerAddress);
    car.ensName = mandate.ensName;
    db.putCar(car);
    if (openaiApiKey) secrets.set(id, openaiApiKey);
    beforeQueue?.(car);
    bus.emit({ t: 'car.joined', car: toPublic(car) });
    await startRun(car, { ...publicSpec, openaiApiKey });
    return { ok: true, car, spec };
  }

  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true, integrations: w.integrations }));

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (e: ArenaEvent) => socket.readyState === 1 && socket.send(JSON.stringify(e));
    send({ t: 'hello', cars: db.publicCars(12), queue: queue.ids(), integrations: w.integrations, tracks: db.tracks(HELLO_TRACKS).map(publicTrack), stats: stats() });
    const off = bus.on(send);
    socket.on('close', off);
  });

  app.post('/api/cars', async (req, reply) => {
    const body = { ...((req.body ?? {}) as SpecInput) };
    // MCP cars are created by the agent itself through the /mcp session that will drive them.
    if (body.kind === 'mcp') return reply.code(400).send({ error: 'connect your agent to /mcp and call crumple_enter_track' });
    // Header or body only — never the query string, which ends up in request logs.
    const ownerToken = String(req.headers['x-owner-token'] ?? body.ownerToken ?? '');
    const r = await admit(body, { ip: req.ip, clientId: String(req.headers['x-phone-id'] ?? ''), ownerToken });
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { car: toPublic(r.car), sessionToken: r.car.sessionToken };
  });

  app.get('/api/cars', async () => ({ cars: db.publicCars() }));

  // ─── tracks ────────────────────────────────────────────────────────────────
  app.get('/api/tracks', async () => ({ tracks: db.tracks().map(publicTrack) }));
  app.get<{ Params: { id: string } }>('/api/tracks/:id', async (req, reply) => {
    const track = db.getTrack(req.params.id);
    if (!track) return reply.code(404).send({ error: 'no such track' });
    return { track: publicTrack(track) };
  });
  app.post('/api/tracks', async (req, reply) => {
    const t = validateTrack((req.body ?? {}) as TrackInput, (id) => db.getIncident(id));
    if (typeof t === 'string') return reply.code(400).send({ error: t });
    const key = `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`;
    const wait = trackCooldown.check(key);
    if (wait) return reply.code(429).send({ error: `One track per ${TRACK_COOLDOWN_SEC}s — try again in ${wait}s` });
    if (db.trackCount() >= MAX_TRACKS) return reply.code(429).send({ error: 'The proving ground is full' });
    trackCooldown.mark(key);
    const base = trackSlug(t.name);
    let id = base;
    while (db.getTrack(id)) id = `${base.slice(0, 27)}-${randomSuffix()}`;
    const track: TrackSpec = { id, ...t, createdAt: Date.now() };
    db.putTrack(track);
    // Clients get the slim view; the full snapshot stays in the store for startRun / the report.
    bus.emit({ t: 'track.created', track: publicTrack(track) });
    emitStats();
    return reply.code(201).send({ track: publicTrack(track) });
  });

  // ─── custom incidents ──────────────────────────────────────────────────────
  app.post('/api/incidents/draft', async (req, reply) => {
    const b = (req.body ?? {}) as { prompt?: unknown; cls?: unknown };
    const cls = b.cls === 'legit' ? 'legit' : 'attack';
    const prompt = String(b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'Describe the incident first.' });
    const key = `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`;
    const wait = draftCooldown.check(key);
    if (wait) return reply.code(429).send({ error: `One draft per 8s — try again in ${wait}s` });
    const now = Date.now();
    while (draftWindow.length && now - draftWindow[0]! > 60_000) draftWindow.shift();
    if (draftWindow.length >= 20) return reply.code(429).send({ error: 'Lots of people are writing incidents — try again in a minute' });
    draftCooldown.mark(key);
    draftWindow.push(now);
    return { draft: await draftIncident(prompt, cls, w.draftLlm) };
  });
  app.post('/api/incidents', async (req, reply) => {
    const v = validateIncident(req.body);
    if (typeof v === 'string') return reply.code(400).send({ error: v });
    const key = `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`;
    const wait = incidentCooldown.check(key);
    if (wait) return reply.code(429).send({ error: `One incident per 20s — try again in ${wait}s` });
    const now = Date.now();
    while (publishWindow.length && now - publishWindow[0]! > 60_000) publishWindow.shift();
    if (publishWindow.length >= 10) return reply.code(429).send({ error: 'Lots of people are publishing — try again in a minute' });
    if (db.incidentCount() >= INCIDENT_LIMITS.maxIncidents) return reply.code(429).send({ error: 'The incident library is full' });
    incidentCooldown.mark(key);
    publishWindow.push(now);
    let id = incidentId(v.title);
    while (db.getIncident(id)) id = incidentId(v.title);
    const incident: CustomIncident = { ...v, id, skin: skinFor(v.cls, v.content), fooled: 0, createdAt: Date.now() };
    db.putIncident(incident);
    bus.emit({ t: 'incident.created', incident });
    publishOnChain(incident);
    return reply.code(201).send({ incident });
  });
  /** Slim rows: everything but the content and the owner request (the page shows those on /api/incidents/:id). */
  app.get('/api/incidents', async () => ({ incidents: db.incidents().map(({ content, ownerRequest, ...slim }) => slim) }));
  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (req, reply) => {
    const incident = db.getIncident(req.params.id);
    return incident ? { incident } : reply.code(404).send({ error: 'no such incident' });
  });

  // ─── deploy guard ──────────────────────────────────────────────────────────
  /** Per-client 8 s cooldown + global 20/min window; returns the 429 message, or null and consumes a slot. */
  const guardSlot = (cd: Cooldown, win: number[], key: string, what: string): string | null => {
    const wait = cd.check(key);
    if (wait) return `One ${what} per 8s — try again in ${wait}s`;
    const now = Date.now();
    while (win.length && now - win[0]! > 60_000) win.shift();
    if (win.length >= 20) return `Lots of people are using the guard — try again in a minute`;
    cd.mark(key);
    win.push(now);
    return null;
  };
  app.get('/api/guard/presets', async () => ({ presets: GUARD_PRESETS }));
  app.post('/api/guard/draft', async (req, reply) => {
    const prompt = String(((req.body ?? {}) as { prompt?: unknown }).prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'Describe the contract first.' });
    if (prompt.length > GUARD_LIMITS.promptMax) return reply.code(400).send({ error: `Keep the request under ${GUARD_LIMITS.promptMax} characters.` });
    const busy = guardSlot(guardDraftCooldown, guardDraftWindow, `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`, 'draft');
    if (busy) return reply.code(429).send({ error: busy });
    return draftContract(prompt, w.draftLlm);
  });
  app.post('/api/guard/audit', async (req, reply) => {
    const raw = ((req.body ?? {}) as { source?: unknown }).source;
    const source = typeof raw === 'string' ? raw : '';
    if (!source.trim()) return reply.code(400).send({ error: 'Paste or draft a contract first.' });
    if (Buffer.byteLength(source, 'utf8') > GUARD_LIMITS.sourceMaxBytes) return reply.code(400).send({ error: 'Contract source must be 12 KB or less.' });
    const busy = guardSlot(guardAuditCooldown, guardAuditWindow, `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`, 'audit');
    if (busy) return reply.code(429).send({ error: busy });
    const run = guardChain.then(async (): Promise<GuardReport> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        // Capped so a hung fork cannot wedge the chain for everyone behind it.
        const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('audit timed out')), GUARD_AUDIT_TIMEOUT_MS); });
        return await Promise.race([guard.audit(source), timeout]);
      } catch (e) {
        // Bad Solidity comes back as a COMPILE_ERROR report; a throw here is the fork misbehaving, so degrade to static.
        app.log.warn({ err: String(e) }, 'guard audit failed on the fork; static-only report');
        return staticGuard.audit(source);
      } finally {
        clearTimeout(timer);
      }
    });
    guardChain = run.catch(() => {});
    return { report: await run };
  });

  app.get<{ Params: { id: string } }>('/api/cars/:id', async (req, reply) => {
    const car = db.publicCar(req.params.id);
    if (!car) return reply.code(404).send({ error: 'no such car' });
    return { car, results: db.results(req.params.id) };
  });
  app.get<{ Params: { id: string } }>('/api/cars/:id/report', async (req, reply) => {
    const report = db.getReport(req.params.id);
    if (!report) return reply.code(404).send({ error: db.getCar(req.params.id) ? 'report not ready' : 'no such car' });
    return { report };
  });

  await mountMcp(app, {
    admit,
    registry: mcp,
    carRating: (id) => db.publicCar(id)?.rating,
    carTrack: (id) => db.getTrack(db.getCar(id)?.spec.trackId ?? DEFAULT_TRACK_ID) ?? DEFAULT_TRACK,
    carResults: (id) => db.results(id),
    carReport: (id) => db.getReport(id),
    log: (line) => app.log.info(`[mcp] ${line}`),
  });

  await w.mountX402?.(app);

  const dist = resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/x402') || req.url.startsWith('/mcp')) return reply.code(404).send({ error: 'not found' });
      const path = req.url.split('?')[0]!;
      const page = path.startsWith('/join') ? 'join.html' : path.startsWith('/car') ? 'car.html' : path.startsWith('/tracks') ? 'tracks.html'
        : path.startsWith('/world') ? 'world.html' : path.startsWith('/classic') ? 'classic.html' : 'index.html';
      return reply.sendFile(existsSync(resolve(dist, page)) ? page : 'index.html');
    });
  }
  return app;
}
