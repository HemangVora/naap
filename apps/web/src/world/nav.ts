import * as THREE from 'three';
import type { BarrierId } from '../types';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { BIOME_FOR, fx } from './fx';
import './nav.css';

// NaAP World v4 navigation, per visitor (every browser is its own player).
//   walk  : Minecraft-style. Pointer lock, mouse look, WASD, Shift sprint, Space jump, F fly (Space/C up/down), gravity onto
//           the terrain (ray down against ground meshes, fallback y = 0), AABB collisions with props and cars.
//           Crosshair + E / click rides along with a car (chase cam), E again hops out. R respawns on the platform.
//   orbit : the v3 overview camera (drag orbit, right/shift-drag pan, wheel zoom, WASD fly, Q/E zoom), framing, chase.
//   tour  : orbit driven by the index's projector auto-tour.
// V cycles walk → orbit → tour. Esc frees the mouse. Touch: left joystick, right drag-look, jump / fly / ride buttons.
// Ground / collider discovery: meshes tagged `userData.ground` / `userData.solid` / `userData.noCollide` win; otherwise
// flat wide meshes are ground and compact ones are solid (see refresh()).

export type NavMode = 'free' | 'follow';
export type NavView = 'walk' | 'orbit' | 'tour';
export type Surface = 'grass' | 'hard';

export interface NavHooks {
  scene?: THREE.Scene;
  /** obstacle type of the road segment nearest (x, z); null when not near any track */
  biomeAt?: (x: number, z: number) => BarrierId | null;
  /** viewing-platform spot (ground x, z) and the yaw that faces the tracks */
  spawn?: () => { x: number; z: number; yaw: number } | null;
  /** crosshair use (E while walking): ray from the screen centre; true when it grabbed something */
  use?: (ray: THREE.Raycaster) => boolean;
  /** the visitor changed the view (V / enter): index starts or stops the auto-tour */
  onView?: (v: NavView) => void;
  /** first user gesture (unlock audio) */
  onGesture?: () => void;
  /** a footstep while walking */
  onStep?: (surface: Surface, sprint: boolean) => void;
  /** landed after a fall (m/s downward) */
  onLand?: (speed: number) => void;
}

/** Optional exact ground height provider (the scene lane can install one; overrides the raycast). */
export type GroundProvider = (x: number, z: number) => number | null;

const EYE = 1.62;
const HEIGHT = 1.8;
const RADIUS = 0.38;
const STEP_UP = 0.6;
const GRAVITY = 26;
const JUMP_V = 8.6;
const DECK_H = 9;
const WALK_FOV = 72;
const ORBIT_FOV = 42;

interface Collider {
  box: THREE.Box3;
}
interface GroundMesh {
  mesh: THREE.Mesh;
  box: THREE.Box3;
  big: boolean;
}
type Spriteish = THREE.Object3D & { isSprite?: boolean };

export class NavCamera {
  camera = new THREE.PerspectiveCamera(ORBIT_FOV, 16 / 9, 0.5, 4000);
  mode: NavMode = 'free';
  view: NavView = 'orbit';
  target = new THREE.Vector3();
  yaw = 0.35;
  pitch = 0.62;
  dist = 260;
  goal = { target: new THREE.Vector3(), yaw: 0.35, pitch: 0.62, dist: 260 };
  /** follow: a function returning the followed object's world position (null when it's gone) */
  follow: (() => THREE.Vector3 | null) | null = null;
  /** walking but control released (Esc / lost pointer lock): shows "click to resume" */
  paused = false;
  readonly touch: boolean;
  player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: -Math.PI / 2, pitch: -0.18, grounded: false, fly: false, spawned: false };
  lastInput = performance.now();
  /** Called on any human input (drag, wheel, keys, look). */
  onInput: () => void = () => {};

  private hooks: NavHooks = {};
  private groundProvider: GroundProvider | null = null;
  private trauma = 0;
  private t = 0;
  private keys = new Set<string>();
  private ease = 2.2;
  private tmp = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private noLock = false;
  private joy = { x: 0, y: 0 };
  private touchJump = false;
  private fovGoal = ORBIT_FOV;
  private blend = { t: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private ray = new THREE.Raycaster();
  private down = new THREE.Vector3(0, -1, 0);
  private colliders: Collider[] = [];
  private grounds: GroundMesh[] = [];
  private carGroups: THREE.Object3D[] = [];
  private carBoxes: Collider[] = [];
  private refreshAt = 0;
  private stepAcc = 0;
  private bob = 0;
  private surface: Surface = 'grass';
  private biomeCheckAt = 0;
  private lastBiome: BarrierId | null = null;
  private platform: THREE.Group | null = null;
  private ui: { enter: HTMLElement; cross: HTMLElement; touch: HTMLElement; tag: HTMLElement } | null = null;
  private tagTimer = 0;

  constructor(private dom: HTMLElement) {
    this.touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
    this.camera.rotation.order = 'YXZ';
    this.bind();
    this.buildUi();
    (window as unknown as { __nav: NavCamera }).__nav = this;
  }

  /** Wire the scene in (index.ts, once). */
  attach(h: NavHooks) {
    this.hooks = { ...this.hooks, ...h };
  }
  /** The scene lane may install an exact terrain height function. */
  setGroundProvider(fn: GroundProvider | null) {
    this.groundProvider = fn;
  }

  get locked() {
    return document.pointerLockElement === this.dom;
  }
  /** Walking with control (pointer locked, or touch / no-lock fallback). */
  get engaged() {
    return this.view === 'walk' && !this.paused && (this.locked || this.touch || this.noLock);
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
    if (w < 900) this.safe = { left: 0, right: 0, top: 90, bottom: 0 };
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  // ── views ─────────────────────────────────────────────────────────────────
  /** "Click to enter": gesture → audio, walk view, pointer lock. */
  enter() {
    this.hooks.onGesture?.();
    this.input();
    if (this.view !== 'walk') this.setView('walk');
    this.paused = false;
    if (!this.touch) this.lock();
    this.syncUi();
  }

  private lock() {
    if (this.noLock) return;
    try {
      const r = (this.dom as HTMLElement & { requestPointerLock(): Promise<void> | void }).requestPointerLock();
      if (r && typeof (r as Promise<void>).then === 'function')
        (r as Promise<void>).catch(() => {
          // refused (automation, iframe, too soon after Esc): walk on with drag-look
          if (!this.locked) this.noLock = true;
          this.syncUi();
        });
    } catch {
      this.noLock = true;
    }
  }

  setView(v: NavView, notify = true) {
    if (v === this.view) return;
    this.startBlend();
    const prev = this.view;
    this.view = v;
    if (v === 'walk') {
      if (!this.player.spawned) this.respawn();
      this.mode = 'free';
      this.follow = null;
      this.fovGoal = WALK_FOV;
      this.paused = false;
    } else {
      if (this.locked) document.exitPointerLock();
      if (prev === 'walk') {
        const P = this.player;
        this.mode = 'free';
        this.follow = null;
        this.goal.target.set(P.pos.x, 0, P.pos.z);
        this.goal.dist = 80;
        this.goal.pitch = 0.62;
        this.goal.yaw = P.yaw;
        this.target.copy(this.goal.target);
        this.yaw = P.yaw;
        this.pitch = 0.3;
        this.dist = 30;
        this.ease = 2;
      }
      this.fovGoal = ORBIT_FOV;
    }
    this.keys.clear();
    this.syncUi();
    if (notify) this.hooks.onView?.(v);
  }

  cycleView() {
    const next: NavView = this.view === 'walk' ? 'orbit' : this.view === 'orbit' ? 'tour' : 'walk';
    if (next === 'walk') this.enter();
    else this.setView(next);
    this.flashTag(next === 'walk' ? 'WALK' : next === 'orbit' ? 'ORBIT OVERVIEW' : 'AUTO-TOUR');
  }

  respawn() {
    const sp = this.hooks.spawn?.();
    const P = this.player;
    if (sp) {
      this.ensurePlatform(sp);
      P.pos.set(sp.x, DECK_H + 0.02, sp.z);
      P.yaw = sp.yaw;
    } else P.pos.set(0, 30, 60);
    P.pitch = -0.2;
    P.vel.set(0, 0, 0);
    P.fly = false;
    P.grounded = true;
    P.spawned = true;
    this.refreshAt = 0;
  }

  // ── orbit API (index.ts) ──────────────────────────────────────────────────
  /** Ease the camera to show a world-space box from the current yaw (or a given one). */
  frameBox(box: THREE.Box3, opts: { yaw?: number; pitch?: number; pad?: number; ease?: number } = {}) {
    if (this.view === 'walk') {
      if (this.engaged) return; // a walking visitor keeps their camera
      this.setView('orbit', false);
    }
    this.mode = 'free';
    this.follow = null;
    box.getCenter(this.goal.target);
    this.goal.target.y = 0;
    const size = box.getSize(this.tmp);
    const pitch = opts.pitch ?? 0.72;
    const sw = Math.max(200, this.w - this.safe.left - this.safe.right) / this.w;
    const sh = Math.max(200, this.h - this.safe.top - this.safe.bottom) / this.h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(ORBIT_FOV) / 2);
    const fovV = 2 * Math.atan(tanV * sh);
    const fovH = 2 * Math.atan(tanV * this.camera.aspect * sw);
    const needW = (Math.max(size.x, 8) * (opts.pad ?? 1.25)) / 2 / Math.tan(fovH / 2);
    const needD = (Math.max(size.z, 8) * (opts.pad ?? 1.25) * Math.sin(pitch)) / 2 / Math.tan(fovV / 2);
    this.goal.dist = THREE.MathUtils.clamp(Math.max(needW, needD) * 1.05, 14, 1400);
    this.goal.pitch = pitch;
    if (opts.yaw !== undefined) this.goal.yaw = opts.yaw;
    this.ease = opts.ease ?? 1.8;
  }

  /** Chase cam on a moving object (ride-along while walking). */
  chase(getPos: () => THREE.Vector3 | null, opts: { dist?: number; yaw?: number; pitch?: number } = {}) {
    const walk = this.view === 'walk';
    if (walk) this.startBlend();
    this.mode = 'follow';
    this.follow = getPos;
    this.goal.dist = walk ? 9.5 : (opts.dist ?? 17);
    this.goal.pitch = walk ? 0.2 : (opts.pitch ?? 0.34);
    this.goal.yaw = opts.yaw ?? -0.95; // behind-left of a car heading +x
    if (walk) {
      const p = getPos();
      if (p) this.target.set(p.x, 0.8 + p.y, p.z);
      this.goal.target.copy(this.target);
      this.yaw = this.goal.yaw;
      this.pitch = this.goal.pitch;
      this.dist = this.goal.dist;
      this.flashTag('RIDE-ALONG · E to hop out');
    }
    this.ease = 2.4;
    this.syncUi();
  }

  glideTo(p: THREE.Vector3, dist = 48) {
    if (this.view === 'walk') {
      if (this.locked) return;
      // mini-map click while walking: teleport there
      this.mode = 'free';
      this.follow = null;
      this.startBlend();
      this.refresh();
      this.player.pos.set(p.x, this.groundAt(p.x, p.z, 400) + 0.02, p.z);
      this.player.vel.set(0, 0, 0);
      this.syncUi();
      return;
    }
    this.mode = 'free';
    this.follow = null;
    this.goal.target.set(p.x, 0, p.z);
    this.goal.dist = Math.min(this.goal.dist, dist);
    this.ease = 2;
  }

  /** Drop follow mode, keeping the current view (walking: hop out beside the car). */
  release() {
    if (this.mode !== 'follow') return;
    if (this.view === 'walk') {
      this.hopOut();
      return;
    }
    this.mode = 'free';
    this.follow = null;
    this.goal.target.copy(this.target);
  }

  private hopOut() {
    const p = this.follow?.() ?? this.target.clone();
    const P = this.player;
    const d = new THREE.Vector3(this.camera.position.x - p.x, 0, this.camera.position.z - p.z);
    if (d.lengthSq() < 1e-4) d.set(0, 0, 1);
    d.normalize();
    this.startBlend();
    P.pos.set(p.x + d.x * 3.2, 0, p.z + d.z * 3.2);
    this.refresh();
    P.pos.y = this.groundAt(P.pos.x, P.pos.z, p.y + 3) + 0.02;
    P.yaw = Math.atan2(d.x, d.z); // look back at the car
    P.pitch = -0.12;
    P.vel.set(0, 0, 0);
    this.mode = 'free';
    this.follow = null;
    this.syncUi();
  }

  /** Mini-map marker: where the player stands and which way they look. */
  marker(): { x: number; z: number; heading: number; walk: boolean } {
    if (this.view === 'walk') {
      if (this.mode === 'follow') return { x: this.target.x, z: this.target.z, heading: this.yaw, walk: true };
      return { x: this.player.pos.x, z: this.player.pos.z, heading: this.player.yaw, walk: true };
    }
    return { x: this.target.x, z: this.target.z, heading: this.yaw, walk: false };
  }

  /** Called by index on a canvas click: true when nav consumed it (walking but paused → resume). */
  consumeClick(): boolean {
    if (this.view === 'walk' && !this.engaged) {
      this.enter();
      return true;
    }
    return false;
  }

  private input() {
    this.lastInput = performance.now();
    this.onInput();
  }

  private look(dx: number, dy: number) {
    this.input();
    if (this.mode === 'follow') {
      this.goal.yaw -= dx * 0.003;
      this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.003, -0.05, 1.3);
      this.ease = 10;
      return;
    }
    const P = this.player;
    P.yaw -= dx * 0.0022;
    P.pitch = THREE.MathUtils.clamp(P.pitch - dy * 0.0022, -1.52, 1.52);
  }

  private use() {
    this.input();
    if (this.mode === 'follow') {
      this.hopOut();
      return;
    }
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.ray.far = 160;
    const got = this.hooks.use?.(this.ray);
    this.ray.far = Infinity;
    if (!got) this.flashTag('Aim the crosshair at a car, then E');
  }

  private toggleFly() {
    const P = this.player;
    P.fly = !P.fly;
    if (P.fly) P.vel.y = 3;
    this.flashTag(P.fly ? 'FLY · Space up · C down · F to land' : 'WALK');
  }

  private bind() {
    const el = this.dom;
    let dragging = false;
    let panning = false;
    let lookId = -1;
    let lx = 0;
    let ly = 0;
    let moved = 0;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      this.hooks.onGesture?.();
      if (this.view === 'walk') {
        // touch / no-lock fallback: drag to look
        if (this.engaged && !this.locked) {
          lookId = e.pointerId;
          lx = e.clientX;
          ly = e.clientY;
          el.setPointerCapture(e.pointerId);
        }
        return;
      }
      dragging = true;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
      moved = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.view === 'walk') {
        if (e.pointerId !== lookId || this.locked) return;
        const k = e.pointerType === 'touch' ? 2.2 : 1.4;
        this.look((e.clientX - lx) * k, (e.clientY - ly) * k);
        lx = e.clientX;
        ly = e.clientY;
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 3) return;
      this.input();
      if (panning) {
        const k = this.goal.dist * 0.0016;
        const fwd = new THREE.Vector3(-Math.sin(this.goal.yaw), 0, -Math.cos(this.goal.yaw));
        const right = new THREE.Vector3(Math.cos(this.goal.yaw), 0, -Math.sin(this.goal.yaw));
        if (this.mode === 'follow') this.release();
        this.goal.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
      } else {
        this.goal.yaw -= dx * 0.005;
        this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, 0.08, 1.45);
        this.ease = 8;
      }
    });
    const up = (e: PointerEvent) => {
      dragging = false;
      if (e.pointerId === lookId) lookId = -1;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.view === 'walk') return;
        this.input();
        this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 6, 1400);
        this.ease = 6;
      },
      { passive: false },
    );
    document.addEventListener('mousemove', (e) => {
      if (this.locked) this.look(e.movementX, e.movementY);
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked && this.view === 'walk' && !this.touch && !this.noLock) {
        this.paused = true;
        this.keys.clear();
      }
      this.syncUi();
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.view === 'walk') this.noLock = true;
      this.syncUi();
    });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const c = e.code;
      if (c === 'KeyV' && !e.repeat) {
        this.cycleView();
        return;
      }
      if (this.view === 'walk') {
        if (c === 'Escape') {
          if (!this.locked) this.paused = true;
          this.keys.clear();
          this.syncUi();
          return;
        }
        if (!this.engaged) {
          if (c === 'Enter') this.enter();
          return;
        }
        this.input();
        if (c === 'KeyF' && !e.repeat) this.toggleFly();
        else if (c === 'KeyE' && !e.repeat) this.use();
        else if (c === 'KeyR' && !e.repeat) this.respawn();
        else this.keys.add(c);
        if (c === 'Space' || c.startsWith('Arrow')) e.preventDefault();
        return;
      }
      if (c === 'Enter' && !e.repeat) {
        this.enter();
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) {
        this.keys.add(c);
        this.input();
        if (c.startsWith('Arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ── UI: enter card, crosshair, touch controls ─────────────────────────────
  private buildUi() {
    const parent = this.dom.parentElement ?? document.body;
    const mk = (tag: string, cls: string, html = '') => {
      const n = document.createElement(tag);
      n.className = cls;
      if (html) n.innerHTML = html;
      return n;
    };
    const enter = mk(
      'button',
      'nav-enter',
      `<b></b><small>${this.touch ? 'left stick move · drag to look · jump · fly · ride' : 'WASD walk · mouse look · Space jump · Shift sprint · F fly · E ride a car · V view · Esc free mouse'}</small>`,
    );
    enter.addEventListener('click', (e) => {
      e.stopPropagation();
      this.enter();
    });
    const cross = mk('div', 'nav-cross');
    const tag = mk('div', 'nav-tag');
    const touch = mk('div', 'nav-touch');
    const joy = mk('div', 'nav-joy');
    const knob = mk('div', 'nav-knob');
    joy.append(knob);
    const btn = (label: string, cls: string, fn: () => void, hold?: (on: boolean) => void) => {
      const b = mk('button', `nav-btn ${cls}`, label);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input();
        fn();
        hold?.(true);
      });
      const off = () => hold?.(false);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
      return b;
    };
    touch.append(
      joy,
      btn('JUMP', 'jump', () => {}, (on) => (this.touchJump = on)),
      btn('FLY', 'fly', () => this.toggleFly()),
      btn('RIDE', 'use', () => this.use()),
      btn('VIEW', 'view', () => this.cycleView()),
    );
    let joyId = -1;
    const joyMove = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect();
      const R = r.width / 2;
      let dx = e.clientX - (r.left + R);
      let dy = e.clientY - (r.top + R);
      const l = Math.hypot(dx, dy);
      if (l > R) {
        dx *= R / l;
        dy *= R / l;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joy.x = dx / R;
      this.joy.y = dy / R;
      this.input();
    };
    joy.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      joyId = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      joyMove(e);
    });
    joy.addEventListener('pointermove', (e) => {
      if (e.pointerId === joyId) joyMove(e);
    });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      joyId = -1;
      this.joy.x = this.joy.y = 0;
      knob.style.transform = '';
    };
    joy.addEventListener('pointerup', joyEnd);
    joy.addEventListener('pointercancel', joyEnd);
    parent.append(cross, tag, touch, enter);
    this.ui = { enter, cross, touch, tag };
    this.syncUi();
  }

  private flashTag(text: string) {
    if (!this.ui) return;
    this.ui.tag.textContent = text;
    this.ui.tag.classList.add('on');
    window.clearTimeout(this.tagTimer);
    this.tagTimer = window.setTimeout(() => this.ui?.tag.classList.remove('on'), 1800);
  }

  private syncUi() {
    if (!this.ui) return;
    const walk = this.view === 'walk';
    const { enter, cross, touch } = this.ui;
    enter.style.display = walk && this.engaged ? 'none' : '';
    enter.classList.toggle('resume', walk && !this.engaged);
    (enter.querySelector('b') as HTMLElement).textContent =
      walk && !this.engaged ? (this.touch ? 'Tap to resume' : 'Click to resume walking') : this.touch ? 'Tap to walk in' : 'Click to walk in';
    cross.style.display = walk && this.engaged && this.mode === 'free' ? '' : 'none';
    touch.style.display = walk && this.touch && this.engaged ? '' : 'none';
    (touch.querySelector('.use') as HTMLElement).textContent = this.mode === 'follow' ? 'HOP OUT' : 'RIDE';
    document.body.classList.toggle('nav-walking', walk && this.engaged);
    document.body.classList.toggle('nav-view-tour', this.view === 'tour');
  }

  // ── viewing platform (spawn) ──────────────────────────────────────────────
  private ensurePlatform(sp: { x: number; z: number; yaw: number }) {
    const scene = this.hooks.scene;
    if (this.platform || !scene) return;
    const g = new THREE.Group();
    g.name = 'nav-viewing-platform';
    const steel = new THREE.MeshStandardMaterial({ color: 0x5d6068, roughness: 0.5, metalness: 0.5 });
    const deckM = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.85 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.6 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, tag?: 'ground' | 'solid') => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (tag) mesh.userData[tag] = true;
      g.add(mesh);
      return mesh;
    };
    const S = 9;
    box(S, 0.5, S, deckM, 0, DECK_H - 0.25, 0, 'ground');
    // hazard-yellow deck edges
    box(S + 0.3, 0.12, 0.3, yellow, 0, DECK_H + 0.01, S / 2 - 0.05);
    box(S + 0.3, 0.12, 0.3, yellow, 0, DECK_H + 0.01, -S / 2 + 0.05);
    box(0.3, 0.12, S + 0.3, yellow, S / 2 - 0.05, DECK_H + 0.01, 0);
    for (const [x, z] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      box(0.5, DECK_H - 0.5, 0.5, steel, x * (S / 2 - 0.4), (DECK_H - 0.5) / 2, z * (S / 2 - 0.4), 'solid');
    // rails on the front (toward the tracks) and both sides; the back opens onto a stair
    const rail = (w: number, d: number, x: number, z: number) => {
      box(w, 0.09, d, yellow, x, DECK_H + 1.05, z, 'solid');
      box(w, 0.06, d, steel, x, DECK_H + 0.55, z);
    };
    rail(0.09, S, S / 2 - 0.1, 0);
    rail(S, 0.09, 0, S / 2 - 0.1);
    rail(S, 0.09, 0, -S / 2 + 0.1);
    for (let i = -2; i <= 2; i++) {
      box(0.08, 1.1, 0.08, steel, S / 2 - 0.1, DECK_H + 0.55, i * 2.1);
      box(0.08, 1.1, 0.08, steel, i * 2.1, DECK_H + 0.55, S / 2 - 0.1);
      box(0.08, 1.1, 0.08, steel, i * 2.1, DECK_H + 0.55, -S / 2 + 0.1);
    }
    // stair down the back (each step ≤ STEP_UP, so you can walk it)
    for (let i = 0; ; i++) {
      const top = DECK_H - (i + 1) * 0.5;
      if (top <= 0.05) break;
      box(0.8, 0.3, 2.2, steel, -S / 2 - 0.4 - i * 0.8, top - 0.15, 0, 'ground');
    }
    g.position.set(sp.x, 0, sp.z);
    g.rotation.y = sp.yaw + Math.PI / 2; // local +x faces the tracks
    scene.add(g);
    this.platform = g;
  }

  // ── collision world ───────────────────────────────────────────────────────
  private refresh() {
    const scene = this.hooks.scene;
    this.colliders = [];
    this.grounds = [];
    this.carGroups = [];
    if (!scene) return;
    scene.updateMatrixWorld();
    const bb = new THREE.Box3();
    const size = new THREE.Vector3();
    const m4 = new THREE.Matrix4();
    const skipMat = (m: THREE.Material | THREE.Material[]) => {
      const a = Array.isArray(m) ? m[0] : m;
      return !a || (a.transparent && a.opacity < 0.6) || a.side === THREE.BackSide || a.depthWrite === false;
    };
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.noCollide) return;
      if (o.userData.carId !== undefined) {
        this.carGroups.push(o);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry && !(o as Spriteish).isSprite && !skipMat(mesh.material)) {
        const geo = mesh.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh) {
          if (inst.count <= 2500 && !o.userData.ground) {
            for (let i = 0; i < inst.count; i++) {
              inst.getMatrixAt(i, m4);
              m4.premultiply(inst.matrixWorld);
              const b = geo.boundingBox!.clone().applyMatrix4(m4);
              b.getSize(size);
              if (size.y >= 0.3 && Math.max(size.x, size.z) <= 40 && size.y < 200) this.colliders.push({ box: b });
            }
          }
        } else {
          bb.copy(geo.boundingBox!).applyMatrix4(o.matrixWorld);
          bb.getSize(size);
          const ext = Math.max(size.x, size.z);
          const tagG = !!o.userData.ground;
          const tagS = !!o.userData.solid;
          const ground = tagG || (!tagS && ext >= 10 && size.y < ext * 0.35);
          if (ground) {
            this.grounds.push({ mesh, box: bb.clone(), big: ext > 120 });
            // big terrain meshes: a BVH once, so the per-frame ground ray is microseconds, not a 20k-triangle scan
            const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
            if (tris > 400 && !(geo as unknown as { boundsTree?: MeshBVH }).boundsTree) {
              try {
                (geo as unknown as { boundsTree?: MeshBVH }).boundsTree = new MeshBVH(geo);
                mesh.raycast = acceleratedRaycast;
              } catch {
                /* odd geometry: plain raycast */
              }
            }
          }
          const solid = tagS || (!tagG && size.y >= 0.3 && size.y < 200 && (ground ? size.y > 1.2 && ext <= 80 : ext <= 40));
          if (solid) this.colliders.push({ box: bb.clone() });
        }
      }
      for (const c of o.children) walk(c);
    };
    walk(scene);
  }

  private updateCarBoxes() {
    const P = this.player.pos;
    this.carBoxes.length = 0;
    const wp = new THREE.Vector3();
    for (const g of this.carGroups) {
      if (!g.parent || !g.visible) continue;
      g.getWorldPosition(wp);
      if (Math.abs(wp.x - P.x) > 14 || Math.abs(wp.z - P.z) > 14) continue;
      const b = new THREE.Box3();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !o.visible || (o as Spriteish).isSprite || !m.geometry) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        b.union(this.tmpBox.copy(m.geometry.boundingBox!).applyMatrix4(o.matrixWorld));
      });
      if (!b.isEmpty() && b.max.y - b.min.y < 6) this.carBoxes.push({ box: b });
    }
  }

  /** Would the player (feet at y) at (x, z) overlap a solid it is not already inside? */
  private blocked(x: number, z: number, y: number) {
    const P = this.player.pos;
    const test = (list: Collider[]) => {
      for (const { box: b } of list) {
        if (y + HEIGHT <= b.min.y || y + STEP_UP >= b.max.y) continue;
        if (x < b.min.x - RADIUS || x > b.max.x + RADIUS || z < b.min.z - RADIUS || z > b.max.z + RADIUS) continue;
        // already inside (spawned in it, a huge box): ignore rather than trap
        if (P.x >= b.min.x - RADIUS && P.x <= b.max.x + RADIUS && P.z >= b.min.z - RADIUS && P.z <= b.max.z + RADIUS) continue;
        return true;
      }
      return false;
    };
    return test(this.colliders) || test(this.carBoxes);
  }

  /** Terrain height under (x, z) for a player whose feet are at y (steps up at most STEP_UP). */
  groundAt(x: number, z: number, y: number) {
    let h = -Infinity;
    let surface: Surface = 'grass';
    const fromProvider = this.groundProvider?.(x, z);
    if (fromProvider != null) h = fromProvider;
    else {
      const cands: THREE.Object3D[] = [];
      for (const g of this.grounds)
        if (x >= g.box.min.x && x <= g.box.max.x && z >= g.box.min.z && z <= g.box.max.z && g.box.min.y <= y + STEP_UP) cands.push(g.mesh);
      if (cands.length) {
        this.ray.set(this.tmp.set(x, y + STEP_UP, z), this.down);
        this.ray.far = 800;
        (this.ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
        const hit = this.ray.intersectObjects(cands, false)[0];
        (this.ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
        this.ray.far = Infinity;
        if (hit) {
          h = hit.point.y;
          const g = this.grounds.find((q) => q.mesh === hit.object);
          surface = g && g.big ? 'grass' : 'hard';
        }
      }
    }
    // tops of solids (walls, cars, props) you can stand on
    const r = RADIUS * 0.6;
    for (const list of [this.colliders, this.carBoxes])
      for (const { box: b } of list)
        if (x >= b.min.x - r && x <= b.max.x + r && z >= b.min.z - r && z <= b.max.z + r && b.max.y <= y + STEP_UP && b.max.y > h) {
          h = b.max.y;
          surface = 'hard';
        }
    if (h === -Infinity) h = 0;
    this.surface = surface;
    return h;
  }

  // ── per-frame ─────────────────────────────────────────────────────────────
  update(dt: number) {
    this.t += dt;
    const now = performance.now();
    if (this.locked) this.lastInput = now; // the projector tour only kicks in when nobody holds the mouse
    if (this.view === 'walk' && this.mode === 'free') this.updateWalk(dt, now);
    else this.updateOrbit(dt);

    if (Math.abs(this.camera.fov - this.fovGoal) > 0.05) this.camera.fov += (this.fovGoal - this.camera.fov) * (1 - Math.exp(-dt * 5));

    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * (this.view === 'walk' ? 0.25 : Math.min(1.2, this.dist * 0.01));
      this.camera.position.x += Math.sin(this.t * 41) * s;
      this.camera.position.y += Math.sin(this.t * 53 + 1.3) * s * 0.7;
      this.camera.rotation.z += Math.sin(this.t * 29) * 0.01 * this.trauma;
    }

    // view blend (walk ↔ orbit ↔ ride)
    if (this.blend.t < 1) {
      this.blend.t = Math.min(1, this.blend.t + dt / 0.75);
      const k = this.blend.t * this.blend.t * (3 - 2 * this.blend.t);
      this.camera.position.lerpVectors(this.blend.pos, this.camera.position, k);
      this.camera.quaternion.slerpQuaternions(this.blend.quat, this.camera.quaternion.clone(), k);
    }

    if (this.view === 'walk') {
      this.camera.far = 3000;
      this.camera.near = 0.12;
      this.camera.clearViewOffset();
    } else {
      this.camera.far = Math.max(1200, this.dist * 4);
      this.camera.near = Math.max(0.3, Math.min(4, this.dist * 0.01));
      const cx = this.safe.left + (this.w - this.safe.left - this.safe.right) / 2;
      const cy = this.safe.top + (this.h - this.safe.top - this.safe.bottom) / 2;
      this.camera.setViewOffset(this.w, this.h, this.w / 2 - cx, this.h / 2 - cy, this.w, this.h);
    }
    this.camera.updateProjectionMatrix();

    // biome under the player (walk) or under the orbit focus (close views only)
    if (now > this.biomeCheckAt) {
      this.biomeCheckAt = now + 300;
      if (this.hooks.biomeAt && (this.view === 'walk' || this.dist < 160)) {
        const m = this.marker();
        const type = this.hooks.biomeAt(m.x, m.z);
        if (type && type !== this.lastBiome) {
          this.lastBiome = type;
          fx.emit({ t: 'enter-biome', biome: BIOME_FOR[type], type });
        }
      }
    }
  }

  private startBlend() {
    this.blend.t = 0;
    this.blend.pos.copy(this.camera.position);
    this.blend.quat.copy(this.camera.quaternion);
  }

  private updateWalk(dt: number, now: number) {
    const P = this.player;
    if (!P.spawned) this.respawn();
    if (now > this.refreshAt) {
      this.refresh();
      this.refreshAt = now + 1500;
    }
    this.updateCarBoxes();
    const k = (...c: string[]) => c.some((x) => this.keys.has(x));
    const active = this.engaged;
    let f = 0;
    let s = 0;
    if (active) {
      f = Number(k('KeyW', 'ArrowUp')) - Number(k('KeyS', 'ArrowDown')) - this.joy.y;
      s = Number(k('KeyD', 'ArrowRight')) - Number(k('KeyA', 'ArrowLeft')) + this.joy.x;
    }
    const sprint = active && k('ShiftLeft', 'ShiftRight');
    const speed = P.fly ? (sprint ? 95 : 30) : sprint ? 13 : 6.2;
    const sy = Math.sin(P.yaw);
    const cy = Math.cos(P.yaw);
    let wx = -sy * f + cy * s;
    let wz = -cy * f - sy * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    const accel = P.fly ? 5 : P.grounded ? 14 : 2.5;
    const a = 1 - Math.exp(-dt * accel);
    P.vel.x += (wx * speed - P.vel.x) * a;
    P.vel.z += (wz * speed - P.vel.z) * a;
    const jump = active && (k('Space') || this.touchJump);
    if (P.fly) {
      const upv = Number(jump) - Number(active && k('KeyC', 'ControlLeft'));
      P.vel.y += (upv * speed * 0.6 - P.vel.y) * a;
    } else {
      P.vel.y -= GRAVITY * dt;
      if (jump && P.grounded) {
        P.vel.y = JUMP_V;
        P.grounded = false;
      }
    }

    // horizontal, axis by axis, so you slide along walls
    const nx = P.pos.x + P.vel.x * dt;
    if (this.blocked(nx, P.pos.z, P.pos.y)) P.vel.x = 0;
    else P.pos.x = nx;
    const nz = P.pos.z + P.vel.z * dt;
    if (this.blocked(P.pos.x, nz, P.pos.y)) P.vel.z = 0;
    else P.pos.z = nz;

    // vertical
    const g = this.groundAt(P.pos.x, P.pos.z, P.pos.y);
    const vy = P.vel.y;
    P.pos.y += P.vel.y * dt;
    if (P.pos.y <= g) {
      if (!P.grounded && vy < -7) this.hooks.onLand?.(-vy);
      P.pos.y = g;
      if (P.vel.y < 0) P.vel.y = 0;
      if (P.fly && vy < -1) {
        P.fly = false; // touching down ends flight
        this.flashTag('WALK');
      }
      P.grounded = !P.fly;
    } else if (!P.fly && P.grounded && P.vel.y <= 0 && P.pos.y - g < 0.45) {
      P.pos.y = g; // stick to slopes and steps down
    } else P.grounded = false;
    if (P.pos.y < -200) this.respawn();
    if (P.pos.y > 1500) P.pos.y = 1500;

    // footsteps + head bob
    const hs = Math.hypot(P.vel.x, P.vel.z);
    if (P.grounded && hs > 1.2) {
      const stride = sprint ? 2.3 : 1.75;
      this.stepAcc += hs * dt;
      this.bob += (hs * dt * Math.PI) / stride;
      if (this.stepAcc >= stride) {
        this.stepAcc -= stride;
        this.hooks.onStep?.(this.surface, sprint);
      }
    }
    const bobY = P.grounded ? Math.abs(Math.sin(this.bob)) * 0.05 * Math.min(1, hs / 6) : 0;
    this.camera.position.set(P.pos.x, P.pos.y + EYE + bobY, P.pos.z);
    this.camera.rotation.set(P.pitch, P.yaw, 0, 'YXZ');
    // keep the index's sun / shadow box and LOD sensible
    this.target.set(P.pos.x, P.pos.y, P.pos.z);
    this.dist = 40 + Math.max(0, P.pos.y - 10) * 0.6;
  }

  private updateOrbit(dt: number) {
    // WASD / arrows fly the target over the ground; Q/E zoom (orbit views only)
    if (this.keys.size && this.view !== 'walk') {
      if (this.mode === 'follow') this.release();
      const speed = Math.max(12, this.goal.dist * 0.9) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.goal.yaw), 0, -Math.cos(this.goal.yaw));
      const right = new THREE.Vector3(Math.cos(this.goal.yaw), 0, -Math.sin(this.goal.yaw));
      const has = (...k: string[]) => k.some((x) => this.keys.has(x));
      if (has('KeyW', 'ArrowUp')) this.goal.target.addScaledVector(fwd, speed);
      if (has('KeyS', 'ArrowDown')) this.goal.target.addScaledVector(fwd, -speed);
      if (has('KeyD', 'ArrowRight')) this.goal.target.addScaledVector(right, speed);
      if (has('KeyA', 'ArrowLeft')) this.goal.target.addScaledVector(right, -speed);
      if (has('KeyE')) this.goal.dist = Math.min(1400, this.goal.dist * (1 + dt * 1.2));
      if (has('KeyQ')) this.goal.dist = Math.max(6, this.goal.dist * (1 - dt * 1.2));
      this.ease = 10;
    }
    const riding = this.view === 'walk';
    if (this.mode === 'follow' && this.follow) {
      const p = this.follow();
      if (p) this.goal.target.set(p.x + (riding ? 0 : 2.5), 0.8 + (riding ? p.y : 0), p.z);
      else this.release();
    }
    const k = 1 - Math.exp(-dt * this.ease);
    this.target.lerp(this.goal.target, this.mode === 'follow' ? 1 - Math.exp(-dt * 6) : k);
    let dy = this.goal.yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;
    this.dist += (this.goal.dist - this.dist) * k;

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    if (this.camera.position.y < 1.2) this.camera.position.y = 1.2;
    this.camera.lookAt(this.target);
  }
}
