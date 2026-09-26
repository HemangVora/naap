import * as THREE from 'three';
import { CarMesh, CRUSH_MAX, NOSE_X } from './car';
import type { Barrier } from './fixtures';
import { smokeTexture } from './textures';

/**
 * A motion that is a pure function of time since its key moment (impact / brake point).
 * The main loop advances `t` in real time; the high-speed-cam inset re-evaluates the same sim slowly.
 */
export interface Sim {
  kind: 'crash' | 'aeb';
  t: number;
  duration: number;
  focusX: number;
  laneZ: number;
  kmh: number;
  apply(t: number): void;
  /** Put the world back to the real-time state after a replay frame. */
  restore(): void;
  dispose(): void;
}

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const easeOut = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);

const SHARDS = 56;
let shardGeo: THREE.BoxGeometry | null = null;
let shardMat: THREE.MeshStandardMaterial | null = null;
let mistTex: THREE.Texture | null = null;
const dummyObj = new THREE.Object3D();

const CRUSH_T = 0.11; // seconds of crush at 64 km/h (≈120 ms real NCAP)
const V0 = 64 / 3.6;

/** NCAP frontal impact: crush → hit-stop moment → rebound with pitch, airbags, dummy lurch, shards, mist, barrier dent. */
export class CrashSim implements Sim {
  kind = 'crash' as const;
  t = 0;
  duration = 2.4;
  focusX: number;
  kmh = 64;
  private shards: THREE.InstancedMesh;
  private seeds: Float32Array;
  private mist: THREE.Sprite[] = [];
  private restoreFn: () => void;

  constructor(
    private scene: THREE.Scene,
    private car: CarMesh,
    private barrier: Barrier | null,
    /** group x at first contact */
    private contactX: number,
    private c0: number,
    private c1: number,
    public laneZ: number,
    restore: () => void,
  ) {
    this.focusX = contactX + NOSE_X + 0.2;
    this.restoreFn = restore;
    shardGeo ??= new THREE.BoxGeometry(0.16, 0.03, 0.12);
    shardMat ??= new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    this.shards = new THREE.InstancedMesh(shardGeo, shardMat, SHARDS);
    this.shards.frustumCulled = false;
    this.seeds = new Float32Array(SHARDS * 8);
    const col = new THREE.Color();
    for (let i = 0; i < SHARDS; i++) {
      const o = i * 8;
      const glass = i % 4 === 0;
      this.seeds[o] = (Math.random() - 0.5) * 0.3; // x0
      this.seeds[o + 1] = 0.45 + Math.random() * 0.5; // y0
      this.seeds[o + 2] = (Math.random() - 0.5) * 1.6; // z0
      this.seeds[o + 3] = -(1.5 + Math.random() * 6); // vx (back along the car)
      this.seeds[o + 4] = 1 + Math.random() * 4.5; // vy
      this.seeds[o + 5] = (Math.random() - 0.5) * 5; // vz
      this.seeds[o + 6] = Math.random() * 0.05; // spawn time
      this.seeds[o + 7] = 0.6 + Math.random() * 1.2; // size
      col.set(glass ? 0xcfe6f2 : Math.random() < 0.8 ? 0x17181b : 0xf5c400);
      this.shards.setColorAt(i, col);
    }
    if (this.shards.instanceColor) this.shards.instanceColor.needsUpdate = true;
    scene.add(this.shards);
    mistTex ??= smokeTexture();
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, color: 0xf0f2f0, transparent: true, opacity: 0, depthWrite: false }));
      s.renderOrder = 6;
      s.visible = false;
      scene.add(s);
      this.mist.push(s);
    }
    this.apply(0);
  }

  private crushAt(t: number) {
    if (t <= 0) return this.c0;
    if (t >= CRUSH_T) return this.c1;
    return this.c0 + (this.c1 - this.c0) * easeOut(t / CRUSH_T);
  }

  apply(t: number) {
    const c = this.crushAt(t);
    let x = this.contactX;
    let pitch = 0;
    let y = 0;
    let airbag = 0;
    let dummy = 0;
    if (t < 0) x = this.contactX + V0 * t;
    else {
      x = this.contactX + CRUSH_MAX * (c - this.c0);
      if (t > CRUSH_T) {
        const s = t - CRUSH_T;
        x -= 0.55 * (1 - Math.exp(-7 * s)) - 0.06 * Math.sin(18 * s) * Math.exp(-5 * s);
      }
      pitch = 0.1 * Math.sin((2 * Math.PI * t) / 0.6) * Math.exp(-2.6 * t);
      y = 0.03 * Math.abs(Math.sin((2 * Math.PI * t) / 0.6)) * Math.exp(-3 * t);
      airbag = smooth(0.02, 0.07, t) * (1 - 0.4 * smooth(0.3, 1.2, t));
      dummy = t < 0.24 ? 0.6 * Math.sin((Math.PI * t) / 0.24) : 0.12 * Math.sin((2 * Math.PI * (t - 0.24)) / 0.5) * Math.exp(-3 * (t - 0.24));
    }
    this.car.setPose({ x, y, pitch, crush: c, airbag, dummy });
    this.barrier?.setDent(c);

    // shards: deterministic ballistic + floor slide
    const noseX = this.contactX + NOSE_X;
    const z0 = this.laneZ;
    for (let i = 0; i < SHARDS; i++) {
      const o = i * 8;
      const tau = t - this.seeds[o + 6];
      if (tau <= 0) {
        dummyObj.scale.setScalar(0);
      } else {
        const slide = Math.min(tau, 0.7);
        const px = noseX + this.seeds[o] + this.seeds[o + 3] * slide;
        let py = this.seeds[o + 1] + this.seeds[o + 4] * tau - 4.9 * tau * tau;
        const pz = z0 + this.seeds[o + 2] + this.seeds[o + 5] * slide;
        if (py < 0.03) py = 0.03;
        dummyObj.position.set(px, py, pz);
        dummyObj.rotation.set(tau * 9 + i, tau * 6, i * 0.7);
        dummyObj.scale.setScalar(this.seeds[o + 7]);
      }
      dummyObj.updateMatrix();
      this.shards.setMatrixAt(i, dummyObj.matrix);
    }
    this.shards.instanceMatrix.needsUpdate = true;

    // coolant mist
    const mistScale = 0.5 + 3.2 * smooth(0, 0.3, t);
    const mistOp = t <= 0 ? 0 : 0.6 * (1 - smooth(0.15, 1.0, t));
    this.mist.forEach((m, i) => {
      m.visible = mistOp > 0.01;
      m.position.set(noseX - 0.3 - i * 0.4 - t * 0.6, 0.7 + i * 0.35 + t * 1.2, z0 + (i - 1) * 0.5);
      m.scale.set(mistScale, mistScale, 1);
      (m.material as THREE.SpriteMaterial).opacity = mistOp;
    });
  }

  /** Persist the end state on the car (cars stay crumpled). */
  finish() {
    this.car.crush = this.c1;
    this.car.airbagRest = 0.6;
  }

  restore() {
    this.restoreFn();
  }

  dispose() {
    this.shards.removeFromParent();
    this.shards.dispose();
    for (const m of this.mist) {
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
    }
  }
}

/** AEB stop: constant approach, hard braking with nose-dive, stops short of the target, suspension settles. */
export class AebSim implements Sim {
  kind = 'aeb' as const;
  t: number;
  duration: number;
  focusX: number;
  kmh: number;
  tStop: number;
  private x0: number;
  private restoreFn: () => void;

  constructor(
    private car: CarMesh,
    /** current group x */
    fromX: number,
    /** group x where the car must come to rest */
    public xStop: number,
    v: number,
    private a: number,
    public laneZ: number,
    restore: () => void,
  ) {
    this.restoreFn = restore;
    let brakeDist = (v * v) / (2 * a);
    if (fromX > xStop - brakeDist) {
      brakeDist = Math.max(0.5, xStop - fromX);
      v = Math.sqrt(2 * a * brakeDist);
    }
    this.v = v;
    this.x0 = xStop - brakeDist;
    this.tStop = v / a;
    this.t = (fromX - this.x0) / v; // negative: constant-speed approach first
    this.duration = this.tStop + 1.2;
    this.focusX = xStop + NOSE_X;
    this.kmh = Math.round(v * 3.6);
  }
  private v: number;

  braking(t = this.t) {
    return t >= 0 && t < this.tStop;
  }

  apply(t: number) {
    let x: number;
    let pitch: number;
    let dummy: number;
    if (t < 0) {
      x = this.x0 + this.v * t;
      pitch = 0;
      dummy = 0;
    } else if (t < this.tStop) {
      x = this.x0 + this.v * t - 0.5 * this.a * t * t;
      pitch = 0.06 * smooth(0, 0.12, t);
      dummy = 0.18 * smooth(0, 0.12, t);
    } else {
      const s = t - this.tStop;
      x = this.xStop;
      pitch = 0.06 * Math.cos((2 * Math.PI * s) / 0.5) * Math.exp(-4 * s);
      dummy = 0.18 * Math.cos((2 * Math.PI * s) / 0.5) * Math.exp(-4 * s);
    }
    this.car.setPose({ x, y: 0, pitch, crush: this.car.crush, airbag: this.car.airbagRest, dummy });
  }

  restore() {
    this.restoreFn();
  }

  dispose() {}
}
