// Simple mode: the disc model drawn without WebGL. The map is a pre-rendered picture tilted with a
// CSS transform; the ice rim, gold base, glass dome, stars, sun and moon are a few SVG shapes and DOM
// elements recomputed only when the view or the sky changes. Exposes the same API as World (world.js)
// so the game code doesn't care which one it is driving.
import { DISC_R, lonLatToLocal, lonLatToUV, uvToLonLat } from './geo.js';
import { STARS, LINES } from './astro.js';

const R = DISC_R;
const DOME = { r: 1.05, h: 0.68 }; // dome radius / height as fractions of the disc radius
const SUN_H = 0.34;
const MOON_H = 0.3;
const THICK = 0.1;
const VIEWS = {
  top: { tilt: 0, zoom: 1, fx: 0.5, fy: 0.5 },
  play: { tilt: 32, zoom: 1.12, fx: 0.5, fy: 0.5 },
  orbit: { tilt: 50, zoom: 1.2, fx: 0.5, fy: 0.5 },
  intro: { tilt: 56, zoom: 1.05, fx: 0.5, fy: 0.5 },
};
const MAX_ZOOM = 64;
const CLOSE_UP = 3; // beyond this zoom the dome, sky and rim fade out so the map has the whole view
// Zooming in eases the view from tilted to straight down (like a map app); once flat, a sharp close-up
// is drawn directly at screen resolution.
const FLATTEN_FROM = 1.25;
const FLAT_AT = 2;
const DETAIL_FROM = 1.3;
const SHAPE_SPACE = 2048; // coordinate space of the painter's cached shapes
const NS = 'http://www.w3.org/2000/svg';
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
}

function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// Convex hull (monotone chain) of screen points, used for the dome's outline.
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const poly = (pts) => `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`;

export class FlatWorld {
  constructor(container) {
    this.container = container;
    this.hooks = new Set();
    this.autoSpin = 0; // ignored in Simple mode: no continuous animation
    this.spinInput = 0;
    this.quality = 'simple';
    this.view = { ...VIEWS.intro, rot: 0 };
    this.tween = null;
    this.pins = [];
    this.raf = 0;
    this.last = performance.now();
    this.viewDirty = true;
    this.skyDirty = true;
    this.starAlpha = 1;
    this.domeAlpha = 1;
    this.sky = null;
    this.drawnSun = null;
    this.drawnGmst = null;
    this.buildDom();
    this.bindInput();
    this.resize();
    new ResizeObserver(() => { this.resize(); this.request(); }).observe(container);
    // A slow heartbeat keeps clocks and timers running when nothing is moving.
    this.heartbeat = setInterval(() => { if (!this.raf) this.step(); }, 250);
    this.request();
  }

  // ---------- DOM ----------

  buildDom() {
    const root = document.createElement('div');
    root.className = 'flat';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'The disc map under its glass dome. Drag to turn and tilt, scroll or pinch to zoom.');
    this.container.appendChild(root);
    this.root = root;

    this.starsCanvas = document.createElement('canvas');
    this.starsCanvas.className = 'flat-space';
    root.appendChild(this.starsCanvas);

    this.back = svgEl('svg', { class: 'flat-svg' });
    root.appendChild(this.back);
    const defs = svgEl('defs', {}, this.back);
    const side = svgEl('linearGradient', { id: 'fw-side', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl('stop', { offset: 0, 'stop-color': '#ffffff' }, side);
    svgEl('stop', { offset: 0.45, 'stop-color': '#a9d6f5' }, side);
    svgEl('stop', { offset: 1, 'stop-color': '#2e5f93' }, side);
    const bulb = svgEl('radialGradient', { id: 'fw-bulb' }, defs);
    svgEl('stop', { offset: 0, 'stop-color': '#fffdf0' }, bulb);
    svgEl('stop', { offset: 0.35, 'stop-color': '#ffd84a' }, bulb);
    svgEl('stop', { offset: 1, 'stop-color': 'rgba(255,170,30,0)' }, bulb);
    const glow = svgEl('radialGradient', { id: 'fw-glow' }, defs);
    svgEl('stop', { offset: 0, 'stop-color': 'rgba(60,150,255,0.45)' }, glow);
    svgEl('stop', { offset: 1, 'stop-color': 'rgba(30,90,200,0)' }, glow);
    this.halo = svgEl('path', { fill: 'url(#fw-glow)' }, this.back);
    this.frameRing = svgEl('path', { fill: 'none', stroke: '#3a4656', 'stroke-width': 3 }, this.back);
    this.sideBand = svgEl('path', { fill: 'url(#fw-side)', stroke: 'rgba(255,255,255,0.6)', 'stroke-width': 1 }, this.back);
    this.goldRing = svgEl('path', { fill: 'none', stroke: '#e7b73c', 'stroke-width': 6, 'stroke-linejoin': 'round' }, this.back);
    this.goldShine = svgEl('path', { fill: 'none', stroke: '#fff1b0', 'stroke-width': 1.5, 'stroke-opacity': 0.7 }, this.back);
    this.bulbs = svgEl('g', { fill: 'url(#fw-bulb)' }, this.back);
    this.bulbDots = Array.from({ length: 48 }, () => svgEl('circle', { r: 6 }, this.bulbs));

    const board = document.createElement('div');
    board.className = 'flat-board';
    // The map picture lives in a canvas: browsers composite canvases as textures, so zooming never
    // forces a huge re-draw of the picture the way an <img> inside a 3D transform can.
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.className = 'flat-layer';
    this.mapCanvas.width = this.mapCanvas.height = 1;
    board.appendChild(this.mapCanvas);
    this.night = document.createElement('canvas');
    this.night.className = 'flat-layer flat-night';
    this.night.width = this.night.height = 160;
    board.appendChild(this.night);
    root.appendChild(board);
    this.board = board;

    // Screen-space close-up (map + highlights), shown when zoomed in with the view flat.
    this.closeMap = document.createElement('canvas');
    this.closeOverlay = document.createElement('canvas');
    for (const c of [this.closeMap, this.closeOverlay]) {
      c.className = 'flat-close';
      c.hidden = true;
      root.appendChild(c);
    }

    this.front = svgEl('svg', { class: 'flat-svg' });
    root.appendChild(this.front);
    const fdefs = svgEl('defs', {}, this.front);
    // glass: clear in the middle, brighter towards the edges, like light catching a real dome
    const glass = svgEl('radialGradient', { id: 'fw-glass', cx: '50%', cy: '55%', r: '55%' }, fdefs);
    svgEl('stop', { offset: 0, 'stop-color': 'rgba(255,255,255,0.03)' }, glass);
    svgEl('stop', { offset: 0.62, 'stop-color': 'rgba(220,240,255,0.07)' }, glass);
    svgEl('stop', { offset: 0.88, 'stop-color': 'rgba(225,242,255,0.22)' }, glass);
    svgEl('stop', { offset: 1, 'stop-color': 'rgba(255,255,255,0.45)' }, glass);
    const iceGrad = svgEl('linearGradient', { id: 'fw-ice', x1: 0, y1: 0, x2: 0, y2: 1 }, fdefs);
    svgEl('stop', { offset: 0, 'stop-color': '#ffffff' }, iceGrad);
    svgEl('stop', { offset: 1, 'stop-color': '#a8d4f2' }, iceGrad);
    this.ice = svgEl('path', { fill: 'url(#fw-ice)', stroke: '#7fb3d9', 'stroke-width': 0.7, 'stroke-linejoin': 'round' }, this.front);
    this.domeGroup = svgEl('g', {}, this.front);
    this.domeFill = svgEl('path', { fill: 'url(#fw-glass)', stroke: 'rgba(255,255,255,0.8)', 'stroke-width': 2 }, this.domeGroup);
    this.domeShine = svgEl('path', { fill: 'none', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 7, 'stroke-linecap': 'round' }, this.domeGroup);
    this.domeShine2 = svgEl('path', { fill: 'none', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 3, 'stroke-linecap': 'round' }, this.domeGroup);
    this.starGroup = svgEl('g', {}, this.front);
    this.starLines = svgEl('path', { fill: 'none', stroke: 'rgba(143,216,255,0.35)', 'stroke-width': 1 }, this.starGroup);
    this.starDots = STARS.map(([, , , mag]) => svgEl('circle', { r: Math.max(0.8, 2.6 - mag * 0.5), fill: '#fffbe8' }, this.starGroup));

    const bodies = document.createElement('div');
    bodies.className = 'flat-bodies';
    this.sunEl = document.createElement('div');
    this.sunEl.className = 'flat-sun';
    this.moonEl = document.createElement('div');
    this.moonEl.className = 'flat-moon';
    bodies.append(this.sunEl, this.moonEl);
    root.appendChild(bodies);
    this.bodies = bodies;

    // precomputed sphere vectors for the day/night overlay
    const n = this.night.width;
    this.nightVec = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const px = ((i + 0.5) / n) * 2 - 1;
        const py = -(((j + 0.5) / n) * 2 - 1);
        const c = Math.min(1, Math.hypot(px, py)) * Math.PI;
        const a = Math.atan2(py, px);
        const k = (j * n + i) * 3;
        this.nightVec[k] = Math.sin(c) * Math.cos(a);
        this.nightVec[k + 1] = Math.sin(c) * Math.sin(a);
        this.nightVec[k + 2] = Math.cos(c);
      }
    }
    this.nightImg = this.night.getContext('2d').createImageData(n, n);
  }

  paintSpace() {
    const c = this.starsCanvas;
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const rand = rng(11);
    for (let i = 0; i < (w * h) / 2200; i++) {
      g.fillStyle = `rgba(255,255,255,${0.15 + rand() * 0.6})`;
      const s = rand() < 0.08 ? 2 : 1;
      g.fillRect(rand() * w, rand() * h, s, s);
    }
  }

  // ---------- input ----------

  bindInput() {
    const pts = new Map();
    let pinch = null;
    const root = this.root;
    root.addEventListener('pointerdown', (e) => {
      root.setPointerCapture?.(e.pointerId);
      this.board.style.willChange = 'transform';
      clearTimeout(this.sharpen);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.tween = null;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    root.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) { this.request(); return; } // hover: let the game look up the country under the cursor
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
      } else if (p.button === 2 || p.shift || v.zoom >= FLAT_AT) { // zoomed in, dragging pans like a map
        this.panBy(dx, dy);
      } else {
        v.rot += dx * (0.35 / Math.sqrt(Math.max(1, v.zoom)));
        v.tilt = clamp(v.tilt - dy * 0.25, 0, 66);
        this.viewDirty = true;
        this.request();
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) {
        clearTimeout(this.sharpen);
        this.sharpen = setTimeout(() => { this.board.style.willChange = ''; }, 400);
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.tween = null;
      this.zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
  }

  // The view orbits and zooms around a focus point on the disc (fx, fy as fractions of the board),
  // so turning or tilting while zoomed in keeps the place you're looking at on screen.
  zoomAt(factor, clientX, clientY) {
    const v = this.view;
    const rect = this.root.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const before = this.screenToBoard(sx, sy);
    v.zoom = clamp(v.zoom * factor, 0.6, MAX_ZOOM);
    this.computeMatrix();
    const after = this.screenToBoard(sx, sy);
    if (before && after) {
      v.fx += (before[0] - after[0]) / this.D;
      v.fy += (before[1] - after[1]) / this.D;
    }
    this.settleView();
  }

  panBy(dx, dy) {
    const v = this.view;
    const [cx, cy] = this.focusScreen();
    const a = this.screenToBoard(cx, cy);
    const b = this.screenToBoard(cx - dx, cy - dy);
    if (a && b) {
      v.fx += (b[0] - a[0]) / this.D;
      v.fy += (b[1] - a[1]) / this.D;
    }
    this.settleView();
  }

  zoomBy(factor) {
    const rect = this.root.getBoundingClientRect();
    const [cx, cy] = this.focusScreen();
    this.tween = null;
    this.zoomAt(factor, rect.left + cx, rect.top + cy);
  }

  // Keep the focus on the disc; when zoomed out it drifts back to the middle.
  settleView() {
    const v = this.view;
    const reach = 0.5 * clamp(v.zoom - 1, 0, 1);
    const dx = v.fx - 0.5;
    const dy = v.fy - 0.5;
    const r = Math.hypot(dx, dy);
    if (r > reach) {
      const k = reach / (r || 1);
      v.fx = 0.5 + dx * k;
      v.fy = 0.5 + dy * k;
    }
    this.computeMatrix();
    this.viewDirty = true;
    this.request();
  }

  focusScreen() {
    const lift = this.D * 0.05 * Math.sin((this.effectiveTilt() * Math.PI) / 180);
    return [this.width / 2, this.height / 2 + lift];
  }

  effectiveTilt() {
    const v = this.view;
    return v.tilt * clamp((FLAT_AT - v.zoom) / (FLAT_AT - FLATTEN_FROM), 0, 1);
  }

  // ---------- camera ----------

  resize() {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.D = Math.min(this.width * 0.84, this.height * 0.84);
    this.board.style.width = `${this.D}px`;
    this.board.style.height = `${this.D}px`;
    for (const svg of [this.back, this.front]) svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.paintSpace();
    this.closeKey = '';
    this.viewDirty = true;
  }

  computeMatrix() {
    const v = this.view;
    const D = this.D;
    const persp = Math.max(this.width, this.height) * 1.5;
    const tilt = this.effectiveTilt();
    const lift = D * 0.05 * Math.sin((tilt * Math.PI) / 180);
    const m = new DOMMatrix()
      .translate(this.width / 2, this.height / 2 + lift)
      .multiply(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / persp, 0, 0, 0, 1]))
      .rotate(tilt, 0, 0)
      .rotate(0, 0, v.rot)
      .scale(v.zoom, v.zoom, v.zoom)
      .translate(-v.fx * D, -v.fy * D);
    this.m = m;
    this.board.style.transform = m.toString();
    // up close the dome, sky and rim would only crowd the map, so they fade away
    const far = clamp((CLOSE_UP + 1 - v.zoom) / 1.5, 0, 1);
    if (far !== this.far) {
      this.far = far;
      for (const el of [this.back, this.front, this.sunEl, this.moonEl, this.night]) {
        el.style.opacity = far;
        el.style.visibility = far ? '' : 'hidden';
      }
    }
  }

  // board-local (px) -> screen (px)
  toScreen(x, y, z = 0) {
    const m = this.m;
    const w = m.m14 * x + m.m24 * y + m.m34 * z + m.m44;
    return [(m.m11 * x + m.m21 * y + m.m31 * z + m.m41) / w, (m.m12 * x + m.m22 * y + m.m32 * z + m.m42) / w, w];
  }

  // world units (disc radius R) -> board px, measured from the board centre
  get unit() {
    return this.D / 2 / R;
  }

  viewPose(name) {
    const pose = { ...(VIEWS[name] || VIEWS.orbit), rot: this.view.rot };
    pose.zoom = Math.min(pose.zoom, (this.width * 0.94) / this.D); // keep the whole disc in view on narrow screens
    return pose;
  }

  setView(name) {
    Object.assign(this.view, this.viewPose(name));
    this.viewDirty = true;
    this.request();
  }

  flyTo(name, duration = 1.2) {
    const to = typeof name === 'string' ? this.viewPose(name) : name;
    return new Promise((resolve) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0.01;
      this.tween = { t: 0, duration, from: { ...this.view }, to, resolve };
      this.request();
    });
  }

  flyToLonLat() {
    return Promise.resolve();
  }

  project(lon, lat, h = 0, out = { x: 0, y: 0, visible: true }) {
    const [u, v] = lonLatToUV(lon, lat);
    const [x, y, w] = this.toScreen(u * this.D, (1 - v) * this.D, h * this.unit);
    out.x = x;
    out.y = y;
    out.visible = w > 0;
    return out;
  }

  pick(clientX, clientY) {
    if (!this.m) return null;
    const rect = this.root.getBoundingClientRect();
    const b = this.screenToBoard(clientX - rect.left, clientY - rect.top);
    if (!b) return null;
    const u = b[0] / this.D;
    const v = 1 - b[1] / this.D;
    if (Math.hypot(u - 0.5, v - 0.5) > 0.5) return null;
    return { lonlat: uvToLonLat(u, v) };
  }

  // Screen point -> board point on the disc plane, or null if that pixel looks past the horizon.
  screenToBoard(sx, sy) {
    const m = this.m;
    // Solve the plane z = 0 for the board point that lands on (sx, sy).
    const a1 = m.m11 - sx * m.m14;
    const b1 = m.m21 - sx * m.m24;
    const c1 = sx * m.m44 - m.m41;
    const a2 = m.m12 - sy * m.m14;
    const b2 = m.m22 - sy * m.m24;
    const c2 = sy * m.m44 - m.m42;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return null;
    const x = (c1 * b2 - c2 * b1) / det;
    const y = (a1 * c2 - a2 * c1) / det;
    if (m.m14 * x + m.m24 * y + m.m44 <= 0) return null;
    return [x, y];
  }

  // ---------- zoomed-in detail ----------

  setDetailPainter(fn) {
    this.detailPainter = fn;
  }

  refreshDetail() {
    this.closeKey = '';
    this.scheduleDetail();
  }

  scheduleDetail() {
    clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.updateDetail(), 180);
  }

  closeUpActive() {
    return !!this.detailPainter && this.view.zoom >= DETAIL_FROM && this.effectiveTilt() === 0;
  }

  // Board -> screen as a 2D matrix (exact when the view is flat).
  affine() {
    const m = this.m;
    return new DOMMatrix([m.m11, m.m12, m.m21, m.m22, m.m41, m.m42]);
  }

  async updateDetail() {
    if (!this.closeUpActive() || !this.m) {
      this.hideCloseUp();
      return;
    }
    const A = this.affine();
    const key = `${A.toString()}|${this.width}x${this.height}`;
    if (key === this.closeKey) return;
    this.closeKey = key;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(this.width * dpr);
    const ch = Math.round(this.height * dpr);
    const unit = this.D / SHAPE_SPACE; // board px per shape unit
    const matrix = new DOMMatrix().scale(dpr).multiply(A).scale(unit);
    const scale = dpr * this.view.zoom * unit;
    // paint into a spare canvas so the visible close-up never flickers half-drawn
    const spare = this.spareCanvas || (this.spareCanvas = document.createElement('canvas'));
    spare.width = cw;
    spare.height = ch;
    const ok = await this.detailPainter(spare, matrix, scale);
    if (!ok || key !== this.closeKey || !this.closeUpActive()) return;
    for (const c of [this.closeMap, this.closeOverlay]) {
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
      c.style.transform = '';
      c.hidden = false;
    }
    this.closeMap.getContext('2d').drawImage(spare, 0, 0);
    this.closeRendered = A;
    this.overlayTarget = { canvas: this.closeOverlay, matrix, scale };
    this.onOverlayChange?.(); // the game redraws its highlights onto the close-up
  }

  hideCloseUp() {
    if (this.closeMap.hidden) return;
    this.closeMap.hidden = true;
    this.closeOverlay.hidden = true;
    this.closeKey = '';
    this.overlayTarget = null;
    this.onOverlayChange?.();
  }

  // While moving, slide the last close-up along with the view until it is redrawn.
  trackCloseUp() {
    if (this.closeMap.hidden) return;
    if (!this.closeUpActive()) {
      this.hideCloseUp();
      return;
    }
    const delta = this.affine().multiply(this.closeRendered.inverse());
    const t = delta.toString();
    this.closeMap.style.transform = t;
    this.closeOverlay.style.transform = t;
  }

  // ---------- map & overlays ----------

  setMapImage(src) {
    if (this.mapSrc === src) return;
    this.mapSrc = src;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (this.mapSrc !== src) return;
      this.mapCanvas.width = img.naturalWidth;
      this.mapCanvas.height = img.naturalHeight;
      this.mapCanvas.getContext('2d').drawImage(img, 0, 0);
      this.request();
    };
    img.src = src;
  }

  setMapCanvas() {}

  setOverlayCanvas(canvas) {
    canvas.classList.add('flat-layer');
    this.board.appendChild(canvas);
  }

  refreshOverlay() {}

  invalidate() {
    this.request();
  }

  setDayNight(on) {
    this.night.style.display = on ? '' : 'none';
  }


  setStarAlpha(a) {
    this.starAlpha = a;
    this.starGroup.setAttribute('opacity', a);
  }

  setDomeAlpha(a) {
    this.domeAlpha = a;
    this.domeGroup.setAttribute('opacity', a);
  }

  setSky(sky) {
    this.sky = sky;
    const moved = !this.drawnSun || Math.abs(sky.sun.lon - this.drawnSun.lon) > 1.5 || Math.abs(sky.sun.lat - this.drawnSun.lat) > 0.5;
    if (moved) {
      this.paintNight(sky.sun);
      this.drawnSun = { ...sky.sun };
      this.skyDirty = true;
    }
    if (this.drawnGmst === null || Math.abs(sky.gmst - this.drawnGmst) > 1) this.skyDirty = true;
  }

  paintNight(sun) {
    const [u, v] = lonLatToUV(sun.lon, sun.lat);
    const px = u * 2 - 1;
    const py = v * 2 - 1;
    const c = Math.min(1, Math.hypot(px, py)) * Math.PI;
    const a = Math.atan2(py, px);
    const s = [Math.sin(c) * Math.cos(a), Math.sin(c) * Math.sin(a), Math.cos(c)];
    const vec = this.nightVec;
    const data = this.nightImg.data;
    for (let i = 0, k = 0; k < vec.length; i += 4, k += 3) {
      const d = vec[k] * s[0] + vec[k + 1] * s[1] + vec[k + 2] * s[2];
      const t = clamp((d + 0.1) / 0.17, 0, 1);
      const day = t * t * (3 - 2 * t);
      const dusk = Math.exp(-(((d + 0.015) / 0.055) ** 2));
      data[i] = 6 + dusk * 120;
      data[i + 1] = 12 + dusk * 40;
      data[i + 2] = 40;
      data[i + 3] = (1 - day) * 115 + dusk * 30;
    }
    this.night.getContext('2d').putImageData(this.nightImg, 0, 0);
  }

  addPin(lon, lat, colour = '#ff3b5c') {
    const el = document.createElement('div');
    el.className = 'flat-pin';
    el.style.setProperty('--c', colour);
    this.bodies.appendChild(el);
    this.pins.push({ el, lon, lat, kind: 'pin' });
    this.place();
    return el;
  }

  pulseAt(lon, lat, colour = '#ffe14d') {
    const el = document.createElement('div');
    el.className = 'flat-pulse';
    el.style.setProperty('--c', colour);
    this.bodies.appendChild(el);
    this.pins.push({ el, lon, lat, kind: 'pulse' });
    this.place();
    return el;
  }

  clearMarks() {
    for (const p of this.pins) p.el.remove();
    this.pins = [];
  }

  onFrame(fn) {
    this.hooks.add(fn);
    return () => this.hooks.delete(fn);
  }

  // ---------- drawing ----------

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.step(); });
  }

  step() {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    let moving = false;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = ease(tw.t);
      for (const key of ['tilt', 'zoom', 'fx', 'fy']) this.view[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * k;
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
    const viewChanged = this.viewDirty;
    if (viewChanged) this.computeMatrix();
    this.viewDirty = false;
    for (const fn of this.hooks) fn(dt, now / 1000);
    if (viewChanged && this.far) this.drawStatic();
    if ((viewChanged || this.skyDirty) && this.far) this.drawSky();
    if (viewChanged) {
      this.place();
      this.trackCloseUp();
      this.scheduleDetail();
    }
    this.skyDirty = false;
    if (moving) this.request();
  }

  rim(radiusFrac, z, n = 96) {
    const c = this.D / 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(this.toScreen(c + Math.cos(a) * c * radiusFrac, c + Math.sin(a) * c * radiusFrac, z));
    }
    return out;
  }

  drawStatic() {
    const c = this.D / 2;
    const zBottom = -THICK * c;
    const top = this.rim(1, 0);
    const bottom = this.rim(0.985, zBottom);
    // side band: the visible front edge between the top rim and the bottom rim
    const band = top.map((p) => [p[0], p[1]]).concat(bottom.slice().reverse().map((p) => [p[0], p[1]]));
    this.sideBand.setAttribute('d', poly(hull(band)));
    this.goldRing.setAttribute('d', poly(bottom));
    this.goldShine.setAttribute('d', poly(this.rim(0.985, zBottom * 0.93)));
    this.frameRing.setAttribute('d', poly(this.rim(1.28, zBottom * 1.3)));
    this.halo.setAttribute('d', poly(this.rim(1.7, zBottom * 2, 64)));
    this.bulbDots.forEach((dot, i) => {
      const p = bottom[(i * 2) % bottom.length];
      dot.setAttribute('cx', p[0].toFixed(1));
      dot.setAttribute('cy', p[1].toFixed(1));
    });

    // jagged ice crown standing on the rim
    const n = 140;
    const rand = rng(5);
    let d = '';
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const h = (0.03 + rand() * 0.075) * c;
      const b0 = this.toScreen(c + Math.cos(a0) * c, c + Math.sin(a0) * c, 0);
      const tip = this.toScreen(c + Math.cos(am) * c * 1.004, c + Math.sin(am) * c * 1.004, h);
      const b1 = this.toScreen(c + Math.cos(a1) * c, c + Math.sin(a1) * c, 0);
      d += `M${b0[0].toFixed(1)},${b0[1].toFixed(1)}L${tip[0].toFixed(1)},${tip[1].toFixed(1)}L${b1[0].toFixed(1)},${b1[1].toFixed(1)}Z`;
    }
    this.ice.setAttribute('d', d);

    // glass dome: outline is the convex hull of points sampled over the dome surface
    const pts = [];
    for (let e = 0; e <= 6; e++) {
      const el = (e / 6) * (Math.PI / 2);
      const ring = Math.cos(el) * DOME.r * c;
      const z = Math.sin(el) * DOME.h * c;
      const steps = e === 6 ? 1 : 36;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const p = this.toScreen(c + Math.cos(a) * ring, c + Math.sin(a) * ring, z);
        pts.push([p[0], p[1]]);
      }
    }
    const outline = hull(pts);
    this.domeFill.setAttribute('d', poly(outline));
    // Highlights on the glass stay put relative to the viewer while the disc turns underneath.
    const spin = (this.view.rot * Math.PI) / 180;
    const arc = (a0, a1, e0, e1, scale) => {
      const out = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const a = Math.PI * (a0 + (a1 - a0) * t) - spin;
        const el = e0 + (e1 - e0) * t;
        const rr = Math.cos(el) * DOME.r * c * scale;
        const p = this.toScreen(c + Math.cos(a) * rr, c + Math.sin(a) * rr, Math.sin(el) * DOME.h * c * scale);
        out.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      return `M${out.join('L')}`;
    };
    this.domeShine.setAttribute('d', arc(1.08, 1.32, 0.55, 0.95, 0.97));
    this.domeShine2.setAttribute('d', arc(1.62, 1.74, 0.85, 0.7, 0.97));
  }

  domePoint(lon, lat) {
    const c = this.D / 2;
    const l = lonLatToLocal(lon, lat, 1);
    const r = Math.min(1, l.r * 0.97);
    const k = r / DOME.r;
    const z = DOME.h * Math.sqrt(Math.max(0, 1 - k * k)) * c * 0.985;
    return this.toScreen(c + l.x * 0.97 * c, c + l.z * 0.97 * c, z);
  }

  drawSky() {
    const sky = this.sky;
    if (!sky || !this.m) return;
    this.drawnGmst = sky.gmst;
    const pos = new Map();
    STARS.forEach(([name, ra, dec], i) => {
      const p = this.domePoint(ra - sky.gmst, dec);
      pos.set(name, p);
      this.starDots[i].setAttribute('cx', p[0].toFixed(1));
      this.starDots[i].setAttribute('cy', p[1].toFixed(1));
    });
    let d = '';
    for (const [a, b] of LINES) {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (pa && pb) d += `M${pa[0].toFixed(1)},${pa[1].toFixed(1)}L${pb[0].toFixed(1)},${pb[1].toFixed(1)}`;
    }
    this.starLines.setAttribute('d', d);
    this.placeBody(this.sunEl, sky.sun.lon, sky.sun.lat, SUN_H * R, 30);
    this.placeBody(this.moonEl, sky.moon.lon, sky.moon.lat, MOON_H * R, 20);
    const shade = (1 - sky.moon.illum) * 20 * (sky.moon.elong < 180 ? -1 : 1);
    this.moonEl.style.setProperty('--shade', `${shade.toFixed(1)}px`);
  }

  placeBody(el, lon, lat, h, size) {
    const p = this.project(lon, lat, h);
    const s = clamp(this.view.zoom, 0.7, 2.2) * size;
    el.style.transform = `translate(${(p.x - s / 2).toFixed(1)}px, ${(p.y - s / 2).toFixed(1)}px)`;
    el.style.width = el.style.height = `${s.toFixed(1)}px`;
  }

  place() {
    if (!this.m) return;
    const o = { x: 0, y: 0, visible: true };
    for (const p of this.pins) {
      this.project(p.lon, p.lat, 0, o);
      p.el.style.transform = `translate(${o.x.toFixed(1)}px, ${o.y.toFixed(1)}px)`;
    }
  }
}
