#!/usr/bin/env python3
"""Bakes the satellite imagery for the Realistic 3D view.

Inputs (public-domain NASA imagery, downloaded to ../safari-bake/src/):
  bm21600.jpg  Blue Marble Next Generation, topography + bathymetry, Dec 2004, 21600x10800
               https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x21600x10800.jpg
  night.jpg    Black Marble 2016 (city lights), 13500x6750
               https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg
  ../safari-bake/land-rings.json from scripts/bake-vectors.mjs (for the water mask)

Outputs:
  public/assets/tiles/{L}/{x}_{y}.webp  azimuthal-equidistant disc (North Pole centre, prime meridian
                                        down), 512px tiles, levels 0..5 (16384px across at level 5)
  public/assets/aux.webp                4096px: R = city lights, G = water mask
"""
import json, os, sys, math
import numpy as np
import cv2
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BAKE = os.path.abspath(os.path.join(ROOT, '..', 'safari-bake'))
OUT = os.path.join(ROOT, 'public', 'assets')
TILE = 512
MAXL = int(os.environ.get('MAXL', 5))
SS = 2  # supersampling


def disc_maps(rows, cols, n, W, H):
    """Source pixel maps for disc pixels (rows x cols are pixel indices in an n x n disc image)."""
    X = (2.0 * (cols[None, :] + 0.5) / n - 1.0).astype(np.float32)
    Z = (2.0 * (rows[:, None] + 0.5) / n - 1.0).astype(np.float32)
    r = np.sqrt(X * X + Z * Z)
    lat = np.clip(90.0 - 180.0 * r, -89.999, 90.0)
    lon = np.degrees(np.arctan2(X, Z))
    mx = ((lon + 180.0) / 360.0 * W - 0.5).astype(np.float32)
    my = ((90.0 - lat) / 180.0 * H - 0.5).astype(np.float32)
    return mx, my


def remap_disc(src, n, row0, row1, col0=0, col1=None):
    """Disc pixels [row0,row1) x [col0,col1) of an n x n disc, supersampled then box-filtered."""
    col1 = n if col1 is None else col1
    H, W = src.shape[:2]
    rows = np.arange(row0 * SS, row1 * SS, dtype=np.float32) / SS + (0.5 / SS - 0.5)
    out = np.zeros((row1 - row0, col1 - col0) + src.shape[2:], src.dtype)
    step = 4096  # cv2.remap needs < 32767 px per side
    for c0 in range(col0, col1, step):
        c1 = min(col1, c0 + step)
        cols = np.arange(c0 * SS, c1 * SS, dtype=np.float32) / SS + (0.5 / SS - 0.5)
        mx, my = disc_maps(rows, cols, n, W, H)
        part = cv2.remap(src, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        out[:, c0 - col0:c1 - col0] = cv2.resize(part, (c1 - c0, row1 - row0), interpolation=cv2.INTER_AREA)
    return out


def tile_in_disc(L, x, y):
    k = 2 ** L
    x0, x1 = 2 * x / k - 1, 2 * (x + 1) / k - 1
    z0, z1 = 2 * y / k - 1, 2 * (y + 1) / k - 1
    cx = 0 if x0 <= 0 <= x1 else min(abs(x0), abs(x1))
    cz = 0 if z0 <= 0 <= z1 else min(abs(z0), abs(z1))
    return cx * cx + cz * cz < 1.0


def grade(img):
    # Blue Marble is a touch flat; lift contrast and saturation slightly.
    f = img.astype(np.float32) / 255.0
    f = np.power(f, 0.92)
    grey = f.mean(axis=2, keepdims=True)
    f = grey + (f - grey) * 1.12
    f = (f - 0.5) * 1.06 + 0.5
    return np.clip(f * 255.0 + 0.5, 0, 255).astype(np.uint8)


def save(img_bgr, path, q=80):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)).save(path, 'WEBP', quality=q, method=5)


def bake_tiles():
    src = cv2.imread(os.path.join(BAKE, 'src', 'bm21600.jpg'), cv2.IMREAD_COLOR)
    print('source', src.shape, flush=True)
    # Inland lakes are near-black in this NASA image; give them a natural deep-lake blue.
    lake = np.array([98, 62, 28], np.float32)  # BGR
    for r0 in range(0, src.shape[0], 512):
        part = src[r0:r0 + 512].astype(np.float32)
        w = np.clip((26.0 - part.max(axis=2)) / 12.0, 0, 1)[..., None]
        src[r0:r0 + 512] = np.clip(part * (1 - w) + lake * w, 0, 255).astype(np.uint8)
    n = TILE * 2 ** MAXL
    k = 2 ** MAXL
    level = {}
    for ty in range(k):
        need = [tx for tx in range(k) if tile_in_disc(MAXL, tx, ty)]
        if not need:
            continue
        strip = grade(remap_disc(src, n, ty * TILE, (ty + 1) * TILE))
        for tx in need:
            t = strip[:, tx * TILE:(tx + 1) * TILE].copy()
            level[(tx, ty)] = t
            save(t, os.path.join(OUT, 'tiles', str(MAXL), f'{tx}_{ty}.webp'))
        print(f'L{MAXL} row {ty + 1}/{k}', flush=True)
    del src
    white = None
    for L in range(MAXL - 1, -1, -1):
        k = 2 ** L
        nxt = {}
        for ty in range(k):
            for tx in range(k):
                if not tile_in_disc(L, tx, ty):
                    continue
                quad = np.zeros((TILE * 2, TILE * 2, 3), np.uint8)
                quad[:] = (250, 248, 246)
                for dy in (0, 1):
                    for dx in (0, 1):
                        c = level.get((tx * 2 + dx, ty * 2 + dy))
                        if c is not None:
                            quad[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = c
                t = cv2.resize(quad, (TILE, TILE), interpolation=cv2.INTER_AREA)
                nxt[(tx, ty)] = t
                save(t, os.path.join(OUT, 'tiles', str(L), f'{tx}_{ty}.webp'), q=82)
        level = nxt
        print(f'L{L}: {len(level)} tiles', flush=True)


def bake_aux(n=4096):
    night = cv2.imread(os.path.join(BAKE, 'src', 'night.jpg'), cv2.IMREAD_COLOR)
    lum = cv2.cvtColor(night, cv2.COLOR_BGR2GRAY)
    lights = remap_disc(lum, n, 0, n)
    # keep the city lights, drop the faint blue-grey background of the source
    f = np.clip((lights.astype(np.float32) - 18.0) / (255.0 - 18.0), 0, 1)
    lights = np.clip(np.power(f, 1.15) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    rings = json.load(open(os.path.join(BAKE, 'land-rings.json')))
    S = n * 2
    land = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(land)
    to_px = lambda p: ((p[0] + 1) / 2 * S, (p[1] + 1) / 2 * S)
    # Rings come in polygon order (outer ring, then its holes). Antarctica's outer ring is the disc rim
    # and its hole is the coast, so polygons are drawn largest first, each with its own holes.
    polys = []
    for ring in rings:
        if not ring['hole'] or not polys:
            polys.append([ring['pts'], []])
        else:
            polys[-1][1].append(ring['pts'])
    def area(p):
        return abs(sum(p[i][0] * p[i - 1][1] - p[i - 1][0] * p[i][1] for i in range(len(p)))) / 2
    polys.sort(key=lambda pr: -area(pr[0]))
    for outer, holes in polys:
        d.polygon([to_px(p) for p in outer], fill=255)
        for h in holes:
            d.polygon([to_px(p) for p in h], fill=0)
    land = np.array(land.resize((n, n), Image.BILINEAR))
    water = 255 - land
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.hypot((xx + 0.5) / n * 2 - 1, (yy + 0.5) / n * 2 - 1)
    water[r > 0.86] = 0  # the frozen south rim never glints like open sea
    aux = np.dstack([np.zeros_like(water), water, lights])  # BGR -> R = lights, G = water
    save(aux, os.path.join(OUT, 'aux.webp'), q=88)
    print('aux done', flush=True)


if __name__ == '__main__':
    what = sys.argv[1:] or ['tiles', 'aux']
    if 'aux' in what:
        bake_aux()
    if 'tiles' in what:
        bake_tiles()
