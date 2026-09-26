import * as THREE from 'three';

/** Cinematic 3/4 rig: slow dolly with the leading car, 1.2 s crash close-up, trauma shake. */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  /** where the dolly wants to be (x along track, z lane centre) */
  focus = new THREE.Vector3(0, 0, 4);
  private smoothed = new THREE.Vector3(-10, 0, 4);
  private closeUp: { at: THREE.Vector3; until: number } | null = null;
  private trauma = 0;
  private t = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private curPos = new THREE.Vector3(-30, 14, -24);
  private curLook = new THREE.Vector3(0, 0, 4);
  private offset = new THREE.Vector3(-12, 9.5, -19);
  private lookOffset = new THREE.Vector3(6, 0.6, 1);

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.5, 400);
    this.camera.position.copy(this.curPos);
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  crashCloseUp(at: THREE.Vector3, ms = 1200) {
    this.closeUp = { at: at.clone(), until: performance.now() + ms };
  }

  update(dt: number, wallDt: number) {
    this.t += wallDt;
    // dolly follows focus slowly
    this.smoothed.lerp(this.focus, 1 - Math.exp(-dt * 1.6));

    const now = performance.now();
    if (this.closeUp && now > this.closeUp.until) this.closeUp = null;

    if (this.closeUp) {
      const a = this.closeUp.at;
      // high near-side angle: looks over the neighbouring lane, nothing occludes the wreck
      this.pos.set(a.x - 7.5, 8, a.z - 6);
      this.look.set(a.x + 0.6, 0.4, a.z);
      // hard cut in, then a slow push
      const k = 1 - Math.exp(-wallDt * 14);
      this.curPos.lerp(this.pos, k);
      this.curLook.lerp(this.look, k);
      this.curPos.x += wallDt * 0.6;
    } else {
      this.pos.copy(this.smoothed).add(this.offset);
      this.look.copy(this.smoothed).add(this.lookOffset);
      const k = 1 - Math.exp(-wallDt * 2.2);
      this.curPos.lerp(this.pos, k);
      this.curLook.lerp(this.look, k);
    }

    // trauma shake: smooth sin-sampled, quadratic falloff
    this.trauma = Math.max(0, this.trauma - wallDt * 1.5);
    const s = this.trauma * this.trauma;
    const sx = Math.sin(this.t * 41) * 0.55 * s;
    const sy = Math.sin(this.t * 53 + 1.3) * 0.4 * s;
    const sz = Math.sin(this.t * 37 + 2.1) * 0.35 * s;

    this.camera.position.set(this.curPos.x + sx, this.curPos.y + sy, this.curPos.z + sz);
    this.camera.lookAt(this.curLook);
    this.camera.rotation.z += Math.sin(this.t * 29) * 0.03 * s;
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
