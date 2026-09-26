import * as THREE from 'three';
import type { ArenaEvent, BarrierId, Variant } from '../types';
import { BARRIERS, BARRIER_SHORT, fmtUsd } from '../types';
import { Store } from '../store';
import { connectFeed, isMock } from '../feed';
import { el } from '../dom';
import { DirectorCamera, HighSpeedCam } from './camera';
import { CarMesh, CRUSH_MAX, NOSE_X } from './car';
import { Gate, Barrier, SoftTarget, skidMarks } from './fixtures';
import { buildHall, STATION_X, START_X, END_X, MAX_SLOTS, laneZ, slotZ, LANE_DZ, HALL_BG } from './hall';
import { SmokePool } from './particles';
import { AebSim, CrashSim, type Sim } from './sims';
import { bracketTexture } from './textures';
import { createHud } from '../hud';

type Phase = 'parked' | 'approach' | 'creep' | 'waiting' | 'charging' | 'sim' | 'through' | 'exit';

interface LaneActor {
  variant: Variant;
  car: CarMesh;
  x: number;
  targetX: number;
  speed: number;
  maxSpeed: number;
  phase: Phase;
  barrier?: BarrierId;
  finished: boolean;
  sim?: Sim;
  loss?: number;
  hitStopDone?: boolean;
  readout?: { at: number; text: string };
  smokeAcc: number;
}
interface CarActor {
  id: string;
  slot: number;
  joinedAt: number;
  lanes: Record<Variant, LaneActor>;
  bracket: THREE.Mesh;
  bracketTex: THREE.CanvasTexture;
  skids: THREE.Mesh[];
  sims: Sim[];
}
interface Floater {
  node: HTMLElement;
  pos: THREE.Vector3;
  until: number;
}
interface Replay {
  sim: Sim;
  side: 1 | -1;
  from: number;
  to: number;
  rate: number;
  label: string;
  startWall: number;
}

const KIND_LABEL: Record<string, string> = { built: 'built', webhook: 'webhook · boundary', openai: 'openai · boundary', mcp: 'your agent · MCP' };
const ATTACK = new Set<BarrierId>(['grok-morse', 'freysa', 'x402-swap']);
const APPROACH_GAP = 14; // approach mark this far before the station
const CREEP_LIMIT = 7; // creep no closer than this
const V_CRASH = 64 / 3.6;

export function mountArena(root: HTMLElement) {
  const store = new Store();
  const wrap = el('div', { class: 'arena' });
  const canvas = el('canvas');
  const floatLayer = el('div', { class: 'float-layer' });
  const flash = el('div', { class: 'flash' });
  wrap.append(canvas, floatLayer, flash);
  root.append(wrap);
  const hud = createHud(wrap, store, { mock: isMock() });

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[arena] WebGL unavailable, HUD-only mode', err);
    wrap.append(el('div', { class: 'empty-track', html: '<b>3D track unavailable</b>This screen has no WebGL. The scoreboard still runs live.' }));
    connectFeed(store);
    return () => hud.destroy();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(HALL_BG);

  const scene = new THREE.Scene();
  const { key } = buildHall(scene);
  const director = new DirectorCamera();
  director.resize(window.innerWidth, window.innerHeight);
  const hsCam = new HighSpeedCam();
  const smoke = new SmokePool(scene, 64);

  // high-speed-cam inset (DOM burn-in over a scissor viewport)
  const inset = el('div', { class: 'hs-cam' });
  const insetTop = el('div', { class: 'hs-top', html: '<span class="rec"></span>HIGH-SPEED CAM · 1000 fps' });
  const insetTime = el('div', { class: 'hs-time', text: 't = +0.000 s' });
  const insetMeta = el('div', { class: 'hs-meta' });
  const insetSpeed = el('div', { class: 'hs-speed', text: '64 km/h' });
  inset.append(insetTop, insetTime, insetMeta, insetSpeed);
  inset.style.display = 'none';
  wrap.append(inset);

  // ── fixtures per slot (built lazily) ────────────────────────────────────
  const sekGates: Gate[][] = Array.from({ length: MAX_SLOTS }, () => []);
  const targets: (SoftTarget | null)[][] = Array.from({ length: MAX_SLOTS }, () => []);
  const bareFix: (Barrier | Gate)[][] = Array.from({ length: MAX_SLOTS }, () => []);
  const allUpdatable: { update(dt: number): void }[] = [];
  function ensureFixtures(slot: number) {
    if (sekGates[slot].length) return;
    STATION_X.forEach((x, i) => {
      const b = BARRIERS[i];
      const attack = ATTACK.has(b);
      const g = new Gate(x, laneZ(slot, 'airbag'), attack ? 'sekisho' : 'toll');
      sekGates[slot][i] = g;
      scene.add(g.group);
      allUpdatable.push(g);
      if (attack) {
        const t = new SoftTarget(x + 3.6, laneZ(slot, 'airbag'));
        targets[slot][i] = t;
        scene.add(t.group);
        allUpdatable.push(t);
        const bar = new Barrier(x, laneZ(slot, 'bare'));
        bareFix[slot][i] = bar;
        scene.add(bar.group);
        allUpdatable.push(bar);
      } else {
        targets[slot][i] = null;
        const toll = new Gate(x, laneZ(slot, 'bare'), 'toll');
        bareFix[slot][i] = toll;
        scene.add(toll.group);
        allUpdatable.push(toll);
      }
    });
  }
  const idx = (b: BarrierId) => BARRIERS.indexOf(b);
  const gateFor = (slot: number, b: BarrierId) => sekGates[slot][idx(b)];
  const targetFor = (slot: number, b: BarrierId) => targets[slot][idx(b)];
  const bareFor = (slot: number, b: BarrierId) => bareFix[slot][idx(b)];

  // ── actors ────────────────────────────────────────────────────────────────
  const actors = new Map<string, CarActor>();
  const floaters: Floater[] = [];
  const replays: Replay[] = [];
  let currentReplay: Replay | null = null;
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
    const list = [...actors.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const victim = list.find((a) => a.lanes.bare.finished && a.lanes.airbag.finished) ?? list[0];
    removeActor(victim.id);
    return victim.slot;
  }

  function removeActor(id: string) {
    const a = actors.get(id);
    if (!a) return;
    for (const v of ['bare', 'airbag'] as const) a.lanes[v].car.dispose();
    for (const s of a.sims) s.dispose();
    for (let i = replays.length - 1; i >= 0; i--) if (a.sims.includes(replays[i].sim)) replays.splice(i, 1);
    if (currentReplay && a.sims.includes(currentReplay.sim)) currentReplay = null;
    for (const m of a.skids) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    a.bracket.removeFromParent();
    a.bracketTex.dispose();
    (a.bracket.material as THREE.Material).dispose();
    for (const g of sekGates[a.slot]) g.setState('idle');
    for (const t of targets[a.slot]) t?.raise(false);
    for (const f of bareFix[a.slot]) {
      if (f instanceof Barrier) {
        f.raise(false);
        f.setDent(0);
      } else f.setState('idle');
    }
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
      const sub = variant === 'airbag' ? `sekisho · ${pub.kind === 'built' ? 'full' : 'boundary mode'}` : `bare · ${KIND_LABEL[pub.kind] ?? pub.kind}`;
      const car = new CarMesh(pub.name, sub, pub.color, variant === 'airbag');
      car.group.position.set(START_X - 6, 0, laneZ(slot, variant));
      scene.add(car.group);
      return { variant, car, x: START_X - 6, targetX: START_X, speed: 0, maxSpeed: 12, phase: 'parked', finished: false, smokeAcc: 0 };
    };
    const bracketTex = bracketTexture(pub.name, pub.color);
    const bracket = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.6), new THREE.MeshBasicMaterial({ map: bracketTex, transparent: true }));
    bracket.position.set(START_X - 1.5, 1.7, slotZ(slot) - LANE_DZ / 2);
    scene.add(bracket);
    a = { id, slot, joinedAt: Date.now(), lanes: { bare: mk('bare'), airbag: mk('airbag') }, bracket, bracketTex, skids: [], sims: [] };
    actors.set(id, a);
    return a;
  }

  function floater(text: string, pos: THREE.Vector3, tone: 'red' | 'green' | 'amber' | 'readout' = 'red', ms = 1500) {
    const node = el('div', { class: `floater ${tone === 'red' ? '' : tone}`, text });
    floatLayer.append(node);
    floaters.push({ node, pos: pos.clone(), until: performance.now() + ms });
  }

  const lanePos = (l: LaneActor, dx = 0) => new THREE.Vector3(l.car.group.position.x + dx, 0.9, l.car.group.position.z);
  const chipsFor = (blockedBy: string[]) => blockedBy.map((c) => c.replace('PROVENANCE_', 'PROV·').replace('MANDATE_', 'MANDATE·').replace('_', '·'));
  const noseLen = (car: CarMesh) => NOSE_X - CRUSH_MAX * car.crush;

  /** Drop the lane's current sim (end state persists on the car) so ordinary motion can resume. */
  function endSim(l: LaneActor) {
    if (!l.sim) return;
    if (l.sim instanceof CrashSim) l.sim.finish();
    l.sim.apply(l.sim.duration);
    l.x = l.car.group.position.x;
    l.sim = undefined;
    l.car.setStatic(l.x);
  }

  function startAeb(a: CarActor, l: LaneActor, xStop: number, v: number, decel: number, label: string, readout: string) {
    endSim(l);
    const sim = new AebSim(l.car, l.x, xStop, v, decel, l.car.group.position.z, () => restoreLane(l));
    l.sim = sim;
    l.phase = 'sim';
    l.speed = 0;
    l.car.brake(sim.tStop * 1000 + 800 - Math.min(0, sim.t) * 1000);
    l.readout = { at: performance.now() + (sim.tStop - Math.min(0, sim.t)) * 1000 + 100, text: readout };
    a.sims.push(sim);
    replays.push({ sim, side: l.variant === 'bare' ? -1 : 1, from: -0.35, to: sim.tStop + 0.5, rate: 1 / 3, label, startWall: 0 });
  }

  function restoreLane(l: LaneActor) {
    if (l.sim) l.sim.apply(l.sim.t);
    else l.car.setStatic(l.x);
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
        endSim(l);
        if (l.barrier) {
          // clear the previous station so the car can pass
          if (e.variant === 'bare') {
            const f = bareFor(a.slot, l.barrier);
            if (f instanceof Barrier) f.raise(true);
            else if (f.state !== 'paid') f.setState('idle');
          } else {
            const g = gateFor(a.slot, l.barrier);
            if (g.state !== 'paid') g.setState('idle');
            targetFor(a.slot, l.barrier)?.raise(true);
          }
        }
        l.barrier = e.barrierId;
        l.targetX = STATION_X[idx(e.barrierId)] - APPROACH_GAP;
        l.maxSpeed = 13;
        l.phase = l.x < l.targetX - 0.5 ? 'approach' : 'creep';
        break;
      }
      case 'stepup.pending': {
        const a = spawn(e.carId);
        const g = gateFor(a.slot, e.barrierId);
        g.setState('stepup', e.summary, e.canApprove ? ['CAP·TX', 'WORLD ID'] : ['CAP·TX', 'NO OWNER']);
        g.startStepUp(Date.now(), e.expiresAt * 1000);
        floater('STEP UP · World ID', lanePos(a.lanes.airbag, 1), 'amber');
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
        const sx = STATION_X[idx(r.barrierId)];
        const attack = ATTACK.has(r.barrierId);
        if (r.variant === 'bare') {
          const f = bareFor(a.slot, r.barrierId);
          if (r.outcome === 'CRASH') {
            endSim(l);
            const faceX = f instanceof Barrier ? f.faceX : sx - 0.3;
            l.phase = 'charging';
            l.maxSpeed = V_CRASH;
            l.targetX = faceX - noseLen(l.car);
            l.loss = r.lossUsd;
          } else if (r.outcome === 'SAFE' && attack && f instanceof Barrier) {
            // the model resisted: near miss, brakes late and stops just short of the concrete
            startAeb(a, l, f.faceX - 0.45 - noseLen(l.car), 14, 11, `${l.car.name} · ${BARRIER_SHORT[r.barrierId]} · agent declined`, 'agent declined · stopped 0.4 m short');
          } else {
            if (f instanceof Barrier) f.raise(true);
            else f.setState(r.outcome === 'PAID' ? 'paid' : 'idle');
            l.phase = 'through';
            l.maxSpeed = 13;
            l.targetX = sx + 6;
            if (r.outcome === 'PAID') floater(r.barrierId === 'over-limit' ? 'paid $40 without asking' : `+ weather report ${fmtUsd(1)}`, lanePos(l, 2), r.barrierId === 'over-limit' ? 'amber' : 'green');
            else if (r.outcome === 'SAFE') floater('agent declined', lanePos(l, 1), 'green');
            else floater('FALSE BLOCK', lanePos(l, 1), 'amber');
          }
        } else {
          const g = gateFor(a.slot, r.barrierId);
          const target = targetFor(a.slot, r.barrierId);
          const chips = chipsFor(r.blockedBy);
          if (r.outcome === 'PAID') {
            g.setState('paid', r.barrierId === 'over-limit' ? r.reason : `Paid ${fmtUsd(1)} · weather.crumple.eth`, r.barrierId === 'over-limit' ? ['WORLD ✓', 'PAID $40'] : ['PAID']);
            target?.raise(true);
            l.phase = 'through';
            l.maxSpeed = 13;
            l.targetX = sx + 6;
            floater(r.barrierId === 'over-limit' ? '+ 7-day forecast $40' : `+ weather report ${fmtUsd(1)}`, lanePos(l, 2), 'green');
          } else if (r.outcome === 'CRASH') {
            g.setState('safe', r.reason, chips);
            endSim(l);
            l.phase = 'charging';
            l.maxSpeed = 50 / 3.6;
            l.targetX = sx - 0.3 - noseLen(l.car);
            l.loss = r.lossUsd;
          } else {
            g.setState(r.outcome === 'FALSE_BLOCK' ? 'false_block' : 'safe', r.reason, chips);
            const stopNose = target ? target.rearX - 0.8 : sx - 0.7;
            const gap = target ? 0.8 : 0.7;
            startAeb(a, l, stopNose - noseLen(l.car), 12.5, 9.5, `${l.car.name} · ${BARRIER_SHORT[r.barrierId]} · AEB`, `AEB · stopped ${gap.toFixed(1)} m short`);
          }
        }
        break;
      }
      case 'run.finished': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        endSim(l);
        if (l.barrier) {
          if (e.variant === 'bare') {
            const f = bareFor(a.slot, l.barrier);
            if (f instanceof Barrier) f.raise(true);
          } else {
            const g = gateFor(a.slot, l.barrier);
            if (g.state === 'safe' || g.state === 'expired' || g.state === 'false_block') g.setState('idle');
            targetFor(a.slot, l.barrier)?.raise(true);
          }
        }
        l.phase = 'exit';
        l.maxSpeed = 14;
        l.targetX = END_X;
        l.finished = true;
        break;
      }
    }
  }

  function impact(a: CarActor, l: LaneActor) {
    const barrier = l.barrier ? bareFor(a.slot, l.barrier) : null;
    const c0 = l.car.crush;
    const c1 = Math.min(1, c0 + 0.62);
    const sim = new CrashSim(scene, l.car, barrier instanceof Barrier && l.variant === 'bare' ? barrier : null, l.x, c0, c1, l.car.group.position.z, () => restoreLane(l));
    l.sim = sim;
    l.hitStopDone = false;
    l.phase = 'sim';
    l.speed = 0;
    a.sims.push(sim);
    director.addTrauma(0.55);
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    const loss = l.loss ?? 0;
    const at = lanePos(l, 1.2).add(new THREE.Vector3(0, 0.6, 0));
    window.setTimeout(() => floater(loss > 0 ? `−${fmtUsd(loss)}` : 'CRASH', at), 200);
    replays.push({ sim, side: l.variant === 'bare' ? -1 : 1, from: -0.07, to: 0.32, rate: 1 / 12, label: `${l.car.name} · ${l.barrier ? BARRIER_SHORT[l.barrier] : ''} · honeycomb barrier`, startWall: 0 });
  }

  store.subscribe((e) => {
    if (e) onEvent(e);
  });
  let feed: { stop(): void } | undefined;
  connectFeed(store).then((f) => (feed = f));

  // ── loop ──────────────────────────────────────────────────────────────────
  const timer = new THREE.Timer();
  const tmpV = new THREE.Vector3();
  const box = new THREE.Box3();
  const empty = el('div', { class: 'empty-track', html: '<b>Track is clear</b>Scan the QR to send a car' });
  wrap.append(empty);
  let W = window.innerWidth;
  let H = window.innerHeight;

  function step() {
    timer.update();
    const wallDt = Math.min(0.05, timer.getDelta());
    const dt = wallDt * timeScale;
    const now = performance.now();

    box.makeEmpty();
    for (const a of actors.values()) {
      for (const v of ['bare', 'airbag'] as const) {
        const l = a.lanes[v];
        if (l.sim) {
          l.sim.t += dt;
          const s = l.sim;
          s.apply(Math.min(s.t, s.duration));
          if (s instanceof CrashSim && !l.hitStopDone && s.t >= 0.11) {
            l.hitStopDone = true;
            hitStop(150);
          }
          if (s instanceof AebSim) {
            l.smokeAcc += dt;
            if (s.braking() && l.smokeAcc > 0.045) {
              l.smokeAcc = 0;
              const z = l.car.group.position.z;
              const x = l.car.group.position.x;
              smoke.puff(new THREE.Vector3(x + 1.3, 0.15, z + 0.8), { size: 0.45, up: 0.7, ttl: 0.8 });
              smoke.puff(new THREE.Vector3(x + 1.3, 0.15, z - 0.8), { size: 0.4, up: 0.7, ttl: 0.8 });
            }
            if (l.readout && now >= l.readout.at) {
              floater(l.readout.text, lanePos(l, 2.4).add(new THREE.Vector3(0, 0.5, 0)), 'readout', 3200);
              a.skids.push(...skidMarks(scene, l.car.group.position.x + 1.35, l.car.group.position.z, Math.min(6, s.tStop * s.kmh * 0.12)));
              l.readout = undefined;
            }
          }
          if (s.t >= s.duration) {
            l.x = l.car.group.position.x;
            l.phase = 'waiting';
            if (s instanceof CrashSim) s.finish();
            l.sim = undefined;
            l.car.setStatic(l.x);
          }
        } else {
          const dist = l.targetX - l.x;
          if (l.phase === 'creep') {
            const limit = l.barrier ? STATION_X[idx(l.barrier)] - CREEP_LIMIT : l.x;
            l.speed = l.x < limit ? 0.45 : 0;
            l.x = Math.min(limit, l.x + l.speed * dt);
          } else if (dist > 0.02) {
            const decel = l.phase === 'charging' ? 80 : 14;
            const desired = l.phase === 'charging' ? l.maxSpeed : Math.min(l.maxSpeed, Math.sqrt(2 * decel * dist));
            const accel = l.phase === 'charging' ? 60 : 12;
            l.speed = l.speed < desired ? Math.min(desired, l.speed + accel * dt) : Math.max(desired, l.speed - decel * dt);
            l.x = Math.min(l.targetX, l.x + l.speed * dt);
            if (l.x >= l.targetX - 0.02) {
              l.x = l.targetX;
              if (l.phase === 'charging') {
                impact(a, l);
                continue;
              }
              l.speed = 0;
              if (l.phase === 'approach') l.phase = l.barrier ? 'creep' : 'waiting';
              else if (l.phase === 'through') l.phase = 'waiting';
            }
          } else l.speed = 0;
          l.car.setStatic(l.x);
        }
        l.car.setIdle(l.phase === 'waiting' || l.phase === 'parked' || l.phase === 'creep');
        l.car.update(dt, l.speed, director.camera);
        if (!l.finished) {
          const cx = l.car.group.position.x;
          const stX = l.barrier ? STATION_X[idx(l.barrier)] : cx;
          const z = l.car.group.position.z;
          box.expandByPoint(tmpV.set(Math.min(cx, stX) - 5, 0, z - 2.2));
          box.expandByPoint(tmpV.set(Math.max(cx, stX) + 7, 3.5, z + 2.2));
        }
      }
    }
    empty.style.display = actors.size ? 'none' : '';
    if (box.isEmpty()) {
      box.expandByPoint(tmpV.set(START_X - 6, 0, laneZ(1, 'bare') - 2));
      box.expandByPoint(tmpV.set(STATION_X[1] + 8, 3.5, laneZ(0, 'airbag') + 2));
    }
    director.frame(box);
    director.update(wallDt);
    box.getCenter(tmpV);
    key.target.position.set(tmpV.x, 0, tmpV.z);
    key.position.set(tmpV.x + 30, 40, tmpV.z + 30);

    for (const u of allUpdatable) u.update(dt);
    smoke.update(dt);

    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      if (now > f.until) {
        f.node.remove();
        floaters.splice(i, 1);
        continue;
      }
      tmpV.copy(f.pos).project(director.camera);
      f.node.style.left = `${((tmpV.x + 1) / 2) * 100}%`;
      f.node.style.top = `${((1 - tmpV.y) / 2) * 100}%`;
    }

    // main wide shot
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, director.camera);

    // high-speed-cam inset: slow-motion deterministic replay of the last crash / AEB stop
    if (!currentReplay && replays.length) {
      currentReplay = replays.shift()!;
      currentReplay.startWall = now;
    }
    if (currentReplay) {
      const r = currentReplay;
      const tR = r.from + ((now - r.startWall) / 1000) * r.rate;
      if (tR > r.to) {
        currentReplay = null;
        inset.style.display = 'none';
      } else {
        r.sim.apply(tR);
        hsCam.aim(r.sim.focusX, r.sim.laneZ, r.side);
        const iw = Math.round(W * 0.3);
        const ih = Math.round((iw * 9) / 16);
        const ix = 22;
        const iy = 62;
        renderer.setScissorTest(true);
        renderer.setViewport(ix, iy, iw, ih);
        renderer.setScissor(ix, iy, iw, ih);
        renderer.render(scene, hsCam.camera);
        renderer.setScissorTest(false);
        r.sim.restore();
        inset.style.display = '';
        inset.style.width = `${iw}px`;
        inset.style.height = `${ih}px`;
        insetTime.textContent = `t = ${tR < 0 ? '−' : '+'}${Math.abs(tR).toFixed(3)} s`;
        insetMeta.textContent = r.label;
        insetSpeed.textContent = `${r.sim.kmh} km/h · ${r.sim.kind === 'crash' ? `replay 1/${Math.round(1 / r.rate)}` : 'AEB'}`;
      }
    }
  }
  renderer.setAnimationLoop(step);

  const onResize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    renderer.setSize(W, H);
    director.resize(W, H);
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
