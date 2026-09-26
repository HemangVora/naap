import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/** HUD insets in CSS px: the scene is framed inside this rect so the rails never cover a car. */
export interface SafeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Wide "director" gantry camera: a fixed high 3/4 direction (≈40° down) whose distance is solved every frame so the
 * bounding box of every active lane fits inside the HUD-safe rect. Eased; never cuts to a close-up.
 */
export class DirectorCamera {
  camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 900);
  safe: SafeRect = { left: 210, right: 250, top: 110, bottom: 130 };
  private dir = new THREE.Vector3(0.3, 0.6, 1.0).normalize(); // ≈30° down, from target toward camera
  private punchAt = new THREE.Vector3();
  private punchUntil = 0;
  private punchMs = 600;
  private center = new THREE.Vector3();
  private dist = 60;
  private targetCenter = new THREE.Vector3();
  private targetDist = 60;
  private started = false;
  private trauma = 0;
  private t = 0;
  private w = 1920;
  private h = 1080;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private corner = new THREE.Vector3();

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  /** Brief push (~15 %) toward a point, eased in and out; the fit still holds every lane. */
  punch(at: THREE.Vector3, ms = 600) {
    this.punchAt.copy(at);
    this.punchMs = ms;
    this.punchUntil = performance.now() + ms;
  }

  /** Fit a world-space box into the safe rect (sets the eased targets). */
  frame(box: THREE.Box3) {
    box.getCenter(this.targetCenter);
    this.fwd.copy(this.dir).negate();
    this.right.crossVectors(this.fwd, UP).normalize();
    this.up.crossVectors(this.right, this.fwd).normalize();
    const safeW = Math.max(200, this.w - this.safe.left - this.safe.right);
    const safeH = Math.max(200, this.h - this.safe.top - this.safe.bottom);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanV = tanHalf * (safeH / this.h) * 0.9;
    const tanH = tanHalf * (this.w / this.h) * (safeW / this.w) * 0.9;
    let need = 0;
    for (let i = 0; i < 8; i++) {
      this.corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      this.tmp.subVectors(this.corner, this.targetCenter);
      const px = this.tmp.dot(this.right);
      const py = this.tmp.dot(this.up);
      const pz = this.tmp.dot(this.fwd);
      need = Math.max(need, pz + Math.abs(py) / tanV, pz + Math.abs(px) / tanH);
    }
    this.targetDist = THREE.MathUtils.clamp(need, 18, 500);
  }

  update(wallDt: number) {
    this.t += wallDt;
    if (!this.started) {
      this.started = true;
      this.center.copy(this.targetCenter);
      this.dist = this.targetDist;
    }
    const k = 1 - Math.exp(-wallDt * 1.4);
    this.center.lerp(this.targetCenter, k);
    this.dist += (this.targetDist - this.dist) * k;

    this.trauma = Math.max(0, this.trauma - wallDt * 1.6);
    const s = this.trauma * this.trauma;
    const shakeScale = 0.004 * this.dist;
    const sx = Math.sin(this.t * 41) * shakeScale * s;
    const sy = Math.sin(this.t * 53 + 1.3) * shakeScale * 0.7 * s;
    const sz = Math.sin(this.t * 37 + 2.1) * shakeScale * 0.6 * s;

    let dist = this.dist;
    const left = this.punchUntil - performance.now();
    if (left > 0) {
      const e = Math.sin(Math.PI * (1 - left / this.punchMs)); // 0 → 1 → 0
      this.center.lerp(this.punchAt, 0.15 * e * Math.min(1, wallDt * 30));
      dist *= 1 - 0.15 * e;
    }
    this.tmp.copy(this.dir).multiplyScalar(dist).add(this.center);
    this.camera.position.set(this.tmp.x + sx, this.tmp.y + sy, this.tmp.z + sz);
    this.camera.lookAt(this.center);
    this.camera.rotation.z += Math.sin(this.t * 29) * 0.012 * s;
    // shift the principal point to the centre of the safe rect
    const cx = this.safe.left + (this.w - this.safe.left - this.safe.right) / 2;
    const cy = this.safe.top + (this.h - this.safe.top - this.safe.bottom) / 2;
    this.camera.setViewOffset(this.w, this.h, this.w / 2 - cx, this.h / 2 - cy, this.w, this.h);
  }
}

/** Side-on high-speed camera for the PiP inset (renders through a scissor viewport). */
export class HighSpeedCam {
  camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.3, 200);

  constructor() {
    this.camera.layers.enable(1); // sees the floodlight banks
  }

  /**
   * Low front-3/4 rig close to the lane, on the side that has no fixture between lens and car:
   * −z (far side, the crushed corner) for bare lanes, +z for sekisho lanes.
   */
  aim(focusX: number, laneZ: number, side: 1 | -1) {
    if (side < 0) {
      this.camera.position.set(focusX - 4.4, 1.45, laneZ - 3.3);
      this.camera.lookAt(focusX - 0.9, 0.75, laneZ);
    } else {
      // sekisho lane: further back and lower so the gate plaque stays above the frame
      this.camera.position.set(focusX - 8.5, 1.25, laneZ + 3.0);
      this.camera.lookAt(focusX - 2.4, 0.7, laneZ);
    }
  }
}
