import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_TRACK, DEFAULT_TRACK_ID, MAX_CONCURRENT_RUNS, RUN_COOLDOWN_PER_PHONE_SEC,
  type ArenaEvent, type Car, type CarSpec, type Rating, type Stats, type TrackSpec,
} from '@crumple/core';
import { toPublic, type CarStore } from './public.js';
import { Bus } from './bus.js';
import { Cooldown, RunQueue } from './queue.js';
import { carId, randomSuffix, trackSlug, validateSpec, validateTrack, type SpecInput, type TrackInput } from './validate.js';
import { computeStats } from './stats.js';
import { McpRegistry, mountMcp, type Admitted, type AdmitMeta } from './mcp.js';

/** Global bound on waiting cars (each run costs LLM credit). */
const MAX_QUEUED_CARS = Number(process.env.MAX_QUEUED_CARS ?? 12);
/** One new track per client per this many seconds; and a global ceiling on the registry. */
const TRACK_COOLDOWN_SEC = Number(process.env.TRACK_COOLDOWN_SEC ?? 30);
const MAX_TRACKS = Number(process.env.MAX_TRACKS ?? 500);
/** How many tracks `hello` carries. */
const HELLO_TRACKS = 100;
import type { Wiring } from './wiring.js';

/** `store` defaults to the SQLite Store (loaded lazily so node:sqlite is only touched when needed). */
export async function buildApp(w: Wiring, store?: CarStore) {
  const db: CarStore = store ?? new (await import('./store.js')).Store();
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
  const stats = (): Stats => computeStats(db.allResults(), db.ratings().length, db.trackCount());
  /** Deferred so listeners see `barrier.result` / `rating` before the stats it caused. */
  const emitStats = () => queueMicrotask(() => bus.emit({ t: 'stats', stats: stats() }));

  bus.on((e) => {
    if (e.t === 'barrier.result') {
      db.putResult(e.result);
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

  async function startRun(car: Car, spec: CarSpec) {
    const track = db.getTrack(spec.trackId ?? DEFAULT_TRACK_ID) ?? DEFAULT_TRACK;
    queue.add(car.id, async () => {
      let rating: Rating | null = null;
      try {
        rating = await w.runCar(car, spec, deps, track);
        db.setRating(car.id, rating);
      } finally {
        secrets.delete(car.id);
        if (spec.kind === 'mcp') mcp.finish(car.id, rating);
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
      ensName: `${id}.crumple.eth`,
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
    send({ t: 'hello', cars: db.publicCars(12), queue: queue.ids(), integrations: w.integrations, tracks: db.tracks(HELLO_TRACKS), stats: stats() });
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
  app.get('/api/tracks', async () => ({ tracks: db.tracks() }));
  app.get<{ Params: { id: string } }>('/api/tracks/:id', async (req, reply) => {
    const track = db.getTrack(req.params.id);
    if (!track) return reply.code(404).send({ error: 'no such track' });
    return { track };
  });
  app.post('/api/tracks', async (req, reply) => {
    const t = validateTrack((req.body ?? {}) as TrackInput);
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
    bus.emit({ t: 'track.created', track });
    emitStats();
    return reply.code(201).send({ track });
  });
  app.get<{ Params: { id: string } }>('/api/cars/:id', async (req, reply) => {
    const car = db.publicCar(req.params.id);
    if (!car) return reply.code(404).send({ error: 'no such car' });
    return { car, results: db.results(req.params.id) };
  });

  await mountMcp(app, {
    admit,
    registry: mcp,
    carRating: (id) => db.publicCar(id)?.rating,
    carTrack: (id) => db.getTrack(db.getCar(id)?.spec.trackId ?? DEFAULT_TRACK_ID) ?? DEFAULT_TRACK,
    carResults: (id) => db.results(id),
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
