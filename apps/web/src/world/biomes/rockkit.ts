import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { uTime } from './mats';
import { LAVA_Y } from './geo';

// v5 rock kit: crafted low-poly rocks for every biome. Boulders are noise-displaced icosahedra with a flattened
// bottom and a few planar "chipped" cuts, flat-shaded, vertex-coloured per palette (face jitter, strata bands, a
// top tint by normal.y). Variants are generated once per palette and instanced; cliffs are stacked strata slabs merged
// into one mesh per plot. Everything is seeded so the world is identical on every load.

export type Palette = 'sand' | 'ochre' | 'basalt' | 'granite';

interface Pal {
  base: THREE.Color;
  bands: THREE.Color[];
  top: THREE.Color;
  topAmt: number;
}
const P = (base: string, bands: string[], top: string, topAmt: number): Pal => ({
  base: new THREE.Color(base),
  bands: bands.map((b) => new THREE.Color(b)),
  top: new THREE.Color(top),
  topAmt,
});
export const PALETTES: Record<Palette, Pal> = {
  sand: P('#b8703c', ['#c98552', '#a45f33', '#d59a64', '#9a5a31'], '#e0b27a', 0.55),
  ochre: P('#95805f', ['#a8916c', '#83704f', '#b39d77', '#7a6547'], '#c2ad84', 0.5),
  basalt: P('#34302e', ['#3b3633', '#2a2624', '#45403c', '#262220'], '#5a524c', 0.35),
  granite: P('#7c8087', ['#8a8e95', '#6c7077', '#969aa0', '#62666d'], '#8a9a68', 0.32),
};

// ── seeded helpers ─────────────────────────────────────────────────────────
export function srng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000003) / 1000003;
  };
}
function hash3(x: number, y: number, z: number, s: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19) * 43758.5453;
  return h - Math.floor(h);
}
/** 3D value noise in [0,1] */
function vnoise(x: number, y: number, z: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, s);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}
function fbm3(x: number, y: number, z: number, s: number, oct = 3) {
  let a = 0.5, f = 1, t = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    t += a * vnoise(x * f, y * f, z * f, s + i * 7);
    n += a;
    a *= 0.5;
    f *= 2.07;
  }
  return t / n;
}

const tmpC = new THREE.Color();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpN = new THREE.Vector3();

/** Flat face colours: palette base with per-face jitter, horizontal strata bands and a top tint by face normal.y. */
function paintFaces(geo: THREE.BufferGeometry, pal: Pal, seed: number, opts: { bandScale?: number; topAmt?: number; yLo?: number; yHi?: number; bandOffset?: number; jitter?: number } = {}) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const bandScale = opts.bandScale ?? 2.4;
  const topAmt = opts.topAmt ?? pal.topAmt;
  const yLo = opts.yLo ?? -1;
  const yHi = opts.yHi ?? 1;
  for (let f = 0; f < n; f += 3) {
    tmpA.fromBufferAttribute(pos, f + 1).sub(tmpB.fromBufferAttribute(pos, f));
    tmpN.fromBufferAttribute(pos, f + 2).sub(tmpB);
    tmpN.crossVectors(tmpA, tmpN).normalize();
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    const band = Math.floor(cy * bandScale + (opts.bandOffset ?? 0) + (vnoise(cx * 0.35, 0, cz * 0.35, seed) - 0.5) * 0.9);
    const bi = ((band % pal.bands.length) + pal.bands.length) % pal.bands.length;
    tmpC.copy(pal.base).lerp(pal.bands[bi], 0.65);
    const jit = opts.jitter ?? 0.12;
    const j = 1 - jit / 2 + hash3(cx * 3.1, cy * 3.1, cz * 3.1, seed) * jit;
    tmpC.multiplyScalar(j);
    // cheap AO: the underside and the foot read darker
    const hk = Math.min(1, Math.max(0, (cy - yLo) / Math.max(0.01, yHi - yLo)));
    tmpC.multiplyScalar(0.78 + 0.22 * hk);
    if (tmpN.y < -0.2) tmpC.multiplyScalar(0.82);
    const t = Math.min(1, Math.max(0, (tmpN.y - 0.55) / 0.35)) * topAmt;
    if (t > 0) tmpC.lerp(pal.top, t);
    for (let k = 0; k < 3; k++) col.set([tmpC.r, tmpC.g, tmpC.b], (f + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function flat(geo: THREE.BufferGeometry) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** One boulder variant: displaced icosahedron, flattened bottom, planar chips. Radius ~1, bottom at y = -0.5. */
export function boulderGeometry(seed: number, detail = 1, kind: 'round' | 'slab' | 'shard' = 'round') {
  const R = srng(seed * 7919 + 13);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const amp = kind === 'shard' ? 0.22 : 0.3;
  const stretch = kind === 'slab' ? new THREE.Vector3(1.35 + R() * 0.3, 0.62 + R() * 0.15, 1.05 + R() * 0.25) : kind === 'shard' ? new THREE.Vector3(0.55 + R() * 0.2, 1.9 + R() * 0.8, 0.6 + R() * 0.2) : new THREE.Vector3(1.05 + R() * 0.35, 0.8 + R() * 0.25, 0.95 + R() * 0.3);
  // chip planes: normals mostly sideways / up, cutting 10–25 % off the silhouette
  const chips: { n: THREE.Vector3; d: number }[] = [];
  const nChips = 3 + Math.floor(R() * 3);
  for (let i = 0; i < nChips; i++) {
    const a = R() * Math.PI * 2;
    const el = (R() - 0.25) * 1.3;
    chips.push({ n: new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize(), d: 0.68 + R() * 0.2 });
  }
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const nz = fbm3(p.x * 1.4 + 3, p.y * 1.4, p.z * 1.4, seed, 3);
    p.multiplyScalar(1 + (nz - 0.5) * 2 * amp);
    for (const c of chips) {
      const dd = p.dot(c.n) - c.d;
      if (dd > 0) p.addScaledVector(c.n, -dd);
    }
    p.multiply(stretch);
    if (kind === 'shard') p.x += p.y * 0.12; // a slight lean
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  // flatten bottom at y = -0.5 (normalised by the stretched height)
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const h = bb.max.y - bb.min.y;
  const cut = bb.min.y + h * 0.22;
  for (let i = 0; i < pos.count; i++) {
    const y = Math.max(cut, pos.getY(i));
    pos.setY(i, ((y - cut) / (bb.max.y - cut)) * (kind === 'shard' ? 2.0 : 1.0) - 0.5);
  }
  return flat(g);
}

// ── instanced boulder sets ────────────────────────────────────────────────
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const eul = new THREE.Euler();
const vv = new THREE.Vector3();
const sv = new THREE.Vector3();
const cc = new THREE.Color();

let _mat: THREE.MeshStandardMaterial | null = null;
let _basalt: THREE.MeshStandardMaterial | null = null;
/** the one rock material (vertex colours × instance tint, flat shaded) */
export function rockMaterial() {
  return (_mat ??= new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.93, metalness: 0 }));
}
/** basalt near lava: hot cracks + an underglow below LAVA_Y + 1.6 (world y), pulsing with uTime */
export function basaltMaterial() {
  if (_basalt) return _basalt;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uLavaY = { value: LAVA_Y };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkW;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        { vec4 rkw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          rkw = instanceMatrix * rkw;
          #endif
          vRkW = (modelMatrix * rkw).xyz; }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkW; uniform float uTime; uniform float uLavaY;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        { float lowk = 1.0 - smoothstep(uLavaY - 0.1, uLavaY + 0.9, vRkW.y);
          float ln = abs(sin(vRkW.x * 2.3 + sin(vRkW.z * 1.7) * 2.1 + vRkW.y * 1.3)) ;
          float ln2 = abs(sin(vRkW.z * 2.9 + sin(vRkW.x * 1.3) * 1.8 - vRkW.y * 0.9));
          float crack = (1.0 - smoothstep(0.0, 0.035, ln)) + (1.0 - smoothstep(0.0, 0.025, ln2)) * 0.7;
          float reach = 1.0 - smoothstep(uLavaY + 0.2, uLavaY + 2.0, vRkW.y);
          float pulse = 0.8 + 0.2 * sin(uTime * 2.3 + vRkW.x * 0.7);
          totalEmissiveRadiance += vec3(1.0, 0.33, 0.05) * (lowk * 0.45 + crack * reach * 1.3) * pulse; }`,
      );
  };
  return (_basalt = m);
}

class VariantPool {
  meshes: THREE.InstancedMesh[];
  constructor(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mat: THREE.Material, cap: number, shadow: boolean) {
    this.meshes = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.count = 0;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = 'rocks';
      parent.add(m);
      return m;
    });
  }
  /** place variant `v` at (x, yGround) — the flat bottom is embedded `embed`·scale into the ground */
  add(v: number, x: number, yGround: number, z: number, s: number, sy: number, sz: number, yaw: number, tilt = 0, tint = 1, embed = 0.18) {
    const m = this.meshes[v % this.meshes.length];
    if (m.count >= m.instanceMatrix.count) return;
    const i = m.count++;
    eul.set(tilt, yaw, tilt * 0.6);
    q.setFromEuler(eul);
    m4.compose(vv.set(x, yGround + (0.5 - embed) * sy, z), q, sv.set(s, sy, sz));
    m.setMatrixAt(i, m4);
    m.setColorAt(i, cc.setScalar(tint));
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

const VARIANTS = 6;
/** Every palette's boulder / shard / scree variants, instanced world-wide (one draw call per variant). */
export class RockKit {
  private sets = new Map<string, VariantPool>();
  constructor(private parent: THREE.Object3D) {}
  private pool(pal: Palette, kind: 'boulder' | 'scree' | 'shard'): VariantPool {
    const key = pal + ':' + kind;
    let p = this.sets.get(key);
    if (!p) {
      const seed0 = { sand: 11, ochre: 23, basalt: 37, granite: 51 }[pal];
      const n = kind === 'boulder' ? VARIANTS : 3;
      const geos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const g = kind === 'scree' ? boulderGeometry(seed0 * 100 + i + 500, 0, i === 2 ? 'slab' : 'round') : kind === 'shard' ? boulderGeometry(seed0 * 100 + i + 900, 1, 'shard') : boulderGeometry(seed0 * 100 + i, i < 2 ? 2 : 1, i === 4 || i === 5 ? 'slab' : 'round');
        paintFaces(g, PALETTES[pal], seed0 + i, { bandScale: kind === 'shard' ? 1.4 : 2.2, yLo: -0.5, yHi: kind === 'shard' ? 1.5 : 0.5, jitter: 0.1 });
        geos.push(g);
      }
      const mat = pal === 'basalt' ? basaltMaterial() : rockMaterial();
      p = new VariantPool(this.parent, geos, mat, kind === 'scree' ? 1400 : kind === 'shard' ? 260 : 360, kind !== 'scree');
      this.sets.set(key, p);
    }
    return p;
  }
  boulder(pal: Palette, v: number, x: number, y: number, z: number, s: number, yaw: number, opts: { sy?: number; sz?: number; tilt?: number; tint?: number; embed?: number } = {}) {
    this.pool(pal, 'boulder').add(v, x, y, z, s, s * (opts.sy ?? 1), s * (opts.sz ?? 1), yaw, opts.tilt ?? 0, opts.tint ?? 1, opts.embed);
  }
  shard(pal: Palette, v: number, x: number, y: number, z: number, s: number, yaw: number, tilt = 0, tint = 1) {
    this.pool(pal, 'shard').add(v, x, y, z, s, s, s, yaw, tilt, tint, 0.12);
  }
  scree(pal: Palette, v: number, x: number, y: number, z: number, s: number, yaw: number, tint = 1) {
    this.pool(pal, 'scree').add(v, x, y, z, s, s * 0.7, s, yaw, 0, tint, 0.25);
  }
  /**
   * Clustered placement: 1 big + 2–4 medium + scree around it. `ground(x, z)` gives the local ground height, `ok(x, z)`
   * rejects spots (lanes, water, props). Coordinates are world space.
   */
  cluster(pal: Palette, R: () => number, x: number, z: number, big: number, ground: (x: number, z: number) => number, ok: (x: number, z: number) => boolean = () => true) {
    if (!ok(x, z)) return;
    const yaw0 = R() * Math.PI * 2;
    this.boulder(pal, Math.floor(R() * VARIANTS), x, ground(x, z), z, big, yaw0, { tint: 0.92 + R() * 0.14, tilt: (R() - 0.5) * 0.12 });
    const nm = 2 + Math.floor(R() * 3);
    for (let k = 0; k < nm; k++) {
      const a = yaw0 + (k / nm) * Math.PI * 2 + (R() - 0.5) * 0.9;
      const r = big * (0.9 + R() * 0.7);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (!ok(px, pz)) continue;
      const s = big * (0.35 + R() * 0.25);
      this.boulder(pal, Math.floor(R() * VARIANTS), px, ground(px, pz), pz, s, R() * 6.28, { tint: 0.88 + R() * 0.2, tilt: (R() - 0.5) * 0.3 });
    }
    const ns = 4 + Math.floor(R() * 6);
    for (let k = 0; k < ns; k++) {
      const a = R() * Math.PI * 2;
      const r = big * (0.8 + R() * 1.6);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (!ok(px, pz)) continue;
      this.scree(pal, k, px, ground(px, pz), pz, 0.18 + R() * 0.3 * Math.min(2, big), R() * 6.28, 0.85 + R() * 0.25);
    }
  }
}

// ── strata cliffs ─────────────────────────────────────────────────────────
export interface WallSpec {
  /** run along the local x axis from x0 to x1; the face looks toward +z (before the transform) at z = 0 */
  x0: number;
  x1: number;
  yBase: number;
  yTop: number;
  /** body depth behind the face */
  depth: number;
  /** how far the top layer leans out over the foot (m) */
  overhang?: number;
  /** extra jagged crest height (m) */
  crest?: number;
  /** keep every slab's top at or below this y (a road runs over it) */
  capY?: number;
  /** per-chunk cap (local x of the chunk centre) — overrides capY */
  capAt?: (lx: number) => number;
  /** the wall steps down over this many metres at both ends */
  taper?: number;
  /** slab thickness: min + random span (m) */
  layer?: [number, number];
  seed: number;
  pal: Palette;
  /** local → plot transform */
  matrix: THREE.Matrix4;
}

/** One stacked-strata wall: horizontal slabs of varying thickness, each slab chunked along the run and offset in/out. */
export function strataWall(w: WallSpec): THREE.BufferGeometry {
  const R = srng(w.seed * 31 + 7);
  const pal = PALETTES[w.pal];
  const parts: THREE.BufferGeometry[] = [];
  const H = w.yTop - w.yBase;
  let y = w.yBase;
  let layer = 0;
  while (y < w.yTop - 0.2) {
    const th = Math.min(w.yTop - y, (w.layer?.[0] ?? 0.9) + R() * (w.layer?.[1] ?? 1.4));
    const frac = (y - w.yBase + th / 2) / Math.max(1, H);
    const layerOff = (layer % 2 ? -0.35 : 0.15) + (R() - 0.5) * 0.4 + (w.overhang ?? 0) * Math.pow(frac, 3);
    const bandIdx = Math.floor(R() * pal.bands.length);
    let x = w.x0 - 0.6;
    while (x < w.x1 + 0.4) {
      const cw = Math.min(w.x1 + 0.8 - x, 2.6 + R() * 3.6);
      const cap = w.capAt ? w.capAt(x + cw / 2) : w.capY;
      const endK = w.taper ? Math.min(1, (x + cw / 2 - w.x0) / w.taper, (w.x1 - x - cw / 2) / w.taper) : 1;
      const yLim = w.yBase + H * (0.3 + 0.7 * Math.max(0, endK));
      const yb = y - 0.06;
      if ((cap !== undefined && yb > cap - 0.25) || y > yLim) {
        x += cw;
        R();
        R();
        continue;
      }
      const top = y + th >= w.yTop - 0.05 || y + th > yLim;
      const extra = top ? (w.crest ?? 0) * (0.25 + R() * 0.9) : 0;
      let hh = th + extra + 0.12;
      if (cap !== undefined && yb + hh > cap) hh = Math.max(0.2, cap - yb);
      const d = w.depth * (0.7 + R() * 0.3);
      const segW = Math.max(2, Math.round(cw / 1.5));
      const segH = hh > 2.2 ? 2 : 1;
      const b = new THREE.BoxGeometry(cw + 0.3, hh, d, segW, segH, 1);
      const pos = b.attributes.position as THREE.BufferAttribute;
      const off = layerOff + (R() - 0.5) * 0.35;
      const sd = w.seed * 13 + layer * 101 + Math.floor(x * 7);
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
        const wx = x + cw / 2 + lx;
        const wy = yb + hh / 2 + ly;
        const front = lz > 0 ? 1 : 0;
        const n1 = fbm3(wx * 0.32, wy * 0.45, lz * 0.3, sd, 2) - 0.5;
        const n2 = vnoise(wx * 0.9, wy * 0.9, lz * 0.5, sd + 3) - 0.5;
        // rounded block ends: pull the front back near the chunk's two ends
        const endU = Math.abs(lx) / ((cw + 0.3) / 2);
        let nx = lx + n2 * 0.3;
        let nzz = lz + front * (n1 * 1.5 + n2 * 0.3 - endU * endU * 0.55);
        let ny = ly + n2 * 0.18 - (ly > 0 ? endU * endU * 0.25 : 0);
        // jagged crest: the top face of a top slab gets big vertical noise
        if (top && ly > 0) ny += (vnoise(wx * 0.8, 0, lz * 0.5, sd + 9) - 0.35) * (w.crest ?? 0) * 0.9;
        if (cap !== undefined) ny = Math.min(ny, cap - (yb + hh / 2));
        // bevel: pull the front-top edge back a little so slabs read as eroded ledges
        if (front && ly > 0) nzz -= 0.18;
        pos.setXYZ(i, nx, ny, nzz);
      }
      b.translate(x + cw / 2, yb + hh / 2, -d / 2 + off);
      const g = flat(b);
      const lc = pal.bands[(bandIdx + layer) % pal.bands.length];
      paintFaces(g, { ...pal, base: lc, bands: [lc] }, sd, { bandScale: 0, yLo: w.yBase, yHi: w.yTop + 1, topAmt: pal.topAmt * 0.8, jitter: 0.07 });
      parts.push(g);
      x += cw;
    }
    y += th;
    layer++;
  }
  const merged = mergeGeometries(parts)!;
  merged.applyMatrix4(w.matrix);
  return merged;
}

/** A tapered stack of displaced drums (the Signal Ridge spire): flat top at `yTop`. */
export function spireGeometry(cx: number, cz: number, yBase: number, yTop: number, r0: number, r1: number, pal: Palette, seed: number) {
  const R = srng(seed);
  const parts: THREE.BufferGeometry[] = [];
  let y = yBase;
  let k = 0;
  const H = yTop - yBase;
  while (y < yTop - 0.1) {
    const th = Math.min(yTop - y, 1.4 + R() * 1.6);
    const f = (y - yBase) / H;
    const r = r0 + (r1 - r0) * f + (R() - 0.5) * 0.5;
    const c = new THREE.CylinderGeometry(r * (0.92 + R() * 0.1), r, th + 0.1, 8, 2, false);
    const pos = c.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const ang = Math.atan2(pz, px);
      const n = fbm3(Math.cos(ang) * 1.3 + k, py * 0.5, Math.sin(ang) * 1.3, seed + k, 2) - 0.5;
      const rr = Math.hypot(px, pz);
      const s = rr > 0.01 ? 1 + n * 0.45 : 1;
      pos.setXYZ(i, px * s, py, pz * s);
    }
    c.rotateY(R() * 6.28);
    c.translate(cx + (R() - 0.5) * 0.5, y + th / 2, cz + (R() - 0.5) * 0.5);
    const g = flat(c);
    paintFaces(g, PALETTES[pal], seed + k, { bandScale: 0.9, yLo: yBase, yHi: yTop, bandOffset: k });
    parts.push(g);
    y += th;
    k++;
  }
  return mergeGeometries(parts)!;
}

/** A single painted boulder geometry (for sims that animate their own instances). */
export function paintedBoulder(pal: Palette, seed: number, detail = 1, kind: 'round' | 'slab' | 'shard' = 'round') {
  const g = boulderGeometry(seed, detail, kind);
  paintFaces(g, PALETTES[pal], seed, { bandScale: 2.2, yLo: -0.5, yHi: 0.5, jitter: 0.1 });
  return g;
}
