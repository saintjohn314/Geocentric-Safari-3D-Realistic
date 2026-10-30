// The 3D model: a map disc ringed by an ice wall, under a glass firmament dome,
// with the sun, moon and stars hanging above their real sub-points.
import * as THREE from '../vendor/three-0.185.1/three.module.min.js';
import { OrbitControls } from '../vendor/three-0.185.1/addons/controls/OrbitControls.js';
import { RoomEnvironment } from '../vendor/three-0.185.1/addons/environments/RoomEnvironment.js';
import { DISC_R, lonLatToLocal, lonLatToUV, uvToLonLat } from './geo.js';
import { STARS, LINES } from './astro.js';

const R = DISC_R;
const DOME_R = R * 1.05;
const DOME_H = 6.8;
const SUN_H = 3.4;
const MOON_H = 3.0;
const BASE_Y = -1.15;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glowTexture(inner, outer, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Reads the WebGL renderer name so we can spot software rendering (no GPU acceleration),
// where every pixel is drawn by the CPU and the full-detail scene would grind the machine.
export function detectGPU() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { webgl: false, software: false, name: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { webgl: true, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name), name };
  } catch {
    return { webgl: false, software: false, name: '' };
  }
}

// GPU textures are allocated at a fixed size, so a different-sized image needs a fresh upload.
function swapImage(texture, image) {
  if (texture.image && (texture.image.width !== image.width || texture.image.height !== image.height)) texture.dispose();
  texture.image = image;
  texture.needsUpdate = true;
}

export class World {
  // quality: 'high' (sharper, more detail), 'low' (battery saver) or 'lite' (software rendering).
  constructor(container, { quality = 'high' } = {}) {
    this.container = container;
    this.hooks = new Set();
    this.pins = [];
    this.pulses = [];
    this.autoSpin = 0;
    this.spinInput = 0;
    this.tween = null;
    this.quality = quality;
    this.highQuality = quality === 'high';
    this.lite = quality === 'lite';

    // Frame pacing: the scene is only redrawn when something changes. Full rate while the player
    // interacts or the camera moves, a gentle ambient rate when idle, and the render resolution
    // drops automatically if the device can't keep up.
    this.fpsCap = this.lite ? 30 : 60;
    this.dirty = true;
    this.lastChange = 0;
    this.controlsActive = false;
    this.dprMax = Math.min(window.devicePixelRatio || 1, this.highQuality ? 1.5 : this.lite ? 0.75 : 1);
    this.dpr = this.dprMax;
    this.lastInput = performance.now();
    this.lastRender = 0;
    this.perf = { sum: 0, n: 0, good: 0 };
    const poke = () => { this.lastInput = performance.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) window.addEventListener(ev, poke, { passive: true });

    const renderer = new THREE.WebGLRenderer({ antialias: !this.lite, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x02040a, 1);
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D model of the disc map. Drag to orbit, scroll or pinch to zoom.');
    renderer.domElement.setAttribute('role', 'img');
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 3000);
    this.camera.position.set(0, 60, 150);

    if (!this.lite) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.55;
      pmrem.dispose();
    }

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.8;
    controls.minDistance = 1.2;
    controls.maxDistance = 90;
    controls.maxPolarAngle = 1.42;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.addEventListener('change', () => { this.clampTarget(); this.lastChange = performance.now(); });
    controls.addEventListener('start', () => { this.controlsActive = true; });
    controls.addEventListener('end', () => { this.controlsActive = false; });
    this.controls = controls;

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.scene.add(new THREE.HemisphereLight('#cfe6ff', '#20142a', 1.1));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(10, 18, 12);
    this.scene.add(key);

    this.buildSpace();
    this.buildDisc();
    this.buildIceWall();
    this.buildBase();
    this.buildDome();
    this.buildStars();
    this.buildSunMoon();

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.tmp = new THREE.Vector3();

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);

    this.last = performance.now();
    renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- construction ----------

  buildSpace() {
    // Nebula colours are baked into the sphere's vertices once, so the background costs nothing per frame.
    const geo = new THREE.SphereGeometry(900, 64, 32);
    const vp = geo.attributes.position;
    const colors = new Float32Array(vp.count * 3);
    const v = new THREE.Vector3();
    const deep = new THREE.Color(0.010, 0.016, 0.035);
    const high = new THREE.Color(0.030, 0.060, 0.130);
    const violet = new THREE.Color(0.10, 0.03, 0.16);
    const teal = new THREE.Color(0.02, 0.10, 0.18);
    const nc = new THREE.Color();
    const wave = (p, f) => Math.sin(p.x * f + 1.7) * Math.sin(p.y * f * 1.3 + 0.4) * Math.sin(p.z * f * 0.9 + 2.1);
    for (let i = 0; i < vp.count; i++) {
      v.fromBufferAttribute(vp, i).normalize();
      nc.copy(deep).lerp(high, THREE.MathUtils.smoothstep(v.y, -0.2, 0.9));
      if (!this.lite) {
        const neb = THREE.MathUtils.smoothstep(0.5 + 0.5 * (wave(v, 3) * 0.6 + wave(v, 7) * 0.4), 0.55, 0.95);
        nc.add(violet.clone().lerp(teal, 0.5 + 0.5 * wave(v, 2)).multiplyScalar(neb * 0.9));
      }
      colors.set([nc.r, nc.g, nc.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
    this.scene.add(sky);

    const rand = rng(7);
    const n = this.highQuality ? 3000 : this.lite ? 800 : 1600;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const tint = [new THREE.Color('#ffffff'), new THREE.Color('#a9c8ff'), new THREE.Color('#ffe2b0'), new THREE.Color('#ffd0d0')];
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos.set([s * Math.cos(th) * 600, u * 600, s * Math.sin(th) * 600], i * 3);
      const c = tint[Math.floor(rand() * tint.length)].clone().multiplyScalar(0.4 + rand() * 0.9);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.spaceStars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    this.scene.add(this.spaceStars);
  }

  buildDisc() {
    const blank = document.createElement('canvas');
    blank.width = blank.height = 4;
    this.mapTexture = new THREE.CanvasTexture(blank);
    this.overlayTexture = new THREE.CanvasTexture(blank);
    for (const t of [this.mapTexture, this.overlayTexture]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.lite ? 1 : Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    }
    // The highlight overlay changes often; skipping mipmaps keeps each re-upload cheap.
    this.overlayTexture.generateMipmaps = false;
    this.overlayTexture.minFilter = THREE.LinearFilter;

    this.discUniforms = {
      uMap: { value: this.mapTexture },
      uOverlay: { value: this.overlayTexture },
      uOverlayAlpha: { value: 1 },
      uSunUV: { value: new THREE.Vector2(0.5, 0.25) },
      uDayNight: { value: 1 },
      uTime: { value: 0 },
    };
    const top = new THREE.Mesh(
      new THREE.CircleGeometry(R, this.lite ? 128 : 256).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.discUniforms,
        toneMapped: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
          #define PI 3.141592653589793
          varying vec2 vUv;
          uniform sampler2D uMap; uniform sampler2D uOverlay;
          uniform float uOverlayAlpha; uniform vec2 uSunUV; uniform float uDayNight; uniform float uTime;
          vec3 sph(vec2 uv){ vec2 p = uv*2.0-1.0; float c = clamp(length(p),0.0,1.0)*PI; float a = atan(p.y, p.x + 1e-9);
            return vec3(sin(c)*cos(a), sin(c)*sin(a), cos(c)); }
          void main(){
            vec3 col = texture2D(uMap, vUv).rgb;
            float d = dot(sph(vUv), sph(uSunUV));
            float day = smoothstep(-0.10, 0.07, d);
            vec3 night = col * vec3(0.40, 0.46, 0.66);
            vec3 lit = mix(col, mix(night, col, day), uDayNight);
            lit += vec3(0.45, 0.18, 0.03) * exp(-pow((d + 0.015) / 0.055, 2.0)) * 0.22 * uDayNight;
            lit += vec3(1.0, 0.9, 0.65) * smoothstep(0.9, 1.0, d) * 0.07 * uDayNight;
            vec4 ov = texture2D(uOverlay, vUv);
            lit = mix(lit, ov.rgb, ov.a * uOverlayAlpha);
            gl_FragColor = vec4(lit * 0.97, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    top.renderOrder = 0;
    this.discTop = top;
    this.world.add(top);

    // Frozen strata around the edge of the disc
    const sc = document.createElement('canvas');
    sc.width = 1024;
    sc.height = 256;
    const g = sc.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, '#d6efff');
    grad.addColorStop(0.55, '#7fb8e6');
    grad.addColorStop(0.8, '#2e5f93');
    grad.addColorStop(1, '#13253f');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 256);
    const rand = rng(3);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(255,255,255,${0.04 + rand() * 0.12})`;
      g.fillRect(rand() * 1024, rand() * 256, 20 + rand() * 120, 1 + rand() * 3);
    }
    const stex = new THREE.CanvasTexture(sc);
    stex.colorSpace = THREE.SRGBColorSpace;
    stex.wrapS = THREE.RepeatWrapping;
    stex.repeat.set(8, 1);
    const side = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 1.012, R * 0.955, -BASE_Y, 200, 1, true),
      new THREE.MeshStandardMaterial({ map: stex, roughness: 0.35, metalness: 0.05, emissive: '#16385c', emissiveIntensity: 0.55 }),
    );
    side.position.y = BASE_Y / 2;
    this.world.add(side);

    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.955, 96).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#0d1724', roughness: 0.8 }),
    );
    bottom.position.y = BASE_Y;
    this.world.add(bottom);
  }

  buildIceWall() {
    const rand = rng(11);
    const rows = [
      { n: this.highQuality ? 480 : 300, r0: 0.995, r1: 1.012, h0: 0.25, h1: 0.95, w0: 0.11, w1: 0.24 },
      { n: this.highQuality ? 320 : this.lite ? 0 : 180, r0: 0.975, r1: 0.993, h0: 0.12, h1: 0.45, w0: 0.08, w1: 0.16 },
    ];
    const total = rows.reduce((s, r) => s + r.n, 0);
    const geom = new THREE.ConeGeometry(1, 1, 5, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: '#d8ecfb',
      roughness: 0.22,
      metalness: 0.0,
      flatShading: true,
      emissive: '#2a5a88',
      emissiveIntensity: 0.25,
    });
    const mesh = new THREE.InstancedMesh(geom, mat, total);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let i = 0;
    for (const row of rows) {
      for (let j = 0; j < row.n; j++) {
        const a = (j / row.n) * Math.PI * 2 + rand() * 0.01;
        const rr = R * (row.r0 + rand() * (row.r1 - row.r0));
        const wave = 0.5 + 0.5 * Math.sin(a * 9 + 1.3) * Math.sin(a * 4 + 0.4);
        const h = row.h0 + (row.h1 - row.h0) * (0.35 * wave + 0.65 * rand());
        const w = row.w0 + (row.w1 - row.w0) * rand();
        p.set(Math.sin(a) * rr, -0.04, Math.cos(a) * rr);
        e.set((rand() - 0.5) * 0.25, rand() * Math.PI, (rand() - 0.5) * 0.25);
        q.setFromEuler(e);
        s.set(w, h, w * (0.7 + rand() * 0.5));
        m.compose(p, q, s);
        mesh.setMatrixAt(i++, m);
      }
    }
    this.iceWall = mesh;
    this.world.add(mesh);
  }

  buildBase() {
    const gold = new THREE.MeshStandardMaterial({ color: '#e7b73c', metalness: 1, roughness: 0.25, emissive: '#5a3800', emissiveIntensity: 0.6 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 0.985, 0.12, 20, 240), gold);
    band.rotation.x = Math.PI / 2;
    band.position.y = BASE_Y + 0.05;
    this.world.add(band);

    const n = 64;
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), n);
    const m = new THREE.Matrix4();
    const glowPos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.sin(a) * (R * 0.985 + 0.13);
      const z = Math.cos(a) * (R * 0.985 + 0.13);
      m.makeTranslation(x, BASE_Y + 0.05, z);
      bulbs.setMatrixAt(i, m);
      bulbs.setColorAt(i, new THREE.Color('#ffe9a8'));
      glowPos.set([x, BASE_Y + 0.05, z], i * 3);
    }
    this.bulbs = bulbs;
    this.world.add(bulbs);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
    gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    this.bulbGlow = new THREE.Points(gg, new THREE.PointsMaterial({
      size: 0.6, map: glowTexture('rgba(255,230,150,1)', 'rgba(255,170,40,0.35)', 64), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.world.add(this.bulbGlow);

    const metal = new THREE.MeshStandardMaterial({ color: '#3a4656', metalness: 0.9, roughness: 0.35 });
    for (const [rad, tube, y] of [[R * 1.3, 0.07, BASE_Y - 0.15], [R * 1.42, 0.035, BASE_Y - 0.2]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rad, tube, 12, 260), metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.world.add(ring);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const len = R * 0.33;
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, len), metal);
      const mid = R * 0.985 + len / 2;
      strut.position.set(Math.sin(a) * mid, BASE_Y - 0.08, Math.cos(a) * mid);
      strut.rotation.y = a;
      this.world.add(strut);
    }

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(R * 2.1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowTexture('rgba(60,150,255,0.55)', 'rgba(30,90,200,0.18)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.position.y = BASE_Y - 0.6;
    this.world.add(halo);
  }

  buildDome() {
    const geom = new THREE.SphereGeometry(DOME_R, 96, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    geom.scale(1, DOME_H / DOME_R, 1);
    this.domeUniforms = { uOpacity: { value: 1 } };
    const dome = new THREE.Mesh(
      geom,
      new THREE.ShaderMaterial({
        uniforms: this.domeUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        vertexShader: `
          varying vec3 vN; varying vec3 vV; varying float vH;
          void main(){
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            vH = position.y / ${DOME_H.toFixed(2)};
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          varying vec3 vN; varying vec3 vV; varying float vH; uniform float uOpacity;
          void main(){
            vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
            float f = pow(1.0 - abs(dot(n, vV)), 2.6);
            vec3 L = normalize(vec3(-0.45, 0.8, 0.55));
            float spec = pow(max(dot(reflect(-vV, n), L), 0.0), 60.0) * 0.55;
            float rings = smoothstep(0.985, 1.0, abs(cos(vH * 3.14159 * 4.5))) * 0.05;
            float rim = smoothstep(0.08, 0.0, vH) * 0.35;
            vec3 col = vec3(0.78, 0.9, 1.0) * (0.42 + 0.5 * f) + vec3(1.0) * spec * 1.4;
            float a = (0.03 + f * 0.5 + rings + rim + spec * 0.5) * uOpacity;
            gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
            #include <colorspace_fragment>
          }`,
      }),
    );
    dome.renderOrder = 10;
    this.dome = dome;
    this.world.add(dome);
  }

  domeY(r, inset = 0.985) {
    const k = Math.min(1, r / (DOME_R * inset));
    return DOME_H * inset * Math.sqrt(Math.max(0, 1 - k * k));
  }

  buildStars() {
    this.starGroup = new THREE.Group();
    this.world.add(this.starGroup);
    const rand = rng(23);
    const named = new Map();
    const pts = [];
    const place = (ra, dec) => {
      const p = lonLatToLocal(ra, dec);
      const inset = 0.975;
      return new THREE.Vector3(p.x * inset, this.domeY(p.r * inset, 0.985), p.z * inset);
    };
    for (const [name, ra, dec, mag] of STARS) {
      const v = place(ra, dec);
      named.set(name, v);
      pts.push({ v, size: Math.max(2.2, 7.5 - mag * 1.6), tw: rand() });
    }
    const extra = this.highQuality ? 420 : this.lite ? 120 : 260;
    for (let i = 0; i < extra; i++) {
      const ra = rand() * 360;
      const dec = 90 - Math.acos(1 - rand() * 1.9) * (180 / Math.PI);
      pts.push({ v: place(ra, dec), size: 0.8 + rand() * 1.6, tw: rand() });
    }
    const pos = new Float32Array(pts.length * 3);
    const size = new Float32Array(pts.length);
    const tw = new Float32Array(pts.length);
    pts.forEach((p, i) => {
      pos.set([p.v.x, p.v.y, p.v.z], i * 3);
      size[i] = p.size;
      tw[i] = p.tw;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aTw', new THREE.BufferAttribute(tw, 1));
    this.starUniforms = { uTime: { value: 0 }, uPx: { value: 1 }, uAlpha: { value: 1 } };
    const stars = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.starUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute float aSize; attribute float aTw; uniform float uTime; uniform float uPx; uniform float uAlpha; varying float vA;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vA = (0.65 + 0.35 * sin(uTime * (1.5 + aTw * 3.0) + aTw * 40.0)) * uAlpha;
            gl_PointSize = aSize * uPx * (28.0 / -mv.z) + 1.0;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying float vA;
          void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 1.25, a * vA); }`,
      }),
    );
    stars.renderOrder = 11;
    this.starGroup.add(stars);

    const lp = [];
    for (const [a, b] of LINES) {
      const va = named.get(a);
      const vb = named.get(b);
      if (va && vb) lp.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#8fd8ff', transparent: true, opacity: 0.32, depthWrite: false }));
    lines.renderOrder = 11;
    this.starLines = lines;
    this.starGroup.add(lines);
  }

  buildSunMoon() {
    const sun = new THREE.Group();
    sun.add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 16), new THREE.MeshBasicMaterial({ color: '#fff6d0', toneMapped: false })));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,210,120,0.45)', 'rgba(255,140,30,0.12)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.scale.setScalar(8);
    sun.add(halo);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,236,170,1)', 'rgba(255,150,40,0.45)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(3.6);
    sun.add(glow);
    this.sunGlow = glow;
    const light = new THREE.PointLight('#ffd9a0', 70, 40, 1.4);
    sun.add(light);
    if (this.highQuality) {
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(3.4, SUN_H, 64, 1, true),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'varying vec2 vUv; void main(){ float a = 0.07 * pow(vUv.y, 1.5); gl_FragColor = vec4(1.0, 0.85, 0.5, a); }',
        }),
      );
      beam.position.y = -SUN_H / 2;
      beam.renderOrder = 12;
      sun.add(beam);
    }
    this.sun = sun;
    this.world.add(sun);

    const mc = document.createElement('canvas');
    mc.width = 256;
    mc.height = 128;
    const g = mc.getContext('2d');
    g.fillStyle = '#d9dde3';
    g.fillRect(0, 0, 256, 128);
    const rand = rng(5);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(110,118,130,${0.25 + rand() * 0.35})`;
      g.beginPath();
      g.arc(rand() * 256, rand() * 128, 3 + rand() * 16, 0, Math.PI * 2);
      g.fill();
    }
    const mtex = new THREE.CanvasTexture(mc);
    mtex.colorSpace = THREE.SRGBColorSpace;
    this.moonUniforms = { uTex: { value: mtex }, uElong: { value: Math.PI } };
    const moon = new THREE.Group();
    moon.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.moonUniforms,
        vertexShader: 'varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
          uniform sampler2D uTex; uniform float uElong; varying vec2 vUv; varying vec3 vN;
          void main(){
            vec3 L = normalize(vec3(sin(uElong), 0.0, -cos(uElong)));
            float lit = smoothstep(-0.04, 0.12, dot(normalize(vN), L));
            vec3 col = texture2D(uTex, vUv).rgb * (0.07 + 1.35 * lit);
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    ));
    const mglow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(220,235,255,0.7)', 'rgba(150,180,255,0.18)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    mglow.scale.setScalar(1.15);
    moon.add(mglow);
    this.moonGlow = mglow;
    this.moon = moon;
    this.world.add(moon);
  }

  // ---------- public API ----------

  // Ask for a redraw on the next display refresh (used whenever something changes while idle).
  invalidate() {
    this.dirty = true;
  }

  setMapCanvas(canvas) {
    swapImage(this.mapTexture, canvas);
    this.dirty = true;
  }

  setOverlayCanvas(canvas) {
    swapImage(this.overlayTexture, canvas);
    this.dirty = true;
  }

  refreshOverlay() {
    this.overlayTexture.needsUpdate = true;
    this.dirty = true;
  }

  // Dome stars dim while a lesson card is in play so they never clutter the map.
  setStarAlpha(a) {
    this.starUniforms.uAlpha.value = a;
    this.starLines.material.opacity = 0.32 * a;
    this.dirty = true;
  }

  setDomeAlpha(a) {
    this.domeUniforms.uOpacity.value = a;
    this.dirty = true;
  }

  setDayNight(on) {
    this.discUniforms.uDayNight.value = on ? 1 : 0;
    this.dirty = true;
  }

  setSky(sky) {
    const s = lonLatToLocal(sky.sun.lon, sky.sun.lat);
    this.sun.position.set(s.x, SUN_H, s.z);
    const [u, v] = lonLatToUV(sky.sun.lon, sky.sun.lat);
    this.discUniforms.uSunUV.value.set(u, v);
    const m = lonLatToLocal(sky.moon.lon, sky.moon.lat);
    this.moon.position.set(m.x, MOON_H, m.z);
    this.moonUniforms.uElong.value = (sky.moon.elong * Math.PI) / 180;
    this.moonGlow.material.opacity = 0.25 + sky.moon.illum * 0.75;
    this.starGroup.rotation.y = (-sky.gmst * Math.PI) / 180;
  }

  onFrame(fn) {
    this.hooks.add(fn);
    return () => this.hooks.delete(fn);
  }

  fitDistance() {
    const aspect = this.camera.aspect || 1;
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(half) * aspect);
    return (R * 1.12) / Math.tan(Math.min(half, halfH));
  }

  viewPose(name) {
    const d = this.fitDistance();
    if (name === 'top') return { pos: new THREE.Vector3(0, d * 1.02, 0.001), target: new THREE.Vector3(0, 0, 0) };
    if (name === 'intro') return { pos: new THREE.Vector3(d * 0.42, d * 0.3, d * 1.05), target: new THREE.Vector3(0, 1.2, 0) };
    if (name === 'play') {
      const e = THREE.MathUtils.degToRad(66);
      return { pos: new THREE.Vector3(0, Math.sin(e) * d * 0.9, Math.cos(e) * d * 0.9), target: new THREE.Vector3(0, -0.3, 0.45) };
    }
    const elev = THREE.MathUtils.degToRad(48);
    return { pos: new THREE.Vector3(0, Math.sin(elev) * d * 0.95, Math.cos(elev) * d * 0.95), target: new THREE.Vector3(0, -0.4, 0.8) };
  }

  setView(name) {
    const p = this.viewPose(name);
    this.camera.position.copy(p.pos);
    this.controls.target.copy(p.target);
    this.controls.update();
    this.dirty = true;
  }

  flyTo(name, duration = 1.4) {
    const p = typeof name === 'string' ? this.viewPose(name) : name;
    return new Promise((resolve) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0.01;
      this.tween = {
        t: 0,
        duration,
        fromPos: this.camera.position.clone(),
        fromTarget: this.controls.target.clone(),
        toPos: p.pos,
        toTarget: p.target,
        resolve,
      };
    });
  }

  zoomBy(factor) {
    const t = this.controls.target;
    const d = this.camera.position.clone().sub(t);
    const len = THREE.MathUtils.clamp(d.length() / factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(t).add(d.setLength(len));
    this.controls.update();
    this.lastInput = performance.now();
    this.dirty = true;
  }

  // Zoom toward a place on the disc (keeps the current viewing angle).
  flyToLonLat(lon, lat, distance = 9) {
    const l = lonLatToLocal(lon, lat);
    const target = this.world.localToWorld(new THREE.Vector3(l.x, 0, l.z));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.5) dir.set(dir.x, 0.5, dir.z).normalize();
    return this.flyTo({ pos: target.clone().add(dir.multiplyScalar(distance)), target }, 1.1);
  }

  clampTarget() {
    const t = this.controls.target;
    const r = Math.hypot(t.x, t.z);
    if (r > R * 0.9) {
      t.x *= (R * 0.9) / r;
      t.z *= (R * 0.9) / r;
    }
    t.y = THREE.MathUtils.clamp(t.y, -1, 1);
  }

  // Screen position (CSS px within the container) of a lon/lat at height h above the disc.
  project(lon, lat, h = 0, out = { x: 0, y: 0, visible: true }) {
    const l = lonLatToLocal(lon, lat);
    const v = this.tmp.set(l.x, h, l.z);
    this.world.localToWorld(v);
    v.project(this.camera);
    out.x = ((v.x + 1) / 2) * this.width;
    out.y = ((1 - v.y) / 2) * this.height;
    out.visible = v.z < 1 && v.z > -1;
    return out;
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.discTop, false)[0];
    if (!hit || !hit.uv) return null;
    return { lonlat: uvToLonLat(hit.uv.x, hit.uv.y) };
  }

  addPin(lon, lat, colour = '#ff3b5c') {
    const l = lonLatToLocal(lon, lat);
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.2 });
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.01, 1.1, 10), new THREE.MeshStandardMaterial({ color: '#dfe6ee', metalness: 0.8, roughness: 0.3 }));
    stick.position.y = 0.55;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), mat);
    head.position.y = 1.12;
    g.add(stick, head);
    g.position.set(l.x, 0, l.z);
    g.userData.born = performance.now();
    g.scale.setScalar(0.001);
    this.world.add(g);
    this.pins.push(g);
    return g;
  }

  pulseAt(lon, lat, colour = '#ffe14d') {
    const l = lonLatToLocal(lon, lat);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.36, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(2), transparent: true, depthWrite: false, toneMapped: false }),
    );
    ring.position.set(l.x, 0.02, l.z);
    ring.userData.born = performance.now();
    this.world.add(ring);
    this.pulses.push(ring);
    return ring;
  }

  clearMarks() {
    for (const o of [...this.pins, ...this.pulses]) {
      this.world.remove(o);
      o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose?.(); });
    }
    this.pins = [];
    this.pulses = [];
    this.dirty = true;
  }

  // ---------- loop ----------

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.starUniforms.uPx.value = this.dpr * (h / 700);
    this.dirty = true;
  }

  // Dynamic resolution: if frames arrive late, render fewer pixels; recover slowly when there's headroom.
  adaptResolution(interval, cap) {
    if (interval > 250) return; // tab switch or breakpoint, not a slow frame
    const p = this.perf;
    p.sum += interval;
    p.n++;
    if (p.n < 40) return;
    const avg = p.sum / p.n;
    const target = 1000 / cap;
    p.sum = 0;
    p.n = 0;
    if (avg > target * 1.45 && this.dpr > 0.5) {
      this.dpr = Math.max(0.5, Math.round((this.dpr - 0.25) * 4) / 4);
      p.good = 0;
      this.resize();
    } else if (avg < target * 1.12 && this.dpr < this.dprMax) {
      if (++p.good >= 4) {
        this.dpr = Math.min(this.dprMax, this.dpr + 0.25);
        p.good = 0;
        this.resize();
      }
    } else p.good = 0;
  }

  tick() {
    const now = performance.now();
    const spin = (this.lite ? 0 : this.autoSpin) + this.spinInput;
    const steering = this.controlsActive || now - this.lastChange < 120 || !!this.tween || this.spinInput !== 0;
    const interacting = now - this.lastInput < (this.lite ? 400 : 3000);
    let cap;
    if (steering || interacting) cap = this.fpsCap;
    else if (spin || this.pins.length || this.pulses.length) cap = this.lite ? 15 : 30;
    else cap = this.lite ? 1 : 20; // ambient: twinkling stars, chasing lights, moving sky
    const elapsed = now - this.lastRender;
    if (!this.dirty && elapsed < 1000 / cap - 2) return; // nothing new to show yet
    if (this.lastRender && cap === this.fpsCap) this.adaptResolution(elapsed, cap);
    this.lastRender = now;
    this.dirty = false;
    const realDt = Math.min(1, (now - this.last) / 1000); // true elapsed time, for clocks and timers
    const dt = Math.min(0.1, realDt);
    this.last = now;
    const t = now / 1000;

    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = easeInOut(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (tw.t >= 1) {
        this.tween = null;
        tw.resolve();
      }
    }
    this.world.rotation.y += spin * dt;
    this.controls.update();

    this.discUniforms.uTime.value = t;
    this.starUniforms.uTime.value = t;
    this.sunGlow.material.rotation = t * 0.05;
    const s = 3.4 + Math.sin(t * 2.1) * 0.12;
    this.sunGlow.scale.set(s, s, 1);

    const c = this.tmpColor || (this.tmpColor = new THREE.Color());
    const glow = this.bulbGlow.geometry.attributes.color;
    for (let i = 0; i < this.bulbs.count; i++) {
      const k = 0.55 + 0.45 * Math.sin(t * 3.2 - i * 0.7);
      this.bulbs.setColorAt(i, c.setRGB(0.75 + 0.25 * k, 0.6 + 0.3 * k, 0.25 + 0.2 * k));
      glow.setXYZ(i, k, k, k);
    }
    this.bulbs.instanceColor.needsUpdate = true;
    glow.needsUpdate = true;

    for (const p of this.pins) {
      const age = (now - p.userData.born) / 1000;
      p.scale.setScalar(Math.min(1, age * 4) * (1 + Math.max(0, 0.25 - age) * 2));
    }
    for (const r of this.pulses) {
      const age = ((now - r.userData.born) / 1000) % 1.4;
      r.scale.setScalar(1 + age * 6);
      r.material.opacity = Math.max(0, 1 - age / 1.4);
    }

    for (const fn of this.hooks) fn(realDt, t);

    this.renderer.render(this.scene, this.camera);
  }
}
