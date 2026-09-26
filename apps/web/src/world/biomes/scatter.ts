import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RockKit } from './rockkit';

// World-wide instanced scatter: pines, rocks, boulders, storm clouds. One draw call per kind for the whole world.

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s3 = new THREE.Vector3();
const col = new THREE.Color();

function colored(g: THREE.BufferGeometry, c: THREE.ColorRepresentation) {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  col.set(c);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function pineGeo() {
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.2, 5);
  trunk.translate(0, 1.1, 0);
  const c1 = new THREE.ConeGeometry(2.0, 4.2, 6);
  c1.translate(0, 3.8, 0);
  const c2 = new THREE.ConeGeometry(1.5, 3.4, 6);
  c2.translate(0, 5.8, 0);
  const c3 = new THREE.ConeGeometry(0.95, 2.4, 6);
  c3.translate(0, 7.5, 0);
  return mergeGeometries([colored(trunk, 0x5a3f2a), colored(c1, 0x2f5a3a), colored(c2, 0x386843), colored(c3, 0x42744b)])!;
}

class Pool {
  mesh: THREE.InstancedMesh;
  constructor(scene: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, public cap: number, shadow = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0, color?: THREE.ColorRepresentation) {
    if (this.mesh.count >= this.cap) return -1;
    const i = this.mesh.count++;
    e.set(rx, ry, rz);
    q.setFromEuler(e);
    m4.compose(v.set(x, y, z), q, s3.set(sx, sy, sz));
    this.mesh.setMatrixAt(i, m4);
    if (color !== undefined) this.mesh.setColorAt(i, col.set(color));
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return i;
  }
}

export class Scatter {
  pines: Pool;
  rocks: Pool;
  boulders: Pool;
  clouds: Pool;
  /** v5 crafted rocks (boulders / shards / scree per palette) */
  kit: RockKit;
  constructor(scene: THREE.Object3D, cloudMat: THREE.Material) {
    const vc = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    this.pines = new Pool(scene, pineGeo(), vc, 2600, false); // perf: thousands of instances, no shadow pass
    this.kit = new RockKit(scene);
    // legacy pools (v4) kept tiny for any external caller; the v5 world places rocks through `kit`
    const rockMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.92, color: 0xffffff });
    this.rocks = new Pool(scene, new THREE.DodecahedronGeometry(1, 0), rockMat, 16, false);
    this.boulders = new Pool(scene, new THREE.IcosahedronGeometry(1, 0), rockMat, 16);
    this.clouds = new Pool(scene, new THREE.IcosahedronGeometry(1, 1), cloudMat, 1, false);
    this.clouds.mesh.visible = false; // v4 owner call: no weather
  }
}

/** Deterministic PRNG. */
export function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Smooth value noise in [0,1]. */
export function noise2(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = xf * xf * (3 - 2 * xf);
  const w = zf * zf * (3 - 2 * zf);
  const a = h(xi, zi);
  const b = h(xi + 1, zi);
  const c = h(xi, zi + 1);
  const d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}
export const fbm = (x: number, z: number) => noise2(x, z) * 0.55 + noise2(x * 2.1 + 17, z * 2.1 - 9) * 0.3 + noise2(x * 4.3 - 5, z * 4.3 + 3) * 0.15;
