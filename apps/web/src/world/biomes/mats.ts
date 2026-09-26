import * as THREE from 'three';
import { PALETTE } from '../../types';

// Shared biome materials: one instance each for the whole world (animated ones share a single time uniform).

export const uTime = { value: 0 };
export const uFlash = { value: 0 }; // storm lightning flash 0..1

const fogPars = { vertex: '#include <fog_pars_vertex>', frag: '#include <fog_pars_fragment>' };

/** Lava: flowing crust cells over a white-hot core, emissive, fogged. */
export const lavaMat = new THREE.ShaderMaterial({
  fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]) as Record<string, THREE.IUniform>,
  vertexShader: `varying vec3 vW;
    ${fogPars.vertex}
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `uniform float uTime; varying vec3 vW;
    ${fogPars.frag}
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
    void main(){
      vec2 p = vW.xz * 0.16;
      float t = uTime * 0.12;
      float q = fbm(p + vec2(t, -t * 0.7));
      float r = fbm(p * 1.7 + q * 2.2 - vec2(t * 1.3, t * 0.4));
      float crust = smoothstep(0.42, 0.62, r);
      float pulse = 0.85 + 0.15 * sin(uTime * 2.1 + q * 9.0);
      vec3 hot = mix(vec3(1.0, 0.86, 0.35), vec3(1.0, 0.36, 0.06), smoothstep(0.2, 0.55, r));
      vec3 col = mix(hot * 2.2 * pulse, vec3(0.09, 0.04, 0.03), crust);
      col += vec3(0.9, 0.18, 0.02) * (1.0 - crust) * 0.4;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
});
lavaMat.uniforms.uTime = uTime;

/** River: flowing along z, streaks + foam at the banks, a little transparency. */
export const waterMat = new THREE.ShaderMaterial({
  fog: true,
  transparent: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]) as Record<string, THREE.IUniform>,
  vertexShader: `varying vec3 vW; varying vec2 vUv; uniform float uTime;
    ${fogPars.vertex}
    void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0);
      w.y += 0.08 * sin(w.z * 0.9 + uTime * 2.6) + 0.05 * sin(w.x * 1.7 + uTime * 1.9);
      vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `uniform float uTime; varying vec3 vW; varying vec2 vUv;
    ${fogPars.frag}
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
    void main(){
      vec2 p = vec2(vW.x * 0.9, vW.z * 0.25 - uTime * 1.6);
      float s = n(p * 1.3) * 0.6 + n(p * 3.1 + 7.0) * 0.4;
      float streak = smoothstep(0.62, 0.8, s);
      float edge = smoothstep(0.32, 0.5, abs(vUv.x - 0.5));
      vec3 deep = vec3(0.08, 0.27, 0.33);
      vec3 shallow = vec3(0.22, 0.52, 0.55);
      vec3 col = mix(deep, shallow, s * 0.7);
      col = mix(col, vec3(0.92, 0.95, 0.93), max(streak * 0.55, edge * (0.5 + 0.5 * n(p * 4.0))));
      gl_FragColor = vec4(col, 0.9);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
});
waterMat.uniforms.uTime = uTime;

/** Calm lake in the lowland. */
export const lakeMat = new THREE.MeshStandardMaterial({ color: 0x4f7f8a, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.92 });

/** Rising particles (rain falls, embers rise) as GPU-animated points; one draw call per emitter. */
function particleMat(opts: { color: THREE.ColorRepresentation; size: number; speed: number; height: number; additive?: boolean; streak?: boolean; opacity?: number }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uTime, uColor: { value: new THREE.Color(opts.color) }, uSize: { value: opts.size }, uSpeed: { value: opts.speed }, uH: { value: opts.height }, uOp: { value: opts.opacity ?? 1 } },
    vertexShader: `uniform float uTime; uniform float uSize; uniform float uSpeed; uniform float uH; attribute float seed; varying float vA;
      void main(){ vec3 p = position; float ph = fract(seed + uTime * uSpeed / uH);
        p.y = ${opts.speed > 0 ? 'ph * uH' : '(1.0 - ph) * uH'};
        p.x += sin(uTime * 1.3 + seed * 40.0) * ${opts.speed > 0 ? '0.6' : '0.05'} * ph;
        vA = ${opts.speed > 0 ? '(1.0 - ph) * smoothstep(0.0, 0.1, ph)' : '1.0'};
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uSize * 300.0 / -mv.z; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOp; varying float vA;
      void main(){ vec2 c = gl_PointCoord - 0.5; ${opts.streak ? 'float a = smoothstep(0.08, 0.0, abs(c.x)) * (1.0 - abs(c.y) * 1.6);' : 'float a = smoothstep(0.5, 0.15, length(c));'}
        if (a < 0.02) discard; gl_FragColor = vec4(uColor, a * vA * uOp); }`,
  });
}
export const rainMat = particleMat({ color: 0xd6e0ea, size: 3.4, speed: -30, height: 30, streak: true, opacity: 0.7 });
export const emberMat = particleMat({ color: 0xff7a22, size: 0.45, speed: 2.4, height: 16, additive: true });

export function particleGeo(n: number, w: number, d: number, seed = 1) {
  const pos = new Float32Array(n * 3);
  const sd = new Float32Array(n);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rnd() - 0.5) * w;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = (rnd() - 0.5) * d;
    sd[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(sd, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), Math.max(w, d));
  return g;
}

export const M = {
  terrain: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.96, metalness: 0 }),
  rock: new THREE.MeshStandardMaterial({ vertexColors: false, flatShading: true, roughness: 0.9, color: 0xffffff }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8f9298, roughness: 0.45, metalness: 0.6 }),
  rail: new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.35, metalness: 0.7 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.8 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xb9b2a3, roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.9, flatShading: true }),
  rotten: new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 1, flatShading: true }),
  yellow: new THREE.MeshStandardMaterial({ color: PALETTE.yellow, roughness: 0.55 }),
  vermilion: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, roughness: 0.55 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xe8b53a, roughness: 0.3, metalness: 0.8, emissive: 0xffa31a, emissiveIntensity: 0.35 }),
  cloud: new THREE.MeshStandardMaterial({ color: 0x59606b, roughness: 1, flatShading: true, emissive: 0xdfe6ff, emissiveIntensity: 0, transparent: true, opacity: 0.78, depthWrite: false }),
  morse: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, emissive: PALETTE.vermilion, emissiveIntensity: 3 }),
  bolt: new THREE.MeshBasicMaterial({ color: 0xeef2ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  glowOrange: new THREE.SpriteMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
  shimmer: new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  snow: new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.8, flatShading: true }),
};
