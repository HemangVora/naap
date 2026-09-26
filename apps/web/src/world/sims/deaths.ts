import * as THREE from 'three';
import type { Sim } from '../../arena/sims';
import { CAR_SCALE, NOSE_X } from '../../arena/car';
import { glowTexture, smokeTexture } from '../../arena/textures';
import type { WorldCar } from '../car';
import {
  BROKEN_Z,
  CLIFF_FLOOR_Y,
  CLIFF_REST,
  CLIFF_X1,
  CLIFF_Z,
  GAP_X0,
  LAVA_X1,
  LAVA_Y,
  RAIL_Z,
  RAMP_END,
  RAMP_START,
  RAMP_TOP_Y,
  RIVER_X0,
  RIVER_X1,
  WALL_Z_FAR,
  WATER_Y,
} from '../biomes/geo';
import { paintedBoulder, rockMaterial } from '../biomes/rockkit';

// v4 biome deaths: deterministic f(t) sims (like v2 CrashSim) so the high-speed-cam inset can replay any moment.
// t = 0 is the moment the car leaves its lane (for RockfallSim: the first boulder lets go).

export type CueKind = 'splash' | 'sizzle' | 'dust' | 'rumble';
export interface Cue {
  t: number;
  kind: CueKind;
  x: number;
  y: number;
  z: number;
}
export interface DeathSim extends Sim {
  kind: 'crash';
  death: 'cliff-fall' | 'lava' | 'water' | 'rockfall';
  cues: Cue[];
  replay: { from: number; to: number; rate: number };
  aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number): void;
  finish(): void;
  exitX: number;
}

const V = 64 / 3.6;
const G = 9.8;
const HC = 0.8; // car centre height above the group origin (world m)
const CX = (NOSE_X - 1.75) * CAR_SCALE; // car centre x offset from the group origin
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const easeOut = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ── shared resources (lazy: textures need the DOM) ─────────────────────────
let R: ReturnType<typeof makeRes> | null = null;
function makeRes() {
  return {
    rock: paintedBoulder('granite', 7101, 0),
    boulder: paintedBoulder('ochre', 7203, 1),
    pebble: paintedBoulder('ochre', 7305, 0),
    puff: new THREE.IcosahedronGeometry(1, 1),
    plank: new THREE.BoxGeometry(2.2, 0.32, 0.12),
    drop: new THREE.IcosahedronGeometry(0.12, 0),
    ember: new THREE.BoxGeometry(0.09, 0.09, 0.09),
    bubble: new THREE.SphereGeometry(0.14, 6, 4),
    ring: new THREE.RingGeometry(0.82, 1, 40),
    crown: new THREE.CylinderGeometry(1, 1.35, 1, 24, 1, true),
    rockMat: new THREE.MeshStandardMaterial({ color: 0x8a7f72, roughness: 0.95, flatShading: true }),
    dustMat: new THREE.MeshStandardMaterial({ color: 0xb89c74, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, flatShading: true }),
    steelMat: new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.45, metalness: 0.6 }),
    waterDrop: new THREE.MeshStandardMaterial({ color: 0xe8f4fa, roughness: 0.2, transparent: true, opacity: 0.85 }),
    lavaDrop: new THREE.MeshBasicMaterial({ color: 0xff7a22, toneMapped: false }),
    emberMat: new THREE.MeshBasicMaterial({ color: 0xffb040, toneMapped: false }),
    bubbleMat: new THREE.MeshStandardMaterial({ color: 0xd8f0f8, roughness: 0.1, transparent: true, opacity: 0.6 }),
    smoke: smokeTexture(),
    glow: glowTexture(),
  };
}
const res = () => (R ??= makeRes());

const tmpO = new THREE.Object3D();
const tmpV = new THREE.Vector3();
const C = new THREE.Vector3(); // pose output: car centre (track-local)
const E = new THREE.Euler(0, 0, 0, 'YXZ'); // pose output: roll x, yaw y, pitch z (nose-down negative)
const hide = (m: THREE.InstancedMesh, i: number) => {
  tmpO.position.set(0, -999, 0);
  tmpO.scale.setScalar(0);
  tmpO.updateMatrix();
  m.setMatrixAt(i, tmpO.matrix);
};

/** Ballistic pieces (debris, droplets, rocks): pure f(t), stop on their floor. */
class Ballistic {
  mesh: THREE.InstancedMesh;
  private s: Float32Array; // t0, x, y, z, vx, vy, vz, spin, size, floor, hideOnFloor
  n = 0;
  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, private cap: number, private g = G) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.s = new Float32Array(cap * 11);
    parent.add(this.mesh);
  }
  add(t0: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, floor: number, hideOnFloor = false) {
    if (this.n >= this.cap) return;
    const o = this.n++ * 11;
    this.s.set([t0, x, y, z, vx, vy, vz, rnd(4, 12) * (Math.random() < 0.5 ? -1 : 1), size, floor, hideOnFloor ? 1 : 0], o);
  }
  apply(t: number) {
    const s = this.s;
    for (let i = 0; i < this.cap; i++) {
      const o = i * 11;
      const tau = t - s[o];
      if (i >= this.n || tau < 0) {
        hide(this.mesh, i);
        continue;
      }
      const dy = s[o + 2] - s[o + 9];
      const tf = (s[o + 5] + Math.sqrt(s[o + 5] * s[o + 5] + 2 * this.g * Math.max(0, dy))) / this.g;
      if (tau > tf && s[o + 10]) {
        hide(this.mesh, i);
        continue;
      }
      const tc = Math.min(tau, tf);
      tmpO.position.set(s[o + 1] + s[o + 4] * tc, Math.max(s[o + 9], s[o + 2] + s[o + 5] * tc - 0.5 * this.g * tc * tc), s[o + 3] + s[o + 6] * tc);
      tmpO.rotation.set(tc * s[o + 7], tc * s[o + 7] * 0.7, i);
      tmpO.scale.setScalar(s[o + 8]);
      tmpO.updateMatrix();
      this.mesh.setMatrixAt(i, tmpO.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Dust bursts: low-poly puffs that billow out, rise and shrink away. */
class Puffs {
  mesh: THREE.InstancedMesh;
  private s: Float32Array; // t0, x, y, z, dx, dz, size
  n = 0;
  constructor(parent: THREE.Object3D, private cap: number, mat?: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(res().puff, mat ?? res().dustMat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.s = new Float32Array(cap * 7);
    parent.add(this.mesh);
  }
  burst(t0: number, x: number, y: number, z: number, count: number, size: number) {
    for (let k = 0; k < count && this.n < this.cap; k++) {
      const a = (k / count) * Math.PI * 2 + rnd(-0.3, 0.3);
      const r = rnd(0.6, 1.4) * size;
      this.s.set([t0 + rnd(0, 0.08), x, y, z, Math.cos(a) * r * 1.6, Math.sin(a) * r * 1.6, size * rnd(0.6, 1.1)], this.n++ * 7);
    }
  }
  apply(t: number, life = 1.5) {
    const s = this.s;
    for (let i = 0; i < this.cap; i++) {
      const o = i * 7;
      const u = (t - s[o]) / life;
      if (i >= this.n || u < 0 || u > 1) {
        hide(this.mesh, i);
        continue;
      }
      const e = easeOut(u * 1.6);
      tmpO.position.set(s[o + 1] + s[o + 4] * e, s[o + 2] + 0.3 + u * 1.4 * s[o + 6], s[o + 3] + s[o + 5] * e);
      tmpO.rotation.set(i, i * 0.3, 0);
      tmpO.scale.setScalar(s[o + 6] * (0.35 + 1.1 * e) * Math.sqrt(1 - u));
      tmpO.updateMatrix();
      this.mesh.setMatrixAt(i, tmpO.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Common plumbing: a group under the track, restore/dispose, pose writer. */
abstract class Base {
  kind = 'crash' as const;
  t = 0;
  kmh = 64;
  cues: Cue[] = [];
  abstract death: DeathSim['death'];
  abstract duration: number;
  abstract replay: DeathSim['replay'];
  abstract exitX: number;
  focusX = 0;
  protected root = new THREE.Group();
  protected owned: { dispose(): void }[] = [];
  protected meshes: THREE.InstancedMesh[] = [];
  constructor(parent: THREE.Object3D, public laneZ: number, private restoreFn: () => void) {
    parent.add(this.root);
  }
  abstract apply(t: number): void;
  abstract aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number): void;
  finish() {}
  restore() {
    this.restoreFn();
  }
  protected track<T extends { mesh: THREE.InstancedMesh }>(p: T): T {
    this.meshes.push(p.mesh);
    return p;
  }
  protected sprite(color: number, additive: boolean, map: THREE.Texture, opacity = 1) {
    const m = new THREE.SpriteMaterial({ map, color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !additive });
    this.owned.push(m);
    const s = new THREE.Sprite(m);
    s.renderOrder = 7;
    this.root.add(s);
    return s;
  }
  dispose() {
    this.root.removeFromParent();
    for (const m of this.meshes) m.dispose();
    for (const o of this.owned) o.dispose();
  }
}

/** Write the car: centre C + Euler E (rotates about the car centre, not the wheel plane). */
function place(car: WorldCar, crush: number, airbag: number, dummy: number) {
  car.setPose({ x: C.x, y: 0, pitch: 0, crush, airbag, dummy });
  car.group.rotation.copy(E);
  tmpV.set(CX, HC, 0).applyEuler(E);
  car.group.position.set(C.x - tmpV.x, C.y - tmpV.y, C.z - tmpV.z);
}
function laneApproach(x0: number, laneZ: number, t: number) {
  C.set(x0 + V * t + CX, HC, laneZ);
  E.set(0, 0, 0);
}
function chaseCam(cam: THREE.PerspectiveCamera, ox: number, oz: number, px: number, py: number, pz: number) {
  cam.position.set(px + ox, py, pz + oz);
  cam.lookAt(C.x + ox, C.y, C.z + oz);
}

// ── cliff-fall ─────────────────────────────────────────────────────────────
export class CliffFallSim extends Base implements DeathSim {
  death = 'cliff-fall' as const;
  duration = 4.2;
  replay = { from: -0.3, to: 3.6, rate: 0.5 };
  exitX: number;
  private T1 = 0.45; // through the rail
  private TF: number; // first scree hit
  private T3: number; // at rest
  private xr: number;
  private rest: THREE.Vector3;
  private b1 = new THREE.Vector3();
  private b2 = new THREE.Vector3();
  private c0: number;
  private rail: Ballistic;
  private rocks: Ballistic;
  private dust: Puffs;
  constructor(parent: THREE.Object3D, private car: WorldCar, private x0: number, laneZ: number, sx: number, restore: () => void) {
    super(parent, laneZ, restore);
    this.c0 = car.crush;
    this.exitX = sx + CLIFF_X1 + 1;
    this.xr = x0 + V * 0.85 * this.T1 + CX;
    const fall = HC - (CLIFF_FLOOR_Y + HC);
    this.TF = this.T1 + (2 + Math.sqrt(4 + 2 * 12 * fall)) / 12;
    this.T3 = this.TF + 0.7 + 0.45;
    this.rest = new THREE.Vector3(sx + CLIFF_REST.dx, CLIFF_FLOOR_Y + HC * 0.9, CLIFF_REST.z);
    const p1 = new THREE.Vector3(this.xr, HC, RAIL_Z);
    this.b1.lerpVectors(p1, this.rest, 0.72).setY(CLIFF_FLOOR_Y + HC);
    this.b2.lerpVectors(p1, this.rest, 0.92).setY(CLIFF_FLOOR_Y + HC);
    this.focusX = this.b1.x;
    const r = res();
    this.rail = this.track(new Ballistic(this.root, r.plank, r.steelMat, 3));
    for (let i = 0; i < 3; i++) this.rail.add(this.T1 - 0.02, this.xr - 1.6 + i * 1.6, 0.7, RAIL_Z, rnd(3, 7), rnd(3, 6), rnd(-6, -3), 1, CLIFF_FLOOR_Y + 0.15);
    this.rocks = this.track(new Ballistic(this.root, r.rock, rockMaterial(), 26));
    for (let i = 0; i < 26; i++)
      this.rocks.add(this.T1 + 0.15 + i * 0.06, this.xr + rnd(-2.5, 3), rnd(-1.2, 0), CLIFF_Z - 0.2, rnd(-1, 2), rnd(-1, 1.5), rnd(-3.5, -1), rnd(0.15, 0.55), CLIFF_FLOOR_Y + 0.2);
    this.dust = this.track(new Puffs(this.root, 44));
    this.dust.burst(this.T1, this.xr, 0.2, RAIL_Z, 6, 0.8);
    for (const [tt, p, n, s] of [
      [this.TF, this.b1, 16, 2.2],
      [this.TF + 0.7, this.b2, 12, 1.6],
      [this.T3, this.rest, 10, 1.2],
    ] as const) {
      this.dust.burst(tt, p.x, CLIFF_FLOOR_Y, p.z, n, s);
      this.cues.push({ t: tt, kind: 'dust', x: p.x, y: CLIFF_FLOOR_Y, z: p.z });
    }
    this.cues.push({ t: this.TF, kind: 'rumble', x: this.b1.x, y: CLIFF_FLOOR_Y, z: this.b1.z });
    this.apply(0);
  }
  private pose(t: number) {
    const { T1, TF, T3 } = this;
    if (t < 0) return laneApproach(this.x0, this.laneZ, t);
    if (t < T1) {
      // sideways acceleration: the car is still heading for the drop when it meets the rail
      const u = t / T1;
      C.set(this.x0 + V * 0.85 * t + CX, HC, lerp(this.laneZ, RAIL_Z, u * u));
      E.set(-0.08 * u, Math.atan2((2 * u * (this.laneZ - RAIL_Z)) / T1, V * 0.85), 0);
      return;
    }
    const yaw1 = Math.atan2((2 * (this.laneZ - RAIL_Z)) / T1, V * 0.85);
    if (t < TF) {
      const tau = t - T1;
      const u = tau / (TF - T1);
      C.set(lerp(this.xr, this.b1.x, u), HC + 2 * tau - 6 * tau * tau, lerp(RAIL_Z, this.b1.z, u));
      E.set(-2 * Math.PI * easeOut(u * 0.9) * 1.0, yaw1 + 0.6 * u, -0.5 * Math.sin(u * Math.PI));
      return;
    }
    const roll0 = -2 * Math.PI * easeOut(0.9);
    if (t < TF + 0.7) {
      const u = (t - TF) / 0.7;
      C.lerpVectors(this.b1, this.b2, u);
      C.y += 1.6 * 4 * u * (1 - u);
      E.set(roll0 - 0.9 * Math.PI * u, yaw1 + 0.6 + 0.5 * u, 0.35 * Math.sin(u * Math.PI));
      return;
    }
    const roll1 = roll0 - 0.9 * Math.PI;
    const target = -3 * Math.PI; // on its roof
    if (t < T3) {
      const u = (t - TF - 0.7) / 0.45;
      C.lerpVectors(this.b2, this.rest, u);
      C.y += 0.55 * 4 * u * (1 - u);
      E.set(lerp(roll1, target, easeOut(u)), yaw1 + 1.1 + 0.2 * u, 0.12 * Math.sin(u * Math.PI));
      return;
    }
    const s = t - T3;
    C.copy(this.rest);
    C.y += 0.05 * Math.sin(s * 14) * Math.exp(-5 * s);
    E.set(target + 0.04 * Math.sin(s * 11) * Math.exp(-4 * s), yaw1 + 1.3, 0);
  }
  apply(t: number) {
    this.pose(t);
    const crush = Math.min(0.85, this.c0 + 0.45 * smooth(this.TF, this.TF + 0.08, t) + 0.25 * smooth(this.TF + 0.7, this.TF + 0.78, t));
    const airbag = smooth(this.TF, this.TF + 0.05, t) * 0.8;
    place(this.car, Math.max(this.c0, crush), Math.max(this.car.airbagRest * (t < this.TF ? 1 : 0), airbag), t > this.T1 ? 0.3 * Math.sin(t * 9) * Math.exp(-(t - this.T1)) : 0);
    this.rail.apply(t);
    this.rocks.apply(t);
    this.dust.apply(t);
  }
  finish() {
    this.car.crush = Math.max(this.car.crush, Math.min(0.85, this.c0 + 0.7));
    this.car.airbagRest = 0.6;
  }
  aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number) {
    this.pose(t);
    const k = clamp01(-C.y / 4);
    chaseCam(cam, ox, oz, C.x - lerp(10, 7, k), C.y + lerp(4.5, 5.5, k), lerp(C.z + 3, Math.max(-21, C.z - 4), k));
  }
}

// ── lava ───────────────────────────────────────────────────────────────────
export class LavaSim extends Base implements DeathSim {
  death = 'lava' as const;
  duration = 5.2;
  replay = { from: -0.3, to: 4.5, rate: 0.6 };
  exitX: number;
  private TA: number; // at the ramp foot
  private TB: number; // off the ramp end
  private TE: number; // lava entry
  private p0: THREE.Vector3;
  private ctrl: THREE.Vector3;
  private rs: THREE.Vector3;
  private re: THREE.Vector3;
  private entry = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private rampYaw: number;
  private rampPitch: number;
  private c0: number;
  private prevMat: THREE.Material;
  private burn: THREE.MeshStandardMaterial;
  private charMat: THREE.MeshStandardMaterial;
  private drops: Ballistic;
  private embers: THREE.InstancedMesh;
  private emberSeed: Float32Array;
  private flames: THREE.Sprite[] = [];
  private smoke: THREE.Sprite[] = [];
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private white = new THREE.Color(1, 1, 1);
  private charred = new THREE.Color(0.16, 0.12, 0.1);
  constructor(parent: THREE.Object3D, private car: WorldCar, private x0: number, laneZ: number, sx: number, restore: () => void) {
    super(parent, laneZ, restore);
    this.c0 = car.crush;
    this.exitX = sx + LAVA_X1 + 1;
    this.prevMat = car.bodyMesh.material as THREE.Material;
    this.burn = (this.prevMat as THREE.MeshStandardMaterial).clone();
    this.burn.emissive = new THREE.Color(0xff5a1a);
    this.charMat = this.burn.clone();
    this.charMat.color.setRGB(0.22, 0.17, 0.14);
    this.charMat.emissiveIntensity = 0.15;
    this.owned.push(this.burn);
    this.p0 = new THREE.Vector3(x0 + CX, HC, laneZ);
    this.rs = new THREE.Vector3(sx + RAMP_START.dx, HC, RAMP_START.z);
    this.re = new THREE.Vector3(sx + RAMP_END.dx, HC + RAMP_TOP_Y, RAMP_END.z);
    this.ctrl = new THREE.Vector3(this.p0.x + V * 0.18, HC, laneZ);
    const lenA = this.p0.distanceTo(this.ctrl) + this.ctrl.distanceTo(this.rs);
    this.TA = Math.max(0.25, lenA / V);
    const lenB = Math.hypot(this.re.x - this.rs.x, this.re.z - this.rs.z);
    this.TB = this.TA + (2 * lenB) / (V + 4);
    this.dir.set(this.re.x - this.rs.x, 0, this.re.z - this.rs.z).normalize();
    this.rampYaw = Math.atan2(-this.dir.z, this.dir.x);
    this.rampPitch = Math.atan2(RAMP_TOP_Y, lenB);
    const vy = 1.2;
    const drop = this.re.y - (LAVA_Y + 0.3);
    const tf = (vy + Math.sqrt(vy * vy + 2 * G * drop)) / G;
    this.TE = this.TB + tf;
    this.entry.copy(this.re).addScaledVector(this.dir, 4 * tf).setY(LAVA_Y + 0.3);
    this.focusX = this.entry.x;
    this.cues.push({ t: this.TE, kind: 'sizzle', x: this.entry.x, y: LAVA_Y, z: this.entry.z });
    const r = res();
    this.drops = this.track(new Ballistic(this.root, r.drop, r.lavaDrop, 36));
    for (let i = 0; i < 36; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(1.5, 5);
      this.drops.add(this.TE + rnd(0, 0.1), this.entry.x, LAVA_Y + 0.2, this.entry.z, Math.cos(a) * sp, rnd(3, 8), Math.sin(a) * sp, rnd(1, 2.6), LAVA_Y, true);
    }
    this.embers = new THREE.InstancedMesh(r.ember, r.emberMat, 48);
    this.embers.frustumCulled = false;
    this.root.add(this.embers);
    this.meshes.push(this.embers);
    this.emberSeed = new Float32Array(48 * 4);
    for (let i = 0; i < 48; i++) this.emberSeed.set([Math.random(), rnd(0.3, 2.2), rnd(0, 6.28), rnd(0.25, 0.6)], i * 4);
    for (let i = 0; i < 7; i++) this.flames.push(this.sprite(i % 3 ? 0xff6a1a : 0xffc040, true, r.glow));
    for (let i = 0; i < 12; i++) this.smoke.push(this.sprite(0x1d1a18, false, r.smoke, 0));
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.owned.push(this.ringMat);
    this.ring = new THREE.Mesh(r.ring, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(this.entry.x, LAVA_Y + 0.06, this.entry.z);
    this.root.add(this.ring);
    this.apply(0);
  }
  private pose(t: number) {
    const { TA, TB, TE } = this;
    if (t < 0) return laneApproach(this.x0, this.laneZ, t);
    if (t < TA) {
      const u = t / TA;
      const a = 1 - u;
      C.set(a * a * this.p0.x + 2 * a * u * this.ctrl.x + u * u * this.rs.x, HC, a * a * this.p0.z + 2 * a * u * this.ctrl.z + u * u * this.rs.z);
      const dx = 2 * a * (this.ctrl.x - this.p0.x) + 2 * u * (this.rs.x - this.ctrl.x);
      const dz = 2 * a * (this.ctrl.z - this.p0.z) + 2 * u * (this.rs.z - this.ctrl.z);
      E.set(0.08 * Math.sin(u * Math.PI), Math.atan2(-dz, dx), this.rampPitch * smooth(0.8, 1, u));
      return;
    }
    if (t < TB) {
      const u = (t - TA) / (TB - TA);
      const s = (V * u - 0.5 * (V - 4) * u * u) / ((V + 4) / 2); // decelerating along the ramp
      C.lerpVectors(this.rs, this.re, s);
      E.set(0, this.rampYaw, this.rampPitch);
      return;
    }
    if (t < TE) {
      const tau = t - TB;
      C.copy(this.re).addScaledVector(this.dir, 4 * tau);
      C.y = this.re.y + 1.2 * tau - 0.5 * G * tau * tau;
      E.set(0.1 * tau, this.rampYaw, lerp(this.rampPitch, -1.05, easeOut(tau / (TE - TB))));
      return;
    }
    const s = t - TE;
    const sink = smooth(0.3, 3.3, s);
    C.copy(this.entry);
    C.y = LAVA_Y + 0.3 - 0.7 * easeOut(s / 0.35) + 0.25 * Math.sin(s * 5) * Math.exp(-2 * s) - 1.7 * sink - HC * 0.8 * sink;
    E.set(0.3 * smooth(0, 2.5, s) + 0.05 * Math.sin(s * 3), this.rampYaw + 0.2 * smooth(0, 3, s), lerp(-1.05, -0.45, smooth(0, 1.5, s)));
  }
  apply(t: number) {
    this.pose(t);
    const s = t - this.TE;
    const hot = s > 0 ? smooth(0, 2.2, s) : 0;
    this.car.setBodyMaterial(t > 0 ? this.burn : this.prevMat);
    this.burn.emissiveIntensity = hot * (2.2 + 0.5 * Math.sin(t * 17) * Math.sin(t * 7.3));
    this.burn.color.copy(this.white).lerp(this.charred, smooth(0, 2, s));
    const crush = s > 0 ? Math.max(this.c0, Math.min(0.75, this.c0 + 0.5 * smooth(0, 0.1, s))) : this.c0;
    place(this.car, crush, s > 0 ? 0.7 * smooth(0, 0.06, s) : this.car.airbagRest, 0);
    this.drops.apply(t);
    const fade = 1 - smooth(this.duration - 0.9, this.duration, t);
    // flames licking up around the car
    this.flames.forEach((f, i) => {
      const on = s > 0 && s < 4.4;
      f.visible = on && fade > 0.02;
      if (!f.visible) return;
      const fl = 0.75 + 0.25 * Math.sin(t * (19 + i * 3) + i * 1.7) * Math.sin(t * 7 + i);
      const k = smooth(0, 0.4, s) * (1 - smooth(3.2, 4.4, s));
      const a = (i / 7) * Math.PI * 2 + t * 0.6;
      f.position.set(this.entry.x + Math.cos(a) * 0.9, Math.max(LAVA_Y + 0.5, C.y) + 0.6 + (i % 3) * 0.5 + fl * 0.4, this.entry.z + Math.sin(a) * 0.9);
      f.scale.setScalar((1.6 + (i % 3) * 0.8) * fl * k + 0.01);
      (f.material as THREE.SpriteMaterial).opacity = 0.9 * k * fade;
    });
    // black smoke column
    this.smoke.forEach((m, i) => {
      const age = s - i * 0.22;
      m.visible = age > 0 && fade > 0.02;
      if (!m.visible) return;
      const ph = (age * 0.3 + (i % 4) * 0.07) % 1;
      m.position.set(this.entry.x + Math.sin(i * 2.1 + ph * 3) * (0.4 + ph * 1.5) + ph * 1.5, LAVA_Y + 1.2 + ph * 14, this.entry.z + Math.cos(i * 1.3) * ph * 1.2);
      m.scale.setScalar(2.2 + ph * 7);
      (m.material as THREE.SpriteMaterial).opacity = 0.85 * smooth(0, 0.08, ph) * (1 - ph) * fade;
    });
    // embers rising
    for (let i = 0; i < 48; i++) {
      const o = i * 4;
      if (s <= 0) {
        hide(this.embers, i);
        continue;
      }
      const ph = (s * this.emberSeed[o + 3] + this.emberSeed[o]) % 1;
      if (s < this.emberSeed[o] * 0.8) {
        hide(this.embers, i);
        continue;
      }
      const a = this.emberSeed[o + 2] + ph * 4;
      const r = this.emberSeed[o + 1] * (0.4 + ph);
      tmpO.position.set(this.entry.x + Math.cos(a) * r, LAVA_Y + 0.3 + ph * 10, this.entry.z + Math.sin(a) * r);
      tmpO.rotation.set(ph * 20, i, 0);
      tmpO.scale.setScalar(1.4 * (1 - ph) + 0.2);
      tmpO.updateMatrix();
      this.embers.setMatrixAt(i, tmpO.matrix);
    }
    this.embers.instanceMatrix.needsUpdate = true;
    // glowing ring that stays
    this.ring.visible = s > 0;
    const rr = 0.8 + 2.8 * easeOut(s / 1.6);
    this.ring.scale.set(rr, rr, 1);
    this.ringMat.opacity = s > 0 ? 0.55 + 0.35 * (1 - smooth(0, 2, s)) + 0.1 * Math.sin(t * 5) : 0;
  }
  finish() {
    this.car.setBodyMaterial(this.charMat);
    this.car.crush = Math.max(this.car.crush, Math.min(0.75, this.c0 + 0.5));
    this.car.airbagRest = 0.6;
  }
  aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number) {
    this.pose(t);
    chaseCam(cam, ox, oz, C.x - 7, Math.max(C.y + 3.5, 3), C.z + 8);
  }
  dispose() {
    super.dispose();
    this.charMat.dispose();
  }
}

// ── water ──────────────────────────────────────────────────────────────────
export class WaterSim extends Base implements DeathSim {
  death = 'water' as const;
  duration: number;
  replay: DeathSim['replay'];
  exitX: number;
  private TA = 0.6;
  private xA: number;
  private TG: number; // tips into the gap
  private TW: number; // hits the water
  private xg: number;
  private c0: number;
  private drops: Ballistic;
  private bubbles: THREE.InstancedMesh;
  private bSeed: Float32Array;
  private crown: THREE.Mesh;
  private crownMat: THREE.MeshStandardMaterial;
  private ripple: THREE.Mesh;
  private rippleMat: THREE.MeshBasicMaterial;
  private splashAt = new THREE.Vector3();
  private aDec = (V - 5) / 0.6;
  constructor(parent: THREE.Object3D, private car: WorldCar, private x0: number, laneZ: number, private sx: number, restore: () => void) {
    super(parent, laneZ, restore);
    this.c0 = car.crush;
    this.exitX = sx + RIVER_X1 + 1;
    this.xA = x0 + CX + V * this.TA - 0.5 * this.aDec * this.TA * this.TA;
    this.xg = Math.max(this.xA + 0.3, sx + GAP_X0 + 0.3);
    this.TG = this.TA + (this.xg - this.xA) / 5;
    const drop = HC - (WATER_Y + 0.3);
    this.TW = this.TG + Math.sqrt((2 * drop) / G);
    this.duration = this.TW + 3.6;
    this.replay = { from: -0.3, to: this.TW + 2.4, rate: 0.6 };
    this.splashAt.set(this.xg + 1.9 * (1 - Math.exp(-3 * (this.TW - this.TG))), WATER_Y, BROKEN_Z);
    this.focusX = this.splashAt.x;
    this.cues.push({ t: this.TW, kind: 'splash', x: this.splashAt.x, y: WATER_Y, z: BROKEN_Z });
    const r = res();
    this.drops = this.track(new Ballistic(this.root, r.drop, r.waterDrop, 64));
    for (let i = 0; i < 64; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(1.5, 6);
      this.drops.add(this.TW + rnd(0, 0.12), this.splashAt.x + Math.cos(a) * 0.8, WATER_Y + 0.1, BROKEN_Z + Math.sin(a) * 0.8, Math.cos(a) * sp, rnd(4, 10), Math.sin(a) * sp, rnd(1, 3), WATER_Y, true);
    }
    this.bubbles = new THREE.InstancedMesh(r.bubble, r.bubbleMat, 30);
    this.bubbles.frustumCulled = false;
    this.root.add(this.bubbles);
    this.meshes.push(this.bubbles);
    this.bSeed = new Float32Array(30 * 4);
    for (let i = 0; i < 30; i++) this.bSeed.set([Math.random(), rnd(-1.2, 1.2), rnd(-1, 1), rnd(0.6, 1.5)], i * 4);
    this.crownMat = new THREE.MeshStandardMaterial({ color: 0xf2f8fb, roughness: 0.3, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
    this.rippleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.owned.push(this.crownMat, this.rippleMat);
    this.crown = new THREE.Mesh(r.crown, this.crownMat);
    this.ripple = new THREE.Mesh(r.ring, this.rippleMat);
    this.ripple.rotation.x = -Math.PI / 2;
    this.root.add(this.crown, this.ripple);
    this.apply(0);
  }
  private pose(t: number) {
    const { TA, TG, TW } = this;
    if (t < 0) return laneApproach(this.x0, this.laneZ, t);
    if (t < TA) {
      const s = smooth(0, TA, t);
      C.set(this.x0 + CX + V * t - 0.5 * this.aDec * t * t, HC, lerp(this.laneZ, BROKEN_Z, s));
      const ds = (6 * (t / TA) * (1 - t / TA)) / TA;
      E.set(0, Math.atan2((this.laneZ - BROKEN_Z) * ds, V - this.aDec * t), 0);
      return;
    }
    if (t < TG) {
      C.set(this.xA + 5 * (t - TA), HC, BROKEN_Z);
      E.set(0, 0, 0);
      return;
    }
    if (t < TW) {
      const tau = t - TG;
      C.set(this.xg + 1.9 * (1 - Math.exp(-3 * tau)), HC - 0.5 * G * tau * tau, BROKEN_Z);
      E.set(0.15 * tau, 0.1 * tau, -Math.min(1.15, 1.6 * tau));
      return;
    }
    const s = t - TW;
    const sink = smooth(1.7, 3.4, s);
    C.copy(this.splashAt);
    C.y = WATER_Y + 0.3 - 1.1 * Math.sin(Math.min(Math.PI, s * 4)) * Math.exp(-s) + 0.12 * Math.sin(s * 4.5) - (HC + 1.4) * sink;
    E.set(0.22 * Math.sin(s * 2.1) + 0.3 * sink, 0.1 * (TW - TG) + 0.15 * s, lerp(-1.15, -0.25, smooth(0, 1.2, s)) - 0.5 * sink + 0.06 * Math.sin(s * 3.3));
  }
  apply(t: number) {
    this.pose(t);
    const s = t - this.TW;
    place(this.car, s > 0 ? Math.max(this.c0, Math.min(0.6, this.c0 + 0.3 * smooth(0, 0.08, s))) : this.c0, s > 0 ? 0.7 * smooth(0, 0.05, s) : this.car.airbagRest, 0);
    this.drops.apply(t);
    // crown splash
    this.crown.visible = s > 0 && s < 1.1;
    if (this.crown.visible) {
      const u = s / 1.1;
      const h = 3.2 * Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * (1 - u);
      const rr = 1.2 + 2.6 * easeOut(u);
      this.crown.scale.set(rr, Math.max(0.01, h), rr);
      this.crown.position.set(this.splashAt.x, WATER_Y + h / 2, this.splashAt.z);
      this.crownMat.opacity = 0.85 * (1 - u);
    }
    // ripple ring on the surface
    this.ripple.visible = s > 0 && s < 3;
    if (this.ripple.visible) {
      const rr = 1 + 8 * easeOut(s / 3);
      this.ripple.scale.set(rr, rr, 1);
      this.ripple.position.set(this.splashAt.x, WATER_Y + 0.05, this.splashAt.z);
      this.rippleMat.opacity = 0.75 * (1 - s / 3);
    }
    // bubbles once it goes under
    for (let i = 0; i < 30; i++) {
      const o = i * 4;
      const age = s - 1.6 - this.bSeed[o] * 0.6;
      if (age <= 0) {
        hide(this.bubbles, i);
        continue;
      }
      const ph = (age * this.bSeed[o + 3] + this.bSeed[o]) % 1;
      tmpO.position.set(this.splashAt.x + this.bSeed[o + 1] * (1 + ph * 0.3), WATER_Y - 2.2 + ph * 2.3, this.splashAt.z + this.bSeed[o + 2]);
      tmpO.rotation.set(0, 0, 0);
      tmpO.scale.setScalar((0.6 + ph * 1.2) * (1 - smooth(this.duration - this.TW - 0.6, this.duration - this.TW, s)));
      tmpO.updateMatrix();
      this.bubbles.setMatrixAt(i, tmpO.matrix);
    }
    this.bubbles.instanceMatrix.needsUpdate = true;
  }
  finish() {
    this.car.crush = Math.max(this.car.crush, Math.min(0.6, this.c0 + 0.3));
    this.car.airbagRest = 0.6;
  }
  aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number) {
    this.pose(t);
    const k = clamp01(-C.y / 3);
    chaseCam(cam, ox, oz, lerp(C.x - 6, Math.max(C.x - 3, this.sx + RIVER_X0 + 0.8), k), lerp(C.y + 3.5, WATER_Y + 3, k), lerp(C.z - 8, BROKEN_Z - 9, k));
  }
}

// ── rockfall (boulders only; the Sekisho car stays stopped behind them) ────
// Each boulder: falls off the lip (spinning), hits the road, takes 2–3 decaying bounces while rolling (angular velocity
// = ground speed / radius about the axis ⟂ to its travel), then settles flat-side-down with a small rock. All f(t).
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const qC = new THREE.Quaternion();
const axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
export class RockfallSim extends Base implements DeathSim {
  death = 'rockfall' as const;
  duration = 3.5;
  replay = { from: 0, to: 3.2, rate: 0.6 };
  exitX: number;
  private n: number;
  private s: Float32Array; // t0, x0, y0, z0, x1, z1, r, xr, zr, spin, tImpact, yaw, ax, az, h1, tRoll
  private rocks: THREE.InstancedMesh;
  private dust: Puffs;
  private static N = 16;
  constructor(parent: THREE.Object3D, private xLand: number, laneZ: number, restore: () => void, private opts: { small?: boolean } = {}) {
    super(parent, laneZ, restore);
    this.exitX = xLand;
    this.focusX = xLand + 2;
    const small = !!opts.small;
    this.n = small ? 6 : 7;
    const r = res();
    this.rocks = new THREE.InstancedMesh(small ? r.pebble : r.boulder, rockMaterial(), this.n);
    this.rocks.castShadow = true;
    this.rocks.frustumCulled = false;
    const col = new THREE.Color();
    for (let i = 0; i < this.n; i++) this.rocks.setColorAt(i, col.setScalar(rnd(0.88, 1.08)));
    this.root.add(this.rocks);
    this.meshes.push(this.rocks);
    this.dust = this.track(new Puffs(this.root, 90));
    const N = RockfallSim.N;
    this.s = new Float32Array(this.n * N);
    for (let i = 0; i < this.n; i++) {
      const rad = small ? rnd(0.2, 0.38) : rnd(0.7, 1.25);
      const t0 = i * (small ? 0.18 : 0.12) + rnd(0, 0.08);
      const x0 = xLand + rnd(-1, 5);
      const y0 = rnd(13.5, 16.5);
      const z0 = WALL_Z_FAR + rnd(-0.5, 0.6);
      const x1 = small ? xLand + rnd(-1, 4) : xLand + 0.4 + (i / this.n) * 3.8 + rnd(-0.4, 0.4);
      const z1 = small ? laneZ - rnd(0.5, 2) : laneZ + rnd(-2.2, 0.4);
      const tImp = Math.sqrt((2 * (y0 - rad * 0.5)) / G);
      const xr = small ? x1 + rnd(-1, 2) : xLand + 0.3 + (i / this.n) * 4 + rnd(-0.3, 0.3);
      const zr = small ? laneZ + rnd(5, 9) : laneZ + rnd(-1.5, 1.5);
      const h1 = small ? rnd(0.5, 0.9) : rnd(0.9, 1.5);
      const tRoll = small ? 1.3 : 1.1;
      const a = rnd(0, Math.PI * 2);
      this.s.set([t0, x0, y0, z0, x1, z1, rad, xr, zr, rnd(3, 7) * (Math.random() < 0.5 ? -1 : 1), tImp, rnd(0, 6.28), Math.cos(a), Math.sin(a), h1, tRoll], i * N);
      // dust at the impact and at each bounce landing
      const tb = this.bounceTimes(h1);
      this.dust.burst(t0 + tImp, x1, 0, z1, small ? 2 : 7, small ? 0.6 : 1.8);
      for (let k = 0; k < tb.length; k++) {
        const u = tb[k] / tRoll;
        const e = easeOut(Math.min(1, u));
        this.dust.burst(t0 + tImp + tb[k], lerp(x1, xr, e), 0, lerp(z1, zr, e), small ? 1 : Math.max(2, 5 - k * 2), (small ? 0.4 : 1.2) * (1 - k * 0.25));
      }
      if (i === 0) this.cues.push({ t: t0 + tImp, kind: 'dust', x: x1, y: 0, z: z1 });
    }
    this.cues.push({ t: 0, kind: 'rumble', x: xLand, y: 10, z: WALL_Z_FAR });
    this.apply(0);
  }
  /** end times of the decaying bounces after the impact (s, relative to the impact) */
  private bounceTimes(h1: number) {
    const out: number[] = [];
    let t = 0;
    let h = h1;
    for (let k = 0; k < 3; k++) {
      t += 2 * Math.sqrt((2 * h) / G);
      out.push(t);
      h *= 0.35;
    }
    return out;
  }
  apply(t: number) {
    const s = this.s;
    const N = RockfallSim.N;
    for (let i = 0; i < this.n; i++) {
      const o = i * N;
      const t0 = s[o], x0 = s[o + 1], y0 = s[o + 2], z0 = s[o + 3], x1 = s[o + 4], z1 = s[o + 5];
      const rad = s[o + 6], xr = s[o + 7], zr = s[o + 8], spin = s[o + 9], tImp = s[o + 10];
      const yaw = s[o + 11], h1 = s[o + 14], tRoll = s[o + 15];
      const tau = t - t0;
      const rest = rad * 0.5; // flat bottom at y = -0.5·rad
      qA.setFromAxisAngle(UP, yaw);
      if (tau < 0) {
        tmpO.position.set(x0, y0, z0);
        tmpO.quaternion.copy(qA);
      } else if (tau < tImp) {
        // free fall off the lip: tumbling about a fixed tilted axis
        const u = tau / tImp;
        tmpO.position.set(lerp(x0, x1, u), y0 - 0.5 * G * tau * tau, lerp(z0, z1, u));
        axis.set(s[o + 12], 0.3, s[o + 13]).normalize();
        qB.setFromAxisAngle(axis, spin * tau);
        tmpO.quaternion.multiplyQuaternions(qB, qA);
      } else {
        const b = tau - tImp;
        const tb = this.bounceTimes(h1);
        // vertical: decaying parabolic hops, then resting
        let y = rest;
        let prev = 0;
        let h = h1;
        for (let k = 0; k < tb.length; k++) {
          if (b < tb[k]) {
            const d = tb[k] - prev;
            const w = (b - prev) / d;
            y = rest + 4 * h * w * (1 - w);
            break;
          }
          prev = tb[k];
          h *= 0.35;
        }
        // horizontal: decelerating roll to the rest spot
        const u = Math.min(1, b / tRoll);
        const e = easeOut(u);
        const dx = xr - x1;
        const dz = zr - z1;
        const dist = Math.hypot(dx, dz) * e;
        tmpO.position.set(x1 + dx * e, y, z1 + dz * e);
        // tumble: the fall spin carried over + rolling (angle = distance / radius) about the axis ⟂ to travel
        axis.set(s[o + 12], 0.3, s[o + 13]).normalize();
        qB.setFromAxisAngle(axis, spin * tImp);
        axis.set(dz, 0, -dx).normalize();
        if (axis.lengthSq() < 0.5) axis.set(0, 0, 1);
        qC.setFromAxisAngle(axis, dist / Math.max(0.15, rad) + spin * 0.15 * Math.min(b, 0.6));
        tmpO.quaternion.multiplyQuaternions(qC, qB).multiply(qA);
        // settle: rock onto the flat bottom over the last part of the roll, with a small damped rock
        const settle = smooth(0.6, 1, u);
        if (settle > 0) {
          qB.setFromAxisAngle(UP, yaw + dist * 0.2);
          const wob = settle >= 1 ? 0.06 * Math.sin((b - tRoll) * 12) * Math.exp(-4 * (b - tRoll)) : 0;
          qC.setFromAxisAngle(axis, wob);
          qB.premultiply(qC);
          tmpO.quaternion.slerp(qB, settle);
        }
      }
      tmpO.scale.setScalar(tau < -0.5 ? 0 : rad);
      tmpO.updateMatrix();
      this.rocks.setMatrixAt(i, tmpO.matrix);
    }
    this.rocks.instanceMatrix.needsUpdate = true;
    this.dust.apply(t);
  }
  aim(cam: THREE.PerspectiveCamera, t: number, ox: number, oz: number) {
    void t;
    C.set(this.xLand + 2, 2.5, this.laneZ - 2);
    chaseCam(cam, ox, oz, this.xLand - 10, 5, this.laneZ + 7);
  }
}
