import * as THREE from 'three';
import { concreteTexture, grassTexture } from './tex';
import { VALLEY_Y } from './biomes/geo';

export const HAZE = new THREE.Color('#e6dccb');

/** Outdoor proving ground: warm late-afternoon sun, sky dome with horizon haze, grass fields, a concrete apron, light poles, grandstand. */
export function buildEnvironment(scene: THREE.Scene) {
  scene.background = HAZE.clone();
  scene.fog = new THREE.Fog(HAZE, 380, 1500);

  // sky dome: warm haze at the horizon → pale blue overhead
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1800, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color('#8fb3cf') }, mid: { value: new THREE.Color('#cfd8d8') }, bottom: { value: HAZE.clone() }, sun: { value: new THREE.Vector3(0.62, 0.3, 0.72).normalize() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sun; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 c = mix(bottom, mid, smoothstep(0.0, 0.12, h)); c = mix(c, top, smoothstep(0.12, 0.7, h));
        float s = max(0.0, dot(normalize(vDir), sun)); c += vec3(1.0,0.78,0.5) * (pow(s, 64.0) * 0.9 + pow(s, 6.0) * 0.18);
        c = mix(c, vec3(1.0, 0.95, 0.82) * 1.6, smoothstep(0.99955, 0.9998, s));
        gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x6b6a4e, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
  sun.position.set(120, 70, 140);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  const sc = sun.shadow.camera;
  sc.near = 10;
  sc.far = 600;
  sc.left = sc.bottom = -90;
  sc.right = sc.top = 90;
  scene.add(sun, sun.target);

  // grass everywhere, then a concrete apron under the plots (resized as tracks are added)
  const grassTex = grassTexture();
  grassTex.repeat.set(400, 400);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, color: 0xb9c29a }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = VALLEY_Y; // v4: the plots stand on mesas; the lowland lies below
  grass.receiveShadow = true;
  scene.add(grass);

  const apronTex = concreteTexture();
  apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping;
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.9 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = 0;
  apron.receiveShadow = true;
  apron.visible = false; // v4: the per-plot terrain replaces the concrete apron

  // horizon: a ring of low-poly mountains with snow caps (unfogged, pre-hazed), and a lake in the lowland
  {
    const N = 56;
    const base = new THREE.ConeGeometry(1, 1, 7, 1);
    base.translate(0, 0.5, 0);
    const cap = new THREE.ConeGeometry(0.34, 0.34, 7, 1);
    cap.translate(0, 1 - 0.17 + 0.004, 0);
    const rockM = new THREE.MeshStandardMaterial({ color: 0x8793a0, flatShading: true, roughness: 1, fog: false });
    const snowM = new THREE.MeshStandardMaterial({ color: 0xf3f5f7, flatShading: true, roughness: 0.9, fog: false });
    const ring = new THREE.InstancedMesh(base, rockM, N * 2);
    const caps = new THREE.InstancedMesh(cap, snowM, N * 2);
    const tint = new THREE.Color();
    const mm = new THREE.Matrix4();
    let k = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let layer = 0; layer < 2; layer++)
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + rnd() * 0.08 + layer * 0.05;
        const r = (layer ? 1350 : 1080) + rnd() * 160;
        const h = (layer ? 300 : 170) + rnd() * (layer ? 260 : 170);
        const w = h * (0.9 + rnd() * 0.6);
        mm.compose(new THREE.Vector3(Math.cos(a) * r, VALLEY_Y - 4, Math.sin(a) * r), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 6, 0)), new THREE.Vector3(w, h, w * (0.8 + rnd() * 0.4)));
        ring.setMatrixAt(k, mm);
        caps.setMatrixAt(k, mm);
        // aerial perspective: the far layer fades toward the haze
        ring.setColorAt(k, tint.set(layer ? 0xa9b3ba : 0x7f8b96).lerp(HAZE, layer ? 0.35 : 0.12));
        caps.setColorAt(k, tint.set(0xf3f5f7).lerp(HAZE, layer ? 0.25 : 0.05));
        k++;
      }
    ring.frustumCulled = caps.frustumCulled = false;
    scene.add(ring, caps);

    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshStandardMaterial({ color: 0x5e8f99, roughness: 0.12, metalness: 0.3 }));
    lake.rotation.x = -Math.PI / 2;
    lake.scale.set(170, 110, 1);
    lake.position.set(-360, VALLEY_Y + 0.3, 170);
    lake.receiveShadow = true;
    scene.add(lake);
    const shore = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 40), new THREE.MeshStandardMaterial({ color: 0xcbb994, roughness: 1 }));
    shore.rotation.x = -Math.PI / 2;
    shore.scale.copy(lake.scale);
    shore.position.set(-360, VALLEY_Y + 0.25, 170);
    scene.add(shore);
  }

  // light poles: instanced mast + head, placed along the far side of every road
  const poleGeo = new THREE.CylinderGeometry(0.16, 0.24, 14, 8);
  poleGeo.translate(0, 7, 0);
  const headGeo = new THREE.BoxGeometry(2.2, 0.35, 0.8);
  headGeo.translate(0.8, 14, 0);
  const MAXP = 400;
  const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x8f9298, roughness: 0.5, metalness: 0.6 }), MAXP);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0x2a2c31, emissive: 0xfff2cc, emissiveIntensity: 0.25 }), MAXP);
  poles.castShadow = true;
  poles.count = heads.count = 0;
  scene.add(poles, heads);
  const m4 = new THREE.Matrix4();
  const addPole = (x: number, z: number, rotY = 0) => {
    if (poles.count >= MAXP) return;
    m4.makeRotationY(rotY).setPosition(x, 0, z);
    poles.setMatrixAt(poles.count, m4);
    heads.setMatrixAt(heads.count, m4);
    poles.count++;
    heads.count++;
    poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  };

  // grandstand (bleachers + canopy + crowd), re-placed at the near edge of the apron
  const stand = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 0.85 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.8 });
  const W = 70;
  for (let i = 0; i < 7; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(W, 0.9 + i * 0.9, 1.8), i % 2 ? standMat : seatMat);
    step.position.set(0, (0.9 + i * 0.9) / 2, i * 1.8);
    step.castShadow = step.receiveShadow = true;
    stand.add(step);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 4, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.6 }));
  roof.position.set(0, 12.5, 6);
  roof.rotation.x = 0.12;
  roof.castShadow = true;
  stand.add(roof);
  for (const x of [-W / 2, -W / 6, W / 6, W / 2]) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 13, 0.5), new THREE.MeshStandardMaterial({ color: 0x5d6068 }));
    col.position.set(x, 6.5, 12.5);
    stand.add(col);
  }
  const crowdN = 380;
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.8, 0.45), new THREE.MeshStandardMaterial({ roughness: 0.9 }), crowdN);
  const palette = ['#f2efe8', '#e2412b', '#f5c400', '#3ddc97', '#2a2c31', '#6fb3ff', '#ffb020', '#c9c5bb'].map((c) => new THREE.Color(c));
  for (let i = 0; i < crowdN; i++) {
    const row = Math.floor(Math.random() * 7);
    m4.makeTranslation((Math.random() - 0.5) * (W - 2), 0.9 + row * 0.9 + 0.4, row * 1.8 + (Math.random() - 0.5) * 0.4);
    crowd.setMatrixAt(i, m4);
    crowd.setColorAt(i, palette[i % palette.length]);
  }
  stand.add(crowd);
  // v4: the grandstand sits on a terrace that rises out of the lowland
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 8, -VALLEY_Y, 22), new THREE.MeshStandardMaterial({ color: 0x9c9a90, roughness: 1, flatShading: true }));
  plinth.position.set(0, VALLEY_Y / 2 - 0.02, 7);
  plinth.receiveShadow = true;
  stand.add(plinth);
  stand.rotation.y = Math.PI; // on the far edge, facing +z (the tracks and the default camera)
  scene.add(stand);

  const apronBox = new THREE.Box3();
  /** Resize the apron + move the grandstand to fit every plot. */
  function fit(box: THREE.Box3) {
    apronBox.copy(box).expandByVector(new THREE.Vector3(30, 0, 24));
    const w = apronBox.max.x - apronBox.min.x;
    const d = apronBox.max.z - apronBox.min.z;
    apron.scale.set(w, d, 1);
    apron.position.set((apronBox.min.x + apronBox.max.x) / 2, 0, (apronBox.min.z + apronBox.max.z) / 2);
    apronTex.repeat.set(w / 12, d / 12);
    stand.position.set((apronBox.min.x + apronBox.max.x) / 2, 0, apronBox.min.z - 4);
  }

  return { sun, hemi, addPole, fit, sky };
}
