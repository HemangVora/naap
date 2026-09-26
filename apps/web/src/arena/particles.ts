import * as THREE from 'three';
import { smokeTexture } from './textures';

/** Pooled sprites for tyre smoke / dust: each puff rises, grows and fades. */
export class SmokePool {
  private sprites: THREE.Sprite[] = [];
  private life: Float32Array;
  private ttl: Float32Array;
  private vel: Float32Array;
  private grow: Float32Array;
  private next = 0;
  private mat: THREE.SpriteMaterial;

  constructor(scene: THREE.Scene, public count = 64) {
    this.mat = new THREE.SpriteMaterial({ map: smokeTexture(), color: 0xf3f3f0, transparent: true, opacity: 0.55, depthWrite: false });
    this.life = new Float32Array(count);
    this.ttl = new Float32Array(count).fill(1);
    this.vel = new Float32Array(count * 3);
    this.grow = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(this.mat.clone());
      s.visible = false;
      s.renderOrder = 5;
      scene.add(s);
      this.sprites.push(s);
    }
  }

  puff(at: THREE.Vector3, opts: { size?: number; up?: number; ttl?: number; drift?: number } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    const s = this.sprites[i];
    s.visible = true;
    s.position.set(at.x + (Math.random() - 0.5) * 0.3, at.y, at.z + (Math.random() - 0.5) * 0.3);
    const size = opts.size ?? 0.5;
    s.scale.set(size, size, 1);
    this.grow[i] = size * 2.2;
    this.ttl[i] = this.life[i] = opts.ttl ?? 0.9;
    const o = i * 3;
    this.vel[o] = (opts.drift ?? -1.2) + (Math.random() - 0.5) * 0.6;
    this.vel[o + 1] = opts.up ?? 0.9;
    this.vel[o + 2] = (Math.random() - 0.5) * 0.8;
  }

  update(dt: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const s = this.sprites[i];
      if (this.life[i] <= 0) {
        s.visible = false;
        continue;
      }
      const o = i * 3;
      s.position.x += this.vel[o] * dt;
      s.position.y += this.vel[o + 1] * dt;
      s.position.z += this.vel[o + 2] * dt;
      const f = this.life[i] / this.ttl[i];
      const sc = s.scale.x + this.grow[i] * dt;
      s.scale.set(sc, sc, 1);
      (s.material as THREE.SpriteMaterial).opacity = 0.5 * f;
    }
  }
}
