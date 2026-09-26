import * as THREE from 'three';
import { el } from '../dom';

export interface MiniTrack {
  id: string;
  box: THREE.Box3;
  name: string;
  active: boolean;
  roadZ: number;
}
export interface MiniCar {
  x: number;
  z: number;
  color: string;
  crashed: boolean;
}

/** Top-down mini-map: every plot, cars as coloured dots, the camera's ground footprint. Click to glide there. */
export class MiniMap {
  el: HTMLElement;
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private bounds = new THREE.Box3();
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private ndc = new THREE.Vector2();

  constructor(onPick: (p: THREE.Vector3) => void) {
    this.c = el('canvas');
    this.c.width = 440;
    this.c.height = 300;
    this.g = this.c.getContext('2d')!;
    this.el = el('div', { class: 'minimap' }, this.c, el('div', { class: 'mm-hint', text: 'drag · scroll · WASD · click a car' }));
    this.c.addEventListener('click', (e) => {
      const r = this.c.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.c.width;
      const py = ((e.clientY - r.top) / r.height) * this.c.height;
      onPick(new THREE.Vector3((px - this.ox) / this.scale, 0, (py - this.oz) / this.scale));
    });
  }

  draw(tracks: MiniTrack[], cars: MiniCar[], camera: THREE.PerspectiveCamera) {
    const g = this.g;
    const W = this.c.width;
    const H = this.c.height;
    this.bounds.makeEmpty();
    for (const t of tracks) this.bounds.union(t.box);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-100, 0, -50), new THREE.Vector3(100, 0, 50));
    const pad = 16;
    const bw = this.bounds.max.x - this.bounds.min.x;
    const bd = this.bounds.max.z - this.bounds.min.z;
    this.scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bd);
    this.ox = W / 2 - ((this.bounds.min.x + this.bounds.max.x) / 2) * this.scale;
    this.oz = H / 2 - ((this.bounds.min.z + this.bounds.max.z) / 2) * this.scale;
    const X = (x: number) => this.ox + x * this.scale;
    const Z = (z: number) => this.oz + z * this.scale;

    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(13,14,17,0.82)';
    g.fillRect(0, 0, W, H);
    for (const t of tracks) {
      g.fillStyle = t.active ? 'rgba(245,196,0,0.28)' : 'rgba(242,239,232,0.12)';
      g.fillRect(X(t.box.min.x), Z(t.box.min.z), (t.box.max.x - t.box.min.x) * this.scale, (t.box.max.z - t.box.min.z) * this.scale);
      // road strip
      g.fillStyle = t.active ? 'rgba(245,196,0,0.9)' : 'rgba(242,239,232,0.5)';
      const zr = t.roadZ - 2.5;
      g.fillRect(X(t.box.min.x), Z(zr), (t.box.max.x - t.box.min.x) * this.scale, Math.max(2, 5 * this.scale));
      g.fillStyle = 'rgba(242,239,232,0.75)';
      g.font = '600 13px "JetBrains Mono", monospace';
      g.textBaseline = 'bottom';
      g.fillText(t.name.slice(0, 22), X(t.box.min.x) + 3, Z(zr) - 2);
    }
    // camera footprint
    const pts: THREE.Vector3[] = [];
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      this.ndc.set(x, y);
      this.ray.setFromCamera(this.ndc, camera);
      const p = this.ray.ray.intersectPlane(this.plane, this.hit);
      if (p && p.distanceTo(camera.position) < 900) pts.push(p.clone());
      else {
        const d = this.ray.ray.direction.clone();
        d.y = 0;
        d.normalize().multiplyScalar(700);
        pts.push(camera.position.clone().add(d));
      }
    }
    g.strokeStyle = '#f2efe8';
    g.lineWidth = 2;
    g.fillStyle = 'rgba(242,239,232,0.08)';
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))));
    g.closePath();
    g.fill();
    g.stroke();
    for (const c of cars) {
      g.fillStyle = c.color;
      g.beginPath();
      g.arc(X(c.x), Z(c.z), 6, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = c.crashed ? '#e2412b' : '#0d0e11';
      g.stroke();
    }
  }
}
