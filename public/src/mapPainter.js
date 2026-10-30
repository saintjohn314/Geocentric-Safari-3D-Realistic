// Paints the azimuthal-equidistant disc texture (and a lightweight highlight overlay) with D3 on canvas.
import { makeProjection } from './geo.js';

const { d3 } = window;

const POLITICAL = ['#f6d55c', '#f59b5b', '#9bd06a', '#ef6f8d', '#c4a7ec', '#7fd8c0'];
const ICE = '#eef6fb';

const CIRCLES = [
  { lat: 66.56, label: 'ARCTIC CIRCLE', colour: '#a8ecff', dash: [10, 8], width: 2.2, at: -135 },
  { lat: 23.44, label: 'TROPIC OF CANCER', colour: '#ffb35c', dash: [10, 8], width: 2.4, at: -130 },
  { lat: 0, label: 'EQUATOR', colour: '#ffe066', dash: [18, 8], width: 4, at: -122 },
  { lat: -23.44, label: 'TROPIC OF CAPRICORN', colour: '#ffb35c', dash: [10, 8], width: 2.4, at: -117 },
];

export class MapPainter {
  constructor(geo, size, overlaySize = 1024) {
    this.geo = geo;
    this.size = size; // coordinate space of the cached shapes (and of the full-disc picture in 3D mode)
    this.overlay = document.createElement('canvas');
    this.overlay.width = this.overlay.height = overlaySize;
    this.overlayPaths = new Map();
    this.token = 0;
    this.detailToken = 0;
  }

  // Project every shape once into reusable Path2D objects; repaints (labels, map style, zoomed-in
  // detail) then only fill pixels.
  async buildPaths(pause) {
    if (this.paths) return;
    if (this.building) return this.building;
    this.building = (async () => {
      this.geo.colourise();
      const proj = makeProjection(this.size);
      const toPath = (obj) => {
        const p = new Path2D();
        d3.geoPath(proj, p)(obj);
        return p;
      };
      const area = d3.geoPath(proj);
      const paths = { proj, land: toPath(this.geo.land) };
      await pause();
      paths.borders = toPath(this.geo.borders);
      paths.graticule = toPath(d3.geoGraticule().step([15, 15]).extentMajor([[-180, -89.999], [180, 89.999]])());
      await pause();
      paths.features = [];
      for (const [i, f] of this.geo.features.entries()) {
        paths.features.push({ f, path: toPath(f), area: area.area(f) });
        if (i % 60 === 59) await pause();
      }
      this.paths = paths;
    })();
    return this.building;
  }

  // The whole disc as one picture (3D mode). Paints in small steps, yielding to the browser between
  // them so the page never locks up. Returns false if a newer paint request superseded this one.
  async paintBase({ style = 'classic', labels = false } = {}, pause = nextFrame) {
    const token = ++this.token;
    await this.buildPaths(pause);
    if (token !== this.token) return false;
    const S = this.size;
    const k = S / 4096;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.canvas.height = S;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    return this.render(ctx, {
      style,
      labels,
      lw: (w) => w * k,
      labelSize: (a) => (a < 700 * k * k ? 0 : Math.max(18 * k, Math.min(140 * k, Math.sqrt(a) * 0.15))),
      grainScale: 1,
    }, async () => {
      if (token !== this.token) return false;
      await pause();
      return token === this.token;
    });
  }

  // A sharp close-up drawn straight onto a screen-sized canvas. `matrix` maps shape units to canvas
  // pixels and `scale` is its zoom (canvas pixels per shape unit), so lines and lettering keep a
  // constant on-screen size however far you zoom in.
  async paintDetail(canvas, matrix, scale, { style = 'classic', labels = false } = {}) {
    const token = ++this.detailToken;
    await this.buildPaths(nextFrame);
    if (token !== this.detailToken) return false;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(matrix);
    const ok = await this.render(ctx, {
      style,
      labels,
      lw: (w) => (w * 0.55) / scale,
      labelSize: (a) => {
        const side = Math.sqrt(a) * scale;
        return side < 30 ? 0 : Math.max(11, Math.min(30, side * 0.12)) / scale;
      },
      grainScale: 1 / scale,
    }, async () => {
      if (token !== this.detailToken) return false;
      await nextFrame();
      return token === this.detailToken;
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ok;
  }

  async render(ctx, cfg, step) {
    const { proj, land, borders, graticule, features } = this.paths;
    const { lw } = cfg;
    const S = this.size;
    const c = S / 2;
    const classic = cfg.style !== 'terrain';
    const rAt = (lat) => ((90 - lat) / 180) * c;
    const grain = ctx.createPattern(noiseTile(), 'repeat');
    grain.setTransform?.(new DOMMatrix().scale(cfg.grainScale));

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.clip();

    // Ocean
    const ocean = ctx.createRadialGradient(c, c, 0, c, c, c);
    (classic
      ? [[0, '#6fc3ee'], [0.5, '#3d97d6'], [0.85, '#2a77bb'], [1, '#1f5f9e']]
      : [[0, '#3d8fcf'], [0.5, '#1f64ab'], [0.85, '#164f8f'], [1, '#113f74']]
    ).forEach(([o, col]) => ocean.addColorStop(o, col));
    ctx.fillStyle = ocean;
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 1;

    // Shallow-water glow along every coast: a few soft strokes instead of a costly blur filter
    ctx.lineJoin = 'round';
    for (const [w, a] of [[30, 0.12], [18, 0.2], [9, 0.3]]) {
      ctx.lineWidth = lw(w);
      ctx.strokeStyle = classic ? `rgba(200,240,255,${a})` : `rgba(120,210,255,${a * 0.85})`;
      ctx.stroke(land);
    }

    ctx.lineWidth = lw(1.4);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.stroke(graticule);
    if (!(await step())) { ctx.restore(); return false; }

    // Land
    if (classic) {
      for (const { f, path } of features) {
        ctx.fillStyle = f.properties.isIce ? ICE : POLITICAL[f.properties.colour];
        ctx.fill(path);
      }
    } else {
      const t = ctx.createRadialGradient(c, c, 0, c, c, c);
      [
        [0, '#eef5f7'], [0.1, '#dfe9e4'], [0.14, '#a3b897'], [0.2, '#5e8b4f'], [0.29, '#6f9f50'],
        [0.34, '#b5a85e'], [0.38, '#d9b97a'], [0.42, '#c9ad6a'], [0.46, '#5f9a43'], [0.5, '#3c7b33'],
        [0.56, '#5f9a43'], [0.61, '#c4a96b'], [0.67, '#c9ae6e'], [0.72, '#7ea456'], [0.8, '#8ea98a'],
        [0.85, '#e6eff4'], [1, '#f7fbff'],
      ].forEach(([o, col]) => t.addColorStop(o, col));
      ctx.fillStyle = t;
      ctx.fill(land);
    }
    // printed-card grain on the land
    ctx.save();
    ctx.clip(land);
    ctx.globalAlpha = classic ? 0.7 : 1;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
    if (!(await step())) { ctx.restore(); return false; }

    // Borders + coastlines
    ctx.lineWidth = lw(classic ? 1.6 : 1.2);
    ctx.strokeStyle = classic ? 'rgba(60,40,40,0.55)' : 'rgba(40,30,15,0.45)';
    ctx.stroke(borders);
    ctx.lineWidth = lw(2);
    ctx.strokeStyle = classic ? 'rgba(20,50,90,0.75)' : 'rgba(10,40,70,0.6)';
    ctx.stroke(land);

    // Ice rim: guarantee a clean frozen edge all the way round
    const ice = ctx.createRadialGradient(c, c, rAt(-74), c, c, c);
    ice.addColorStop(0, 'rgba(238,246,251,0)');
    ice.addColorStop(0.35, 'rgba(238,246,251,0.9)');
    ice.addColorStop(1, '#ffffff');
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.arc(c, c, rAt(-74), 0, Math.PI * 2, true);
    ctx.fillStyle = ice;
    ctx.fill('evenodd');

    // Named circles of latitude, with lettering set along the curve
    for (const circle of CIRCLES) {
      const r = rAt(circle.lat);
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.setLineDash(circle.dash.map((v) => lw(v)));
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = lw(circle.width * 3);
      ctx.strokeStyle = circle.colour;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = lw(circle.width);
      ctx.stroke();
      ctx.restore();
      arcText(ctx, circle.label, c, r + lw(16), circle.at, lw(26), circle.colour);
    }

    // Longitude ring on the ice
    ctx.save();
    ctx.font = `600 ${lw(30)}px "Fredoka Variable", "Fredoka", sans-serif`;
    ctx.fillStyle = '#25507e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let lon = -150; lon <= 180; lon += 30) {
      const [x, y] = proj([lon, -84.5]);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(y - c, x - c) - Math.PI / 2);
      ctx.fillText(lon === 0 ? '0°' : lon === 180 ? '180°' : `${Math.abs(lon)}°${lon > 0 ? 'E' : 'W'}`, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // Compass star on the North Pole
    compass(ctx, c, c, lw(46));

    if (cfg.labels) this.paintLabels(ctx, proj, cfg.labelSize);
    ctx.restore();
    return step();
  }

  paintLabels(ctx, proj, labelSize) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const { f, area } of this.paths.features) {
      if (f.properties.isIce) continue;
      const size = labelSize(area);
      if (!size) continue;
      const [x, y] = proj(this.geo.labelPoint(f));
      ctx.font = `600 ${size}px "Fredoka Variable", "Fredoka", sans-serif`;
      ctx.lineWidth = size * 0.28;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.fillStyle = '#1b2433';
      ctx.strokeText(f.properties.name, x, y);
      ctx.fillText(f.properties.name, x, y);
    }
    ctx.restore();
  }

  // Highlights. items: [{ feature, fill, stroke }] or [{ circle: {center:[lon,lat], radius:deg}, fill, stroke }].
  // Drawn onto the painter's own full-disc overlay, or onto `target` ({ canvas, matrix, scale } in
  // shape space, like paintDetail) for a sharp close-up.
  paintOverlay(items, target = null) {
    const cv = target ? target.canvas : this.overlay;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    let m;
    if (target) {
      ctx.setTransform(target.matrix); // target space is the same 2048-unit shape space as OVERLAY_SPACE
      m = target.scale;
    } else {
      m = cv.width / OVERLAY_SPACE;
      ctx.setTransform(m, 0, 0, m, 0, 0);
    }
    for (const it of items) {
      const path = it.feature ? this.overlayPath(it.feature) : this.circlePath(it.circle);
      if (it.fill) { ctx.fillStyle = it.fill; ctx.fill(path); }
      if (it.stroke) { ctx.lineWidth = ((it.width || 6) * 0.5) / m; ctx.strokeStyle = it.stroke; ctx.stroke(path); }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  overlayPath(feature) {
    let p = this.overlayPaths.get(feature);
    if (!p) {
      p = new Path2D();
      d3.geoPath(makeProjection(OVERLAY_SPACE), p)(feature);
      this.overlayPaths.set(feature, p);
    }
    return p;
  }

  circlePath(circle) {
    const p = new Path2D();
    d3.geoPath(makeProjection(OVERLAY_SPACE), p)(d3.geoCircle().center(circle.center).radius(circle.radius).precision(2)());
    return p;
  }
}

const OVERLAY_SPACE = 2048; // highlight shapes are projected once into this coordinate space
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

let tile = null;
function noiseTile() {
  if (tile) return tile;
  tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  const g = tile.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = Math.random();
    const light = r > 0.5;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 255 : 30;
    img.data[i + 3] = r > 0.93 || r < 0.07 ? 22 : 0;
  }
  g.putImageData(img, 0, 0);
  return tile;
}

function arcText(ctx, text, c, r, startDeg, size, colour) {
  ctx.save();
  ctx.font = `700 ${size}px "Fredoka Variable", "Fredoka", sans-serif`;
  ctx.fillStyle = colour;
  ctx.strokeStyle = 'rgba(10,30,60,0.55)';
  ctx.lineWidth = size * 0.22;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let a = (startDeg * Math.PI) / 180;
  for (const ch of text) {
    const w = ctx.measureText(ch).width + size * 0.08;
    const da = w / r;
    a += da / 2;
    ctx.save();
    ctx.translate(c + r * Math.cos(a), c + r * Math.sin(a));
    ctx.rotate(a + Math.PI / 2);
    ctx.strokeText(ch, 0, 0);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    a += da / 2;
  }
  ctx.restore();
}

function compass(ctx, x, y, r) {
  ctx.save();
  ctx.translate(x, y);
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    const len = long ? r : r * 0.55;
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.lineTo(r * 0.14, 0);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = long ? '#ffd23f' : '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.lineTo(-r * 0.14, 0);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = long ? '#c98f00' : '#9fb4c8';
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = '#ff3b5c';
  ctx.fill();
  ctx.restore();
}
