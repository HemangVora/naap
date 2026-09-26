import * as THREE from 'three';
import type { BarrierId } from '../types';
import { BIOME_FOR, fx } from './fx';
import './nav.css';

// NaAP World v5 navigation: an overhead strategy camera (Cities: Skylines / RTS), per visitor.
//   keys  : Arrows / WASD pan across the ground (speed scales with height), Q/E rotate, R/F or PageUp/PageDown zoom,
//           Shift faster, Space glides to the latest crash.
//   mouse : drag turns and tilts the view, Shift/right/middle-drag grabs the ground and pans, the wheel zooms toward
//           the cursor from a ~220 m overview down to ~6 m over the ground (pitch eases from ~60° to ~25° on the way down),
//           double-click glides there (index.ts).
//   touch : one finger pans, two fingers pinch-zoom and twist-rotate, tap a car to follow (index.ts click).
//   follow: chase(getPos) keeps a car framed from above-behind; any pan input releases it.
//   tour  : index.ts drives frameBox / chase while view === 'tour'.
// The camera orbits a ground focus point (target) that sits on the terrain; the camera itself never dips under it.
// `enter-biome` is emitted for the biome under the screen centre so the ambient bed crossfades as you fly around.

export type NavMode = 'free' | 'follow';
export type NavView = 'orbit' | 'tour';

export interface NavHooks {
  scene?: THREE.Scene;
  /** obstacle type of the road segment nearest (x, z); null when not near any track */
  biomeAt?: (x: number, z: number) => BarrierId | null;
  /** first user gesture (unlock audio) */
  onGesture?: () => void;
}

/** Exact ground height provider (the scene exposes biomes.groundAt); overrides the raycast fallback. */
export type GroundProvider = (x: number, z: number) => number | null;

const FOV = 42;
const MIN_DIST = 12; // ≈ 5–6 m above the ground at the low pitch
const OVERVIEW_DIST = 255; // ≈ 220 m up at 60°
const LOW_PITCH = THREE.MathUtils.degToRad(25);
const HIGH_PITCH = THREE.MathUtils.degToRad(60);
const CLEARANCE = 2.2;
const PAN_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const HELD_KEYS = [...PAN_KEYS, 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'PageUp', 'PageDown', 'ShiftLeft', 'ShiftRight'];

/** Pitch the camera eases toward for an orbit distance: ~60° looking down high up, ~25° near the ground (log scale). */
export function autoPitch(dist: number) {
  const t = THREE.MathUtils.clamp(Math.log(dist / MIN_DIST) / Math.log(OVERVIEW_DIST / MIN_DIST), 0, 1);
  const s = t * t * (3 - 2 * t);
  return LOW_PITCH + (HIGH_PITCH - LOW_PITCH) * s;
}

export class NavCamera {
  camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 4000);
  mode: NavMode = 'free';
  view: NavView = 'orbit';
  /** ground focus point at the screen centre */
  target = new THREE.Vector3();
  yaw = 0.35;
  pitch = 0.9;
  dist = 260;
  goal = { target: new THREE.Vector3(), yaw: 0.35, pitch: 0.9, dist: 260 };
  /** follow: a function returning the followed object's world position (null when it's gone) */
  follow: (() => THREE.Vector3 | null) | null = null;
  readonly touch: boolean;
  lastInput = performance.now();
  /** Called on any human input (drag, wheel, keys). */
  onInput: () => void = () => {};
  /** the most recent crash on the fx bus (Space glides there) */
  lastCrash: { x: number; y: number; z: number; kind: string; at: number } | null = null;

  private hooks: NavHooks = {};
  private groundProvider: GroundProvider | null = null;
  private trauma = 0;
  private t = 0;
  private keys = new Set<string>();
  private ease = 2.2;
  private maxDist = 300;
  private bounds: THREE.Box3 | null = null;
  private ray = new THREE.Raycaster();
  private down = new THREE.Vector3(0, -1, 0);
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private grounds: THREE.Object3D[] = [];
  private groundsAt = 0;
  private biomeCheckAt = 0;
  private lastBiome: BarrierId | null = null;
  private tag: HTMLElement | null = null;
  private tagTimer = 0;
  private liftY = 0;
  /** left-drag / one-finger pan: the ground point grabbed and where the pointer is now (applied once per frame) */
  private grab: { anchor: THREE.Vector3; x: number; y: number; live: boolean } | null = null;

  constructor(private dom: HTMLElement) {
    this.touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
    this.camera.rotation.order = 'YXZ';
    this.bind();
    this.buildUi();
    fx.on((e) => {
      // a splash / sizzle is where the crashed car actually lands (river, lava): Space swoops there
      if (e.t === 'crash') this.lastCrash = { x: e.x, y: e.y, z: e.z, kind: e.kind, at: performance.now() };
      else if (e.t === 'splash' || e.t === 'sizzle') this.lastCrash = { x: e.x, y: e.y, z: e.z, kind: e.t, at: performance.now() };
    });
    (window as unknown as { __nav: NavCamera }).__nav = this;
  }

  /** Wire the scene in (index.ts, once). */
  attach(h: NavHooks) {
    this.hooks = { ...this.hooks, ...h };
  }
  /** The scene exposes an exact terrain height function (biomes.groundAt). */
  setGroundProvider(fn: GroundProvider | null) {
    this.groundProvider = fn;
  }
  /** World extent (all plots): the focus point stays inside it (plus a margin). */
  setBounds(box: THREE.Box3) {
    if (box.isEmpty()) return;
    this.bounds = box.clone().expandByVector(new THREE.Vector3(70, 0, 70));
  }

  /** HUD insets (CSS px): framing fits inside this rect and the principal point sits at its centre. */
  safe = { left: 330, right: 350, top: 130, bottom: 40 };
  private w = 1600;
  private h = 900;
  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // narrow screens (phones): no rails to dodge
    this.safe = w < 900 ? { left: 0, right: 0, top: 90, bottom: 0 } : { left: 330, right: 350, top: 130, bottom: 40 };
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  setView(v: NavView, _notify = true) {
    this.view = v;
    this.keys.clear();
    document.body.classList.toggle('nav-view-tour', v === 'tour');
  }

  // ── camera API (index.ts) ─────────────────────────────────────────────────
  /** Ease the camera to show a world-space box from the current yaw (or a given one). */
  frameBox(box: THREE.Box3, opts: { yaw?: number; pitch?: number; pad?: number; ease?: number } = {}) {
    this.mode = 'free';
    this.follow = null;
    box.getCenter(this.goal.target);
    this.goal.target.y = this.groundAt(this.goal.target.x, this.goal.target.z);
    const size = box.getSize(this.tmp);
    const pitch = opts.pitch ?? 0.9;
    const sw = Math.max(200, this.w - this.safe.left - this.safe.right) / this.w;
    const sh = Math.max(200, this.h - this.safe.top - this.safe.bottom) / this.h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const fovV = 2 * Math.atan(tanV * sh);
    const fovH = 2 * Math.atan(tanV * this.camera.aspect * sw);
    const needW = (Math.max(size.x, 8) * (opts.pad ?? 1.25)) / 2 / Math.tan(fovH / 2);
    const needD = (Math.max(size.z, 8) * (opts.pad ?? 1.25) * Math.sin(pitch)) / 2 / Math.tan(fovV / 2);
    this.goal.dist = THREE.MathUtils.clamp(Math.max(needW, needD) * 1.05, MIN_DIST, 1400);
    this.maxDist = Math.max(this.maxDist, this.goal.dist * 1.15);
    this.goal.pitch = pitch;
    if (opts.yaw !== undefined) this.goal.yaw = this.yaw + wrap(opts.yaw - this.yaw);
    this.ease = opts.ease ?? 1.8;
  }

  /** Follow a moving object from above-behind (still overhead, not first-person). */
  chase(getPos: () => THREE.Vector3 | null, opts: { dist?: number; yaw?: number; pitch?: number } = {}) {
    this.mode = 'follow';
    this.follow = getPos;
    this.goal.dist = Math.max(20, (opts.dist ?? 22) * 1.3);
    this.goal.pitch = opts.pitch ?? 0.66;
    const yaw = opts.yaw ?? -0.95; // behind-left of a car heading +x
    this.goal.yaw = this.yaw + wrap(yaw - this.yaw);
    this.ease = 1.9;
    this.flashTag('FOLLOWING · Esc or any move key to release');
  }

  /** Glide (and descend to at most `dist`) to a ground point. */
  glideTo(p: THREE.Vector3, dist = 48) {
    this.mode = 'free';
    this.follow = null;
    this.goal.target.set(p.x, this.groundAt(p.x, p.z), p.z);
    this.clampTarget(this.goal.target);
    this.setDist(Math.min(this.goal.dist, dist));
    this.ease = 1.7;
  }

  /** Space: swoop down to where the latest crash happened. */
  toLatestCrash() {
    const c = this.lastCrash;
    if (!c) {
      this.flashTag('NO CRASH YET');
      return;
    }
    this.glideTo(this.tmp2.set(c.x, c.y, c.z), 34);
    this.setDist(34);
    this.flashTag('LATEST CRASH');
  }

  /** Drop follow mode, staying where we are. */
  release() {
    if (this.mode !== 'follow') return;
    this.mode = 'free';
    this.follow = null;
    this.goal.target.copy(this.target);
  }

  /** Ground point under a screen position: the view ray marched against the terrain height, else a plane at the focus. */
  pickGround(clientX: number, clientY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    if (d.y < -0.02) {
      let prev = 0;
      const far = Math.min(3000, this.dist * 6);
      const stepLen = Math.max(1.5, this.dist * 0.04);
      for (let s = stepLen; s <= far; s += stepLen) {
        if (o.y + d.y * s <= this.groundAt(o.x + d.x * s, o.z + d.z * s)) {
          let a = prev;
          let b = s;
          for (let i = 0; i < 6; i++) {
            const m = (a + b) / 2;
            if (o.y + d.y * m <= this.groundAt(o.x + d.x * m, o.z + d.z * m)) b = m;
            else a = m;
          }
          return out.copy(o).addScaledVector(d, b);
        }
        prev = s;
      }
    }
    this.plane.set(this.tmp.set(0, 1, 0), -this.target.y);
    const p = this.ray.ray.intersectPlane(this.plane, out);
    if (!p || p.distanceTo(o) > Math.max(400, this.dist * 5)) return null;
    return p;
  }

  private setDist(d: number) {
    const nd = THREE.MathUtils.clamp(d, MIN_DIST, this.maxDist);
    // a hand-set / framed tilt is kept relative to the auto pitch, but fades out as you dive so the ground view settles ~25°
    const off = this.goal.pitch - autoPitch(this.goal.dist);
    const decay = nd < this.goal.dist ? Math.sqrt(nd / this.goal.dist) : 1;
    this.goal.pitch = THREE.MathUtils.clamp(autoPitch(nd) + off * decay, 0.14, 1.5);
    this.goal.dist = nd;
  }

  /** Zoom by factor f (< 1 dives in) toward a screen point (none = the centre). */
  zoomAt(f: number, clientX?: number, clientY?: number) {
    const old = this.goal.dist;
    this.setDist(old * f);
    const k = this.goal.dist / old;
    if (clientX === undefined || clientY === undefined || this.mode === 'follow') return;
    const p = this.pickGround(clientX, clientY, this.tmp2);
    if (!p) return;
    // keep the point under the cursor under the cursor: pull the focus toward it by the zoom ratio
    this.goal.target.x = p.x + (this.goal.target.x - p.x) * k;
    this.goal.target.z = p.z + (this.goal.target.z - p.z) * k;
    this.clampTarget(this.goal.target);
  }

  private clampTarget(v: THREE.Vector3) {
    const b = this.bounds;
    if (!b) return;
    v.x = THREE.MathUtils.clamp(v.x, b.min.x, b.max.x);
    v.z = THREE.MathUtils.clamp(v.z, b.min.z, b.max.z);
  }

  private input() {
    this.lastInput = performance.now();
    this.onInput();
  }

  private gesture() {
    this.hooks.onGesture?.();
  }

  private orbitBy(dx: number, dy: number) {
    this.goal.yaw -= dx * 0.005;
    this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, 0.14, 1.5);
    this.ease = Math.max(this.ease, 8);
  }

  private startGrab(x: number, y: number, live = false) {
    const a = this.pickGround(x, y);
    this.grab = a ? { anchor: a.clone(), x, y, live } : null;
  }

  private bind() {
    const el = this.dom;
    el.style.touchAction = 'none';
    const pts = new Map<number, { x: number; y: number }>();
    let orbiting = false;
    let lx = 0;
    let ly = 0;
    let moved = 0;
    let pinch: { d: number; a: number } | null = null;
    const pinchState = () => {
      const [p, q] = [...pts.values()];
      return { d: Math.hypot(q.x - p.x, q.y - p.y), a: Math.atan2(q.y - p.y, q.x - p.x), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      this.gesture();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      lx = e.clientX;
      ly = e.clientY;
      moved = 0;
      if (pts.size >= 2) {
        this.grab = null;
        orbiting = false;
        const s = pinchState();
        pinch = { d: s.d, a: s.a };
        return;
      }
      // Mouse: plain drag turns/tilts the view (trackpads have no easy right-drag); Shift / right / middle drag pans.
      orbiting = e.pointerType === 'mouse' && !(e.shiftKey || e.button === 2 || e.button === 1);
      if (!orbiting) this.startGrab(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size >= 2 && pinch) {
        const s = pinchState();
        if (s.d > 10 && pinch.d > 10) this.zoomAt(pinch.d / s.d, s.mx, s.my);
        this.goal.yaw += wrap(s.a - pinch.a);
        this.ease = Math.max(this.ease, 8);
        pinch = { d: s.d, a: s.a };
        this.input();
        return;
      }
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 4) return;
      this.input();
      if (orbiting) this.orbitBy(dx, dy);
      else if (this.grab) {
        if (this.mode === 'follow') {
          this.release();
          this.startGrab(e.clientX, e.clientY, true);
        }
        if (this.grab) {
          this.grab.x = e.clientX;
          this.grab.y = e.clientY;
          this.grab.live = true;
        }
      }
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      pinch = null;
      orbiting = false;
      this.grab = null;
      // lifting one of two fingers: keep panning with the other
      if (pts.size === 1) {
        const [q] = [...pts.values()];
        lx = q.x;
        ly = q.y;
        moved = 10;
        this.startGrab(q.x, q.y, true);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.input();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomAt(Math.exp(THREE.MathUtils.clamp(dy, -240, 240) * 0.0016), e.clientX, e.clientY);
        this.ease = Math.max(this.ease, 5);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey) return;
      const c = e.code;
      this.gesture();
      if (c === 'Space') {
        e.preventDefault();
        if (!e.repeat) {
          this.input();
          this.toLatestCrash();
        }
        return;
      }
      if (!HELD_KEYS.includes(c)) return;
      if (c.startsWith('Arrow') || c.startsWith('Page')) e.preventDefault();
      this.keys.add(c);
      if (c.startsWith('Shift')) return;
      this.input();
      if (PAN_KEYS.includes(c)) this.release();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ── UI: a transient tag ───────────────────────────────────────────────────
  private buildUi() {
    const parent = this.dom.parentElement ?? document.body;
    const tag = document.createElement('div');
    tag.className = 'nav-tag';
    parent.append(tag);
    this.tag = tag;
  }

  flashTag(text: string) {
    if (!this.tag) return;
    this.tag.textContent = text;
    this.tag.classList.add('on');
    window.clearTimeout(this.tagTimer);
    this.tagTimer = window.setTimeout(() => this.tag?.classList.remove('on'), 1800);
  }

  // ── terrain ───────────────────────────────────────────────────────────────
  /** Terrain height at (x, z): the scene's height function, else a ray straight down onto userData.ground meshes. */
  groundAt(x: number, z: number): number {
    const h = this.groundProvider?.(x, z);
    if (h != null) return h;
    const scene = this.hooks.scene;
    if (!scene) return 0;
    const now = performance.now();
    if (now > this.groundsAt) {
      this.groundsAt = now + 2000;
      this.grounds = [];
      scene.traverse((o) => {
        if (o.userData.ground && (o as THREE.Mesh).isMesh) this.grounds.push(o);
      });
    }
    if (!this.grounds.length) return 0;
    this.ray.set(this.tmp.set(x, 1500, z), this.down);
    this.ray.far = 3000;
    const hit = this.ray.intersectObjects(this.grounds, false)[0];
    this.ray.far = Infinity;
    return hit ? hit.point.y : 0;
  }

  // ── per-frame ─────────────────────────────────────────────────────────────
  update(dt: number) {
    this.t += dt;
    const now = performance.now();
    dt = Math.min(dt, 0.1);
    const G = this.goal;

    // keys: pan (speed scales with height), rotate, zoom
    if (this.keys.size) {
      const has = (...k: string[]) => k.some((x) => this.keys.has(x));
      const fast = has('ShiftLeft', 'ShiftRight') ? 2.6 : 1;
      const f = Number(has('KeyW', 'ArrowUp')) - Number(has('KeyS', 'ArrowDown'));
      const s = Number(has('KeyD', 'ArrowRight')) - Number(has('KeyA', 'ArrowLeft'));
      if (f || s) {
        if (this.mode === 'follow') this.release();
        const speed = Math.max(10, this.dist * 0.85) * fast * dt;
        const sy = Math.sin(G.yaw);
        const cy = Math.cos(G.yaw);
        G.target.x += (-sy * f + cy * s) * speed;
        G.target.z += (-cy * f - sy * s) * speed;
        this.ease = Math.max(this.ease, 8);
      }
      const r = Number(has('KeyQ')) - Number(has('KeyE'));
      if (r) {
        G.yaw += r * 1.5 * fast * dt;
        this.ease = Math.max(this.ease, 8);
      }
      const z = Number(has('KeyF', 'PageDown')) - Number(has('KeyR', 'PageUp'));
      if (z) {
        this.setDist(G.dist * Math.exp(z * 1.4 * fast * dt));
        this.ease = Math.max(this.ease, 6);
      }
    }

    // left-drag / one-finger: keep the grabbed ground point under the pointer
    if (this.grab?.live) {
      const p = this.pickGround(this.grab.x, this.grab.y, this.tmp2);
      if (p) {
        const dx = this.grab.anchor.x - p.x;
        const dz = this.grab.anchor.z - p.z;
        this.target.x += dx;
        this.target.z += dz;
        G.target.x += dx;
        G.target.z += dz;
      }
    }

    if (this.mode === 'follow' && this.follow) {
      const p = this.follow();
      if (p) G.target.set(p.x + 2.5, p.y + 0.8, p.z);
      else this.release();
    } else {
      this.clampTarget(G.target);
      G.target.y = this.groundAt(G.target.x, G.target.z);
    }

    const k = 1 - Math.exp(-dt * this.ease);
    // drags and keys are snappy; once they stop, the ease relaxes back to the long-glide rate
    this.ease += (2.2 - this.ease) * (1 - Math.exp(-dt * 1.5));
    const tk = this.mode === 'follow' ? Math.max(k, 1 - Math.exp(-dt * 5)) : k;
    this.target.x += (G.target.x - this.target.x) * tk;
    this.target.z += (G.target.z - this.target.z) * tk;
    this.target.y += (G.target.y - this.target.y) * (1 - Math.exp(-dt * 4));
    this.yaw += wrap(G.yaw - this.yaw) * k;
    this.pitch += (G.pitch - this.pitch) * k;
    this.dist += (G.dist - this.dist) * k;

    const cp = Math.cos(this.pitch);
    const cam = this.camera.position;
    cam.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    // never under the terrain, and keep the line of sight to the focus clear of it (canyon walls, crater rims):
    // sample the terrain between the focus and the camera and lift the camera until the sight line passes above it
    let minY = this.groundAt(cam.x, cam.z) + CLEARANCE;
    const ty = this.target.y;
    for (let i = 1; i <= 6; i++) {
      const f = i / 7;
      const g = this.groundAt(this.target.x + (cam.x - this.target.x) * f, this.target.z + (cam.z - this.target.z) * f) + 1;
      if (g > ty + 0.5) minY = Math.max(minY, ty + (g - ty) / f);
    }
    if (cam.y < minY) this.liftY += (minY - cam.y - this.liftY) * (1 - Math.exp(-dt * 6));
    else this.liftY *= Math.exp(-dt * 3);
    cam.y = Math.max(cam.y + this.liftY, this.groundAt(cam.x, cam.z) + CLEARANCE);
    this.camera.lookAt(this.target);

    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * Math.min(1.2, this.dist * 0.01);
      cam.x += Math.sin(this.t * 41) * s;
      cam.y += Math.sin(this.t * 53 + 1.3) * s * 0.7;
      this.camera.rotation.z += Math.sin(this.t * 29) * 0.01 * this.trauma;
    }

    this.camera.far = Math.max(1200, this.dist * 5);
    this.camera.near = Math.max(0.25, Math.min(4, this.dist * 0.01));
    const cx = this.safe.left + (this.w - this.safe.left - this.safe.right) / 2;
    const cy = this.safe.top + (this.h - this.safe.top - this.safe.bottom) / 2;
    this.camera.setViewOffset(this.w, this.h, this.w / 2 - cx, this.h / 2 - cy, this.w, this.h);
    this.camera.updateProjectionMatrix();

    // biome under the screen centre → ambient bed crossfade
    if (now > this.biomeCheckAt) {
      this.biomeCheckAt = now + 300;
      const type = this.hooks.biomeAt?.(this.target.x, this.target.z);
      if (type && type !== this.lastBiome) {
        this.lastBiome = type;
        fx.emit({ t: 'enter-biome', biome: BIOME_FOR[type], type });
      }
    }
  }
}

function wrap(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
