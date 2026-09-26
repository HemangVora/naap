import * as THREE from 'three';
import type { BarrierId } from '../../types';
import { M, emberMat, uFlash, uTime } from './mats';
import { Scatter, rng } from './scatter';
import { buildPlot, type PlotDress, type TrackLike } from './terrain';
import { VALLEY_Y } from './geo';

export { DEATH_FOR } from './geo';

// Morse for the beacon: the attacker's reply "-... .- -. -.-" (BANK), 1 unit = 0.16 s
const MORSE = (() => {
  const code = '-... .- -. -.-';
  const seq: [number, boolean][] = [];
  for (const ch of code) {
    if (ch === ' ') seq.push([3, false]);
    else {
      seq.push([ch === '.' ? 1 : 3, true]);
      seq.push([1, false]);
    }
  }
  seq.push([7, false]);
  const total = seq.reduce((s, [u]) => s + u, 0);
  return { seq, total };
})();
function morseOn(t: number) {
  let u = (t / 0.16) % MORSE.total;
  for (const [len, on] of MORSE.seq) {
    if (u < len) return on;
    u -= len;
  }
  return false;
}

/** Dust / debris puffs as one Points draw call (world space). */
class DustPool {
  points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private ttl: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private base: Float32Array;
  private next = 0;
  constructor(scene: THREE.Object3D, private cap = 220) {
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.ttl = new Float32Array(cap).fill(1);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.base = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0xc2a27a) } },
      vertexShader: `attribute float size; attribute float alpha; varying float vA;
        void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * 320.0 / -mv.z; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vA; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a); }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
  }
  puff(x: number, y: number, z: number, size = 1, up = 0.6, ttl = 1.2, op = 0.5) {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.pos.set([x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4], i * 3);
    this.vel.set([(Math.random() - 0.5) * 0.8, up, (Math.random() - 0.5) * 0.8], i * 3);
    this.life[i] = this.ttl[i] = ttl;
    this.base[i] = size;
    this.alpha[i] = op;
  }
  update(dt: number) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = 1 - this.life[i] / this.ttl[i];
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.base[i] * (1 + k * 2.2);
      this.alpha[i] = Math.max(0, (1 - k) * 0.5);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.size.needsUpdate = g.attributes.alpha.needsUpdate = true;
  }
}

/** Every plot's biome terrain + animated effects (rain, lightning, lava, embers, water) and the world-wide scatter. */
export class BiomeWorld {
  scatter: Scatter;
  dust: DustPool;
  plots = new Map<TrackLike, PlotDress>();
  private R = rng(4242);
  private hemiBase: number;

  constructor(scene: THREE.Scene, private hemi: THREE.HemisphereLight) {
    this.scatter = new Scatter(scene, M.cloud);
    this.dust = new DustPool(scene);
    this.hemiBase = hemi.intensity;
    this.lowland();
  }

  /** Pines and rocks in the lowland around the mesas. */
  private lowland() {
    const R = rng(99);
    for (let i = 0; i < 1500; i++) {
      const a = R() * Math.PI * 2;
      const r = 160 + Math.pow(R(), 0.7) * 820;
      const x = Math.cos(a) * r * 1.2;
      const z = Math.sin(a) * r;
      if (Math.hypot((x + 360) / 180, (z - 170) / 120) < 1.1) continue; // the lake
      const s = 0.9 + R() * 1.1;
      if (R() < 0.8) this.scatter.pines.add(x, VALLEY_Y - 0.3, z, s, s * (0.8 + R() * 0.6), s, 0, R() * 6, 0);
      else if (R() < 0.3) this.scatter.kit.cluster('granite', R, x, z, 1.4 + s * 1.2, () => VALLEY_Y - 0.1);
      else this.scatter.kit.boulder('granite', Math.floor(R() * 6), x, VALLEY_Y - 0.1, z, s * 1.4, R() * 6.28, { tint: 0.85 + R() * 0.2, tilt: (R() - 0.5) * 0.2 });
    }
    // birches of pines ring the lake
    for (let i = 0; i < 120; i++) {
      const a = R() * Math.PI * 2;
      const k = 1.12 + R() * 0.25;
      const s = 0.9 + R() * 0.8;
      this.scatter.pines.add(-360 + Math.cos(a) * 170 * k, VALLEY_Y - 0.3, 170 + Math.sin(a) * 110 * k, s, s, s, 0, R() * 6, 0);
    }
  }

  addTrack(t: TrackLike): PlotDress {
    let p = this.plots.get(t);
    if (!p) {
      p = buildPlot(t, this.scatter);
      this.plots.set(t, p);
    }
    return p;
  }

  /** Obstacle type whose biome covers track-local x (or 'start' on the run-up). */
  typeAt(t: TrackLike, lx: number): BarrierId | 'start' {
    return this.plots.get(t)?.typeAt(lx) ?? 'start';
  }

  /** World-space ground height (terrain of whichever plot covers the point; lowland otherwise). For the walker. */
  groundAt(x: number, z: number): number {
    for (const [t, p] of this.plots) {
      const lx = x - t.origin.x;
      const lz = z - t.origin.z;
      if (lz >= -26 && lz <= 26 && lx >= -90 && lx <= 400) {
        const h = p.heightAt(lx, lz);
        if (h > VALLEY_Y + 0.5) return h;
      }
    }
    return VALLEY_Y;
  }

  update(dt: number, clock: number, camera: THREE.Camera) {
    uTime.value = clock;
    const cam = camera.position;
    M.morse.emissiveIntensity = morseOn(clock) ? 4 : 0.15;
    let flash = 0;
    for (const p of this.plots.values()) {
      for (const s of p.storms) {
        const on = morseOn(clock);
        s.beacon.visible = on;
        s.wash.material.opacity = on ? 0.4 : 0.08;
      }
      for (const c of p.calderas) {
        const d = Math.hypot(cam.x - c.x, cam.z - c.z);
        c.embers.visible = d < 320;
        c.glow.material.opacity = 0.45 + 0.12 * Math.sin(clock * 3.1) + 0.06 * Math.sin(clock * 7.3);
        c.vaultGlow.material.opacity = 0.65 + 0.25 * Math.sin(clock * 2.2);
        c.shimmer.forEach((m, k) => {
          m.visible = d < 220;
          m.rotation.y = Math.atan2(cam.x - c.x, cam.z - c.z);
          m.position.y = -2.6 + 3.5 + Math.sin(clock * 1.7 + k) * 0.5;
          m.scale.y = 1 + 0.15 * Math.sin(clock * 2.3 + k * 2);
          (m.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.04 * Math.sin(clock * 5 + k);
        });
      }
    }
    uFlash.value = flash;
    this.hemi.intensity = this.hemiBase * (1 + flash * 0.45);
    void emberMat;
    this.dust.update(dt);
  }
}
