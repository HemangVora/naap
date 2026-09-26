import * as THREE from 'three';
import { PALETTE } from '../types';
import { DISPLAY, MONO } from '../arena/textures';

export function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

export function tex(c: HTMLCanvasElement, repeat?: [number, number]) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, n: number, light: number, dark: number, size = 2) {
  for (let i = 0; i < n; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${Math.random() * light})` : `rgba(0,0,0,${Math.random() * dark})`;
    g.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

let _asphalt: THREE.CanvasTexture | null = null;
/** Fine-grain asphalt, one tile ≈ 8 m. */
export function asphaltTexture() {
  if (_asphalt) return _asphalt;
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, 512, 512);
  noise(g, 512, 512, 26000, 0.1, 0.16, 2);
  g.strokeStyle = 'rgba(20,20,22,0.25)';
  g.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    const y = Math.random() * 512;
    g.moveTo(0, y);
    g.bezierCurveTo(170, y + 30, 340, y - 30, 512, y + 8);
    g.stroke();
  }
  _asphalt = tex(c, [1, 1]);
  return _asphalt;
}

export function concreteTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#c9c5bb';
  g.fillRect(0, 0, 512, 512);
  noise(g, 512, 512, 16000, 0.08, 0.06, 2);
  // expansion joints: slabs of 6 m (tile = 12 m)
  g.fillStyle = 'rgba(60,58,52,0.22)';
  g.fillRect(0, 0, 512, 3);
  g.fillRect(0, 255, 512, 3);
  g.fillRect(0, 0, 3, 512);
  g.fillRect(255, 0, 3, 512);
  for (let i = 0; i < 10; i++) {
    g.fillStyle = `rgba(90,80,60,${Math.random() * 0.05})`;
    g.beginPath();
    g.ellipse(Math.random() * 512, Math.random() * 512, 30 + Math.random() * 60, 20 + Math.random() * 40, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, [1, 1]);
}

export function grassTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#7d8f55';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5 ? `rgba(200,210,140,${Math.random() * 0.18})` : `rgba(40,55,20,${Math.random() * 0.2})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 2 + Math.random() * 3);
  }
  return tex(c, [1, 1]);
}

/** Vermilion / off-white kerb blocks, one tile = 2 blocks. */
export function kerbTexture() {
  const [c, g] = canvas(128, 32);
  g.fillStyle = PALETTE.vermilion;
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#f2efe8';
  g.fillRect(64, 0, 64, 32);
  return tex(c, [1, 1]);
}

/** Dashed centre line between two lanes (tile = 6 m: 3 m paint, 3 m gap). */
export function dashTexture() {
  const [c, g] = canvas(64, 8);
  g.clearRect(0, 0, 64, 8);
  g.fillStyle = '#f2efe8';
  g.fillRect(0, 0, 32, 8);
  return tex(c, [1, 1]);
}

/** Track name painted on the run-up, read from above (text runs along +x, viewed from +z). */
export function roadNameTexture(name: string, author: string) {
  const [c, g] = canvas(1024, 320);
  g.clearRect(0, 0, 1024, 320);
  g.fillStyle = 'rgba(242,239,232,0.92)';
  g.font = `800 150px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 150;
  while (g.measureText(name.toUpperCase()).width > 980 && size > 60) {
    size -= 8;
    g.font = `800 ${size}px ${DISPLAY}`;
  }
  g.fillText(name.toUpperCase(), 512, 120);
  g.fillStyle = 'rgba(245,196,0,0.95)';
  g.font = `700 64px ${DISPLAY}`;
  g.fillText(`by ${author}`, 512, 250);
  return tex(c);
}

/** Gantry panel: "<name> · by <author>" with the obstacle count. */
export function gantryTexture(name: string, author: string, n: number, isDefault: boolean) {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = '#15161a';
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = isDefault ? PALETTE.yellow : PALETTE.vermilion;
  g.fillRect(0, 0, 1024, 14);
  g.fillRect(0, 242, 1024, 14);
  g.fillStyle = '#f2efe8';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  let size = 110;
  g.font = `800 ${size}px ${DISPLAY}`;
  const title = name.toUpperCase();
  while (g.measureText(title).width > 940 && size > 50) {
    size -= 6;
    g.font = `800 ${size}px ${DISPLAY}`;
  }
  g.fillText(title, 40, 104);
  g.fillStyle = PALETTE.yellow;
  g.font = `600 44px ${DISPLAY}`;
  g.fillText(`by ${author}`, 42, 190);
  g.fillStyle = '#9a9890';
  g.font = `500 28px ${MONO}`;
  g.textAlign = 'right';
  g.fillText(`${n} obstacle${n === 1 ? '' : 's'} · bare vs sekisho`, 990, 192);
  return tex(c);
}

/** "fooled 3/5" counter floating over an obstacle. */
export function drawCounter(c: HTMLCanvasElement, label: string, fooled: number, attempts: number) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const r = 18;
  g.fillStyle = 'rgba(13,14,17,0.86)';
  g.beginPath();
  g.roundRect(4, 4, W - 8, H - 8, r);
  g.fill();
  const bad = attempts > 0 && fooled / attempts >= 0.5;
  g.fillStyle = attempts === 0 ? '#9a9890' : bad ? PALETTE.vermilion : PALETTE.green;
  g.fillRect(4, H - 14, (W - 8) * (attempts ? fooled / attempts : 0), 10);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#9a9890';
  g.font = `600 30px ${MONO}`;
  g.fillText(label.toUpperCase(), W / 2, 36);
  g.fillStyle = '#f2efe8';
  g.font = `800 64px ${DISPLAY}`;
  g.fillText(attempts ? `fooled ${fooled}/${attempts}` : 'untested', W / 2, 92);
}

/** Morse billboard screen: header + dot/dash rows; `phase` scrolls the code. */
export function drawMorse(c: HTMLCanvasElement, phase: number) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  g.fillStyle = '#0b0c0f';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d1f25';
  g.fillRect(0, 0, W, 64);
  g.fillStyle = '#f2efe8';
  g.font = `700 36px ${DISPLAY}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText('@drb_whale · replying to you', 22, 33);
  g.fillStyle = PALETTE.vermilion;
  g.beginPath();
  g.arc(W - 30, 33, 10, 0, Math.PI * 2);
  g.fill();
  const code = '-.. .-. .- .. -. / .- .-.. .-.. / - --- / --... .- ...-- -.-. / ... . -. -.. / -. --- .-- / ';
  const unit = 18;
  for (let row = 0; row < 3; row++) {
    let x = 22 - ((phase * 60 + row * 140) % (code.length * unit));
    const y = 112 + row * 52;
    for (let rep = 0; rep < 3; rep++)
      for (const ch of code) {
        if (x > W) break;
        if (ch === '.') {
          g.fillStyle = PALETTE.amber;
          g.beginPath();
          g.arc(x + 5, y, 6, 0, Math.PI * 2);
          g.fill();
          x += unit;
        } else if (ch === '-') {
          g.fillStyle = PALETTE.amber;
          g.fillRect(x, y - 5, 28, 10);
          x += unit + 16;
        } else x += unit;
      }
  }
}

export function inboxTexture() {
  const [c, g] = canvas(256, 512);
  g.fillStyle = '#f2efe8';
  g.fillRect(0, 0, 256, 512);
  g.fillStyle = PALETTE.charcoal;
  g.fillRect(0, 0, 256, 70);
  g.fillStyle = '#f2efe8';
  g.font = `800 46px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('INBOX', 128, 38);
  // mail slots
  for (let i = 0; i < 5; i++) {
    g.fillStyle = '#d6d1c4';
    g.fillRect(24, 96 + i * 62, 208, 46);
    g.fillStyle = '#2a2c31';
    g.fillRect(40, 116 + i * 62, 176, 8);
  }
  // envelope with prize
  g.fillStyle = PALETTE.vermilion;
  g.fillRect(34, 410, 188, 80);
  g.strokeStyle = '#f2efe8';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(34, 410);
  g.lineTo(128, 460);
  g.lineTo(222, 410);
  g.stroke();
  return tex(c);
}

export function x402SignTexture() {
  const [c, g] = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  // square sign panel
  g.fillStyle = '#f2efe8';
  g.beginPath();
  g.roundRect(16, 150, 480, 340, 26);
  g.fill();
  g.strokeStyle = PALETTE.charcoal;
  g.lineWidth = 12;
  g.stroke();
  // original arrow (faded) points right → payee
  g.strokeStyle = 'rgba(13,14,17,0.18)';
  g.lineWidth = 34;
  g.beginPath();
  g.moveTo(90, 260);
  g.lineTo(400, 260);
  g.stroke();
  g.fillStyle = 'rgba(13,14,17,0.18)';
  g.beginPath();
  g.moveTo(440, 260);
  g.lineTo(380, 210);
  g.lineTo(380, 310);
  g.fill();
  // swapped arrow in vermilion, bent away
  g.strokeStyle = PALETTE.vermilion;
  g.lineWidth = 38;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(420, 400);
  g.lineTo(220, 400);
  g.lineTo(140, 330);
  g.stroke();
  g.fillStyle = PALETTE.vermilion;
  g.beginPath();
  g.moveTo(100, 294);
  g.lineTo(180, 300);
  g.lineTo(120, 370);
  g.fill();
  // 402 shield
  g.fillStyle = PALETTE.amber;
  g.strokeStyle = PALETTE.charcoal;
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(256, 8);
  g.lineTo(356, 30);
  g.lineTo(350, 110);
  g.quadraticCurveTo(330, 150, 256, 176);
  g.quadraticCurveTo(182, 150, 162, 110);
  g.lineTo(156, 30);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = PALETTE.charcoal;
  g.font = `800 76px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('402', 256, 90);
  g.font = `700 30px ${MONO}`;
  g.fillStyle = PALETTE.charcoal;
  g.fillText('payTo 0x7a…e1', 256, 460);
  return tex(c);
}

export function kioskTexture(price: string, sub: string, amber: boolean) {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#0b0c0f';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = amber ? PALETTE.amber : PALETTE.green;
  g.font = `800 96px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(price, 128, 96);
  g.fillStyle = '#f2efe8';
  g.font = `600 26px ${MONO}`;
  g.fillText(sub, 128, 180);
  g.fillStyle = amber ? PALETTE.amber : PALETTE.green;
  g.fillRect(0, 236, 256, 20);
  return tex(c);
}
