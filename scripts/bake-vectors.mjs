// Bakes the 1:50m Natural Earth countries into GPU-ready geometry for the Realistic 3D view:
//   public/data/vectors.bin  - Int16 disc positions, Uint32 triangle indices, coastline + border lines
//   public/data/vectors.json - per-country metadata (name, colour, ranges, rings, label point, area)
// and, for scripts/bake-tiles.py, the projected land rings used to make the water mask.
// Run: node scripts/bake-vectors.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as d3 from 'd3-geo';
import * as topojson from 'topojson-client';
import earcut from 'earcut';

const root = new URL('..', import.meta.url).pathname;
globalThis.window = { d3, topojson };
const { Geo } = await import(`${root}public/src/geo.js`);

const topology = JSON.parse(await readFile(`${root}public/data/countries-50m.json`, 'utf8'));
const geo = new Geo(topology);
geo.colourise();

const Q = 32767; // Int16 quantisation of the unit disc
const toDisc = ([lon, lat]) => {
  const r = (90 - lat) / 180;
  const l = (lon * Math.PI) / 180;
  return [r * Math.sin(l), r * Math.cos(l)];
};

// Densify long edges in lon/lat before projecting: edges along parallels (and the south-pole
// closing edge of Antarctica) are arcs on the disc.
function densify(ring) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = [...ring[i + 1]];
    out.push(a);
    // Edges that cross the antimeridian go the short way round. (Antarctica's outer ring is a full
    // circle of short steps along latitude -89.999, which becomes the rim of the disc.)
    if (Math.abs(b[0] - a[0]) > 180) b[0] += b[0] < a[0] ? 360 : -360;
    const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 0.5);
    for (let s = 1; s < steps; s++) out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
  }
  return out; // open ring (last point == first point dropped)
}

const pos = [];
const idx = [];
const meta = [];
const landRings = [];
for (const f of geo.features) {
  const g = f.geometry;
  if (!g) continue;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const v0 = pos.length / 2;
  const i0 = idx.length;
  const rings = [];
  for (const poly of polys) {
    const flat = [];
    const holes = [];
    const base = pos.length / 2;
    poly.forEach((ring, ri) => {
      const pts = densify(ring).map(toDisc);
      if (pts.length < 3) return;
      if (ri > 0) holes.push(flat.length / 2);
      rings.push(pos.length / 2 + flat.length / 2 - v0, pts.length);
      for (const [x, z] of pts) flat.push(x, z);
      landRings.push({ hole: ri > 0, pts: pts.map(([x, z]) => [+x.toFixed(5), +z.toFixed(5)]) });
    });
    if (flat.length < 6) continue;
    const tri = earcut(flat, holes.length ? holes : null, 2);
    for (let k = 0; k < flat.length; k++) pos.push(Math.round(flat[k] * Q));
    for (const t of tri) idx.push(base + t);
  }
  const lp = geo.labelPoint(f);
  meta.push({
    name: f.properties.name,
    colour: f.properties.colour,
    ice: f.properties.isIce || undefined,
    v: [v0, pos.length / 2 - v0],
    i: [i0, idx.length - i0],
    rings,
    label: [+lp[0].toFixed(3), +lp[1].toFixed(3)],
    area: +geo.area(f).toFixed(6),
  });
}

// Coastlines (arcs used by one country) and borders (shared arcs), as line strips.
function strips(mesh) {
  const p = [];
  const lens = [];
  for (const line of mesh.coordinates) {
    const pts = densify([...line, line[line.length - 1]]).map(toDisc);
    if (pts.length < 2) continue;
    lens.push(pts.length);
    for (const [x, z] of pts) p.push(Math.round(x * Q), Math.round(z * Q));
  }
  return { p, lens };
}
const obj = topology.objects.countries;
const coast = strips(topojson.mesh(topology, obj, (a, b) => a === b));
const border = strips(topojson.mesh(topology, obj, (a, b) => a !== b));

const parts = [
  ['fillPos', Int16Array.from(pos)],
  ['fillIdx', Uint32Array.from(idx)],
  ['coastPos', Int16Array.from(coast.p)],
  ['coastLen', Uint32Array.from(coast.lens)],
  ['borderPos', Int16Array.from(border.p)],
  ['borderLen', Uint32Array.from(border.lens)],
];
let offset = 0;
const layout = {};
const chunks = [];
for (const [name, arr] of parts) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  layout[name] = { offset, length: arr.length, type: arr.constructor.name };
  chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  offset += arr.byteLength;
}
await writeFile(`${root}public/data/vectors.bin`, Buffer.concat(chunks));
await writeFile(`${root}public/data/vectors.json`, JSON.stringify({ q: Q, layout, countries: meta }));
await mkdir(`${root}../safari-bake`, { recursive: true });
await writeFile(`${root}../safari-bake/land-rings.json`, JSON.stringify(landRings));
console.log(`countries ${meta.length}, vertices ${pos.length / 2}, triangles ${idx.length / 3}, coast pts ${coast.p.length / 2}, border pts ${border.p.length / 2}, bin ${(offset / 1024).toFixed(0)} KB`);
