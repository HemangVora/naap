import * as THREE from 'three';
import { PALETTE } from '../../types';

// Canvas textures for the biome signage (drawn once, cached).

const cache = new Map<string, THREE.CanvasTexture>();
function make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  let t = cache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}
const font = (px: number, w = 800) => `${w} ${px}px "Inter", "Helvetica Neue", Arial, sans-serif`;

/** Amber price board: "$40 > $5 cap". */
export function priceBoardTexture(amount: number) {
  const amt = `$${amount % 1 ? amount.toFixed(2) : amount}`;
  return make(`price:${amt}`, 1024, 512, (g) => {
    g.fillStyle = '#16120a';
    g.fillRect(0, 0, 1024, 512);
    g.strokeStyle = PALETTE.amber;
    g.lineWidth = 18;
    g.strokeRect(14, 14, 996, 484);
    g.fillStyle = PALETTE.amber;
    g.font = font(54, 800);
    g.textAlign = 'center';
    g.fillText(`${amt.slice(1)} h GPU BLOCK · OVER YOUR CAP`, 512, 104);
    g.font = font(230, 900);
    g.fillText(`${amt} > $5`, 512, 330);
    g.font = font(56, 700);
    g.fillStyle = '#f2efe8';
    g.fillText('compute.naap.eth · owner approval', 512, 440);
  });
}

/** Glowing "PRIZE" vault face. */
export function prizeTexture() {
  return make('prize', 512, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#fff3b0');
    grd.addColorStop(1, '#ffb020');
    g.fillStyle = '#2a1605';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = grd;
    g.font = font(150, 900);
    g.textAlign = 'center';
    g.fillText('PRIZE', 256, 170);
    g.font = font(34, 700);
    g.fillStyle = '#ffd36b';
    g.fillText('receive it → call pay()', 256, 226);
  });
}

/** Green ENS road sign for the real bridge. */
export function bridgeSignTexture() {
  return make('bridge', 1024, 256, (g) => {
    g.fillStyle = '#0f6b45';
    g.fillRect(0, 0, 1024, 256);
    g.strokeStyle = '#f2efe8';
    g.lineWidth = 10;
    g.strokeRect(16, 16, 992, 224);
    g.fillStyle = '#f2efe8';
    g.font = font(104, 800);
    g.textAlign = 'left';
    g.fillText('compute.naap.eth', 60, 142);
    g.font = font(44, 700);
    g.fillStyle = PALETTE.green;
    g.fillText('✓ ENS-resolved · GPU inference · real bridge', 62, 214);
  });
}

/** The swapped detour sign: a 402 shield pointing at the broken bridge. */
export function detourTexture() {
  return make('detour', 512, 512, (g) => {
    g.fillStyle = PALETTE.amber;
    g.beginPath();
    g.moveTo(256, 20);
    g.lineTo(492, 256);
    g.lineTo(256, 492);
    g.lineTo(20, 256);
    g.closePath();
    g.fill();
    g.lineWidth = 14;
    g.strokeStyle = '#16120a';
    g.stroke();
    g.fillStyle = '#16120a';
    g.textAlign = 'center';
    g.font = font(58, 900);
    g.fillText('DETOUR', 256, 180);
    g.font = font(120, 900);
    g.fillText('402', 256, 300);
    g.font = font(44, 800);
    g.fillText('← pay 0x7a…e1', 256, 372);
  });
}

/** Chevrons for the prize ramp. */
export function chevronTexture() {
  const t = make('chev', 256, 64, (g) => {
    g.fillStyle = PALETTE.yellow;
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#16120a';
    for (let x = -64; x < 256; x += 64) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 28, 0);
      g.lineTo(x + 60, 32);
      g.lineTo(x + 28, 64);
      g.lineTo(x, 64);
      g.lineTo(x + 32, 32);
      g.closePath();
      g.fill();
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Soft radial glow. */
export function glowTex() {
  return make('glow', 128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  });
}
