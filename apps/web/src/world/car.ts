import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CarMesh, CAR_SCALE, CRUSH_MAX, NOSE_X, sideWeight, type CarPose } from '../arena/car';
import { roundelTexture, sekiBadgeTexture } from '../arena/textures';

// Kenney "Car Kit" (CC0, www.kenney.nl) bodies, re-based into the v2 car frame (nose at +x = NOSE_X, ground y = 0) so the v2
// crash / AEB sims drive them unchanged. The body is recoloured per car (paint swatch → car.color via vertex colours) and
// folds on impact with the same crush law as the v2 procedural shell.

const MODELS = ['sedan', 'hatchback-sports', 'sedan-sports', 'suv'] as const;
const BODY_LEN = 3.5; // local metres (×CAR_SCALE in the world)

interface CarTemplate {
  name: string;
  body: THREE.BufferGeometry; // chassis-local, merged body (+spoiler)
  paint: Uint8Array; // 1 = paint vertex
  shade: Float32Array; // paint shading relative to the swatch's mean lightness
  base: Float32Array; // per-vertex base colour (linear)
  wheels: { geo: THREE.BufferGeometry; pos: THREE.Vector3; front: boolean }[];
  wheelMat: THREE.Material;
  scale: number;
  box: THREE.Box3;
}

const templates: CarTemplate[] = [];
let loading: Promise<void> | null = null;

/** Load the car bodies once. Resolves (never rejects); cars fall back to the procedural v2 shell on failure. */
export function loadCarModels(): Promise<void> {
  loading ??= (async () => {
    const loader = new GLTFLoader();
    await Promise.all(
      MODELS.map(async (m) => {
        try {
          const gltf = await loader.loadAsync(`/models/kenney/${m}.glb`);
          const t = toTemplate(m, gltf.scene);
          if (t) templates.push(t);
        } catch (err) {
          console.warn('[world] car model failed', m, err);
        }
      }),
    );
    templates.sort((a, b) => MODELS.indexOf(a.name as (typeof MODELS)[number]) - MODELS.indexOf(b.name as (typeof MODELS)[number]));
  })();
  return loading;
}

function sampleImage(img: CanvasImageSource & { width: number; height: number }) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

function toTemplate(name: string, root: THREE.Object3D): CarTemplate | null {
  root.updateMatrixWorld(true);
  const bodies: THREE.Mesh[] = [];
  const wheels: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (/wheel/.test(m.name) && !/wheel-back$/.test(m.name)) wheels.push(m);
    else if (!/wheel/.test(m.name)) bodies.push(m);
  });
  if (!bodies.length) return null;
  const mat = (bodies[0].material as THREE.MeshStandardMaterial) ?? null;
  const img = mat?.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  const pixels = img ? sampleImage(img) : null;

  // model frame: nose +z, width x, ground y 0 → chassis frame: nose +x
  const box = new THREE.Box3();
  for (const b of bodies) box.expandByObject(b);
  const len = box.max.z - box.min.z;
  const s = BODY_LEN / len;
  const xoff = NOSE_X - box.max.z * s;
  const toLocal = new THREE.Matrix4().makeTranslation(xoff, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(s, s, s));

  const parts: THREE.BufferGeometry[] = [];
  for (const b of bodies) {
    const g = b.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, b.matrixWorld));
    parts.push(g);
  }
  // merge (positions, normals, uvs; index offset)
  let count = 0;
  let icount = 0;
  for (const p of parts) {
    count += p.attributes.position.count;
    icount += p.index ? p.index.count : p.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const idx: number[] = [];
  let off = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, off * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array as Float32Array, off * 2);
    const n = p.attributes.position.count;
    if (p.index) for (let i = 0; i < p.index.count; i++) idx.push(p.index.getX(i) + off);
    else for (let i = 0; i < n; i++) idx.push(i + off);
    off += n;
  }
  void icount;
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  body.setIndex(idx);
  body.computeVertexNormals();

  // colours from the colormap; the dominant saturated hue on the body is its paint (swatches carry shading, so match by hue)
  const base = new Float32Array(count * 3);
  const hsl = new Float32Array(count * 3);
  const bins = new Float32Array(36);
  const col = new THREE.Color();
  const h = { h: 0, s: 0, l: 0 };
  for (let i = 0; i < count; i++) {
    let r = 200;
    let g = 200;
    let b = 200;
    if (pixels) {
      const u = uv[i * 2] - Math.floor(uv[i * 2]);
      const v = uv[i * 2 + 1] - Math.floor(uv[i * 2 + 1]);
      const px = Math.min(pixels.width - 1, Math.floor(u * pixels.width));
      const py = Math.min(pixels.height - 1, Math.floor(v * pixels.height));
      const o = (py * pixels.width + px) * 4;
      r = pixels.data[o];
      g = pixels.data[o + 1];
      b = pixels.data[o + 2];
    }
    col.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    base[i * 3] = col.r;
    base[i * 3 + 1] = col.g;
    base[i * 3 + 2] = col.b;
    col.getHSL(h, THREE.SRGBColorSpace);
    hsl[i * 3] = h.h;
    hsl[i * 3 + 1] = h.s;
    hsl[i * 3 + 2] = h.l;
    if (h.s > 0.35 && h.l > 0.15 && h.l < 0.85) bins[Math.floor(h.h * 36) % 36] += 1;
  }
  let peak = 0;
  for (let k = 1; k < 36; k++) if (bins[k] > bins[peak]) peak = k;
  const peakHue = (peak + 0.5) / 36;
  const paint = new Uint8Array(count);
  const shade = new Float32Array(count);
  let lSum = 0;
  let lN = 0;
  for (let i = 0; i < count; i++) {
    let d = Math.abs(hsl[i * 3] - peakHue);
    d = Math.min(d, 1 - d);
    if (d < 0.07 && hsl[i * 3 + 1] > 0.3 && hsl[i * 3 + 2] > 0.12) {
      paint[i] = 1;
      lSum += hsl[i * 3 + 2];
      lN++;
    }
  }
  const lRef = lN ? lSum / lN : 0.5;
  for (let i = 0; i < count; i++) shade[i] = paint[i] ? Math.min(1.35, Math.max(0.55, hsl[i * 3 + 2] / lRef)) : 1;

  const bbox = new THREE.Box3().setFromBufferAttribute(body.attributes.position as THREE.BufferAttribute);
  const tw = wheels.map((w) => {
    const g = w.geometry.clone();
    // bake rotation + scale into the wheel geometry, keep its hub as the pivot
    const hub = new THREE.Vector3().setFromMatrixPosition(w.matrixWorld).applyMatrix4(toLocal);
    const m = new THREE.Matrix4().multiplyMatrices(toLocal, w.matrixWorld);
    g.applyMatrix4(m);
    g.translate(-hub.x, -hub.y, -hub.z);
    return { geo: g, pos: hub, front: hub.x > 0 };
  });
  return { name, body, paint, shade, base, wheels: tw, wheelMat: wheels[0]?.material as THREE.Material, scale: s, box: bbox };
}

const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 });
let roundelMat: THREE.MeshBasicMaterial | null = null;
let badgeMat: THREE.MeshBasicMaterial | null = null;
const decalGeo = new THREE.PlaneGeometry(0.62, 0.62);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hash3 = (x: number, y: number, z: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h) - 0.5;
};

export const modelIndexFor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

/** A v2 CarMesh whose visible shell is a Kenney body (falls back to the v2 procedural shell when models are missing). */
export class WorldCar extends CarMesh {
  private gBody?: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  private gOrig?: Float32Array;
  private gSeed?: Float32Array;
  private gWheels: { mesh: THREE.Mesh; x: number; front: boolean }[] = [];
  private gCrush = -1;
  private wheelR = 0.3;
  private tmpl?: CarTemplate;

  constructor(name: string, sub: string, color: string, airbag: boolean, id: string) {
    super(name, sub, color, airbag);
    if (!templates.length) return;
    const t = templates[modelIndexFor(id) % templates.length];
    this.tmpl = t;
    // hide the procedural shell (keep the dummy + airbags inside, and the name billboard)
    const priv = this as unknown as { dummy: THREE.Object3D; airbags: THREE.Mesh[] };
    const keep = new Set<THREE.Object3D>([priv.dummy, ...priv.airbags]);
    for (const ch of this.chassis.children) if (!keep.has(ch)) ch.visible = false;
    for (const w of this.wheels) w.visible = false;

    const geo = t.body.clone();
    const n = geo.attributes.position.count;
    const colors = new Float32Array(n * 3);
    const paint = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      if (t.paint[i]) {
        const k = t.shade[i];
        colors[i * 3] = Math.min(1, paint.r * k);
        colors[i * 3 + 1] = Math.min(1, paint.g * k);
        colors[i * 3 + 2] = Math.min(1, paint.b * k);
      } else {
        colors[i * 3] = t.base[i * 3];
        colors[i * 3 + 1] = t.base[i * 3 + 1];
        colors[i * 3 + 2] = t.base[i * 3 + 2];
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.gBody = new THREE.Mesh(geo, bodyMat);
    this.gBody.castShadow = true;
    this.chassis.add(this.gBody);
    this.gOrig = (geo.attributes.position.array as Float32Array).slice();
    this.gSeed = new Float32Array(this.gOrig.length);
    for (let i = 0; i < this.gOrig.length; i += 3) {
      const [x, y, z] = [this.gOrig[i], this.gOrig[i + 1], this.gOrig[i + 2]];
      this.gSeed[i] = hash3(x, y, z);
      this.gSeed[i + 1] = hash3(y, z, x);
      this.gSeed[i + 2] = hash3(z, x, y);
    }

    for (const w of t.wheels) {
      const m = new THREE.Mesh(w.geo, t.wheelMat);
      m.position.copy(w.pos);
      m.castShadow = true;
      this.group.add(m);
      this.gWheels.push({ mesh: m, x: w.pos.x, front: w.front });
    }
    this.wheelR = 0.3 * t.scale;

    // calibration roundels on both flanks + roof; Sekisho badge on the roof of airbag cars
    roundelMat ??= new THREE.MeshBasicMaterial({ map: roundelTexture(), transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
    const b = t.box;
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(decalGeo, roundelMat);
      d.position.set(b.min.x + (b.max.x - b.min.x) * 0.42, b.min.y + (b.max.y - b.min.y) * 0.34, side * (b.max.z + 0.012));
      d.rotation.y = side > 0 ? 0 : Math.PI;
      this.chassis.add(d);
    }
    const roof = new THREE.Mesh(decalGeo, roundelMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(b.min.x + (b.max.x - b.min.x) * 0.36, b.max.y + 0.012, 0.36);
    this.chassis.add(roof);
    if (airbag) {
      badgeMat ??= new THREE.MeshBasicMaterial({ map: sekiBadgeTexture(), transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
      const bd = new THREE.Mesh(decalGeo, badgeMat);
      bd.rotation.x = -Math.PI / 2;
      bd.position.set(b.min.x + (b.max.x - b.min.x) * 0.36, b.max.y + 0.012, -0.36);
      this.chassis.add(bd);
    }
  }

  override setPose(p: CarPose) {
    super.setPose(p);
    if (this.gBody && Math.abs(p.crush - this.gCrush) > 0.0015) {
      this.gCrush = p.crush;
      this.foldBody(p.crush);
    }
  }

  /** Same crush law as the v2 shell: the nose folds back toward the barrier, the bonnet tents up, the far side crushes most. */
  private foldBody(c: number) {
    const pos = this.gBody!.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const o = this.gOrig!;
    const s = this.gSeed!;
    const midY = (this.tmpl!.box.min.y + this.tmpl!.box.max.y) / 2;
    for (let i = 0; i < arr.length; i += 3) {
      const ox = o[i];
      const oy = o[i + 1];
      const oz = o[i + 2];
      const f = clamp01((ox - 0.1) / (NOSE_X - 0.1));
      const a = c * sideWeight(oz);
      const fold = Math.pow(f, 1.3) * a;
      arr[i] = ox - CRUSH_MAX * fold + s[i] * 0.2 * a * f;
      arr[i + 1] = oy + a * f * (oy > midY ? 0.26 : 0.04) + s[i + 1] * 0.16 * a * f;
      arr[i + 2] = oz + Math.sign(oz) * a * f * 0.12 + s[i + 2] * 0.12 * a * f;
    }
    pos.needsUpdate = true;
    this.gBody!.geometry.computeVertexNormals();
    for (const w of this.gWheels) {
      if (!w.front) continue;
      w.mesh.position.x = w.x - 0.34 * c * sideWeight(w.mesh.position.z);
      w.mesh.rotation.y = (w.mesh.position.z < 0 ? 1 : -1) * 0.14 * c;
    }
  }

  override update(dt: number, speed: number, camera: THREE.Camera) {
    super.update(dt, speed, camera);
    if (!this.gWheels.length) return;
    const rot = (speed * dt) / (this.wheelR * CAR_SCALE);
    for (const w of this.gWheels) w.mesh.rotation.z -= rot;
  }

  override dispose() {
    this.gBody?.geometry.dispose();
    super.dispose();
  }
}
