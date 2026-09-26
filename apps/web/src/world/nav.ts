import * as THREE from 'three';

// Orbit / fly camera for humans + follow (chase) mode + framing, with eased transitions and a small shake.
// State: target point on the ground, yaw (around y), pitch (down angle), dist. Everything eases toward the goal values.

export type NavMode = 'free' | 'follow';

export class NavCamera {
  camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 4000);
  mode: NavMode = 'free';
  target = new THREE.Vector3();
  yaw = 0.35;
  pitch = 0.62;
  dist = 260;
  goal = { target: new THREE.Vector3(), yaw: 0.35, pitch: 0.62, dist: 260 };
  /** follow: a function returning the followed object's world position (null when it's gone) */
  follow: (() => THREE.Vector3 | null) | null = null;
  private trauma = 0;
  private t = 0;
  private keys = new Set<string>();
  private ease = 2.2;
  private tmp = new THREE.Vector3();
  lastInput = performance.now();
  /** Called on any human input (drag, wheel, keys). */
  onInput: () => void = () => {};

  constructor(private dom: HTMLElement) {
    this.bind();
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

  /** Ease the camera to show a world-space box from the current yaw (or a given one). */
  frameBox(box: THREE.Box3, opts: { yaw?: number; pitch?: number; pad?: number; ease?: number } = {}) {
    this.mode = 'free';
    this.follow = null;
    box.getCenter(this.goal.target);
    this.goal.target.y = 0;
    const size = box.getSize(this.tmp);
    const pitch = opts.pitch ?? 0.72;
    const sw = Math.max(200, this.w - this.safe.left - this.safe.right) / this.w;
    const sh = Math.max(200, this.h - this.safe.top - this.safe.bottom) / this.h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const fovV = 2 * Math.atan(tanV * sh);
    const fovH = 2 * Math.atan(tanV * this.camera.aspect * sw);
    const needW = (Math.max(size.x, 8) * (opts.pad ?? 1.25)) / 2 / Math.tan(fovH / 2);
    const needD = (Math.max(size.z, 8) * (opts.pad ?? 1.25) * Math.sin(pitch)) / 2 / Math.tan(fovV / 2);
    this.goal.dist = THREE.MathUtils.clamp(Math.max(needW, needD) * 1.05, 14, 1400);
    this.goal.pitch = pitch;
    if (opts.yaw !== undefined) this.goal.yaw = opts.yaw;
    this.ease = opts.ease ?? 1.8;
  }

  /** Chase cam on a moving object. */
  chase(getPos: () => THREE.Vector3 | null, opts: { dist?: number; yaw?: number; pitch?: number } = {}) {
    this.mode = 'follow';
    this.follow = getPos;
    this.goal.dist = opts.dist ?? 17;
    this.goal.pitch = opts.pitch ?? 0.34;
    this.goal.yaw = opts.yaw ?? -0.95; // behind-left of a car heading +x
    this.ease = 2.4;
  }

  glideTo(p: THREE.Vector3, dist = 48) {
    this.mode = 'free';
    this.follow = null;
    this.goal.target.set(p.x, 0, p.z);
    this.goal.dist = Math.min(this.goal.dist, dist);
    this.ease = 2;
  }

  private input() {
    this.lastInput = performance.now();
    this.onInput();
  }

  private bind() {
    const el = this.dom;
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;
    let moved = 0;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
      moved = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
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
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.input();
        this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 6, 1400);
        this.ease = 6;
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        this.keys.add(k);
        this.input();
        if (k.startsWith('arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Drop follow mode, keeping the current view. */
  release() {
    if (this.mode !== 'follow') return;
    this.mode = 'free';
    this.follow = null;
    this.goal.target.copy(this.target);
  }

  update(dt: number) {
    this.t += dt;
    // WASD / arrows fly the target over the ground; Q/E fly up/down
    if (this.keys.size) {
      if (this.mode === 'follow') this.release();
      const speed = Math.max(12, this.goal.dist * 0.9) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.goal.yaw), 0, -Math.cos(this.goal.yaw));
      const right = new THREE.Vector3(Math.cos(this.goal.yaw), 0, -Math.sin(this.goal.yaw));
      const has = (...k: string[]) => k.some((x) => this.keys.has(x));
      if (has('w', 'arrowup')) this.goal.target.addScaledVector(fwd, speed);
      if (has('s', 'arrowdown')) this.goal.target.addScaledVector(fwd, -speed);
      if (has('d', 'arrowright')) this.goal.target.addScaledVector(right, speed);
      if (has('a', 'arrowleft')) this.goal.target.addScaledVector(right, -speed);
      if (has('e')) this.goal.dist = Math.min(1400, this.goal.dist * (1 + dt * 1.2));
      if (has('q')) this.goal.dist = Math.max(6, this.goal.dist * (1 - dt * 1.2));
      this.ease = 10;
    }
    if (this.mode === 'follow' && this.follow) {
      const p = this.follow();
      if (p) this.goal.target.set(p.x + 2.5, 0.8, p.z);
      else this.release();
    }
    const k = 1 - Math.exp(-dt * this.ease);
    this.target.lerp(this.goal.target, this.mode === 'follow' ? 1 - Math.exp(-dt * 6) : k);
    // shortest-way yaw
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
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * Math.min(1.2, this.dist * 0.01);
      this.camera.position.x += Math.sin(this.t * 41) * s;
      this.camera.position.y += Math.sin(this.t * 53 + 1.3) * s * 0.7;
      this.camera.rotation.z += Math.sin(this.t * 29) * 0.01 * this.trauma;
    }
    this.camera.far = Math.max(1200, this.dist * 4);
    this.camera.near = Math.max(0.3, Math.min(4, this.dist * 0.01));
    const cx = this.safe.left + (this.w - this.safe.left - this.safe.right) / 2;
    const cy = this.safe.top + (this.h - this.safe.top - this.safe.bottom) / 2;
    this.camera.setViewOffset(this.w, this.h, this.w / 2 - cx, this.h / 2 - cy, this.w, this.h);
    this.camera.updateProjectionMatrix();
  }
}
