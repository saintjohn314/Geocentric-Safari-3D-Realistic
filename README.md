# Geocentric Safari 3D

**The electronic geography quiz — on the disc.** A tribute to the classic 90's GeoSafari quiz console, played on a flat earth (azimuthal-equidistant) map under a glass firmament dome.

Live: https://geocentric-safari-3d.netlify.app

![Geocentric Safari 3D](public/assets/og-image.jpg)

## What's in the box

- **Lesson cards, GeoSafari style.** 7 cards × 20 numbered spots: Nations of the Disc, Capital Cities, Wonders & Landmarks, Peaks & Volcanoes, Oceans/Seas & Lakes, Islands & Territories, Explorer's Extremes. Every spot has a clue and a "did you know?" fact.
- **The console.** 20 question lamps around the board, red seven-segment score displays, an amber countdown timer, a green entry readout and a chunky rubber keypad. Answer by typing the spot number and pressing **GO**, or tap the spot.
- **Three tries, beat the clock.** First-try answers score 100, then 60, then 30, plus 5 points per second left and a streak bonus. After a miss the right spot flashes so everyone learns it.
- **Two-player mode.** Players alternate, each with their own score display and turn light.
- **Map Hunt mode.** No numbers — tap the place itself. Misses tell you how far off you were and which way to head.
- **A living sky.** The sun, moon (with its real phase) and constellations hang over the places where they are overhead *right now*, computed from a low-precision ephemeris. Daylight sweeps across the disc; speed the sky clock up in Settings.
- **The model.** North Pole at the centre, the prime meridian pointing down (the UN-emblem layout), the Antarctic ice rim as a wall of ice, a gold base ring with lights, and the glass firmament dome over it all.
- **Zoom right in.** Scroll, pinch or use ＋/－ up to 64×. As you zoom in the view flattens to straight-down and the map is redrawn sharply from the detailed (1:50m) data, so even Luxembourg or Malta fill the screen.
- **Free Explore.** Hover or tap anywhere to identify countries with their coordinates, local solar time and sun altitude.
- **Polish.** Synthesised console sounds, optional talking console (reads questions aloud), country-name labels, natural-colour or lesson-card map styles, keyboard shortcuts and high scores per card.

## Graphics modes

- **Realistic 3D (default on computers with graphics acceleration)** - WebGL. The disc is real NASA satellite imagery (Blue Marble, with Black Marble city lights on the night side) in 512px tiles up to 16,384px across, so it stays sharp as you zoom in (up to 180x). Borders and coastlines are GPU lines from Natural Earth 1:50m, crisp at any zoom. Around it: a jagged ice wall, rock strata under the rim, and a glass firmament dome with the real stars, the sun (with its spotlight cone) and the moon (with its real phase) over the places where they're overhead right now. It only draws a frame when something changes, compiles shaders asynchronously, caps its texture cache and lowers its resolution automatically if frames run slow.
- **Simple** - no WebGL at all. Chosen automatically when the browser has no graphics acceleration, or in Settings.
- **Boot watchdog** - if a 3D start ever fails to reach the title screen, the next visit starts in Simple mode.

Append `?gfx=simple`, `?gfx=low` or `?gfx=high` to the URL to force a mode for testing.

### Why the old versions froze

The first release installed a service worker that served `js/*.js` cache-first, so returning visitors kept running that release's heavy code (12+ seconds of blocking map painting) under newer pages. Scripts now live in `src/` (URLs the old cache never held), the retired `sw.js` unregisters itself, and graphics choices saved by earlier releases are discarded.

## Rebuilding the map data

```bash
npm install
npm run bake:vectors   # countries -> public/data/vectors.bin/.json (+ land rings for the water mask)
npm run bake:tiles     # NASA imagery -> public/assets/tiles/ and public/assets/aux.webp (needs Python, OpenCV, Pillow)
```

`bake-tiles.py` lists the NASA source images it expects in `../safari-bake/src/`.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Turn & tilt / zoom / pan | Drag · scroll, pinch or ＋/－ · right-drag, shift-drag or two fingers (drag pans once zoomed in) | `+` / `-` zoom |
| Turn the disc | ⟲ ⟳ buttons | `A` / `D` |
| Top-down card view / 3D view | TOP / 3D | `T` / `V` |
| Enter a spot number | Keypad | `0`–`9`, `Enter` = GO, `Backspace` = CLR |
| Hint (half points) | HINT | `H` |
| Country names | 🏷️ | `L` |
| Pause / menu | MENU | `Esc` |

## Project layout

```
public/            ← the whole site (Netlify publishes this folder)
  index.html
  css/style.css
  src/             ← app.js (game), realworld.js (Realistic 3D, three.js), flatworld.js (Simple mode), probe.js,
                     mapPainter.js (D3 map drawing), spots.js (numbered spots), cards.js (lesson cards),
                     astro.js (sun/moon/stars), geo.js (map data + disc maths), sevenseg.js, audio.js, main.js
  assets/          ← pre-rendered disc maps (map-*.webp), cover art, icons
  data/            ← Natural Earth countries (world-atlas 110m for start-up, 50m for close-ups and 3D)
  vendor/          ← three.js, d3-geo, topojson, fonts — copied from npm, no CDN needed
  sw.js            ← retires the offline cache used by earlier releases
scripts/           ← vendor.mjs, bake-maps.cjs, serve.mjs
netlify.toml       ← publish dir, security headers (CSP), caching
```

## Develop

```bash
npm install
npm run vendor  # copy three.js, d3, topojson, fonts and map data into public/
npm start       # http://localhost:8080
npm run bake    # (with npm start running) re-render public/assets/map-*.webp after changing mapPainter.js
```

`npm run bake` needs Playwright with Chromium (`npx playwright install chromium`).

## Deploy to Netlify

The Netlify project **geocentric-safari-3d** is already set up. Pick one:

- **Connected repo (current setup):** every push to the linked branch deploys automatically. `netlify.toml` sets the publish folder (`public`) and no build command.
- **One-off deploy from your machine:**
  ```bash
  npx netlify-cli deploy --prod --dir=public --site=geocentric-safari-3d
  ```

## Credits

Satellite imagery: NASA Visible Earth (Blue Marble Next Generation, Black Marble 2016), public domain. Map data © [Natural Earth](https://www.naturalearthdata.com/) via [world-atlas](https://github.com/topojson/world-atlas). Built with [d3-geo](https://github.com/d3/d3-geo), [topojson](https://github.com/topojson/topojson-client) and, for Full 3D, [three.js](https://threejs.org/). Fonts: Fredoka, VT323, Share Tech Mono (SIL OFL). GeoSafari is a trademark of Educational Insights; this is an unaffiliated fan tribute by JW Games.
