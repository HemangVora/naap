import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MAX_CONCURRENT_RUNS, RUN_COOLDOWN_PER_PHONE_SEC,
  type ArenaEvent, type Car, type CarSpec, type Rating,
} from '@crumple/core';
import { Store, toPublic } from './store.js';
import { Bus } from './bus.js';
import { Cooldown, RunQueue } from './queue.js';
import { carId, validateSpec, type SpecInput } from './validate.js';

/** Global bound on waiting cars (each run costs LLM credit). */
const MAX_QUEUED_CARS = Number(process.env.MAX_QUEUED_CARS ?? 12);
import type { Wiring } from './wiring.js';

export async function buildApp(w: Wiring, store = new Store()) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
  const bus = new Bus();
  const cooldown = new Cooldown(RUN_COOLDOWN_PER_PHONE_SEC);
  const queue = new RunQueue(MAX_CONCURRENT_RUNS, (waiting) => bus.emit({ t: 'queue', waiting }));
  /** Connected-agent keys live only here, only until the run ends. */
  const secrets = new Map<string, string>();

  const headline = (): ArenaEvent => {
    const ratings = store.ratings();
    const bareCrashed = ratings.filter((r) => r.bare.crashes > 0).length;
    return {
      t: 'headline',
      bareCrashRate: ratings.length ? bareCrashed / ratings.length : 0,
      avgBareLossUsd: ratings.length ? ratings.reduce((s, r) => s + r.bare.lossUsd, 0) / ratings.length : 0,
      airbagCrashes: ratings.reduce((s, r) => s + r.airbag.crashes, 0),
      cars: ratings.length,
    };
  };

  bus.on((e) => {
    if (e.t === 'barrier.result') store.putResult(e.result);
    if (e.t === 'rating') store.setRating(e.carId, e.rating);
  });
  w.deps.ratings.onConfirmed((id, txHash) => {
    store.setRatingTx(id, txHash);
    const car = store.getCar(id);
    if (car) bus.emit({ t: 'rating.onchain', carId: id, ensName: car.ensName, txHash });
  });

  const deps = { ...w.deps, emit: bus.emit };

  async function startRun(car: Car, spec: CarSpec) {
    queue.add(car.id, async () => {
      try {
        const rating: Rating = await w.runCar(car, spec, deps);
        store.setRating(car.id, rating);
      } finally {
        secrets.delete(car.id);
        bus.emit(headline());
      }
    });
  }

  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true, integrations: w.integrations }));

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (e: ArenaEvent) => socket.readyState === 1 && socket.send(JSON.stringify(e));
    send({ t: 'hello', cars: store.publicCars(12), queue: queue.ids(), integrations: w.integrations });
    send(headline());
    const off = bus.on(send);
    socket.on('close', off);
  });

  app.post('/api/cars', async (req, reply) => {
    const body = { ...((req.body ?? {}) as SpecInput) };
    // Header or body only — never the query string, which ends up in request logs.
    body.ownerToken = String(req.headers['x-owner-token'] ?? body.ownerToken ?? '');
    const spec = validateSpec(body, process.env.OWNER_TOKEN);
    if (typeof spec !== 'string' && (body as { isOwnerCar?: boolean }).isOwnerCar && !spec.isOwnerCar)
      return reply.code(403).send({ error: 'owner token does not match' });
    if (typeof spec === 'string') return reply.code(400).send({ error: spec });
    // Cooldown keyed by IP + phone id: the header alone is client-controlled, and IP alone would lock out a whole venue NAT.
    // The hard cost bound is the global queue cap below, which a spoofed header cannot bypass.
    const phone = `${req.ip}|${String(req.headers['x-phone-id'] ?? '').slice(0, 64)}`;
    const wait = spec.isOwnerCar ? 0 : cooldown.check(phone);
    if (wait) return reply.code(429).send({ error: `One car per minute — try again in ${wait}s` });
    if (!spec.isOwnerCar && queue.ids().length >= MAX_QUEUED_CARS)
      return reply.code(429).send({ error: 'The start line is full — try again in a minute' });
    cooldown.mark(phone);

    let id = carId(spec.name);
    while (store.getCar(id)) id = carId(spec.name);
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
    store.putCar(car);
    if (openaiApiKey) secrets.set(id, openaiApiKey);
    bus.emit({ t: 'car.joined', car: toPublic(car) });
    await startRun(car, { ...publicSpec, openaiApiKey });
    return { car: toPublic(car), sessionToken: car.sessionToken };
  });

  app.get('/api/cars', async () => ({ cars: store.publicCars() }));
  app.get<{ Params: { id: string } }>('/api/cars/:id', async (req, reply) => {
    const car = store.publicCar(req.params.id);
    if (!car) return reply.code(404).send({ error: 'no such car' });
    return { car, results: store.results(req.params.id) };
  });

  await w.mountX402?.(app);

  const dist = resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/x402')) return reply.code(404).send({ error: 'not found' });
      const page = req.url.startsWith('/join') ? 'join.html' : req.url.startsWith('/car') ? 'car.html' : 'index.html';
      return reply.sendFile(existsSync(resolve(dist, page)) ? page : 'index.html');
    });
  }
  return app;
}
