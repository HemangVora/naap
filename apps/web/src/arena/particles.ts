import * as THREE from 'three';

/** Instanced particle pool (sparks / debris). One draw call per pool. */
export class ParticlePool {
  mesh: THREE.InstancedMesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private rot: Float32Array;
  private life: Float32Array;
  private ttl: Float32Array;
  private size: Float32Array;
  private next = 0;
  private dummy = new THREE.Object3D();
  private gravity: number;
  private bounce: number;

  constructor(
    scene: THREE.Scene,
    public count: number,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    opts: { gravity?: number; bounce?: number } = {},
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.rot = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.ttl = new Float32Array(count).fill(1);
    this.size = new Float32Array(count);
    this.gravity = opts.gravity ?? -22;
    this.bounce = opts.bounce ?? 0.35;
    this.dummy.scale.setScalar(0);
    for (let i = 0; i < count; i++) {
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    scene.add(this.mesh);
  }

  burst(at: THREE.Vector3, n: number, opts: { speed: number; spread: number; up?: number; ttl?: [number, number]; size?: [number, number]; dir?: THREE.Vector3 }) {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      const o = i * 3;
      this.pos[o] = at.x + (Math.random() - 0.5) * 0.4;
      this.pos[o + 1] = at.y + (Math.random() - 0.5) * 0.5;
      this.pos[o + 2] = at.z + (Math.random() - 0.5) * 0.8;
      const sp = opts.speed * (0.4 + Math.random());
      const dx = (opts.dir?.x ?? 0) + (Math.random() - 0.5) * opts.spread;
      const dy = (opts.up ?? 0.8) + Math.random() * opts.spread;
      const dz = (opts.dir?.z ?? 0) + (Math.random() - 0.5) * opts.spread;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.vel[o] = (dx / len) * sp;
      this.vel[o + 1] = (dy / len) * sp;
      this.vel[o + 2] = (dz / len) * sp;
      this.rot[o] = Math.random() * 6;
      this.rot[o + 1] = Math.random() * 6;
      this.rot[o + 2] = Math.random() * 6;
      const [t0, t1] = opts.ttl ?? [0.4, 1.0];
      this.ttl[i] = t0 + Math.random() * (t1 - t0);
      this.life[i] = this.ttl[i];
      const [s0, s1] = opts.size ?? [0.6, 1.4];
      this.size[i] = s0 + Math.random() * (s1 - s0);
    }
  }

  update(dt: number) {
    if (dt <= 0) return;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const o = i * 3;
      this.life[i] -= dt;
      this.vel[o + 1] += this.gravity * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < 0.04) {
        this.pos[o + 1] = 0.04;
        this.vel[o + 1] *= -this.bounce;
        this.vel[o] *= 0.7;
        this.vel[o + 2] *= 0.7;
      }
      const f = Math.max(0, this.life[i] / this.ttl[i]);
      this.dummy.position.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      this.dummy.rotation.set(this.rot[o] + this.life[i] * 6, this.rot[o + 1], this.rot[o + 2] + this.life[i] * 4);
      this.dummy.scale.setScalar(this.life[i] <= 0 ? 0 : this.size[i] * (0.3 + 0.7 * f));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export function makePools(scene: THREE.Scene) {
  const sparks = new ParticlePool(
    scene,
    500,
    new THREE.BoxGeometry(0.07, 0.07, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xffd36b, toneMapped: false }),
    { gravity: -14, bounce: 0.2 },
  );
  const debris = new ParticlePool(
    scene,
    120,
    new THREE.BoxGeometry(0.22, 0.14, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.9 }),
    { gravity: -24, bounce: 0.3 },
  );
  const glass = new ParticlePool(
    scene,
    120,
    new THREE.BoxGeometry(0.12, 0.02, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.85, toneMapped: false }),
    { gravity: -20, bounce: 0.1 },
  );
  return {
    sparks,
    debris,
    glass,
    update(dt: number) {
      sparks.update(dt);
      debris.update(dt);
      glass.update(dt);
    },
    crash(at: THREE.Vector3) {
      sparks.burst(at, 140, { speed: 9, spread: 1.6, up: 1.2, ttl: [0.35, 0.9], dir: new THREE.Vector3(-1, 0, 0) });
      debris.burst(at, 34, { speed: 6, spread: 1.4, up: 1.4, ttl: [0.9, 1.8], size: [0.5, 1.4], dir: new THREE.Vector3(-0.8, 0, 0) });
      glass.burst(at, 40, { speed: 5, spread: 1.6, up: 1.0, ttl: [0.6, 1.3], dir: new THREE.Vector3(-0.6, 0, 0) });
    },
    puff(at: THREE.Vector3) {
      sparks.burst(at, 18, { speed: 3, spread: 1.4, up: 1.4, ttl: [0.3, 0.6], size: [0.4, 0.8] });
    },
  };
}
