import * as THREE from 'three';
import type { ArenaEvent, BarrierId, RunReport, TrackSpec, Variant } from '../types';
import { ATTACK_TYPES, BARRIER_SHORT, DEFAULT_TRACK_ID, controlLabel, fmtUsd } from '../types';
import { Store } from '../store';
import { connectFeed, isMock } from '../feed';
import { el, esc, starsText } from '../dom';
import { HighSpeedCam } from '../arena/camera';
import { CAR_SCALE, CRUSH_MAX, NOSE_X } from '../arena/car';
import { Barrier, skidMarks } from '../arena/fixtures';
import { SmokePool } from '../arena/particles';
import { AebSim, CrashSim, type Sim } from '../arena/sims';
import { createHud } from '../hud';
import { WorldCar, loadCarModels } from './car';
import { buildEnvironment } from './env';
import { NavCamera } from './nav';
import { WorldAudio } from './audio';
import { MiniMap } from './minimap';
import { tickProps } from './props';
import { TrackView, type Slot } from './track';
import { START_X, laneZ, slotZ } from './layout';
import { fx } from './fx';
import { BiomeWorld, DEATH_FOR } from './biomes';
import { CliffFallSim, LavaSim, RockfallSim, WaterSim, type DeathSim } from './sims/deaths';

const isDeath = (s: Sim | undefined): s is DeathSim => !!s && 'death' in s;
const DIRT = new Set(['grok-morse', 'freysa', 'x402-swap', 'over-limit']);
const DEATH_LABEL: Record<string, string> = { 'cliff-fall': 'over the cliff', lava: 'into the lava', water: 'into the river', rockfall: 'rockfall' };

// NaAP World v3: an open proving ground. Every track is its own road on a plot; every car drives the track it picked, bare
// and behind Sekisho, on its own lane pair. v2's crash / AEB sims, fixtures and high-speed-cam inset are reused as-is.

type Phase = 'parked' | 'approach' | 'creep' | 'waiting' | 'charging' | 'sim' | 'through' | 'exit';

interface LaneActor {
  variant: Variant;
  car: WorldCar;
  x: number;
  targetX: number;
  speed: number;
  maxSpeed: number;
  phase: Phase;
  step?: number;
  finished: boolean;
  sim?: Sim;
  loss?: number;
  hitStopDone?: boolean;
  readout?: { at: number; text: string };
  smokeAcc: number;
  /** v4: lane z, the biome death the car is lying in (until the run moves on), its burnt skin, fx throttles */
  z0: number;
  dead?: DeathSim;
  skin?: THREE.Material;
  engAcc: number;
  dustAcc: number;
  /** a death is still playing / the car is lying in it: move on (tow back) at this time, into this phase */
  reviveAt?: number;
  afterRevive?: Phase;
  /** Rockfall Pass closed the road in front of this (Sekisho) car: it stays put, the run ends there */
  blocked?: boolean;
}
interface CarActor {
  id: string;
  track: TrackView;
  slot: Slot;
  joinedAt: number;
  lanes: Record<Variant, LaneActor>;
  skids: THREE.Mesh[];
  sims: Sim[];
  leaveAt?: number;
}
interface Floater {
  node: HTMLElement;
  pos: THREE.Vector3;
  until: number;
}
interface Replay {
  sim: Sim;
  actor: CarActor;
  side: 1 | -1;
  from: number;
  to: number;
  rate: number;
  label: string;
  startWall: number;
}

const KIND_LABEL: Record<string, string> = { built: 'built', webhook: 'webhook · boundary', openai: 'openai · boundary', mcp: 'your agent · MCP' };
const APPROACH_GAP = 14;
const CREEP_LIMIT = 7;
const V_CRASH = 64 / 3.6;

export async function mountWorld(root: HTMLElement) {
  const store = new Store();
  const mock = isMock();
  const params = new URLSearchParams(location.search);
  const wrap = el('div', { class: 'arena world' });
  const canvas = el('canvas');
  const floatLayer = el('div', { class: 'float-layer' });
  const flash = el('div', { class: 'flash' });
  wrap.append(canvas, floatLayer, flash);
  root.append(wrap);

  let nav: NavCamera | null = null;
  const minimap = new MiniMap((p) => {
    tour.stop();
    nav?.glideTo(p, 90);
  });
  const audio = new WorldAudio(); // nav + audio lane: WebAudio starts on the first gesture
  const hints =
    '<b>Arrows/WASD</b> move · <b>drag</b> look around · <b>Shift+drag</b> pan · <b>scroll</b> dive in · <b>click a car</b> to follow · <b>Space</b>: latest crash';
  const hud = createHud(wrap, store, { mock, minimap: minimap.el, sub: 'open proving ground × sekisho 関所', sound: audio, hints });

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[world] WebGL unavailable, HUD-only mode', err);
    wrap.append(el('div', { class: 'empty-track', html: '<b>3D world unavailable</b>This screen has no WebGL. The scoreboard still runs live.' }));
    connectFeed(store);
    return () => hud.destroy();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // the error check reads each new program's link status back synchronously (a stalled frame); dev only
  renderer.debug.checkShaderErrors = import.meta.env.DEV;

  const scene = new THREE.Scene();
  const env = buildEnvironment(scene);
  const biomes = new BiomeWorld(scene, env.hemi);
  nav = new NavCamera(canvas);
  nav.resize(window.innerWidth, window.innerHeight);
  nav.setGroundProvider((x, z) => biomes.groundAt(x, z));
  const hsCam = new HighSpeedCam();
  // The crash-replay inset covers the lanes on a presenter screen; opt back in with ?hscam.
  const showHsCam = new URLSearchParams(location.search).has('hscam');
  const smoke = new SmokePool(scene, 64);

  const inset = el('div', { class: 'hs-cam' });
  const insetTop = el('div', { class: 'hs-top', html: '<span class="rec"></span>HIGH-SPEED CAM · 1000 fps' });
  const insetTime = el('div', { class: 'hs-time', text: 't = +0.000 s' });
  const insetMeta = el('div', { class: 'hs-meta' });
  const insetSpeed = el('div', { class: 'hs-speed', text: '64 km/h' });
  inset.append(insetTop, insetTime, insetMeta, insetSpeed);
  inset.style.display = 'none';
  wrap.append(inset);
  const tourPill = el('div', { class: 'tour-pill', text: 'AUTO-TOUR · move or click to take over' });
  tourPill.style.display = 'none';
  wrap.append(tourPill);
  const fpsPill = el('div', { class: 'fps-pill' });
  const showFps = params.has('fps');
  fpsPill.style.display = showFps ? '' : 'none';
  wrap.append(fpsPill);

  // report card: pops for a few seconds when a run's report arrives; pinned while following that car (Esc closes)
  const reportCard = el('div', { class: 'report-card' });
  reportCard.style.display = 'none';
  wrap.append(reportCard);
  let reportFor = '';
  let reportUntil = 0;
  let reportPinned = false;
  function showReport(r: RunReport, pinned: boolean) {
    reportFor = r.carId;
    reportPinned = pinned;
    reportUntil = performance.now() + 9000;
    const car = store.car(r.carId)?.car;
    const q = mock ? '?mock=1' : '';
    reportCard.style.setProperty('--c', car?.color ?? '#f5c400');
    reportCard.innerHTML =
      `<div class="rc-top"><span class="rc-k">REPORT CARD${r.aiWritten ? ' · AI assessor' : ''}</span><button class="rc-x" aria-label="Close">×</button></div>` +
      `<div class="rc-name">${esc(r.carName)} <small>on ${esc(r.trackName)}</small></div>` +
      `<div class="rc-stars"><span class="bare">${starsText(r.rating.bare.stars)}</span><span class="arrow">bare → Sekisho</span><span class="air">${starsText(r.rating.airbag.stars)}</span></div>` +
      `<div class="rc-head">${esc(r.headline)}</div>` +
      `<div class="rc-sum">${esc(r.summary)}</div>` +
      `<a class="rc-link" href="/car/${encodeURIComponent(r.carId)}${q}">Full report →</a>`;
    reportCard.style.display = '';
    (reportCard.querySelector('.rc-x') as HTMLButtonElement).onclick = () => hideReport();
  }
  function hideReport() {
    reportCard.style.display = 'none';
    reportFor = '';
    reportPinned = false;
  }

  // car bodies load before the first car spawns (never blocks for more than 4 s)
  await Promise.race([loadCarModels(), new Promise((r) => setTimeout(r, 4000))]);

  // ── tracks ────────────────────────────────────────────────────────────────
  let touched = false;
  let ready = false;
  const tracks = new Map<string, TrackView>();
  const allBounds = new THREE.Box3();
  function refit() {
    allBounds.makeEmpty();
    const b = new THREE.Box3();
    for (const t of tracks.values()) allBounds.union(t.bounds(b));
    env.fit(allBounds);
    nav?.setBounds(allBounds);
  }
  // Link every material's shader up front, in parallel where the driver allows: otherwise each one links the first time
  // it scrolls into view or its LOD / label switches on, and the camera hitches mid-drag. compile() only walks visible
  // objects, so hidden ones are shown for the (synchronous) program setup and hidden again before any frame draws.
  function warmNow(root: THREE.Object3D) {
    if (!nav) return;
    const hidden: THREE.Object3D[] = [];
    root.traverse((o) => {
      // lights stay as they are: the light count is part of every lit program's key
      if (!o.visible && !(o as THREE.Light).isLight) {
        hidden.push(o);
        o.visible = true;
      }
    });
    renderer.compileAsync(root, nav.camera, scene).catch(() => {});
    for (const o of hidden) o.visible = false;
  }
  let warmTimer = 0;
  /** Whole scene, debounced (new plots arrive in bursts). */
  function warmShaders() {
    window.clearTimeout(warmTimer);
    warmTimer = window.setTimeout(() => warmNow(scene), 60);
  }
  function ensureTrack(spec: TrackSpec): TrackView {
    let t = tracks.get(spec.id);
    if (t) return t;
    t = new TrackView(spec, tracks.size);
    scene.add(t.group);
    tracks.set(spec.id, t);
    t.applyBiome(biomes.addTrack(t).propSpot);
    for (let x = -30; x < t.endX; x += 36) if (biomes.groundAt(t.origin.x + x, t.origin.z - 8.4) > -0.3) env.addPole(t.origin.x + x, t.origin.z - 8.4);
    refit();
    warmShaders();
    t.setCounters(countersFrom());
    // keep the overview on every plot until a human takes the camera
    if (ready && !touched && !tour.on) frameAll();
    return t;
  }
  const isDefault = (t: TrackSpec) => !!t.isDefault || t.id === DEFAULT_TRACK_ID;
  function addTracks(list: TrackSpec[]) {
    const sorted = [...list].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)) || a.createdAt - b.createdAt);
    for (const s of sorted) ensureTrack(s);
  }
  const trackFor = (id: string | undefined) => tracks.get(id || DEFAULT_TRACK_ID) ?? ensureTrack(store.trackOf(id));
  function countersFrom() {
    const m = new Map<BarrierId, { attempts: number; fooled: number }>();
    for (const a of store.stats().attacks) m.set(a.type, { attempts: a.attempts, fooled: a.fooled });
    // over-limit: "paid without asking" on the bare lane (derived locally)
    let att = 0;
    let fooled = 0;
    for (const c of store.state.cars.values())
      for (const r of c.lanes.bare.steps)
        if (r && r.barrierId === 'over-limit') {
          att++;
          if (r.outcome === 'PAID') fooled++;
        }
    m.set('over-limit', { attempts: att, fooled });
    return m;
  }
  addTracks([...store.state.tracks.values()]);

  // ── actors ────────────────────────────────────────────────────────────────
  const actors = new Map<string, CarActor>();
  const floaters: Floater[] = [];
  const replays: Replay[] = [];
  let currentReplay: Replay | null = null;
  let timeScale = 1;
  let hitStopTimer: number | undefined;
  let baseScale = 1;
  const hitStop = (ms: number, scale = 0.05) => {
    timeScale = scale;
    window.clearTimeout(hitStopTimer);
    hitStopTimer = window.setTimeout(() => (timeScale = baseScale), ms);
  };

  function removeActor(id: string) {
    const a = actors.get(id);
    if (!a) return;
    for (const v of ['bare', 'airbag'] as const) a.lanes[v].car.dispose();
    for (const s of a.sims) s.dispose();
    for (let i = replays.length - 1; i >= 0; i--) if (replays[i].actor === a) replays.splice(i, 1);
    if (currentReplay?.actor === a) {
      currentReplay = null;
      inset.style.display = 'none';
    }
    for (const m of a.skids) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    a.track.releaseSlot(a.slot);
    actors.delete(id);
  }

  function spawn(id: string): CarActor {
    let a = actors.get(id);
    if (a) return a;
    const cs = store.car(id);
    const pub = cs?.car ?? { id, name: id, color: '#f5c400', kind: 'built' as const, ensName: `${id}.naap.eth`, isOwnerCar: false, trackId: DEFAULT_TRACK_ID };
    const track = trackFor(pub.trackId);
    let slot = track.claimSlot(id);
    if (!slot) {
      // every lane pair busy: the oldest car on this track leaves
      const victim = [...actors.values()].filter((x) => x.track === track).sort((p, q) => p.joinedAt - q.joinedAt)[0];
      if (victim) removeActor(victim.id);
      slot = track.claimSlot(id)!;
    }
    const sl = slot;
    const mk = (variant: Variant): LaneActor => {
      const sub = variant === 'airbag' ? `sekisho · ${pub.kind === 'built' ? 'full' : 'boundary mode'}` : `bare · ${KIND_LABEL[pub.kind] ?? pub.kind}`;
      const car = new WorldCar(pub.name, sub, pub.color, variant === 'airbag', pub.id);
      car.group.position.set(START_X - 8, 0, laneZ(sl.index, variant));
      car.group.userData.carId = id;
      track.group.add(car.group);
      car.setStatic(START_X - 8);
      return { variant, car, x: START_X - 8, targetX: START_X, speed: 0, maxSpeed: 12, phase: 'parked', finished: false, smokeAcc: 0, z0: laneZ(sl.index, variant), engAcc: Math.random() * 0.1, dustAcc: 0 };
    };
    a = { id, track, slot: sl, joinedAt: performance.now(), lanes: { bare: mk('bare'), airbag: mk('airbag') }, skids: [], sims: [] };
    actors.set(id, a);
    warmNow(track.group); // before its first frame: the new cars (and maybe a new lane pair) bring fresh materials
    return a;
  }

  const worldOf = (a: CarActor, local: THREE.Vector3) => local.add(new THREE.Vector3(a.track.origin.x, 0, a.track.origin.z));
  function floater(text: string, pos: THREE.Vector3, tone: 'red' | 'green' | 'amber' | 'readout' = 'red', ms = 1100) {
    const node = el('div', { class: `floater ${tone === 'red' ? '' : tone}`, text });
    floatLayer.append(node);
    floaters.push({ node, pos: pos.clone(), until: performance.now() + ms });
  }
  const lanePos = (a: CarActor, l: LaneActor, dx = 0) => worldOf(a, new THREE.Vector3(l.car.group.position.x + dx, 3.4, l.car.group.position.z));
  const chipsFor = (blockedBy: string[]) => blockedBy.map((c) => controlLabel(c).replace('PROVENANCE_', 'PROV·').replace('MANDATE_', 'MANDATE·').replace('_', '·'));
  const noseLen = (car: WorldCar) => (NOSE_X - CRUSH_MAX * car.crush) * CAR_SCALE;
  const asScene = (t: TrackView) => t.group as unknown as THREE.Scene;

  function endSim(l: LaneActor) {
    if (!l.sim) return;
    if (isDeath(l.sim)) {
      settleDeath(l, l.sim);
      return;
    }
    if (l.sim instanceof CrashSim) l.sim.finish();
    l.sim.apply(l.sim.duration);
    l.x = l.car.group.position.x;
    l.sim = undefined;
    l.car.setStatic(l.x);
  }
  /** A biome death ran out: the car lies where it fell (crumpled, maybe charred) until the run moves on. */
  function settleDeath(l: LaneActor, s: DeathSim) {
    s.apply(s.duration);
    s.finish();
    l.dead = s;
    if (s.death === 'lava') l.skin = l.car.bodyMesh.material as THREE.Material;
    l.x = l.car.group.position.x;
    l.sim = undefined;
    l.car.setStatic(l.x);
  }
  /** Towed back onto its lane past the hazard (the run continues after a biome death). */
  function revive(l: LaneActor) {
    endSim(l);
    if (!l.dead) return;
    l.x = Math.max(l.x, l.dead.exitX);
    l.dead = undefined;
    l.reviveAt = undefined;
    l.car.resetTransform(l.z0);
    l.car.setStatic(l.x);
  }
  function restoreLane(l: LaneActor) {
    if (l.dead && !l.sim) {
      l.dead.apply(l.dead.duration);
      l.dead.finish();
      return;
    }
    if (l.sim && isDeath(l.sim)) {
      l.sim.apply(l.sim.t);
      return;
    }
    // a replay of an earlier death may have moved / re-skinned the car: put it back on its lane first
    l.car.resetTransform(l.z0);
    if (l.skin) l.car.setBodyMaterial(l.skin);
    if (l.sim) l.sim.apply(l.sim.t);
    else l.car.setStatic(l.x);
  }
  const worldPt = (a: CarActor, x: number, y: number, z: number) => ({ x: a.track.origin.x + x, y, z: a.track.origin.z + z });
  function gateFx(a: CarActor, step: number, state: 'open' | 'close' | 'amber') {
    const g = a.slot.gates[step];
    if (!g) return;
    fx.emit({ t: 'gate', state, ...worldPt(a, g.group.position.x, 2, g.group.position.z) });
  }
  /** Bare lane falls for the biome's attack: cliff / lava / river, a deterministic sim the inset can replay. */
  function startDeath(a: CarActor, l: LaneActor, kind: 'cliff-fall' | 'lava' | 'water', type: BarrierId) {
    const sx = a.track.stationX(l.step ?? 0);
    const Ctor = kind === 'cliff-fall' ? CliffFallSim : kind === 'lava' ? LavaSim : WaterSim;
    const sim = new Ctor(a.track.group, l.car, l.x, l.z0, sx, () => restoreLane(l));
    l.sim = sim;
    l.phase = 'sim';
    l.speed = 0;
    a.sims.push(sim);
    const loss = l.loss ?? 0;
    fx.emit({ t: 'crash', carId: a.id, kind, ...worldPt(a, l.x, 0.5, l.z0), lossUsd: loss });
    nav!.addTrauma(nav!.dist < 120 ? 0.3 : 0.1);
    const at = lanePos(a, l, 4).add(new THREE.Vector3(0, 1.6, -3));
    window.setTimeout(() => floater(loss > 0 ? `−${fmtUsd(loss)} · ${DEATH_LABEL[kind]}` : DEATH_LABEL[kind].toUpperCase(), at, 'red', 2200), 450);
    replays.push({ sim, actor: a, side: -1, from: sim.replay.from, to: sim.replay.to, rate: sim.replay.rate, label: `${l.car.name} · ${BARRIER_SHORT[type]} · ${DEATH_LABEL[kind]}`, startWall: 0 });
    tour.onCrash(a, l);
  }
  /** Rockfall Pass: boulders come down on the road (Sekisho refused the over-limit payment) or a few pebbles (bare paid). */
  const rockfalls: { sim: DeathSim; a: CarActor; at: number; started: boolean; small: boolean; label: string }[] = [];
  function queueRockfall(a: CarActor, l: LaneActor, xLand: number, delayMs: number, small: boolean) {
    const entry = { sim: null as unknown as DeathSim, a, at: performance.now() + delayMs, started: false, small, label: `${l.car.name} · ${small ? 'paid without asking · rumble' : 'over-limit refused · rockfall'}` };
    entry.sim = new RockfallSim(a.track.group, xLand, l.z0, () => entry.sim.apply(Math.min(Math.max(0, entry.sim.t), entry.sim.duration)), { small });
    entry.sim.t = 0;
    entry.sim.apply(0);
    a.sims.push(entry.sim);
    rockfalls.push(entry);
    if (!small) l.blocked = true;
  }
  function startAeb(a: CarActor, l: LaneActor, xStop: number, v: number, decel: number, label: string, readout: string) {
    revive(l);
    const sim = new AebSim(l.car, l.x, xStop, v, decel, l.car.group.position.z, () => restoreLane(l));
    fx.emit({ t: 'aeb', carId: a.id, ...worldPt(a, xStop, 0.5, l.z0) });
    l.sim = sim;
    l.phase = 'sim';
    l.speed = 0;
    l.car.brake(sim.tStop * 1000 + 800 - Math.min(0, sim.t) * 1000);
    l.readout = { at: performance.now() + (sim.tStop - Math.min(0, sim.t)) * 1000 + 100, text: readout };
    a.sims.push(sim);
    replays.push({ sim, actor: a, side: l.variant === 'bare' ? -1 : 1, from: -0.35, to: sim.tStop + 0.5, rate: 1 / 3, label, startWall: 0 });
  }

  /** Step of an event: from the wire, else what the store derived (old server shape). */
  const stepOf = (carId: string, variant: Variant, step: number | undefined) => {
    if (typeof step === 'number' && step >= 0) return step;
    return store.car(carId)?.lanes[variant].step ?? 0;
  };

  function clearStation(a: CarActor, l: LaneActor) {
    if (l.step === undefined) return;
    if (l.variant === 'bare') {
      const f = a.slot.bare[l.step];
      if (f instanceof Barrier) f.raise(true);
      else if (f && f.state !== 'paid') f.setState('idle');
    } else {
      const g = a.slot.gates[l.step];
      if (g && g.state !== 'paid') g.setState('idle');
      a.slot.targets[l.step]?.raise(true);
    }
  }

  function onEvent(e: ArenaEvent) {
    switch (e.t) {
      case 'hello':
        for (const id of [...actors.keys()]) removeActor(id);
        addTracks(e.tracks ?? []);
        for (const c of e.cars) if (!c.rating) spawn(c.id);
        break;
      case 'track.created': {
        const t = ensureTrack(e.track);
        floater(`NEW TRACK · ${e.track.name}`, new THREE.Vector3(t.origin.x + START_X, 12, t.origin.z), 'amber', 2600);
        break;
      }
      case 'car.joined':
        spawn(e.car.id);
        break;
      case 'report':
        fx.emit({ t: 'report', carId: e.carId });
        if (e.report) showReport(e.report, following === e.carId);
        break;
      case 'run.started': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        l.targetX = START_X + 2;
        l.phase = 'approach';
        l.finished = false;
        l.blocked = false;
        a.leaveAt = undefined;
        break;
      }
      case 'barrier.enter': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        const dying = isDeath(l.sim) || !!l.dead;
        if (!dying) revive(l);
        clearStation(a, l);
        l.step = stepOf(e.carId, e.variant, e.step);
        l.targetX = a.track.stationX(l.step) - APPROACH_GAP;
        l.maxSpeed = 13;
        if (dying) {
          // let the death play out, lie there a beat, then tow back onto the lane
          l.reviveAt = performance.now() + (isDeath(l.sim) ? Math.max(0, l.sim.duration - l.sim.t) * 1000 : 0) + 1400;
          l.afterRevive = 'approach';
        } else l.phase = l.x < l.targetX - 0.5 ? 'approach' : 'creep';
        a.track.lastActivity = performance.now();
        break;
      }
      case 'stepup.pending': {
        const a = spawn(e.carId);
        const g = a.slot.gates[stepOf(e.carId, 'airbag', e.step)];
        if (!g) break;
        g.setState('stepup', e.summary, e.canApprove ? ['CAP·TX', 'OWNER'] : ['CAP·TX', 'NO OWNER']);
        gateFx(a, stepOf(e.carId, 'airbag', e.step), 'amber');
        g.startStepUp(Date.now(), e.expiresAt * 1000);
        floater('STEP UP · owner approval', lanePos(a, a.lanes.airbag, 1), 'amber');
        break;
      }
      case 'stepup.resolved': {
        const a = spawn(e.carId);
        const l = a.lanes.airbag;
        if (l.step === undefined) break;
        const g = a.slot.gates[l.step];
        if (!g) break;
        if (e.result.status === 'APPROVED') g.setState('paid', `Owner approved${e.result.subject ? ` · ${e.result.subject}` : ''}`, ['OWNER ✓']);
        else g.setState('expired', e.result.detail, [e.result.status === 'DENIED' ? 'OWNER·DENIED' : 'OWNER·EXPIRED']);
        gateFx(a, l.step, e.result.status === 'APPROVED' ? 'open' : 'close');
        break;
      }
      case 'barrier.result': {
        const r = e.result;
        const a = spawn(e.carId);
        const l = a.lanes[r.variant];
        const step = stepOf(e.carId, r.variant, r.step);
        l.step = step;
        const sx = a.track.stationX(step);
        const attack = ATTACK_TYPES.includes(r.barrierId);
        a.track.lastActivity = performance.now();
        if (r.variant === 'bare') {
          const f = a.slot.bare[step];
          if (!f) break;
          if (r.outcome === 'CRASH') {
            revive(l);
            const faceX = f instanceof Barrier ? f.faceX : sx - 0.3;
            l.phase = 'charging';
            l.maxSpeed = V_CRASH;
            l.targetX = DEATH_FOR[r.barrierId] ? Math.max(l.x + 0.5, sx - 2) : faceX - noseLen(l.car);
            l.loss = r.lossUsd;
          } else if (r.outcome === 'SAFE' && attack && f instanceof Barrier) {
            startAeb(a, l, f.faceX - 0.45 - noseLen(l.car), 14, 11, `${l.car.name} · ${BARRIER_SHORT[r.barrierId]} · agent declined`, 'agent declined · stopped 0.4 m short');
          } else {
            if (f instanceof Barrier) f.raise(true);
            else f.setState(r.outcome === 'PAID' ? 'paid' : 'idle');
            l.phase = 'through';
            l.maxSpeed = 13;
            l.targetX = sx + 6;
            if (r.outcome === 'PAID') floater(r.barrierId === 'over-limit' ? 'PAID WITHOUT ASKING' : `+ 1 h GPU inference ${fmtUsd(1)}`, lanePos(a, l, 2), r.barrierId === 'over-limit' ? 'amber' : 'green', r.barrierId === 'over-limit' ? 2600 : 1100);
            if (r.outcome === 'PAID' && r.barrierId === 'over-limit') {
              // the pass rumbles: pebbles rain down ahead of the car that paid without asking
              queueRockfall(a, l, sx + 3, 350, true);
              nav!.addTrauma(nav!.dist < 120 ? 0.18 : 0.05);
            }
            if (!(f instanceof Barrier) && r.outcome === 'PAID') fx.emit({ t: 'gate', state: 'open', ...worldPt(a, sx, 2, l.z0) });
            else if (r.outcome === 'SAFE') floater('agent declined', lanePos(a, l, 1), 'green');
            else floater('FALSE BLOCK', lanePos(a, l, 1), 'amber');
          }
        } else {
          const g = a.slot.gates[step];
          if (!g) break;
          const target = a.slot.targets[step];
          const chips = chipsFor(r.blockedBy);
          if (r.outcome === 'PAID') {
            g.setState('paid', r.barrierId === 'over-limit' ? r.reason : `Paid ${fmtUsd(1)} · compute.naap.eth`, r.barrierId === 'over-limit' ? ['OWNER ✓', 'PAID'] : ['PAID']);
            target?.raise(true);
            gateFx(a, step, 'open');
            revive(l);
            l.phase = 'through';
            l.maxSpeed = 13;
            l.targetX = sx + 6;
            floater(r.barrierId === 'over-limit' ? '+ 40 h GPU block' : `+ 1 h GPU inference ${fmtUsd(1)}`, lanePos(a, l, 2), 'green');
          } else if (r.outcome === 'CRASH') {
            g.setState('safe', r.reason, chips);
            endSim(l);
            l.phase = 'charging';
            l.maxSpeed = 50 / 3.6;
            l.targetX = sx - 0.3 - noseLen(l.car);
            l.loss = r.lossUsd;
          } else {
            g.setState(r.outcome === 'FALSE_BLOCK' ? 'false_block' : 'safe', r.reason, chips);
            gateFx(a, step, 'close');
            const stopNose = target ? target.rearX - 0.8 : sx - 0.7;
            const gap = target ? 0.8 : 0.7;
            startAeb(a, l, stopNose - noseLen(l.car), 12.5, 9.5, `${l.car.name} · ${BARRIER_SHORT[r.barrierId]} · AEB`, `AEB · stopped ${gap.toFixed(1)} m short`);
            // over-limit refused (step-up expired / denied): the pass comes down in front of the stopped car — a SAFE result
            if (r.barrierId === 'over-limit' && r.outcome === 'SAFE') queueRockfall(a, l, stopNose + 2.2, 900, false);
          }
        }
        break;
      }
      case 'run.finished': {
        const a = spawn(e.carId);
        const l = a.lanes[e.variant];
        const dying = isDeath(l.sim) || !!l.dead;
        if (!dying) revive(l);
        if (l.step !== undefined) {
          if (e.variant === 'bare') {
            const f = a.slot.bare[l.step];
            if (f instanceof Barrier) f.raise(true);
          } else {
            const g = a.slot.gates[l.step];
            if (g && (g.state === 'safe' || g.state === 'expired' || g.state === 'false_block')) g.setState('idle');
            a.slot.targets[l.step]?.raise(true);
          }
        }
        l.maxSpeed = 14;
        l.targetX = a.track.endX;
        l.finished = true;
        if (l.blocked) {
          // the pass is closed: the refused car stays behind the boulders
          l.phase = 'waiting';
          l.targetX = l.x;
        } else if (dying) {
          l.reviveAt = performance.now() + (isDeath(l.sim) ? Math.max(0, l.sim.duration - l.sim.t) * 1000 : 0) + 1400;
          l.afterRevive = 'exit';
        } else l.phase = 'exit';
        break;
      }
      default:
        break;
    }
  }

  function impact(a: CarActor, l: LaneActor) {
    const bt = l.step !== undefined ? a.track.type(l.step) : undefined;
    const death = l.variant === 'bare' && bt ? DEATH_FOR[bt] : undefined;
    if (bt && (death === 'cliff-fall' || death === 'lava' || death === 'water')) {
      startDeath(a, l, death, bt);
      return;
    }
    fx.emit({ t: 'crash', carId: a.id, kind: 'wall', ...worldPt(a, l.x, 0.5, l.z0), lossUsd: l.loss ?? 0 });
    const barrier = l.step !== undefined ? a.slot.bare[l.step] : null;
    const c0 = l.car.crush;
    const c1 = Math.min(1, c0 + 0.62);
    const sim = new CrashSim(asScene(a.track), l.car, barrier instanceof Barrier && l.variant === 'bare' ? barrier : null, l.x, c0, c1, l.car.group.position.z, () => restoreLane(l));
    l.sim = sim;
    l.hitStopDone = false;
    l.phase = 'sim';
    l.speed = 0;
    a.sims.push(sim);
    if (barrier instanceof Barrier) barrier.flash();
    nav!.addTrauma(nav!.dist < 120 ? 0.4 : 0.12);
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    const loss = l.loss ?? 0;
    const at = lanePos(a, l, 1.2).add(new THREE.Vector3(0, 1.2, 0));
    window.setTimeout(() => floater(loss > 0 ? `−${fmtUsd(loss)}` : 'CRASH', at, 'red', 1400), 200);
    const type = l.step !== undefined ? a.track.type(l.step) : undefined;
    replays.push({ sim, actor: a, side: l.variant === 'bare' ? -1 : 1, from: -0.07, to: 0.32, rate: 1 / 12, label: `${l.car.name} · ${type ? BARRIER_SHORT[type] : ''} · ${a.track.spec.name}`, startWall: 0 });
    tour.onCrash(a, l);
  }

  function cue(a: CarActor, c: { kind: string; x: number; y: number; z: number }, death?: string) {
    const p = worldPt(a, c.x, c.y, c.z);
    if (c.kind === 'splash') fx.emit({ t: 'splash', ...p });
    else if (c.kind === 'sizzle') fx.emit({ t: 'sizzle', ...p });
    else if (c.kind === 'rumble') {
      nav!.addTrauma(nav!.dist < 120 ? 0.22 : 0.06);
      // the thud where the eye is: the car hits the scree 16 m below the rail
      if (death === 'cliff-fall') fx.emit({ t: 'crash', carId: a.id, kind: 'cliff-fall', ...p, lossUsd: 0 });
    }
    else if (c.kind === 'dust') for (let k = 0; k < 4; k++) biomes.dust.puff(p.x, p.y + 0.3, p.z, 2.2, 1.2, 1.8);
  }

  // ── navigation: click car → chase, click sign → frame track, dbl-click → glide, Esc → overview ──
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pick = (ev: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, nav!.camera);
  };
  let following = '';
  const followCar = (a: CarActor, l: LaneActor, dist = 17, byHuman = false) => {
    const v = new THREE.Vector3();
    following = a.id;
    const rep = store.state.reports.get(a.id);
    if (byHuman && rep) showReport(rep, true);
    nav!.chase(() => (actors.get(a.id) === a ? l.car.group.getWorldPosition(v) : null), { dist, yaw: l.variant === 'bare' ? -2.2 : -0.95 });
  };
  const frameAll = () => nav!.frameBox(allBounds, { pitch: 0.86, yaw: 0.22, pad: 1.4 });
  const frameTrack = (t: TrackView, yaw = 0.3) => nav!.frameBox(t.bounds(), { pitch: 0.62, yaw, pad: 1.35 });

  /** Projector mode (?tour=1 only, never on idle): cycle through active tracks and cut to crashes. */
  const tour = {
    on: false,
    next: 0,
    cutUntil: 0,
    idx: 0,
    start() {
      this.on = true;
      this.next = 0;
      tourPill.style.display = '';
      nav!.setView('tour', false);
    },
    stop() {
      if (!this.on) return;
      this.on = false;
      this.cutUntil = 0;
      tourPill.style.display = 'none';
      if (nav!.view === 'tour') nav!.setView('orbit', false);
    },
    onCrash(a: CarActor, l: LaneActor) {
      if (!this.on || performance.now() < this.cutUntil) return;
      this.cutUntil = performance.now() + 5200;
      this.next = this.cutUntil;
      followCar(a, l, 15);
    },
    update(now: number) {
      if (!this.on || now < this.next) return;
      const active = [...tracks.values()].filter((t) => [...actors.values()].some((a) => a.track === t && a.leaveAt === undefined));
      const list = active.length ? active : [...tracks.values()];
      const k = this.idx % (list.length + 1);
      if (k === list.length) frameAll();
      else {
        const t = list[k];
        // frame the live cars on the track, not the empty road
        const cars = [...actors.values()].filter((a) => a.track === t);
        if (cars.length) {
          const b = new THREE.Box3();
          const p = new THREE.Vector3();
          for (const a of cars)
            for (const v of ['bare', 'airbag'] as const) {
              a.lanes[v].car.group.getWorldPosition(p);
              b.expandByPoint(new THREE.Vector3(p.x - 12, 0, p.z - 7));
              b.expandByPoint(new THREE.Vector3(p.x + 30, 4, p.z + 5));
            }
          nav!.frameBox(b, { pitch: 0.48, yaw: 0.2 + (this.idx % 3) * 0.22, pad: 1.1, ease: 1.2 });
        } else frameTrack(t, 0.25 + (this.idx % 3) * 0.2);
      }
      this.idx++;
      this.next = now + 8000;
    },
  };

  let downAt = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  /** Follow the car under the ray (click / tap). */
  const rideAt = (ray: THREE.Raycaster) => {
    const carObjs: THREE.Object3D[] = [];
    for (const a of actors.values()) for (const v of ['bare', 'airbag'] as const) carObjs.push(a.lanes[v].car.group);
    const hitCar = ray.intersectObjects(carObjs, true).find((h) => h.object.visible);
    if (!hitCar) return false;
    let o: THREE.Object3D | null = hitCar.object;
    while (o && o.userData.carId === undefined) o = o.parent;
    const a = o ? actors.get(o.userData.carId as string) : undefined;
    if (!a) return false;
    followCar(a, a.lanes.bare.car.group === o ? a.lanes.bare : a.lanes.airbag, 17, true);
    return true;
  };
  canvas.addEventListener('click', (e) => {
    if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 5) return;
    tour.stop();
    nav!.lastInput = performance.now();
    pick(e);
    if (rideAt(raycaster)) return;
    const signs: THREE.Object3D[] = [];
    for (const t of tracks.values()) signs.push(...t.pickables);
    const hitSign = raycaster.intersectObjects(signs, true)[0];
    if (hitSign) {
      let o: THREE.Object3D | null = hitSign.object;
      while (o && o.userData.trackId === undefined) o = o.parent;
      const t = o ? tracks.get(o.userData.trackId as string) : undefined;
      if (t) frameTrack(t);
    }
  });
  canvas.addEventListener('dblclick', (e) => {
    pick(e);
    const p = nav!.pickGround(e.clientX, e.clientY) ?? raycaster.ray.intersectPlane(ground, new THREE.Vector3());
    if (p) {
      tour.stop();
      nav!.glideTo(p, 40);
    }
  });
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (e.code === 'KeyM' && tag !== 'INPUT' && tag !== 'TEXTAREA') audio.toggle();
    if (e.key === 'Escape') {
      hideReport();
      following = '';
      tour.stop();
      nav!.lastInput = performance.now();
      // Esc releases a followed car where it is; a second Esc (or Esc while free) pulls back to the overview
      if (nav!.mode === 'follow') nav!.release();
      else frameAll();
    }
  };
  window.addEventListener('keydown', onKey);
  nav.onInput = () => {
    touched = true;
    tour.stop();
  };
  // nav + audio lane wiring: biome under the screen centre → ambient bed, first gesture → audio unlock
  const biomeBox = new THREE.Box3();
  nav.attach({
    scene,
    biomeAt: (x, z) => {
      let best: TrackView | null = null;
      let bd = Infinity;
      for (const t of tracks.values()) {
        const b = t.bounds(biomeBox);
        const d = Math.hypot(Math.max(b.min.x - x, 0, x - b.max.x), Math.max(b.min.z - z, 0, z - b.max.z));
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (!best || bd > 40) return null;
      let i = 0;
      let id = Infinity;
      for (let k = 0; k < best.n; k++) {
        const d = Math.abs(best.origin.x + best.stationX(k) - x);
        if (d < id) {
          id = d;
          i = k;
        }
      }
      return best.type(i);
    },
    onGesture: () => audio.unlock(),
  });
  audio.attach(nav.camera);
  audio.prepare(); // open the audio device now, not on the first drag (it blocks ~0.4 s)

  // debug / screenshot hooks
  const api = {
    follow(carId?: string, variant: Variant = 'bare') {
      const a = carId ? actors.get(carId) : [...actors.values()][0];
      if (a) followCar(a, a.lanes[variant], 17, true);
    },
    overview: () => frameAll(),
    /** v4: slow the sims down (screenshots): 1 = real time */
    slow(k: number) {
      window.clearTimeout(hitStopTimer);
      timeScale = baseScale = k;
    },
    /** v4: world-space ground height (terrain of the plot under the point, else the lowland) — for walkers */
    ground: (x: number, z: number) => biomes.groundAt(x, z),
    /** v4: frame obstacle `step` of track `trackId` (screenshots) */
    biome(trackId: string, step: number, yaw = 0.35, pitch = 0.5, pad = 1.0) {
      const t = tracks.get(trackId) ?? [...tracks.values()][0];
      if (!t) return;
      const sx = t.origin.x + t.stationX(step);
      touched = true;
      nav!.frameBox(new THREE.Box3(new THREE.Vector3(sx - 10, -8, t.origin.z - 24), new THREE.Vector3(sx + 18, 8, t.origin.z + 6)), { pitch, yaw, pad: 1 });
      // pad = orbit distance (m): snap straight there for screenshots
      nav!.goal.target.set(sx + 4, 0, t.origin.z - 8);
      nav!.goal.dist = pad * 40;
      nav!.target.copy(nav!.goal.target);
      nav!.yaw = yaw;
      nav!.pitch = pitch;
      nav!.dist = nav!.goal.dist;
    },
    tour: () => tour.start(),
    fps: () => (window as unknown as { __worldFps?: number }).__worldFps,
  };
  (window as unknown as { __world: typeof api }).__world = api;

  // ── stats → counters ──────────────────────────────────────────────────────
  let countersDirty = true;
  store.subscribe((e) => {
    if (e) onEvent(e);
    if (e && (e.t === 'stats' || e.t === 'barrier.result' || e.t === 'hello')) countersDirty = true;
  });
  let feed: { stop(): void } | undefined;
  connectFeed(store).then((f) => (feed = f));
  ready = true;
  frameAll();
  nav.target.copy(nav.goal.target);
  nav.yaw = nav.goal.yaw;
  nav.pitch = nav.goal.pitch;
  nav.dist = nav.goal.dist * 1.35;
  warmShaders();
  if (params.get('tour') === '1') tour.start();

  // ── loop ──────────────────────────────────────────────────────────────────
  const timer = new THREE.Timer();
  const tmpV = new THREE.Vector3();
  // no empty-state banner: the world explains itself (owner feedback)
  const empty = el('div', { class: 'empty-track' });
  empty.style.display = 'none';
  let W = window.innerWidth;
  let H = window.innerHeight;
  let lastMini = 0;
  let clock = 0;
  let fpsFrames = 0;
  let fpsT = performance.now();

  function step() {
    timer.update();
    const wallDt = Math.min(0.05, timer.getDelta());
    const dt = wallDt * timeScale;
    const now = performance.now();
    clock += wallDt;

    for (const a of [...actors.values()]) {
      let done = 0;
      for (const v of ['bare', 'airbag'] as const) {
        const l = a.lanes[v];
        if (l.sim) {
          const t0 = l.sim.t;
          l.sim.t += dt;
          const s = l.sim;
          if (isDeath(s)) {
            for (const c of s.cues) if (c.t > t0 && c.t <= s.t) cue(a, c, s.death);
            if (s.t >= s.duration) {
              settleDeath(l, s);
              l.phase = 'waiting';
              l.car.setIdle(false);
              l.car.update(dt, 0, nav!.camera);
              continue;
            }
            s.apply(s.t);
            l.car.update(dt, 0, nav!.camera);
            continue;
          }
          s.apply(Math.min(s.t, s.duration));
          if (s instanceof CrashSim && !l.hitStopDone && s.t >= 0.11) {
            l.hitStopDone = true;
            hitStop(150);
          }
          if (s instanceof AebSim) {
            l.smokeAcc += dt;
            if (s.braking() && l.smokeAcc > 0.045) {
              l.smokeAcc = 0;
              const p = worldOf(a, new THREE.Vector3(l.car.group.position.x + 1.3, 0.15, l.car.group.position.z));
              smoke.puff(new THREE.Vector3(p.x, p.y, p.z + 0.8), { size: 0.45, up: 0.7, ttl: 0.8 });
              smoke.puff(new THREE.Vector3(p.x, p.y, p.z - 0.8), { size: 0.4, up: 0.7, ttl: 0.8 });
            }
            if (l.readout && now >= l.readout.at) {
              floater(l.readout.text, lanePos(a, l, 2.4).add(new THREE.Vector3(0, 0.5, 0)), 'readout', 3200);
              a.skids.push(...skidMarks(asScene(a.track), l.car.group.position.x + 1.35, l.car.group.position.z, Math.min(6, s.tStop * s.kmh * 0.12)));
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
        } else if (l.dead) {
          l.speed = 0;
          if (l.reviveAt !== undefined && now >= l.reviveAt) {
            revive(l);
            l.reviveAt = undefined;
            const ph = l.afterRevive ?? 'waiting';
            l.phase = ph === 'approach' ? (l.x < l.targetX - 0.5 ? 'approach' : 'creep') : ph;
            l.car.setStatic(l.x);
          }
        } else {
          const dist = l.targetX - l.x;
          if (l.phase === 'creep') {
            const limit = l.step !== undefined ? a.track.stationX(l.step) - CREEP_LIMIT : l.x;
            l.speed = l.x < limit ? 0.45 : 0;
            l.x = l.x < limit ? Math.min(limit, l.x + l.speed * dt) : l.x;
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
              if (l.phase === 'approach') l.phase = l.step !== undefined ? 'creep' : 'waiting';
              else if (l.phase === 'through') l.phase = 'waiting';
            }
          } else l.speed = 0;
          l.car.setStatic(l.x);
        }
        if (l.finished && ((l.blocked && !l.sim) || (l.phase === 'exit' && l.x >= a.track.endX - 0.1))) done++;
        l.car.setIdle(!l.dead && (l.phase === 'waiting' || l.phase === 'parked' || l.phase === 'creep'));
        l.car.update(dt, l.speed, nav!.camera);
        // fx: engine hum (≈10 Hz per moving car), dust trail on the dirt biomes
        l.engAcc += wallDt;
        const moving = l.speed > 0.05;
        if (!l.dead && l.engAcc >= (moving ? 0.1 : 0.5)) {
          // ≈10 Hz while moving, 2 Hz idle rumble while parked / waiting
          l.engAcc = 0;
          fx.emit({ t: 'engine', carId: a.id, variant: v, ...worldPt(a, l.car.group.position.x, 0.5, l.z0), speed: moving ? l.speed : 0 });
        }
        if (l.speed > 3 && !l.dead) {
          l.dustAcc += wallDt;
          if (l.dustAcc > 0.05 && DIRT.has(biomes.typeAt(a.track, l.car.group.position.x))) {
            l.dustAcc = 0;
            const p = worldPt(a, l.car.group.position.x - 0.2, 0.25, l.z0);
            biomes.dust.puff(p.x, p.y, p.z + (Math.random() - 0.5) * 1.2, 0.7 + l.speed * 0.04, 0.5, 1.1);
          }
        }
      }
      // the car leaves (crumpled or not) a while after both lanes reached the finish
      if (done === 2 && a.leaveAt === undefined) a.leaveAt = now + 9000;
      if (a.leaveAt !== undefined && now > a.leaveAt) removeActor(a.id);
    }
    // empty-state banner removed
    if (nav!.mode !== 'follow') following = '';
    if (reportFor && !(reportPinned && following === reportFor) && now > reportUntil) hideReport();

    tour.update(now);
    nav!.update(wallDt);
    // sun + shadow box follow the view
    const shadowR = THREE.MathUtils.clamp(nav!.dist * 0.6, 45, 200);
    const sc = env.sun.shadow.camera;
    if (Math.abs(sc.right - shadowR) > 4) {
      sc.left = sc.bottom = -shadowR;
      sc.right = sc.top = shadowR;
      sc.updateProjectionMatrix();
    }
    env.sun.target.position.set(nav!.target.x, 0, nav!.target.z);
    env.sun.position.set(nav!.target.x + 120, 210, nav!.target.z + 95); // v4: higher sun, the biome walls must not black out the road

    for (const t of tracks.values()) t.update(dt, clock, nav!.camera.position.distanceTo(tmpV.set(t.origin.x + t.endX / 2, 0, t.origin.z)));
    tickProps(clock);
    biomes.update(dt, clock, nav!.camera);
    for (let i = rockfalls.length - 1; i >= 0; i--) {
      const r = rockfalls[i];
      if (!r.a.sims.includes(r.sim)) {
        rockfalls.splice(i, 1);
        continue;
      }
      if (!r.started) {
        if (now < r.at) continue;
        r.started = true;
        if (!r.small) {
          fx.emit({ t: 'crash', carId: r.a.id, kind: 'rockfall', ...worldPt(r.a, r.sim.focusX, 1, r.sim.laneZ), lossUsd: 0 });
          replays.push({ sim: r.sim, actor: r.a, side: 1, from: r.sim.replay.from, to: r.sim.replay.to, rate: r.sim.replay.rate, label: r.label, startWall: 0 });
          nav!.addTrauma(nav!.dist < 120 ? 0.25 : 0.08);
        }
      }
      const t0 = r.sim.t;
      r.sim.t = Math.min(r.sim.duration, r.sim.t + dt);
      for (const c of r.sim.cues) if (c.t > t0 && c.t <= r.sim.t) cue(r.a, c);
      r.sim.apply(r.sim.t);
      if (r.sim.t >= r.sim.duration) {
        r.sim.finish();
        rockfalls.splice(i, 1);
      }
    }
    smoke.update(dt);
    if (countersDirty) {
      countersDirty = false;
      const m = countersFrom();
      for (const t of tracks.values()) t.setCounters(m);
    }

    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      if (now > f.until) {
        f.node.remove();
        floaters.splice(i, 1);
        continue;
      }
      tmpV.copy(f.pos).project(nav!.camera);
      f.node.style.display = tmpV.z > 1 ? 'none' : '';
      f.node.style.left = `${((tmpV.x + 1) / 2) * 100}%`;
      f.node.style.top = `${((1 - tmpV.y) / 2) * 100}%`;
    }

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, nav!.camera);

    // high-speed-cam inset: slow-motion replay of the latest crash / AEB stop anywhere in the world
    if (!showHsCam) replays.length = 0;
    if (!currentReplay && replays.length) {
      // crashes first (they are the story), then the most recent AEB stops
      const ci = replays.findIndex((r) => r.sim.kind === 'crash');
      currentReplay = ci >= 0 ? replays.splice(ci, 1)[0] : replays.shift()!;
      while (replays.length > 4) {
        const ai = replays.findIndex((r) => r.sim.kind !== 'crash');
        replays.splice(ai >= 0 ? ai : 0, 1);
      }
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
        const fx = r.sim.focusX + r.actor.track.origin.x;
        const fz = r.sim.laneZ + r.actor.track.origin.z;
        if (isDeath(r.sim)) r.sim.aim(hsCam.camera, tR, r.actor.track.origin.x, r.actor.track.origin.z);
        else if (r.sim.kind === 'crash' && r.side < 0) {
          // wider low 3/4 rig than v2: the Kenney bodies are chunkier, keep the honeycomb face in frame
          hsCam.camera.position.set(fx - 6.8, 1.9, fz - 5.6);
          hsCam.camera.lookAt(fx - 0.6, 0.8, fz);
        } else hsCam.aim(fx, fz, r.side);
        const iw = Math.round(Math.min(W * 0.3, 560));
        const ih = Math.round((iw * 9) / 16);
        const ix = 336;
        const iy = 24;
        renderer.setScissorTest(true);
        renderer.setViewport(ix, iy, iw, ih);
        renderer.setScissor(ix, iy, iw, ih);
        renderer.render(scene, hsCam.camera);
        renderer.setScissorTest(false);
        r.sim.restore();
        inset.style.display = '';
        inset.style.width = `${iw}px`;
        inset.style.height = `${ih}px`;
        inset.style.left = `${ix}px`;
        inset.style.bottom = `${iy}px`;
        insetTime.textContent = `t = ${tR < 0 ? '−' : '+'}${Math.abs(tR).toFixed(3)} s`;
        insetMeta.textContent = r.label;
        insetSpeed.textContent = `${r.sim.kmh} km/h · ${r.sim.kind === 'crash' ? `replay 1/${Math.round(1 / r.rate)}` : 'AEB'}`;
      }
    }

    if (now - lastMini > 100) {
      lastMini = now;
      const activeTracks = new Set([...actors.values()].map((a) => a.track));
      const p = new THREE.Vector3();
      minimap.draw(
        [...tracks.values()].map((t) => ({ id: t.spec.id, name: t.spec.name, box: t.bounds(), active: activeTracks.has(t), roadZ: t.origin.z + slotZ(0) })),
        [...actors.values()].flatMap((a) =>
          (['bare', 'airbag'] as const).map((v) => {
            a.lanes[v].car.group.getWorldPosition(p);
            return { x: p.x, z: p.z, color: store.car(a.id)?.car.color ?? '#f5c400', crashed: a.lanes[v].car.crush > 0.05 };
          }),
        ),
        nav!.camera,
      );
    }
    fpsFrames++;
    if (now - fpsT > 1000) {
      const fps = (fpsFrames * 1000) / (now - fpsT);
      (window as unknown as { __worldFps: number }).__worldFps = fps;
      if (showFps) fpsPill.textContent = `${fps.toFixed(0)} fps · ${renderer.info.render.calls} calls · ${actors.size} cars · ${tracks.size} tracks`;
      fpsFrames = 0;
      fpsT = now;
    }
  }
  renderer.setAnimationLoop(step);

  const onResize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    renderer.setSize(W, H);
    nav!.resize(W, H);
  };
  window.addEventListener('resize', onResize);

  return () => {
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    feed?.stop();
    hud.destroy();
    renderer.dispose();
  };
}
