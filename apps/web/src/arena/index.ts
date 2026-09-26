import * as THREE from 'three';
import type { ArenaEvent, BarrierId, Variant } from '../types';
import { BARRIERS, fmtUsd } from '../types';
import { Store } from '../store';
import { connectFeed, isMock } from '../feed';
import { el } from '../dom';
import { CameraRig } from './camera';
import { CarMesh } from './car';
import { Gate, Block } from './fixtures';
import { buildHall, STATION_X, START_X, END_X, MAX_SLOTS, laneZ, slotZ, LANE_DZ } from './hall';
import { makePools } from './particles';
import { createHud } from '../hud';

type Phase = 'parked' | 'approach' | 'waiting' | 'charging' | 'through' | 'exit';

interface LaneActor {
  variant: Variant;
  car: CarMesh;
  x: number;
  targetX: number;
  speed: number;
  maxSpeed: number;
  phase: Phase;
  barrier?: BarrierId;
  idleAt: number;
  finished: boolean;
}
interface CarActor {
  id: string;
  slot: number;
  joinedAt: number;
  lanes: Record<Variant, LaneActor>;
}
interface Floater {
  node: HTMLElement;
  pos: THREE.Vector3;
  until: number;
}

const KIND_LABEL: Record<string, string> = { built: 'built', webhook: 'webhook · boundary', openai: 'openai · boundary' };

export function mountArena(root: HTMLElement) {
  const store = new Store();
  const wrap = el('div', { class: 'arena' });
  const canvas = el('canvas');
  const floatLayer = el('div', { class: 'float-layer' });
  const flash = el('div', { class: 'flash' });
  wrap.append(canvas, floatLayer, flash);
  root.append(wrap);
  const hud = createHud(wrap, store, { mock: isMock() });

  // ── renderer / scene ──────────────────────────────────────────────────────
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    // No WebGL (headless capture, old GPU): keep the HUD alive on the feed and say so.
    console.warn('[arena] WebGL unavailable, HUD-only mode', err);
    wrap.append(el('div', { class: 'empty-track', html: '<b>3D track unavailable</b>This screen has no WebGL. The scoreboard still runs live.' }));
    connectFeed(store);
    return () => hud.destroy();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const { key } = buildHall(scene);
  const rig = new CameraRig(window.innerWidth / window.innerHeight);
  const pools = makePools(scene);

  const gates: (Gate | undefined)[][] = Array.from({ length: MAX_SLOTS }, () => []);
  const blocks: (Block | undefined)[][] = Array.from({ length: MAX_SLOTS }, () => []);
  const allGates: Gate[] = [];
  const allBlocks: Block[] = [];
  function ensureFixtures(slot: number) {
    if (gates[slot][0]) return;
    STATION_X.forEach((x, i) => {
      const g = new Gate(x, laneZ(slot, 'airbag'));
      const b = new Block(x, laneZ(slot, 'bare'));
      gates[slot][i] = g;
      blocks[slot][i] = b;
      allGates.push(g);
      allBlocks.push(b);
      scene.add(g.group, b.group);
    });
  }
  const gateFor = (slot: number, b: BarrierId) => gates[slot][BARRIERS.indexOf(b)]!;
  const blockFor = (slot: number, b: BarrierId) => blocks[slot][BARRIERS.indexOf(b)]!;

  // ── actors ────────────────────────────────────────────────────────────────
  const actors = new Map<string, CarActor>();
  const floaters: Floater[] = [];
  let timeScale = 1;
  let hitStopTimer: number | undefined;

  function hitStop(ms: number, scale = 0.05) {
    timeScale = scale;
    window.clearTimeout(hitStopTimer);
    hitStopTimer = window.setTimeout(() => (timeScale = 1), ms);
  }

  function freeSlot(): number {
    const used = new Set([...actors.values()].map((a) => a.slot));
    for (let s = 0; s < MAX_SLOTS; s++) if (!used.has(s)) return s;
    // evict: oldest fully finished car, else the oldest car
    const list = [...actors.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const victim = list.find((a) => a.lanes.bare.finished && a.lanes.airbag.finished) ?? list[0];
    removeActor(victim.id);
    return victim.slot;
  }

  function removeActor(id: string) {
    const a = actors.get(id);
    if (!a) return;
    for (const v of ['bare', 'airbag'] as const) a.lanes[v].car.dispose();
    for (const g of gates[a.slot]) g?.setState('idle');
    for (const b of blocks[a.slot]) b?.raise(false);
    actors.delete(id);
  }

  function spawn(id: string): CarActor {
    let a = actors.get(id);
    if (a) return a;
    const cs = store.car(id);
    const pub = cs?.car ?? { id, name: id, color: '#f5c400', kind: 'built' as const, ensName: `${id}.crumple.eth`, isOwnerCar: false };
    const slot = freeSlot();
    ensureFixtures(slot);
    const mk = (variant: Variant): LaneActor => {
      const sub = variant === 'airbag' ? `airbag · ${pub.kind === 'built' ? 'sekisho full' : 'boundary mode'}` : `bare · ${KIND_LABEL[pub.kind] ?? pub.kind}`;
      const car = new CarMesh(pub.name, sub, pub.color, variant === 'airbag');
      car.group.position.set(START_X - 6, 0, laneZ(slot, variant));
      scene.add(car.group);
      return { variant, car, x: START_X - 6, targetX: START_X, speed: 0, maxSpeed: 13, phase: 'parked', idleAt: 0, finished: false };
    };
    a = { id, slot, joinedAt: Date.now(), lanes: { bare: mk('bare'), airbag: mk('airbag') } };
    actors.set(id, a);
    return a;
  }

  function floater(text: string, pos: THREE.Vector3, tone: 'red' | 'green' | 'amber' = 'red') {
    const node = el('div', { class: `floater ${tone === 'red' ? '' : tone}`, text });
    floatLayer.append(node);
    floaters.push({ node, pos: pos.clone(), until: performance.now() + 1500 });
  }

  function lanePos(l: LaneActor, dx = 0) {
    return new THREE.Vector3(l.x + dx, 0.8, l.car.group.position.z);
  }

  function chipsFor(blockedBy: string[]) {
    return blockedBy.map((c) => c.replace('PROVENANCE_', 'PROV·').replace('MANDATE_', 'MANDATE·').replace('_', '·'));
  }

  // ── event → motion ────────────────────────────────────────────────────────
  function onEvent(e: ArenaEvent) {
    switch (e.t) {
      case 'hello':
        for (const id of [...actors.keys()]) removeActor(id);
        for (const c of e.cars) if (!c.rating) spawn(c.id);
        break;
      case 'car.joined':
        spawn(e.car.id);
        break;
      case 'run.started': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        l.targetX = START_X + 2;
        l.phase = 'approach';
        l.finished = false;
        break;
      }
      case 'barrier.enter': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        // reset the previous station on this lane so the car can pass it
        if (l.barrier) {
          if (e.variant === 'bare') blockFor(a.slot, l.barrier).raise(true);
          else {
            const g = gateFor(a.slot, l.barrier);
            if (g.state !== 'paid') g.setState('idle');
          }
        }
        l.barrier = e.barrierId;
        l.targetX = STATION_X[BARRIERS.indexOf(e.barrierId)] - 3.6;
        l.maxSpeed = 13;
        l.phase = 'approach';
        break;
      }
      case 'stepup.pending': {
        const a = spawn(e.carId);
        const g = gateFor(a.slot, e.barrierId);
        g.setState('stepup', e.summary, e.canApprove ? ['CAP·TX', 'WORLD ID'] : ['CAP·TX', 'NO OWNER']);
        g.startStepUp(Date.now(), e.expiresAt * 1000);
        floater('STEP UP', lanePos(a.lanes.airbag, 1), 'amber');
        break;
      }
      case 'stepup.resolved': {
        const a = spawn(e.carId);
        const l = a.lanes.airbag;
        if (!l.barrier) break;
        const g = gateFor(a.slot, l.barrier);
        if (e.result.status === 'APPROVED') g.setState('paid', `Owner approved via World ID${e.result.subject ? ` · ${e.result.subject}` : ''}`, ['WORLD ✓']);
        else g.setState('expired', e.result.detail, [e.result.status === 'DENIED' ? 'WORLD·DENIED' : 'WORLD·EXPIRED']);
        break;
      }
      case 'barrier.result': {
        const r = e.result;
        const a = spawn(e.carId);
        const l = a.lanes[r.variant];
        const si = BARRIERS.indexOf(r.barrierId);
        const sx = STATION_X[si];
        if (r.variant === 'bare') {
          const block = blockFor(a.slot, r.barrierId);
          if (r.outcome === 'CRASH') {
            l.phase = 'charging';
            l.maxSpeed = 24;
            l.targetX = sx - 1.55; // front bumper buried in the hazard face
            (l as LaneActor & { loss?: number }).loss = r.lossUsd;
          } else {
            block.raise(true);
            l.phase = 'through';
            l.targetX = sx + 5;
            if (r.outcome === 'PAID') floater(r.barrierId === 'over-limit' ? 'paid $40 without asking' : `+ weather report ${fmtUsd(1)}`, lanePos(l, 2), r.barrierId === 'over-limit' ? 'amber' : 'green');
            else if (r.outcome === 'SAFE') floater('SAFE', lanePos(l, 1), 'green');
            else floater('FALSE BLOCK', lanePos(l, 1), 'amber');
          }
        } else {
          const g = gateFor(a.slot, r.barrierId);
          const chips = chipsFor(r.blockedBy);
          if (r.outcome === 'PAID') {
            g.setState('paid', r.barrierId === 'over-limit' ? r.reason : `Paid ${fmtUsd(1)} · weather.crumple.eth`, r.barrierId === 'over-limit' ? ['WORLD ✓', 'PAID $40'] : ['PAID']);
            l.phase = 'through';
            l.targetX = sx + 5;
            floater(r.barrierId === 'over-limit' ? '+ 7-day forecast $40' : `+ weather report ${fmtUsd(1)}`, lanePos(l, 2), 'green');
          } else if (r.outcome === 'CRASH') {
            // airbag crash (should never happen) — treat as a hard hit against the gate
            g.setState('safe', r.reason, chips);
            l.phase = 'charging';
            l.maxSpeed = 20;
            l.targetX = sx - 1.55;
            (l as LaneActor & { loss?: number }).loss = r.lossUsd;
          } else {
            g.setState(r.outcome === 'FALSE_BLOCK' ? 'false_block' : 'safe', r.reason, chips);
            l.car.brake(1200);
            l.phase = 'waiting';
            pools.puff(lanePos(l, 1.8));
          }
        }
        break;
      }
      case 'run.finished': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        if (l.barrier) {
          if (e.variant === 'bare') blockFor(a.slot, l.barrier).raise(true);
          else {
            const g = gateFor(a.slot, l.barrier);
            if (g.state === 'safe' || g.state === 'expired' || g.state === 'false_block') {
              // arm lifts, plaque stays
              g.setState('idle');
            }
          }
        }
        l.phase = 'exit';
        l.maxSpeed = 15;
        l.targetX = END_X;
        l.finished = true;
        break;
      }
    }
  }

  function impact(a: CarActor, l: LaneActor) {
    const loss = (l as LaneActor & { loss?: number }).loss ?? 0;
    const at = lanePos(l, 1.7);
    l.car.hit(1);
    pools.crash(at);
    rig.addTrauma(0.75);
    rig.crashCloseUp(at, 1200);
    hitStop(90);
    if (l.variant === 'bare' && l.barrier) blockFor(a.slot, l.barrier).kick();
    flash.classList.remove('on');
    void flash.offsetWidth; // restart the CSS animation
    flash.classList.add('on');
    window.setTimeout(() => floater(loss > 0 ? `−${fmtUsd(loss)}` : 'CRASH', at.clone().add(new THREE.Vector3(-0.5, 0.8, 0))), 120);
    l.phase = 'waiting';
  }

  store.subscribe((e) => {
    if (e) onEvent(e);
  });
  connectFeed(store).then((f) => (feed = f));
  let feed: { stop(): void } | undefined;

  // ── loop ──────────────────────────────────────────────────────────────────
  const timer = new THREE.Timer();
  const tmpV = new THREE.Vector3();
  const empty = el('div', { class: 'empty-track', html: '<b>Track is clear</b>Scan the QR to send a car' });
  wrap.append(empty);

  function step() {
    timer.update();
    const wallDt = Math.min(0.05, timer.getDelta());
    const dt = wallDt * timeScale;

    let leadX = -Infinity;
    let zSum = 0;
    let zN = 0;
    for (const a of actors.values()) {
      for (const v of ['bare', 'airbag'] as const) {
        const l = a.lanes[v];
        // longitudinal motion: accelerate, then brake so we stop exactly at targetX
        const dist = l.targetX - l.x;
        if (dist > 0.02) {
          const decel = l.phase === 'charging' ? 60 : 16;
          const desired = l.phase === 'charging' ? l.maxSpeed : Math.min(l.maxSpeed, Math.sqrt(2 * decel * dist));
          const accel = l.phase === 'charging' ? 40 : 14;
          l.speed = l.speed < desired ? Math.min(desired, l.speed + accel * dt) : Math.max(desired, l.speed - decel * dt);
          l.x = Math.min(l.targetX, l.x + l.speed * dt);
          if (l.x >= l.targetX - 0.02) {
            l.x = l.targetX;
            l.speed = 0;
            if (l.phase === 'charging') impact(a, l);
            else if (l.phase === 'approach') {
              l.phase = 'waiting';
              l.car.brake(500);
            }
          }
        } else l.speed = 0;
        l.car.group.position.x = l.x;
        l.car.setIdle(l.phase === 'waiting' || l.phase === 'parked');
        l.car.update(dt, l.speed, rig.camera);
        if (!l.finished || l.x < END_X - 2) {
          if (l.x > leadX) leadX = l.x;
        }
      }
      if (!(a.lanes.bare.finished && a.lanes.airbag.finished)) {
        zSum += slotZ(a.slot) + LANE_DZ / 2;
        zN++;
      }
    }
    empty.style.display = actors.size ? 'none' : '';
    if (leadX === -Infinity) leadX = 30;
    rig.focus.set(THREE.MathUtils.clamp(leadX, START_X + 8, END_X - 20), 0, zN ? zSum / zN : 4);
    rig.update(dt, wallDt);
    key.target.position.set(rig.focus.x, 0, rig.focus.z);
    key.position.set(rig.focus.x + 20, 30, rig.focus.z - 18);

    for (const g of allGates) g.update(dt);
    for (const b of allBlocks) b.update(dt);
    pools.update(dt);

    // floating labels follow their 3D anchor
    const now = performance.now();
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      if (now > f.until) {
        f.node.remove();
        floaters.splice(i, 1);
        continue;
      }
      tmpV.copy(f.pos).project(rig.camera);
      f.node.style.left = `${((tmpV.x + 1) / 2) * 100}%`;
      f.node.style.top = `${((1 - tmpV.y) / 2) * 100}%`;
    }

    renderer.render(scene, rig.camera);
  }
  renderer.setAnimationLoop(step);

  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    rig.resize(window.innerWidth / window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  return () => {
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    feed?.stop();
    hud.destroy();
    renderer.dispose();
  };
}
