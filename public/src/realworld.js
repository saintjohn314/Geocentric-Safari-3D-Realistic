// Realistic 3D: the disc as a satellite-imagery map under a glass firmament, drawn with WebGL.
//
// Built to stay light so it can't lock up a computer:
// - nothing is painted on the CPU: the map is pre-baked image tiles (decoded off the main thread
//   with createImageBitmap) and the borders/coastlines are pre-baked GPU geometry;
// - it only draws a frame when something changes (camera, sky, highlights, a tile arriving);
// - shaders compile asynchronously, resolution drops automatically if frames run slow, and the
//   tile cache is capped.
// Exposes the same API as FlatWorld (Simple mode) so the game code drives either one.
import * as THREE from '../vendor/three-0.185.1/three.module.min.js';
import { DISC_R, lonLatToLocal, localToLonLat } from './geo.js';
import { STARS, LINES } from './astro.js';

const R = DISC_R;
const TILE = 512;
const MAX_LEVEL = 5;
const BASE_LEVEL = 2; // levels 0..2 (21 tiles) are always kept loaded
const MAX_TEXTURES = 120;
const DOME = { r: 1.045, h: 0.6 };
const SUN_H = 0.34;
const MOON_H = 0.3;
const WALL_H = 0.62; // ice wall height in world units (disc radius 10)
const BASE_DEPTH = 1.1;
const FOV = 38;
const MAX_ZOOM = 180;
const VIEWS = {
  top: { tilt: 0, zoom: 1 },
  play: { tilt: 26, zoom: 1.1 },
  orbit: { tilt: 50, zoom: 1.12 },
  intro: { tilt: 58, zoom: 1.08 },
};
const POLITICAL = ['#f6d55c', '#f59b5b', '#9bd06a', '#ef6f8d', '#c4a7ec', '#7fd8c0'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const DEG = Math.PI / 180;

function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// lon/lat -> unit vector on the globe, used for the true day/night line (matches the shader).
function sphereVec(lon, lat, out = new THREE.Vector3()) {
  const c = ((90 - lat) / 180) * Math.PI;
  const l = lon * DEG;
  return out.set(Math.sin(c) * Math.sin(l), Math.cos(c), Math.sin(c) * Math.cos(l));
}

function tileInDisc(L, x, y) {
  const k = 2 ** L;
  const x0 = (2 * x) / k - 1;
  const x1 = (2 * (x + 1)) / k - 1;
  const z0 = (2 * y) / k - 1;
  const z1 = (2 * (y + 1)) / k - 1;
  const cx = x0 <= 0 && x1 >= 0 ? 0 : Math.min(Math.abs(x0), Math.abs(x1));
  const cz = z0 <= 0 && z1 >= 0 ? 0 : Math.min(Math.abs(z0), Math.abs(z1));
  return cx * cx + cz * cz < 1;
}

function parseColour(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '');
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return { color: new THREE.Color(r / 255, g / 255, b / 255), alpha: a };
  }
  return { color: new THREE.Color(css || '#ffffff'), alpha: 1 };
}

function glowTexture(inner, outer, size = 128) {
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
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

async function loadBitmap(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function bitmapTexture(bitmap, anisotropy) {
  const t = new THREE.Texture(bitmap);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// ---------- shaders ----------

const SPHERE_GLSL = /* glsl */ `
  vec3 sphereDir(vec2 p, float R) {
    float c = length(p) / R * 3.14159265;
    float lon = atan(p.x, p.y);
    float s = sin(c);
    return vec3(s * sin(lon), cos(c), s * cos(lon));
  }
`;

const TILE_VERT = /* glsl */ `
  uniform vec4 uvRect;
  varying vec3 vW;
  varying vec2 vUv;
  void main() {
    vUv = uvRect.xy + uv * uvRect.zw;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const TILE_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D aux;
  uniform vec3 sunVec;
  uniform vec3 sunPos;
  uniform float nightOn;
  uniform float uR;
  varying vec3 vW;
  varying vec2 vUv;
  ${SPHERE_GLSL}
  void main() {
    float rr = length(vW.xz);
    if (rr > uR) discard;
    vec3 base = texture2D(map, vUv).rgb;
    vec4 ax = texture2D(aux, vW.xz / uR * 0.5 + 0.5);
    float d = dot(sphereDir(vW.xz, uR), sunVec);
    float day = mix(1.0, smoothstep(-0.11, 0.07, d), nightOn);
    float dusk = exp(-pow((d + 0.025) / 0.075, 2.0)) * nightOn;
    vec3 col = base * (0.2 + 0.85 * day);
    col = mix(col, col * vec3(0.5, 0.62, 1.0), (1.0 - day) * 0.65);
    col += base * vec3(0.32, 0.12, 0.02) * dusk;
    col += vec3(1.0, 0.76, 0.42) * pow(ax.r, 1.3) * (1.0 - day) * 1.45;
    vec3 L = normalize(sunPos - vW);
    vec3 V = normalize(cameraPosition - vW);
    float nh = max(normalize(L + V).y, 0.0);
    col += vec3(1.0, 0.93, 0.8) * (pow(nh, 260.0) * 1.3 + pow(nh, 22.0) * 0.07) * ax.g * day;
    col *= 1.0 + 0.1 * pow(max(d, 0.0), 6.0);
    // the far south frosts over towards the ice wall
    col = mix(col, vec3(0.93, 0.96, 1.0) * (0.25 + 0.75 * day), smoothstep(0.985, 1.0, rr / uR) * 0.8);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const WALL_VERT = /* glsl */ `
  attribute float h;
  varying vec3 vW;
  varying vec3 vN;
  varying float vH;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(vec3(position.x, 0.0, position.z));
    vH = h;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
`;

const WALL_FRAG = /* glsl */ `
  uniform vec3 sunPos;
  uniform float light;
  varying vec3 vW;
  varying vec3 vN;
  varying float vH;
  ${NOISE_GLSL}
  void main() {
    vec3 n = gl_FrontFacing ? vN : -vN;
    float a = atan(vW.x, vW.z);
    float streak = fbm(vec2(a * 260.0, vW.y * 3.0));
    float crack = smoothstep(0.62, 0.7, fbm(vec2(a * 900.0, vW.y * 9.0)));
    vec3 deep = vec3(0.42, 0.62, 0.8);
    vec3 snow = vec3(0.97, 0.99, 1.0);
    vec3 col = mix(deep, snow, smoothstep(0.0, 1.0, vH) * 0.7 + streak * 0.35);
    col = mix(col, vec3(0.55, 0.75, 0.92), crack * 0.5);
    vec3 L = normalize(sunPos - vW);
    float diff = max(dot(n, L), 0.0);
    vec3 V = normalize(cameraPosition - vW);
    float rim = pow(1.0 - abs(dot(n, V)), 3.0);
    col *= (0.38 + 0.75 * diff) * light;
    col += vec3(0.6, 0.8, 1.0) * rim * 0.18;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const BASE_FRAG = /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  ${NOISE_GLSL}
  void main() {
    float a = atan(vW.x, vW.z);
    float y = -vW.y;
    float band = y + fbm(vec2(a * 40.0, y * 2.0)) * 0.18;
    vec3 col = vec3(0.86, 0.9, 0.95);
    col = mix(col, vec3(0.45, 0.42, 0.4), smoothstep(0.06, 0.16, band));
    col = mix(col, vec3(0.36, 0.27, 0.2), smoothstep(0.32, 0.45, band));
    col = mix(col, vec3(0.24, 0.22, 0.22), smoothstep(0.62, 0.75, band));
    col = mix(col, vec3(0.6, 0.22, 0.06), smoothstep(0.98, 1.1, band) * 0.6);
    col *= 0.75 + 0.35 * fbm(vec2(a * 300.0, y * 20.0));
    float side = 0.55 + 0.45 * max(dot(vN, normalize(vec3(0.4, 0.3, 1.0))), 0.0);
    gl_FragColor = vec4(col * side, 1.0);
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 sunPos;
  uniform float alpha;
  uniform float day;
  varying vec3 vW;
  varying vec3 vN;
  void main() {
    vec3 n = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    float f = pow(1.0 - abs(dot(n, V)), 2.4);
    vec3 col = mix(vec3(0.35, 0.55, 0.9) * (0.25 + 0.35 * day), vec3(0.92, 0.97, 1.0), f);
    vec3 L = normalize(sunPos - vW);
    float spec = pow(max(dot(reflect(-V, n), L), 0.0), 90.0);
    float a = (0.025 + 0.55 * f) * alpha + spec * 0.6 * alpha;
    gl_FragColor = vec4(col + spec, a);
  }
`;

const CONE_FRAG = /* glsl */ `
  uniform float alpha;
  varying vec3 vW;
  varying vec3 vN;
  varying vec2 vUv;
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float facing = abs(dot(normalize(vN), V));
    float a = pow(facing, 1.6) * (0.25 + 0.75 * vUv.y) * alpha;
    gl_FragColor = vec4(vec3(1.0, 0.86, 0.55) * a, a);
  }
`;

const CONE_VERT = /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const MOON_FRAG = /* glsl */ `
  uniform vec3 lightDir;
  varying vec3 vN;
  varying vec3 vP;
  ${NOISE_GLSL}
  void main() {
    vec3 n = normalize(vN);
    float lit = smoothstep(-0.05, 0.12, dot(n, lightDir));
    float maria = fbm(vP.xy * 3.0 + vP.z * 2.0);
    vec3 col = mix(vec3(0.95, 0.94, 0.9), vec3(0.62, 0.62, 0.64), smoothstep(0.45, 0.7, maria));
    gl_FragColor = vec4(col * (0.06 + 0.98 * lit), 1.0);
  }
`;

const MOON_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vP;
  void main() {
    vP = position * 4.0;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_VERT = /* glsl */ `
  attribute float size;
  attribute float bright;
  uniform float pxScale;
  varying float vB;
  void main() {
    vB = bright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(size * pxScale, 1.0, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float alpha;
  uniform vec3 tint;
  varying float vB;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.0) * vB * alpha;
    gl_FragColor = vec4(tint * a, a);
  }
`;

export class RealWorld {
  constructor(container, { quality = 'low', maxTex = 4096 } = {}) {
    this.container = container;
    this.quality = quality;
    this.hooks = new Set();
    this.autoSpin = 0;
    this.spinInput = 0;
    this.view = { ...VIEWS.intro, rot: 0, tx: 0, tz: 0 };
    this.tween = null;
    this.pins = [];
    this.marks = [];
    this.raf = 0;
    this.last = performance.now();
    this.viewDirty = true;
    this.needsRender = true;
    this.labelsOn = false;
    this.style = 'terrain';
    this.maxDpr = quality === 'high' ? 2 : 1.5;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.slowFrames = 0;
    this.frameTimes = [];
    this.sunLL = { lon: 0, lat: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
    THREE.ColorManagement.enabled = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(this.dpr);
    renderer.setClearColor('#03060d');
    renderer.debug.checkShaderErrors = false;
    this.renderer = renderer;
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'The disc map under its glass dome. Drag to turn and tilt, scroll or pinch to zoom.');
    container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onContextLost?.();
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 2000);
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.frustum = new THREE.Frustum();
    this.projScreen = new THREE.Matrix4();

    this.U = {
      sunVec: { value: new THREE.Vector3(0, 1, 0) },
      sunPos: { value: new THREE.Vector3(0, SUN_H * R, 0) },
      nightOn: { value: 1 },
      uR: { value: R },
      aux: { value: null },
    };

    this.buildSpace();
    this.buildTiles();
    this.buildIceAndBase();
    this.buildDome();
    this.buildBodies();
    this.buildDom();
    this.bindInput();
    this.resize();
    new ResizeObserver(() => { this.resize(); this.request(); }).observe(container);
    this.heartbeat = setInterval(() => { if (!this.raf) this.step(); }, 250);
    this.ready = this.init();
  }

  // ---------- loading ----------

  async init() {
    const base = [];
    for (let L = 0; L <= BASE_LEVEL; L++) {
      const k = 2 ** L;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) if (tileInDisc(L, x, y)) base.push(this.loadTile(L, x, y, true));
    }
    const aux = loadBitmap('assets/aux.webp').then((bmp) => {
      const t = bitmapTexture(bmp, 1);
      this.U.aux.value = t;
    }).catch((err) => console.warn(err));
    this.loadVectors();
    await Promise.race([Promise.allSettled([...base, aux]), new Promise((r) => setTimeout(r, 15000))]);
    if (!this.U.aux.value) this.U.aux.value = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.updateCamera();
    this.updateTiles();
    try {
      await Promise.race([this.renderer.compileAsync(this.scene, this.camera), new Promise((r) => setTimeout(r, 8000))]);
    } catch { /* compiles on first draw instead */ }
    this.redraw();
  }

  async loadVectors() {
    try {
      const [meta, buf] = await Promise.all([
        fetch('data/vectors.json').then((r) => r.json()),
        fetch('data/vectors.bin').then((r) => r.arrayBuffer()),
      ]);
      const get = (name) => {
        const { offset, length, type } = meta.layout[name];
        return new { Int16Array, Uint32Array }[type](buf, offset, length);
      };
      const k = R / meta.q;
      const toPos = (q) => {
        const p = new Float32Array((q.length / 2) * 3);
        for (let i = 0, j = 0; i < q.length; i += 2, j += 3) {
          p[j] = q[i] * k;
          p[j + 2] = q[i + 1] * k;
        }
        return new THREE.BufferAttribute(p, 3);
      };
      const lines = (posName, lenName, colour, opacity) => {
        const pos = toPos(get(posName));
        const lens = get(lenName);
        let total = 0;
        for (const n of lens) total += n - 1;
        const idx = new Uint32Array(total * 2);
        let v = 0;
        let w = 0;
        for (const n of lens) {
          for (let i = 0; i < n - 1; i++) { idx[w++] = v + i; idx[w++] = v + i + 1; }
          v += n;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', pos);
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        const m = new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
        const mesh = new THREE.LineSegments(g, m);
        mesh.renderOrder = 3;
        mesh.frustumCulled = false;
        return mesh;
      };
      this.coast = lines('coastPos', 'coastLen', '#d6ecff', 0.26);
      this.borders = lines('borderPos', 'borderLen', '#ffe9a8', 0.5);
      this.scene.add(this.coast, this.borders);

      this.fillPos = toPos(get('fillPos'));
      this.fillIdx = get('fillIdx');
      this.countries = new Map(meta.countries.map((c) => [c.name, c]));
      this.countryList = meta.countries;
      this.applyStyle();
      this.refreshMarks();
      this.redraw();
    } catch (err) {
      console.warn('Borders unavailable', err);
    }
  }

  // ---------- scene ----------

  buildSpace() {
    const rand = rng(7);
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const bright = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos.set([s * Math.cos(t) * 600, u * 600, s * Math.sin(t) * 600], i * 3);
      size[i] = 0.8 + Math.pow(rand(), 6) * 2.4;
      bright[i] = 0.25 + rand() * 0.75;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('bright', new THREE.BufferAttribute(bright, 1));
    this.spaceMat = this.starMaterial(0.9, '#dfe9ff');
    const pts = new THREE.Points(g, this.spaceMat);
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    this.scene.add(pts);
  }

  starMaterial(alpha, tint) {
    return new THREE.ShaderMaterial({
      uniforms: { alpha: { value: alpha }, tint: { value: new THREE.Color(tint) }, pxScale: { value: this.dpr } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  buildTiles() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.tileGeo = g;
    this.tileMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, uvRect: { value: new THREE.Vector4(0, 0, 1, 1) }, ...this.U },
      vertexShader: TILE_VERT,
      fragmentShader: TILE_FRAG,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    this.tileGroup = new THREE.Group();
    this.scene.add(this.tileGroup);
    this.tileMeshes = [];
    this.tiles = new Map(); // key -> { tex, state, used }
    this.queue = [];
    this.loading = 0;
    this.frameNo = 0;
  }

  tileMesh(i) {
    let m = this.tileMeshes[i];
    if (!m) {
      const mat = this.tileMat.clone();
      for (const k of Object.keys(this.U)) mat.uniforms[k] = this.U[k]; // share sky uniforms
      m = new THREE.Mesh(this.tileGeo, mat);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      this.tileMeshes[i] = m;
      this.tileGroup.add(m);
    }
    return m;
  }

  loadTile(L, x, y, keep = false) {
    const key = `${L}/${x}_${y}`;
    let t = this.tiles.get(key);
    if (t) return t.promise;
    t = { state: 'loading', used: this.frameNo, keep };
    this.tiles.set(key, t);
    this.loading++;
    t.promise = loadBitmap(`assets/tiles/${L}/${x}_${y}.webp`).then((bmp) => {
      t.tex = bitmapTexture(bmp, this.anisotropy);
      t.state = 'ready';
    }).catch(() => {
      t.state = 'error';
    }).finally(() => {
      this.loading--;
      this.tilesDirty = true;
      this.pumpQueue();
      this.request();
    });
    return t.promise;
  }

  pumpQueue() {
    while (this.loading < 6 && this.queue.length) {
      const q = this.queue.shift();
      if (!this.tiles.has(q.key)) this.loadTile(q.L, q.x, q.y);
    }
  }

  // Pick the tiles to draw: refine where a tile would show at more than about one texel per pixel.
  updateTiles() {
    this.frameNo++;
    const cam = this.camera;
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const scale = (this.height * this.dpr) / (2 * Math.tan((FOV * DEG) / 2));
    const cp = cam.position;
    const out = [];
    const box = new THREE.Box3();
    let budget = 1.0;
    const visit = (L, x, y) => {
      if (!tileInDisc(L, x, y)) return;
      const s = (2 * R) / 2 ** L;
      const x0 = -R + x * s;
      const z0 = -R + y * s;
      box.min.set(x0, -0.01, z0);
      box.max.set(x0 + s, 0.01, z0 + s);
      if (!this.frustum.intersectsBox(box)) return;
      const dx = Math.max(x0 - cp.x, 0, cp.x - (x0 + s));
      const dz = Math.max(z0 - cp.z, 0, cp.z - (z0 + s));
      const dist = Math.max(1e-4, Math.hypot(dx, cp.y, dz));
      const px = (s / dist) * scale;
      if (L < MAX_LEVEL && px > TILE * budget) {
        visit(L + 1, x * 2, y * 2);
        visit(L + 1, x * 2 + 1, y * 2);
        visit(L + 1, x * 2, y * 2 + 1);
        visit(L + 1, x * 2 + 1, y * 2 + 1);
      } else out.push([L, x, y, dist]);
    };
    visit(0, 0, 0);
    if (out.length > 140) { // very oblique views: settle for coarser tiles far away
      budget = 1.8;
      out.length = 0;
      visit(0, 0, 0);
    }

    const want = [];
    out.forEach(([L, x, y, dist], i) => {
      const m = this.tileMesh(i);
      m.visible = true;
      const s = (2 * R) / 2 ** L;
      m.matrix.makeScale(s, 1, s).setPosition(-R + x * s, 0, -R + y * s);
      m.matrixWorldNeedsUpdate = true;
      // best loaded texture: this tile, or the nearest loaded ancestor
      let tex = null;
      let rect = null;
      for (let a = L; a >= 0; a--) {
        const f = 2 ** (L - a);
        const ax = Math.floor(x / f);
        const ay = Math.floor(y / f);
        const t = this.tiles.get(`${a}/${ax}_${ay}`);
        if (t) t.used = this.frameNo;
        if (t?.state === 'ready') {
          tex = t.tex;
          const inset = 0.5 / TILE;
          const k = 1 - 1 / TILE;
          rect = [inset + ((x - ax * f) / f) * k, inset + ((y - ay * f) / f) * k, k / f, k / f];
          break;
        }
      }
      if (!this.tiles.has(`${L}/${x}_${y}`)) want.push({ key: `${L}/${x}_${y}`, L, x, y, dist });
      m.material.uniforms.map.value = tex;
      m.material.uniforms.uvRect.value.set(...(rect || [0, 0, 1, 1]));
      m.visible = !!tex;
    });
    for (let i = out.length; i < this.tileMeshes.length; i++) this.tileMeshes[i].visible = false;

    // fetch missing tiles, coarse and near first
    want.sort((a, b) => a.L - b.L || a.dist - b.dist);
    this.queue = want;
    this.pumpQueue();
    this.evict();
    this.tilesDirty = false;
  }

  evict() {
    if (this.tiles.size <= MAX_TEXTURES) return;
    const old = [...this.tiles.entries()].filter(([, t]) => !t.keep && t.state !== 'loading' && t.used < this.frameNo).sort((a, b) => a[1].used - b[1].used);
    for (const [key, t] of old.slice(0, this.tiles.size - MAX_TEXTURES)) {
      t.tex?.image?.close?.();
      t.tex?.dispose();
      this.tiles.delete(key);
    }
  }

  buildIceAndBase() {
    // jagged ice wall standing on the rim
    const N = 900;
    const rows = 5;
    const rand = rng(21);
    const tops = [];
    for (let i = 0; i < N; i++) {
      const spike = rand() < 0.18 ? rand() * 0.55 : 0;
      tops.push(0.55 + 0.25 * Math.sin(i * 0.031) * Math.sin(i * 0.0071 + 1) + rand() * 0.22 + spike);
    }
    const pos = [];
    const hAttr = [];
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const top = tops[i % N] * WALL_H;
      const rr = R * (1.0 + 0.0025 * Math.sin(i * 0.9) + 0.002 * (rand() - 0.5));
      for (let j = 0; j <= rows; j++) {
        const t = j / rows;
        const inset = t > 0.85 ? (t - 0.85) * 0.06 : 0;
        pos.push(Math.sin(a) * (rr - inset), top * t - 0.02, Math.cos(a) * (rr - inset));
        hAttr.push(t);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < rows; j++) {
        const a = i * (rows + 1) + j;
        const b = a + rows + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('h', new THREE.Float32BufferAttribute(hAttr, 1));
    wg.setIndex(idx);
    this.wallMat = new THREE.ShaderMaterial({
      uniforms: { sunPos: this.U.sunPos, light: { value: 1 } },
      vertexShader: WALL_VERT,
      fragmentShader: WALL_FRAG,
      side: THREE.DoubleSide,
    });
    const wall = new THREE.Mesh(wg, this.wallMat);
    wall.frustumCulled = false;
    this.scene.add(wall);

    // the disc's cut edge: rock strata under the ice, and a dark underside
    const side = new THREE.CylinderGeometry(R * 1.004, R * 0.985, BASE_DEPTH, 256, 1, true);
    side.translate(0, -BASE_DEPTH / 2 - 0.02, 0);
    const sideMat = new THREE.ShaderMaterial({ vertexShader: WALL_VERT.replace('attribute float h;', '').replace('vH = h;', 'vH = 0.0;'), fragmentShader: BASE_FRAG });
    const sideMesh = new THREE.Mesh(side, sideMat);
    this.scene.add(sideMesh);
    const under = new THREE.Mesh(new THREE.CircleGeometry(R * 0.985, 128), new THREE.MeshBasicMaterial({ color: '#0d0f14' }));
    under.rotation.x = Math.PI / 2;
    under.position.y = -BASE_DEPTH - 0.02;
    this.scene.add(under);
  }

  buildDome() {
    const geo = new THREE.SphereGeometry(1, 128, 48, 0, Math.PI * 2, 0, Math.PI / 2);
    this.domeU = { sunPos: this.U.sunPos, alpha: { value: 1 }, day: { value: 1 } };
    const make = (side, order) => {
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: this.domeU,
        vertexShader: /* glsl */ `
          varying vec3 vW;
          varying vec3 vN;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            vN = normalize((normal / vec3(${(DOME.r * R).toFixed(3)}, ${(DOME.h * R).toFixed(3)}, ${(DOME.r * R).toFixed(3)})));
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: DOME_FRAG,
        transparent: true,
        depthWrite: false,
        side,
      }));
      m.scale.set(DOME.r * R, DOME.h * R, DOME.r * R);
      m.renderOrder = order;
      this.scene.add(m);
      return m;
    };
    this.domeBack = make(THREE.BackSide, 5);
    this.domeFront = make(THREE.FrontSide, 9);

    // stars and constellations painted on the inside of the firmament
    const rand = rng(3);
    const pts = [];
    const size = [];
    const bright = [];
    const domePoint = (lon, lat, inset = 0.985) => {
      const l = lonLatToLocal(lon, lat, 1);
      const r = Math.min(1, l.r * 0.97);
      const k = r / DOME.r;
      const y = DOME.h * Math.sqrt(Math.max(0, 1 - k * k)) * inset;
      return [l.x * 0.97 * R * inset, y * R, l.z * 0.97 * R * inset];
    };
    const named = new Map();
    for (const [name, ra, dec, mag] of STARS) {
      const p = domePoint(ra, dec);
      named.set(name, p);
      pts.push(...p);
      size.push(Math.max(1.6, 4.6 - mag * 0.9));
      bright.push(1);
    }
    for (let i = 0; i < 1500; i++) {
      // faint stars over the upper firmament only: near the rim the glass is seen edge-on and
      // stars there crowd into a speckled band
      const lon = rand() * 360 - 180;
      const s0 = Math.sin(-40 * DEG);
      const lat = Math.asin(s0 + rand() * (1 - s0)) / DEG;
      pts.push(...domePoint(lon, lat, 0.98));
      size.push(0.9 + Math.pow(rand(), 5) * 2);
      bright.push(0.2 + rand() * 0.6);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    sg.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    sg.setAttribute('bright', new THREE.Float32BufferAttribute(bright, 1));
    this.domeStarMat = this.starMaterial(1, '#fff8e6');
    const stars = new THREE.Points(sg, this.domeStarMat);
    stars.renderOrder = 6;
    stars.frustumCulled = false;
    const lp = [];
    for (const [a, b] of LINES) {
      const pa = named.get(a);
      const pb = named.get(b);
      if (pa && pb) lp.push(...pa, ...pb);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    this.constMat = new THREE.LineBasicMaterial({ color: '#8fd8ff', transparent: true, opacity: 0.22, depthWrite: false });
    const lines = new THREE.LineSegments(lg, this.constMat);
    lines.renderOrder = 6;
    this.starGroup = new THREE.Group();
    this.starGroup.add(stars, lines);
    this.scene.add(this.starGroup);
  }

  buildBodies() {
    // Sun: a small fierce ball, a soft glow and the classic flat-earth spotlight cone.
    this.sun = new THREE.Group();
    this.sun.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 16), new THREE.MeshBasicMaterial({ color: '#fff6dc' })));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,250,225,1)', 'rgba(255,190,70,0.35)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.set(3.4, 3.4, 1);
    glow.renderOrder = 8;
    this.sun.add(glow);
    const h = SUN_H * R;
    const cone = new THREE.ConeGeometry(R * 0.42, h, 96, 1, true);
    cone.translate(0, -h / 2, 0);
    this.coneU = { alpha: { value: 0.11 } };
    this.cone = new THREE.Mesh(cone, new THREE.ShaderMaterial({
      uniforms: this.coneU,
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }));
    this.cone.renderOrder = 7;
    this.sun.add(this.cone);
    this.scene.add(this.sun);

    this.moonU = { lightDir: { value: new THREE.Vector3(1, 0, 0) } };
    this.moon = new THREE.Group();
    this.moon.add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 16), new THREE.ShaderMaterial({ uniforms: this.moonU, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG })));
    const mg = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(220,235,255,0.55)', 'rgba(160,190,255,0.12)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    mg.scale.set(1.5, 1.5, 1);
    mg.renderOrder = 8;
    this.moon.add(mg);
    this.scene.add(this.moon);

    this.markGroup = new THREE.Group();
    this.scene.add(this.markGroup);
    this.buildGraticule();
  }

  buildGraticule() {
    const group = new THREE.Group();
    const circle = (lat, colour, opacity, dash) => {
      const r = ((90 - lat) / 180) * R;
      const p = [];
      for (let i = 0; i <= 512; i++) {
        const a = (i / 512) * Math.PI * 2;
        p.push(Math.sin(a) * r, 0, Math.cos(a) * r);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      const m = new THREE.LineDashedMaterial({ color: colour, transparent: true, opacity, dashSize: dash, gapSize: dash * 0.7, depthWrite: false });
      const l = new THREE.Line(g, m);
      l.computeLineDistances();
      l.renderOrder = 2;
      group.add(l);
    };
    circle(66.56, '#a8ecff', 0.35, 0.12);
    circle(23.44, '#ffb35c', 0.4, 0.12);
    circle(0, '#ffe066', 0.55, 0.2);
    circle(-23.44, '#ffb35c', 0.4, 0.12);
    const mer = [];
    for (let lon = -180; lon < 180; lon += 30) {
      const v = lonLatToLocal(lon, -60);
      mer.push(0, 0, 0, v.x, 0, v.z);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mer, 3));
    const ml = new THREE.LineSegments(mg, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.06, depthWrite: false }));
    ml.renderOrder = 2;
    group.add(ml);
    this.scene.add(group);
  }

  buildDom() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'rw-overlay';
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'rw-labels';
    this.bodies = document.createElement('div');
    this.bodies.className = 'flat-bodies';
    this.overlay.append(this.labelLayer, this.bodies);
    this.container.appendChild(this.overlay);
    this.labelEls = new Map();
  }

  // ---------- input ----------

  bindInput() {
    const el = this.renderer.domElement;
    const pts = new Map();
    let pinch = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.tween = null;
      this.interacting = true;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) { this.request(); return; } // hover: the game looks up the country under the cursor
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      const v = this.view;
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.zoomAt(d / pinch.d, mx, my);
        this.panBy(mx - pinch.mx, my - pinch.my);
        pinch = { d, mx, my };
        return;
      }
      const panMode = v.zoom >= 2.2 ? !(p.button === 2 || p.shift) : (p.button === 2 || p.shift);
      if (panMode) this.panBy(dx, dy);
      else {
        v.rot -= dx * (0.3 / Math.sqrt(Math.max(1, v.zoom)));
        v.tilt = clamp(v.tilt - dy * 0.25, 0, 76);
        this.viewDirty = true;
        this.request();
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) this.interacting = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.tween = null;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(Math.exp(-clamp(dy, -200, 200) * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
  }

  // ---------- camera ----------

  fitDistance() {
    const t = Math.tan((FOV * DEG) / 2);
    const aspect = this.width / this.height;
    return Math.max((R * 1.12) / t, (R * 1.12) / (t * aspect));
  }

  cameraFor(v, cam = this.camera) {
    const d = this.fitDistance() / v.zoom;
    const tilt = v.tilt * DEG;
    const rot = v.rot * DEG;
    const T = new THREE.Vector3(v.tx, 0, v.tz);
    cam.position.set(v.tx + d * Math.sin(tilt) * Math.sin(rot), d * Math.cos(tilt), v.tz + d * Math.sin(tilt) * Math.cos(rot));
    const fwd = T.clone().sub(cam.position).normalize();
    const right = new THREE.Vector3(Math.cos(rot), 0, -Math.sin(rot));
    cam.up.copy(right).cross(fwd).normalize();
    cam.lookAt(T);
    cam.near = Math.max(0.002, d * 0.02);
    cam.far = d * 6 + R * 8 + 700;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  updateCamera() {
    this.cameraFor(this.view);
  }

  // Disc-plane point under a screen point (CSS px relative to the canvas), or null.
  planePoint(sx, sy, cam = this.camera) {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, cam);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.plane, hit) ? hit : null;
  }

  zoomAt(factor, clientX, clientY) {
    const v = this.view;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    this.updateCamera();
    const before = this.planePoint(sx, sy);
    v.zoom = clamp(v.zoom * factor, 0.55, MAX_ZOOM);
    this.updateCamera();
    const after = this.planePoint(sx, sy);
    if (before && after) {
      v.tx += before.x - after.x;
      v.tz += before.z - after.z;
    }
    this.settleView();
  }

  panBy(dx, dy) {
    const v = this.view;
    this.updateCamera();
    const cx = this.width / 2;
    const cy = this.height / 2;
    const a = this.planePoint(cx, cy);
    const b = this.planePoint(cx - dx, cy - dy);
    if (a && b) {
      v.tx += b.x - a.x;
      v.tz += b.z - a.z;
    }
    this.settleView();
  }

  zoomBy(factor) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.tween = null;
    this.zoomAt(factor, rect.left + this.width / 2, rect.top + this.height / 2);
  }

  // Keep the focus on the disc; when zoomed out it drifts back to the middle.
  settleView() {
    const v = this.view;
    const reach = R * clamp(v.zoom - 1, 0, 1);
    const r = Math.hypot(v.tx, v.tz);
    if (r > reach) {
      const k = reach / (r || 1);
      v.tx *= k;
      v.tz *= k;
    }
    this.viewDirty = true;
    this.request();
  }

  viewPose(name) {
    const pose = { ...(VIEWS[name] || VIEWS.orbit), rot: this.view.rot, tx: 0, tz: 0 };
    if (this.width / this.height < 1.05) pose.zoom = Math.min(pose.zoom, 0.97); // keep the whole disc on tall screens
    return pose;
  }

  setView(name) {
    Object.assign(this.view, this.viewPose(name));
    this.viewDirty = true;
    this.request();
  }

  flyTo(name, duration = 1.2) {
    const to = typeof name === 'string' ? this.viewPose(name) : { ...this.view, ...name };
    return new Promise((resolve) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0.01;
      this.tween = { t: 0, duration, from: { ...this.view }, to, resolve };
      this.request();
    });
  }

  flyToLonLat(lon, lat, zoom = 3, duration = 1.2) {
    const v = lonLatToLocal(lon, lat);
    return this.flyTo({ tx: v.x, tz: v.z, zoom }, duration);
  }

  resize() {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.viewDirty = true;
    this.needsRender = true;
  }

  setPixelRatio(dpr) {
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    for (const m of [this.spaceMat, this.domeStarMat]) m.uniforms.pxScale.value = dpr;
    this.viewDirty = true;
  }

  // ---------- picking / projection ----------

  project(lon, lat, h = 0, out = { x: 0, y: 0, visible: true }) {
    const l = lonLatToLocal(lon, lat);
    const p = new THREE.Vector3(l.x, h, l.z);
    const inFront = p.clone().applyMatrix4(this.camera.matrixWorldInverse).z < 0;
    p.project(this.camera);
    out.x = ((p.x + 1) / 2) * this.width;
    out.y = ((1 - p.y) / 2) * this.height;
    out.visible = inFront && Math.abs(p.x) < 1.3 && Math.abs(p.y) < 1.3;
    return out;
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.planePoint(clientX - rect.left, clientY - rect.top);
    if (!hit || Math.hypot(hit.x, hit.z) > R) return null;
    return { lonlat: localToLonLat(hit.x, hit.z, R) };
  }

  // ---------- map style, highlights, marks ----------

  setStyle({ style, labels }) {
    if (style) this.style = style;
    if (labels !== undefined) this.labelsOn = labels;
    this.applyStyle();
    this.updateLabels(true);
    this.redraw();
  }

  applyStyle() {
    if (!this.fillPos) return;
    const classic = this.style === 'classic';
    if (classic && !this.tint) {
      const n = this.fillPos.count;
      const colours = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (const meta of this.countryList) {
        c.set(meta.ice ? '#eef6fb' : POLITICAL[meta.colour ?? 0]);
        for (let i = meta.v[0]; i < meta.v[0] + meta.v[1]; i++) colours.set([c.r, c.g, c.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', this.fillPos);
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      g.setIndex(new THREE.BufferAttribute(this.fillIdx, 1));
      this.tint = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      this.tint.renderOrder = 1;
      this.tint.frustumCulled = false;
      this.scene.add(this.tint);
    }
    if (this.tint) this.tint.visible = classic;
    if (this.borders) this.borders.material.opacity = classic ? 0.75 : 0.5;
  }

  // items: [{ feature, fill, stroke }] or [{ circle: { center: [lon, lat], radius }, fill, stroke }]
  setMarks(items) {
    this.marks = items;
    this.refreshMarks();
  }

  refreshMarks() {
    for (const m of this.markGroup.children) m.geometry.dispose?.();
    this.markGroup.clear();
    for (const it of this.marks) {
      const shape = it.feature ? this.countryShape(it.feature.properties.name) : this.circleShape(it.circle);
      if (!shape) continue;
      if (it.fill) {
        const { color, alpha } = parseColour(it.fill);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', shape.pos);
        g.setIndex(new THREE.BufferAttribute(shape.fill, 1));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(0.9, alpha * 1.35), depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        m.renderOrder = 2;
        m.frustumCulled = false;
        this.markGroup.add(m);
      }
      if (it.stroke) {
        const { color, alpha } = parseColour(it.stroke);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', shape.pos);
        g.setIndex(new THREE.BufferAttribute(shape.line, 1));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: alpha, depthWrite: false }));
        l.renderOrder = 4;
        l.frustumCulled = false;
        this.markGroup.add(l);
      }
    }
    this.redraw();
  }

  countryShape(name) {
    const c = this.countries?.get(name);
    if (!c) return null;
    const fill = this.fillIdx.subarray(c.i[0], c.i[0] + c.i[1]);
    const line = [];
    for (let k = 0; k < c.rings.length; k += 2) {
      const s = c.v[0] + c.rings[k];
      const n = c.rings[k + 1];
      for (let j = 0; j < n; j++) line.push(s + j, s + ((j + 1) % n));
    }
    return { pos: this.fillPos, fill, line: new Uint32Array(line) };
  }

  circleShape({ center, radius }) {
    const d3 = window.d3;
    const ring = d3.geoCircle().center(center).radius(radius).precision(2)().coordinates[0];
    const c = lonLatToLocal(center[0], center[1]);
    const p = [c.x, 0, c.z];
    for (const [lon, lat] of ring) {
      const v = lonLatToLocal(lon, lat);
      p.push(v.x, 0, v.z);
    }
    const n = ring.length;
    const fill = [];
    const line = [];
    for (let i = 1; i < n; i++) {
      fill.push(0, i, i + 1 > n ? 1 : i + 1);
      line.push(i, i + 1 > n ? 1 : i + 1);
    }
    return { pos: new THREE.BufferAttribute(new Float32Array(p), 3), fill: new Uint32Array(fill), line: new Uint32Array(line) };
  }

  addPin(lon, lat, colour = '#ff3b5c') {
    const el = document.createElement('div');
    el.className = 'flat-pin';
    el.style.setProperty('--c', colour);
    this.bodies.appendChild(el);
    this.pins.push({ el, lon, lat });
    this.place();
    return el;
  }

  pulseAt(lon, lat, colour = '#ffe14d') {
    const el = document.createElement('div');
    el.className = 'flat-pulse';
    el.style.setProperty('--c', colour);
    this.bodies.appendChild(el);
    this.pins.push({ el, lon, lat });
    this.place();
    return el;
  }

  clearMarks() {
    for (const p of this.pins) p.el.remove();
    this.pins = [];
  }

  place() {
    const o = { x: 0, y: 0, visible: true };
    for (const p of this.pins) {
      this.project(p.lon, p.lat, 0, o);
      p.el.style.transform = `translate(${o.x.toFixed(1)}px, ${o.y.toFixed(1)}px)`;
      p.el.style.visibility = o.visible ? '' : 'hidden';
    }
  }

  // Country names as crisp HTML labels, shown when the country is big enough on screen.
  updateLabels(force = false) {
    if (!this.labelsOn || !this.countryList) {
      if (this.labelLayer.childElementCount) { this.labelLayer.textContent = ''; this.labelEls.clear(); }
      return;
    }
    const now = performance.now();
    if (!force && now - (this.labelAt || 0) < 120) { this.labelPending = true; return; }
    this.labelAt = now;
    this.labelPending = false;
    const o = { x: 0, y: 0, visible: true };
    const cam = this.camera.position;
    const placed = [];
    const seen = new Set();
    const sorted = this.sortedLabels || (this.sortedLabels = this.countryList.filter((c) => !c.ice).sort((a, b) => b.area - a.area));
    const scale = this.height / (2 * Math.tan((FOV * DEG) / 2));
    for (const c of sorted) {
      if (placed.length > 140) break;
      this.project(c.label[0], c.label[1], 0, o);
      if (!o.visible || o.x < 0 || o.y < 0 || o.x > this.width || o.y > this.height) continue;
      const l = lonLatToLocal(c.label[0], c.label[1]);
      const dist = Math.hypot(l.x - cam.x, cam.y, l.z - cam.z);
      const side = (Math.sqrt(c.area) * (R / Math.PI) * scale) / dist; // rough on-screen size in px
      if (side < 34) continue;
      const fs = clamp(side * 0.1, 10, 22);
      const w = c.name.length * fs * 0.55;
      const box = [o.x - w / 2, o.y - fs * 0.7, o.x + w / 2, o.y + fs * 0.7];
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      seen.add(c.name);
      let el = this.labelEls.get(c.name);
      if (!el) {
        el = document.createElement('span');
        el.className = 'rw-label';
        el.textContent = c.name;
        this.labelLayer.appendChild(el);
        this.labelEls.set(c.name, el);
      }
      el.style.transform = `translate(${o.x.toFixed(0)}px, ${o.y.toFixed(0)}px) translate(-50%, -50%)`;
      el.style.fontSize = `${fs.toFixed(0)}px`;
    }
    for (const [name, el] of this.labelEls) {
      if (!seen.has(name)) { el.remove(); this.labelEls.delete(name); }
    }
  }

  // ---------- sky ----------

  setDayNight(on) {
    this.U.nightOn.value = on ? 1 : 0;
    this.cone.visible = on;
    this.redraw();
  }

  setStarAlpha(a) {
    this.domeStarMat.uniforms.alpha.value = a;
    this.constMat.opacity = 0.22 * a;
    this.redraw();
  }

  setDomeAlpha(a) {
    this.domeU.alpha.value = a;
    this.redraw();
  }

  setSky(sky) {
    const s = sky.sun;
    const moved = Math.abs(s.lon - this.sunLL.lon) > 0.05 || Math.abs(s.lat - this.sunLL.lat) > 0.02;
    const gmstMoved = this.gmst === undefined || Math.abs(sky.gmst - this.gmst) > 0.05;
    if (!moved && !gmstMoved && this.moonLL) return;
    this.sunLL = { ...s };
    this.gmst = sky.gmst;
    this.moonLL = { ...sky.moon };
    sphereVec(s.lon, s.lat, this.U.sunVec.value);
    const sp = lonLatToLocal(s.lon, s.lat);
    this.sun.position.set(sp.x, SUN_H * R, sp.z);
    this.U.sunPos.value.copy(this.sun.position);
    const mp = lonLatToLocal(sky.moon.lon, sky.moon.lat);
    this.moon.position.set(mp.x, MOON_H * R, mp.z);
    const e = sky.moon.elong * DEG;
    this.moonU.lightDir.value.set(Math.sin(e), 0, -Math.cos(e)).normalize();
    this.starGroup.rotation.y = -sky.gmst * DEG;
    // the dome glows faintly blue on the daylit half seen from the camera
    this.domeU.day.value = 0.6;
    this.needsRender = true;
    this.request();
  }

  invalidate() {
    this.redraw();
  }

  // Simple-mode hooks the game may call; nothing to do here.
  setMapImage() {}
  setMapCanvas() {}
  setOverlayCanvas() {}
  refreshOverlay() {}
  refreshDetail() {}
  setDetailPainter() {}

  onFrame(fn) {
    this.hooks.add(fn);
    return () => this.hooks.delete(fn);
  }

  // ---------- frame loop (on demand) ----------

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.step(); });
  }

  // something visible changed: draw a frame
  redraw() {
    this.needsRender = true;
    this.request();
  }

  step() {
    if (this.lost) return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    let moving = false;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = ease(tw.t);
      for (const key of ['tilt', 'zoom', 'tx', 'tz']) this.view[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * k;
      if (tw.to.rot !== undefined && tw.to.rot !== tw.from.rot) this.view.rot = tw.from.rot + (tw.to.rot - tw.from.rot) * k;
      this.viewDirty = true;
      if (tw.t >= 1) {
        this.tween = null;
        tw.resolve();
      } else moving = true;
    }
    if (this.spinInput) {
      this.view.rot += this.spinInput * dt * 40;
      this.viewDirty = true;
      moving = true;
    }
    if (this.autoSpin && !this.interacting && !this.tween && !document.hidden) {
      this.view.rot += this.autoSpin * dt * 60;
      this.viewDirty = true;
      moving = true;
    }
    const viewChanged = this.viewDirty;
    if (viewChanged) {
      this.updateCamera();
      this.place();
      this.updateLabels();
    } else if (this.labelPending) this.updateLabels();
    this.viewDirty = false;
    for (const fn of this.hooks) fn(dt, now / 1000);
    let draw = viewChanged || this.needsRender;
    if (viewChanged || this.tilesDirty) {
      this.updateTiles();
      draw = true;
    }
    if (draw) this.render(now, moving || this.interacting);
    if (moving || this.labelPending) {
      // the slow idle turn of the title screen only needs ~30 frames a second
      const idleSpin = !this.tween && !this.spinInput && !this.interacting;
      if (idleSpin) {
        clearTimeout(this.spinTimer);
        this.spinTimer = setTimeout(() => this.request(), 30);
      } else this.request();
    }
  }

  render(now, continuous) {
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
    // Adaptive resolution: if continuous frames keep running slow, render fewer pixels.
    if (continuous && this.lastFrame) {
      const gap = now - this.lastFrame;
      if (gap < 250) {
        this.frameTimes.push(gap);
        if (this.frameTimes.length >= 24) {
          const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
          this.frameTimes.length = 0;
          if (avg > 38 && this.dpr > 0.6) this.setPixelRatio(Math.max(0.6, this.dpr * 0.8));
        }
      }
    }
    this.lastFrame = now;
  }
}
