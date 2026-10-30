import { FlatWorld } from './flatworld.js';
import { probeGL } from './probe.js';
import { Geo, distanceKm } from './geo.js';
import { MapPainter } from './mapPainter.js';
import { skyAt, sunAltitude } from './astro.js';
import { SevenSeg } from './sevenseg.js';
import { Sound } from './audio.js';
import { CARDS, cardById } from './cards.js';
import { Spots } from './spots.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  get(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: settings just won't persist */ }
  },
};

const DEFAULTS = {
  sound: true, voice: false, labels: false, dayNight: true, style: 'terrain', sky: 'live', quality: 'auto',
  card: 'nations', players: 1, mode: 'card', timer: 30, rounds: 10, initials: '',
};
const SETTINGS_VERSION = 5;
const BOOT_KEY = 'gs3d.boot';
const SKY_SPEED = { live: 1, fast: 720, turbo: 7200 };
const TRY_POINTS = [100, 60, 30];
const CARD_ICONS = { nations: '🗺️', capitals: '🏛️', wonders: '🗿', peaks: '🏔️', waters: '🌊', islands: '🏝️', extremes: '🧭' };
const SCORE_KEY = 'gs3d.scores.v2';
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bearing([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  const b = (Math.atan2(y, x) / r + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

const fmtLat = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class App {
  constructor() {
    const saved = store.get('gs3d.settings', {}) || {};
    // Earlier releases could store a heavy graphics mode (even switching to it automatically). Those
    // stored choices are dropped so every browser starts again on the safe default.
    if (saved.v !== SETTINGS_VERSION) {
      delete saved.quality;
      saved.v = SETTINGS_VERSION;
    }
    this.settings = { ...DEFAULTS, ...saved };
    if (!['auto', 'simple', 'low', 'high'].includes(this.settings.quality)) this.settings.quality = 'auto';
    this.sound = new Sound();
    this.sound.muted = !this.settings.sound;
    this.sound.voice = this.settings.voice;
    this.view = 'boot';
    this.game = null;
    this.paused = false;
    this.skyTime = Date.now();
    this.skyLabelAt = 0;
    this.pointer = null;
    this.hoverFeature = null;
    this.marks = [];
    this.selectedCard = this.settings.card;
  }

  async start() {
    this.dom();
    this.buildRails(20);
    this.buildDisplays();
    this.bind();
    this.applySettingsToUI();

    // Realistic 3D (WebGL, satellite imagery) on computers with graphics acceleration; Simple mode
    // (no WebGL at all) otherwise, or when chosen in Settings.
    const engine = this.resolveEngine();
    this.quality = engine;
    try {
      if (engine === 'simple') {
        this.world = new FlatWorld($('#viewport'));
      } else {
        $('#loader-text').textContent = 'Starting 3D…';
        const { RealWorld } = await import('./realworld.js');
        this.world = new RealWorld($('#viewport'), { quality: engine });
        this.world.onContextLost = () => this.fallBackToSimple('The graphics card stopped responding, so Simple graphics have been switched on.');
        $('#loader-text').textContent = 'Loading satellite imagery…';
        await this.world.ready;
      }
    } catch (err) {
      console.error(err);
      this.fallBackToSimple('3D couldn’t start on this device, so Simple graphics have been switched on.');
      return;
    }
    this.world.setView('intro');
    this.world.autoSpin = 0.06;
    this.spots = new Spots($('#stage'), this.world, {
      onPick: (n) => this.answerNumber(n),
      onHover: () => this.sound.blip(),
    });

    $('#loader-text').textContent = 'Loading the disc…';
    let geo;
    try {
      [geo] = await Promise.all([
        Geo.load('data/countries-110m.json'),
        document.fonts?.load('600 32px "Fredoka Variable"').catch(() => null),
      ]);
    } catch (err) {
      console.error(err);
      this.fail('The map data could not be loaded. Check your connection and reload.');
      return;
    }
    this.geo = geo;
    if (engine === 'simple') {
      this.painter = new MapPainter(geo, 0, 1024); // only the highlight overlay is drawn live
      this.world.setDetailPainter((canvas, matrix, scale) => this.paintDetail(canvas, matrix, scale));
      this.world.onOverlayChange = () => this.paintMarks();
    }
    await this.repaintMap();
    if (this.painter) {
      this.world.setOverlayCanvas(this.painter.overlay);
      this.painter.paintOverlay([]);
    }
    this.world.setDayNight(this.settings.dayNight);
    this.world.onFrame((dt) => this.frame(dt));

    $('#loader').classList.add('is-done');
    $('#power-led').classList.add('on');
    this.idleDisplays();
    this.view = 'title';
    this.show('title');
    this.bootOk();
    if (this.bootNotice) this.setStrip('Graphics', esc(this.bootNotice));
    // The detailed (1:50m) countries make hover and taps exact on small islands; fetched once idle.
    if (engine !== 'simple') setTimeout(() => this.upgradeGeo(), 2500);
  }

  async upgradeGeo() {
    if (this.detailGeo) return;
    this.detailGeo = Geo.load('data/countries-50m.json').then((g) => {
      this.geo = g;
      return g;
    }).catch(() => null);
  }

  fallBackToSimple(message) {
    this.settings.quality = 'simple';
    this.save();
    store.set(BOOT_KEY, 'ok');
    this.fail(`${message} Restarting…`);
    setTimeout(() => location.reload(), 1800);
  }

  fail(message) {
    $('#loader-text').textContent = message;
    $('.loader__ring')?.remove();
  }

  // 'auto' picks Realistic 3D ('low') with graphics acceleration, else Simple. ?gfx=simple|low|high forces one.
  resolveEngine() {
    const forced = new URLSearchParams(location.search).get('gfx');
    if (['simple', 'high', 'low'].includes(forced)) {
      this.forcedEngine = true;
      return forced;
    }
    let wanted = ['simple', 'high', 'low'].includes(this.settings.quality) ? this.settings.quality : 'auto';
    if (wanted === 'auto') {
      const gl = probeGL();
      if (!gl.ok || gl.software) {
        if (gl.software) this.bootNotice = 'This browser is drawing without graphics acceleration, so Simple graphics are on. Turn on hardware acceleration in your browser settings to see the realistic 3D disc.';
        return 'simple';
      }
      wanted = 'low';
    }
    // Boot watchdog: a 3D start that never reached the title screen (froze, crashed or was closed)
    // leaves this flag behind, and the next visit starts in Simple mode instead.
    if (wanted !== 'simple' && String(store.get(BOOT_KEY, '')).startsWith('pending')) {
      this.settings.quality = 'simple';
      this.save();
      this.bootNotice = 'The last 3D start didn’t finish, so the game has switched to Simple graphics. You can try 3D again in Settings.';
      store.set(BOOT_KEY, 'ok');
      return 'simple';
    }
    if (wanted !== 'simple') store.set(BOOT_KEY, `pending-${wanted}`);
    return wanted;
  }

  // Called once the game has drawn a few frames: the start-up succeeded.
  bootOk() {
    let frames = 0;
    const tick = () => {
      if (++frames < 30) requestAnimationFrame(tick);
      else store.set(BOOT_KEY, 'ok');
    };
    requestAnimationFrame(tick);
  }

  // ---------------- DOM ----------------

  dom() {
    this.el = {
      stage: $('#stage'),
      strip: $('#strip'),
      stripMeta: $('#strip-meta'),
      stripText: $('#strip-text'),
      stripTab: $('#strip-tab'),
      next: $('#btn-next'),
      toast: $('#toast'),
      tooltip: $('#tooltip'),
      sky: $('#sky-clock'),
      slot: $('#card-slot'),
      slotName: $('#card-slot-name'),
      tries: $('#tries'),
      deck: $('.deck'),
      railLeft: $('#rail-left'),
      railRight: $('#rail-right'),
    };
    this.screens = Object.fromEntries($$('.screen').map((s) => [s.id.replace('screen-', ''), s]));
  }

  show(name) {
    for (const [key, s] of Object.entries(this.screens)) s.hidden = key !== name;
    this.current = name || null;
    const first = name && this.screens[name]?.querySelector('[aria-checked="true"], .btn--go, .menu-btn--primary, .big-btn, button');
    if (first && !window.matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
  }

  buildRails(n) {
    this.lamps = [];
    this.el.railLeft.innerHTML = '';
    this.el.railRight.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const lamp = document.createElement('div');
      lamp.className = 'lamp';
      lamp.innerHTML = `<i></i><span>${i + 1}</span>`;
      (i < n / 2 ? this.el.railLeft : this.el.railRight).appendChild(lamp);
      this.lamps.push(lamp);
    }
  }

  setLamps(rounds) {
    this.lamps.forEach((l, i) => {
      l.className = 'lamp';
      if (i >= rounds) l.classList.add('is-off');
    });
  }

  buildDisplays() {
    this.seg = {
      p1: new SevenSeg($('#seg-p1'), 5),
      p2: new SevenSeg($('#seg-p2'), 5),
      time: new SevenSeg($('#seg-time'), 2, { colour: 'amber' }),
      entry: new SevenSeg($('#seg-entry'), 2, { colour: 'green' }),
    };
  }

  idleDisplays() {
    this.seg.p1.set('0');
    this.seg.p2.set('0');
    this.seg.time.set('--');
    this.seg.entry.set('--');
    $('#disp-p2').classList.toggle('is-off', true);
    this.setTries(null);
  }

  setTries(left) {
    this.el.tries.innerHTML = left === null ? '' : [0, 1, 2].map((i) => `<i class="${i < left ? '' : 'used'}"></i>`).join('');
    this.el.tries.setAttribute('aria-label', left === null ? '' : `${left} tries left`);
  }

  setStrip(meta, html, { colour } = {}) {
    if (meta !== null) this.el.stripMeta.innerHTML = meta;
    if (html !== null) this.el.stripText.innerHTML = html;
    if (colour) this.el.strip.style.setProperty('--card', colour);
  }

  toast(text, kind = 'info', sub = '') {
    const t = this.el.toast;
    t.className = `toast ${kind}`;
    t.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    void t.offsetWidth;
    t.classList.add('show');
  }

  // ---------------- input ----------------

  bind() {
    $('#btn-press-start').addEventListener('click', () => this.pressStart());
    $$('[data-go]').forEach((b) => b.addEventListener('click', () => this.go(b.dataset.go)));
    $('#btn-begin').addEventListener('click', () => this.beginFromPicker());
    $('#btn-again').addEventListener('click', () => this.startGame(this.game.card.id, this.game.opts));
    $('#btn-resume').addEventListener('click', () => this.resume());
    $('#btn-restart').addEventListener('click', () => this.startGame(this.game.card.id, this.game.opts));
    $('#btn-quit').addEventListener('click', () => this.quit());
    $('#btn-next').addEventListener('click', () => this.next());
    $('#btn-start').addEventListener('click', () => this.startButton());
    $('#btn-hint').addEventListener('click', () => this.hint());
    $('#btn-menu').addEventListener('click', () => this.menuButton());
    $('#btn-settings').addEventListener('click', () => this.openSettings());
    $('#btn-settings-done').addEventListener('click', () => this.closeSettings());
    $('#btn-sound').addEventListener('click', () => this.toggleSetting('sound'));
    $('#btn-labels').addEventListener('click', () => this.toggleSetting('labels'));
    $('#btn-fullscreen').addEventListener('click', () => this.fullscreen());
    $('#view-3d').addEventListener('click', () => this.world?.flyTo(this.game ? 'play' : 'orbit', 0.9));
    $('#view-top').addEventListener('click', () => this.world?.flyTo('top', 0.9));
    $('#view-zoom-in').addEventListener('click', () => this.world?.zoomBy(1.8));
    $('#view-zoom-out').addEventListener('click', () => this.world?.zoomBy(1 / 1.8));
    for (const [id, dir] of [['#view-spin-l', -1], ['#view-spin-r', 1]]) {
      const b = $(id);
      const stop = () => { if (this.world) this.world.spinInput = 0; };
      b.addEventListener('pointerdown', () => { if (this.world) this.world.spinInput = dir * 1.2; });
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
    }
    $('#keys').addEventListener('click', (e) => {
      const k = e.target.closest('[data-key]');
      if (k) this.key(k.dataset.key);
    });
    $('#initials-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveHighScore();
    });
    $('#initials').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

    const opts = $('#screen-cards');
    opts.addEventListener('change', (e) => {
      if (e.target.name) {
        this.settings[e.target.name] = e.target.name === 'mode' ? e.target.value : Number(e.target.value);
        this.save();
        this.sound.key();
      }
    });

    // Settings controls
    $('#set-sound').addEventListener('change', (e) => this.setSetting('sound', e.target.checked));
    $('#set-voice').addEventListener('change', (e) => this.setSetting('voice', e.target.checked));
    $('#set-labels').addEventListener('change', (e) => this.setSetting('labels', e.target.checked));
    $('#set-daynight').addEventListener('change', (e) => this.setSetting('dayNight', e.target.checked));
    $('#set-style').addEventListener('change', (e) => this.setSetting('style', e.target.value));
    $('#set-sky').addEventListener('change', (e) => this.setSetting('sky', e.target.value));
    $('#set-quality').addEventListener('change', (e) => this.setSetting('quality', e.target.value));

    // Map clicks & hover (distinguish a tap from an orbit drag)
    const vp = $('#viewport');
    let down = null;
    vp.addEventListener('pointerdown', (e) => {
      this.sound.unlock();
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    vp.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 7 && performance.now() - down.t < 650) this.mapClick(e.clientX, e.clientY, e.pointerType);
      down = null;
    });
    vp.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons, dirty: true };
    });
    vp.addEventListener('pointerleave', () => { this.pointer = null; this.setHover(null); });

    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => {
      if (['a', 'd', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase()) && this.world) this.world.spinInput = 0;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.game?.phase === 'ask' && !this.paused) this.pause();
    });
  }

  keydown(e) {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (/^[0-9]$/.test(k)) { this.key(k); this.flashKey(k); return; }
    if (k === 'enter') {
      if (this.current === 'title') { this.pressStart(); e.preventDefault(); return; }
      if (this.game?.phase === 'ask' && this.game.mode === 'card' && !this.current) { this.key('go'); this.flashKey('go'); e.preventDefault(); }
      else if (this.game?.phase === 'feedback' && !this.current) { this.next(); e.preventDefault(); }
      return;
    }
    if (k === 'backspace' || k === 'delete') { this.key('clr'); this.flashKey('clr'); return; }
    if (k === 'escape') { this.menuButton(); return; }
    if (!this.world) return;
    if (k === 'a' || k === 'arrowleft') this.world.spinInput = -1.2;
    else if (k === 'd' || k === 'arrowright') this.world.spinInput = 1.2;
    else if (k === '+' || k === '=') this.world.zoomBy(1.5);
    else if (k === '-' || k === '_') this.world.zoomBy(1 / 1.5);
    else if (k === 't') this.world.flyTo('top', 0.9);
    else if (k === 'v') this.world.flyTo(this.game ? 'play' : 'orbit', 0.9);
    else if (k === 'l') this.toggleSetting('labels');
    else if (k === 'm') this.toggleSetting('sound');
    else if (k === 'h') this.hint();
  }

  flashKey(k) {
    const b = $(`#keys [data-key="${k}"]`);
    if (!b) return;
    b.classList.add('is-down');
    setTimeout(() => b.classList.remove('is-down'), 110);
  }

  // ---------------- navigation ----------------

  pressStart() {
    if (this.view !== 'title') return;
    this.sound.unlock();
    this.sound.boot();
    this.sound.whoosh();
    this.view = 'menu';
    this.world.flyTo('orbit', 2.2);
    this.show('menu');
    this.setStrip('Main menu', 'Choose <b>Play a Lesson Card</b> to begin, or explore the disc freely.');
  }

  go(where) {
    this.sound.unlock();
    this.sound.key();
    if (where === 'cards') this.openPicker();
    else if (where === 'explore') this.startExplore();
    else if (where === 'scores') this.openScores();
    else if (where === 'menu') this.toMenu();
    else this.show(where);
  }

  toMenu() {
    this.endRound();
    this.view = 'menu';
    this.world.autoSpin = 0.06;
    this.show('menu');
    this.setStrip('Main menu', 'Choose <b>Play a Lesson Card</b> to begin, or explore the disc freely.', { colour: 'var(--yellow)' });
    this.loadSlot(null);
    this.idleDisplays();
  }

  startButton() {
    this.sound.unlock();
    if (this.view === 'title') return this.pressStart();
    if (this.game && this.game.phase !== 'done') return this.startGame(this.game.card.id, this.game.opts);
    this.go('cards');
  }

  menuButton() {
    this.sound.key();
    if (this.current === 'pause') return this.resume();
    if (this.current === 'settings') return this.closeSettings();
    if (this.game && this.game.phase !== 'done' && !this.current) return this.pause();
    if (this.view === 'title') return;
    this.toMenu();
  }

  openPicker() {
    const list = $('#card-list');
    const best = store.get(SCORE_KEY, {});
    list.innerHTML = CARDS.map((c, i) => {
      const top = best[c.id]?.[0]?.score;
      return `<button class="lesson" type="button" role="radio" aria-checked="${c.id === this.selectedCard}" data-card="${c.id}" style="--c:${c.color}">
        <span class="lesson__n">CARD ${String(i + 1).padStart(2, '0')}</span><span class="lesson__icon" aria-hidden="true">${CARD_ICONS[c.id] || '🌍'}</span>
        <h3>${esc(c.title)}</h3><p>${esc(c.subtitle)}</p>
        <div class="lesson__meta"><span class="lesson__dots" aria-label="Difficulty ${c.level} of 3">${'●'.repeat(c.level)}${'○'.repeat(3 - c.level)}</span><span>${top ? `BEST ${top}` : '20 SPOTS'}</span></div>
      </button>`;
    }).join('');
    $$('.lesson', list).forEach((b) => b.addEventListener('click', () => {
      this.selectedCard = b.dataset.card;
      $$('.lesson', list).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      this.sound.key();
      const card = cardById(b.dataset.card);
      this.setStrip(`Card selected · ${esc(card.subtitle)}`, esc(card.title), { colour: card.color });
    }));
    list.addEventListener('dblclick', (e) => { if (e.target.closest('.lesson')) this.beginFromPicker(); });
    for (const name of ['players', 'mode', 'timer', 'rounds']) {
      const input = $(`#screen-cards input[name="${name}"][value="${this.settings[name]}"]`);
      if (input) input.checked = true;
    }
    this.view = 'menu';
    this.show('cards');
  }

  beginFromPicker() {
    this.settings.card = this.selectedCard;
    this.save();
    const { players, mode, timer, rounds } = this.settings;
    this.startGame(this.selectedCard, { players, mode, timer, rounds });
  }

  loadSlot(card) {
    this.el.slot.classList.toggle('is-loaded', !!card);
    this.el.slot.style.setProperty('--card', card ? card.color : 'transparent');
    this.el.slotName.textContent = card ? card.title : '— insert a card —';
  }

  // ---------------- explore ----------------

  startExplore() {
    this.endRound();
    this.view = 'explore';
    this.show(null);
    this.loadSlot(null);
    this.world.autoSpin = 0;
    this.world.flyTo('orbit', 1.2);
    this.setStrip('Free explore', 'Hover or tap anywhere on the disc to identify it. Drag to orbit, scroll or pinch to zoom, <kbd>A</kbd>/<kbd>D</kbd> to turn the disc.', { colour: 'var(--cyan)' });
    this.idleDisplays();
  }

  describePlace(lonlat) {
    const f = this.geo.countryAt(lonlat);
    const sky = skyAt(new Date(this.skyTime));
    const alt = sunAltitude(lonlat, sky.sun);
    const utcH = (new Date(this.skyTime).getUTCHours() + new Date(this.skyTime).getUTCMinutes() / 60 + lonlat[0] / 15 + 48) % 24;
    const solar = `${String(Math.floor(utcH)).padStart(2, '0')}:${String(Math.floor((utcH % 1) * 60)).padStart(2, '0')}`;
    const sun = alt > 0 ? `Sun ${alt.toFixed(0)}° above the horizon` : alt > -6 ? 'Twilight' : 'Night';
    return { f, html: `${esc(f ? f.properties.name : 'Open water')} <span class="fact">${fmtLat(lonlat[1])} · ${fmtLon(lonlat[0])} · local solar time ${solar} · ${sun}</span>` };
  }

  // ---------------- game ----------------

  startGame(cardId, opts) {
    this.sound.unlock();
    this.endRound();
    const card = cardById(cardId);
    const numbers = shuffle(card.items.map((_, i) => i + 1));
    const items = card.items.map((it, i) => ({ ...it, n: numbers[i], index: i }));
    const order = shuffle(items.map((_, i) => i)).slice(0, opts.rounds);
    this.game = {
      card, opts, items, order, mode: opts.mode,
      qi: -1, player: 0, phase: 'intro',
      scores: [0, 0], correct: [0, 0], asked: [0, 0], streak: [0, 0], best: [0, 0], firstTry: [0, 0],
      practice: this.settings.labels,
      timeLeft: 0, tries: 0, hinted: false, entry: '',
    };
    this.paused = false;
    this.view = 'play';
    this.el.tooltip.hidden = true;
    this.show(null);
    this.loadSlot(card);
    this.setLamps(opts.rounds);
    this.el.stage.classList.toggle('is-hunting', opts.mode === 'hunt');
    $('#disp-p2').classList.toggle('is-off', opts.players < 2);
    this.seg.p1.set('0');
    this.seg.p2.set(opts.players < 2 ? '' : '0');
    this.world.autoSpin = 0;
    this.world.setStarAlpha(0.3);
    this.world.setDomeAlpha(0.55);
    this.world.clearMarks();
    this.marks = [];
    this.paintMarks();
    if (opts.mode === 'card') this.spots.set(items.map((it) => ({ n: it.n, lon: it.lon, lat: it.lat })));
    else this.spots.clear();
    this.world.flyTo('play', 1.4);
    this.sound.boot();
    this.setStrip(`${esc(card.title)} · ${opts.players} player${opts.players > 1 ? 's' : ''} · ${opts.mode === 'card' ? 'numbered spots' : 'map hunt'}`,
      opts.mode === 'card' ? 'Find each clue’s numbered spot on the disc. Get ready…' : 'Tap the right place on the disc. Get ready…', { colour: card.color });
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.next(), 1500);
  }

  endRound() {
    clearTimeout(this.nextTimer);
    this.sound.hush();
    this.game = null;
    this.paused = false;
    this.spots?.clear();
    this.world?.clearMarks();
    this.world?.setStarAlpha(1);
    this.world?.setDomeAlpha(1);
    this.marks = [];
    if (this.painter || this.world?.setMarks) this.paintMarks();
    this.el.next.hidden = true;
    this.el.stage.classList.remove('is-hunting');
    $('#disp-p1').classList.remove('is-turn');
    $('#disp-p2').classList.remove('is-turn');
    $('.disp--time').classList.remove('is-low');
    this.setLamps(20);
  }

  get item() {
    const g = this.game;
    return g.items[g.order[g.qi]];
  }

  ask() {
    const g = this.game;
    const it = this.item;
    g.phase = 'ask';
    g.tries = 0;
    g.hinted = false;
    g.entry = '';
    g.timeLeft = g.opts.timer;
    g.lastWhole = Math.ceil(g.timeLeft);
    g.asked[g.player]++;
    this.lamps.forEach((l, i) => l.classList.toggle('is-cur', i === g.qi));
    this.setTries(3);
    this.seg.entry.set('--');
    this.seg.time.set(g.opts.timer ? String(g.opts.timer) : '--');
    $('#disp-p1').classList.toggle('is-turn', g.opts.players > 1 && g.player === 0);
    $('#disp-p2').classList.toggle('is-turn', g.opts.players > 1 && g.player === 1);
    $('.disp--time').classList.remove('is-low');
    this.el.next.hidden = true;
    const who = g.opts.players > 1 ? ` · <b>Player ${g.player + 1}</b>` : '';
    const meta = `Question ${g.qi + 1} of ${g.order.length}${who}`;
    if (g.mode === 'card') this.setStrip(meta, esc(it.clue));
    else this.setStrip(meta, `Find: <b>${esc(it.name)}</b><span class="fact">${esc(it.clue)}</span>`);
    this.sound.say(g.mode === 'card' ? it.clue : `Find ${it.name}. ${it.clue}`);
  }

  key(k) {
    this.sound.unlock();
    const g = this.game;
    if (!g || g.phase !== 'ask' || g.mode !== 'card' || this.current) {
      if (k === 'go' && g?.phase === 'feedback' && !this.current) this.next();
      return;
    }
    this.sound.key();
    if (k === 'clr') g.entry = '';
    else if (k === 'go') {
      if (!g.entry) return;
      const n = Number(g.entry);
      g.entry = '';
      this.answerNumber(n);
      return;
    } else {
      g.entry = (g.entry + k).slice(-2);
      if (g.entry === '00') g.entry = '0';
    }
    this.seg.entry.set(g.entry || '--');
  }

  answerNumber(n) {
    const g = this.game;
    if (!g || g.phase !== 'ask' || this.paused || this.current) return;
    if (g.mode !== 'card') return;
    this.seg.entry.set(String(n));
    const picked = g.items.find((it) => it.n === n);
    if (!picked) {
      this.sound.wrong();
      this.toast('No such spot', 'bad', `Spots run from 1 to ${g.items.length}`);
      return;
    }
    if (picked === this.item) this.correct();
    else {
      this.spots.setState(n, 'wrong');
      this.wrong(`That was spot ${n}: ${picked.name}`);
    }
  }

  mapClick(x, y, pointerType) {
    if (!this.geo || this.current) return;
    const hit = this.world.pick(x, y);
    if (this.view === 'explore') {
      if (!hit) return;
      this.sound.blip();
      const { f, html } = this.describePlace(hit.lonlat);
      this.setStrip('Free explore', html);
      this.setHover(f);
      if (pointerType !== 'mouse') this.showTooltip(x, y, f ? f.properties.name : 'Open water');
      return;
    }
    const g = this.game;
    if (!g || g.phase !== 'ask' || g.mode !== 'hunt' || this.paused || !hit) return;
    const it = this.item;
    const target = [it.lon, it.lat];
    const dist = distanceKm(hit.lonlat, target);
    let ok = dist <= (it.tol ?? 350);
    if (g.card.type === 'country') {
      const f = this.geo.countryAt(hit.lonlat);
      ok = (f && f.properties.name === it.country) || dist <= (it.tol ?? 0);
    }
    if (ok) {
      this.world.addPin(hit.lonlat[0], hit.lonlat[1], '#3dff8f');
      this.correct();
    } else {
      this.world.addPin(hit.lonlat[0], hit.lonlat[1], '#ff3b5c');
      const f = this.geo.countryAt(hit.lonlat);
      const where = f ? f.properties.name : 'open water';
      this.wrong(`That's ${where} — ${Math.round(dist).toLocaleString()} km away. Head ${bearing(hit.lonlat, target)}.`);
    }
  }

  correct() {
    const g = this.game;
    const it = this.item;
    const p = g.player;
    let pts = TRY_POINTS[g.tries];
    if (g.opts.timer) pts += Math.ceil(g.timeLeft) * 5;
    g.streak[p]++;
    g.best[p] = Math.max(g.best[p], g.streak[p]);
    if (g.streak[p] >= 3) pts += Math.min(50, (g.streak[p] - 2) * 10);
    if (g.hinted) pts = Math.round(pts / 2);
    g.scores[p] += pts;
    g.correct[p]++;
    if (g.tries === 0) g.firstTry[p]++;
    this.sound.correct();
    this.toast('Correct!', 'good', `+${pts} points${g.streak[p] >= 3 ? ` · streak ×${g.streak[p]}` : ''}`);
    if (g.mode === 'card') this.spots.setState(it.n, 'correct');
    else this.world.pulseAt(it.lon, it.lat, '#3dff8f');
    if (g.card.type === 'country') this.mark(it.country, 'rgba(61,255,143,0.55)', '#0a8a3d');
    this.animateScore(p);
    this.finish(true);
  }

  wrong(detail) {
    const g = this.game;
    g.tries++;
    g.streak[g.player] = 0;
    this.setTries(3 - g.tries);
    if (g.tries >= 3) {
      this.sound.wrong();
      this.reveal('Out of tries');
      return;
    }
    this.sound.wrong();
    this.toast('Try again', 'bad', `${3 - g.tries} ${3 - g.tries === 1 ? 'try' : 'tries'} left`);
    this.setStrip(null, g.mode === 'card'
      ? `${esc(this.item.clue)}<span class="fact miss">${esc(detail)}</span>`
      : `Find: <b>${esc(this.item.name)}</b><span class="fact miss">${esc(detail)}</span>`);
  }

  reveal(reason) {
    const g = this.game;
    const it = this.item;
    g.streak[g.player] = 0;
    setTimeout(() => this.sound.reveal(), 350);
    this.toast(reason, 'bad', g.mode === 'card' ? `It was spot ${it.n}` : `It was ${it.name}`);
    if (g.mode === 'card') {
      this.spots.setState(it.n, 'reveal');
      this.seg.entry.set(String(it.n));
    } else {
      this.world.pulseAt(it.lon, it.lat, '#ffe14d');
      this.world.addPin(it.lon, it.lat, '#ffcf33');
    }
    if (g.card.type === 'country') this.mark(it.country, 'rgba(255,207,51,0.6)', '#c98f00');
    this.finish(false);
  }

  finish(ok) {
    const g = this.game;
    const it = this.item;
    g.phase = 'feedback';
    const lamp = this.lamps[g.qi];
    lamp.classList.remove('is-cur');
    lamp.classList.add(ok ? 'is-ok' : 'is-miss');
    if (g.player === 1) lamp.classList.add('p2');
    $('.disp--time').classList.remove('is-low');
    const label = g.mode === 'card' ? `Spot ${it.n}: ` : '';
    this.setStrip(null, `<span class="${ok ? 'ans' : 'miss'}">${ok ? '✔' : '✘'} ${label}${esc(it.name)}</span><span class="fact">★ ${esc(it.fact)}</span>`);
    this.sound.say(ok ? `Correct! ${it.name}. ${it.fact}` : `The answer was ${it.name}. ${it.fact}`);
    this.el.next.hidden = false;
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.next(), this.settings.voice ? 9000 : 5200);
  }

  next() {
    const g = this.game;
    if (!g || this.paused) return;
    if (g.phase !== 'feedback' && g.phase !== 'intro') return;
    clearTimeout(this.nextTimer);
    this.sound.hush();
    if (g.qi >= 0) {
      const it = this.item;
      if (g.mode === 'card') {
        this.spots.resetStates();
        this.spots.markDone(it.n);
      }
      this.world.clearMarks();
      this.marks = [];
      this.paintMarks();
    }
    g.qi++;
    if (g.qi >= g.order.length) return this.endGame();
    if (g.opts.players > 1 && g.qi > 0) {
      g.player = 1 - g.player;
      this.sound.turn();
    }
    this.ask();
  }

  hint() {
    const g = this.game;
    if (!g || g.phase !== 'ask' || g.hinted || this.current) return;
    g.hinted = true;
    this.sound.key();
    const it = this.item;
    if (g.mode === 'card') {
      this.setStrip(null, `${esc(it.clue)}<span class="fact">Hint: it’s <b>${esc(it.name)}</b> — now find its number. (half points)</span>`);
    } else {
      const jitter = () => (Math.random() - 0.5) * 8;
      this.marks.push({ circle: { center: [it.lon + jitter(), Math.max(-80, Math.min(88, it.lat + jitter()))], radius: 14 }, fill: 'rgba(255,207,51,0.18)', stroke: 'rgba(255,207,51,0.95)', width: 5 });
      this.paintMarks();
      this.setStrip(null, `Find: <b>${esc(it.name)}</b><span class="fact">Hint: it’s inside the yellow circle. (half points)</span>`);
    }
  }

  tickTimer(dt) {
    const g = this.game;
    if (!g || g.phase !== 'ask' || !g.opts.timer || this.paused || this.current) return;
    g.timeLeft = Math.max(0, g.timeLeft - dt);
    const whole = Math.ceil(g.timeLeft);
    if (whole !== g.lastWhole) {
      g.lastWhole = whole;
      this.seg.time.set(String(whole));
      if (whole <= 5 && whole > 0) {
        this.sound.tick(whole <= 3);
        $('.disp--time').classList.add('is-low');
      }
    }
    if (g.timeLeft <= 0) {
      this.sound.timeout();
      this.reveal('Time’s up!');
    }
  }

  animateScore(p) {
    const g = this.game;
    const seg = p === 0 ? this.seg.p1 : this.seg.p2;
    const from = Number(seg.value) || 0;
    const to = g.scores[p];
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 700);
      seg.set(String(Math.round(from + (to - from) * k)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  endGame() {
    const g = this.game;
    g.phase = 'done';
    this.el.next.hidden = true;
    this.lamps.forEach((l) => l.classList.remove('is-cur'));
    $('#disp-p1').classList.remove('is-turn');
    $('#disp-p2').classList.remove('is-turn');
    this.sound.fanfare();
    const players = g.opts.players;
    const accs = [0, 1].map((p) => (g.asked[p] ? g.correct[p] / g.asked[p] : 0));
    const winner = players > 1 ? (g.scores[0] === g.scores[1] ? -1 : g.scores[0] > g.scores[1] ? 0 : 1) : 0;
    $('#results-title').textContent = players > 1 ? (winner < 0 ? 'It’s a tie!' : `Player ${winner + 1} wins!`) : 'Safari complete!';
    const acc = players > 1 ? accs[Math.max(0, winner)] : accs[0];
    const stars = acc >= 0.9 ? 3 : acc >= 0.7 ? 2 : acc >= 0.4 ? 1 : 0;
    $('#results-stars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < stars ? 'on' : ''}">★</span>`).join('');
    $('#results-body').innerHTML = Array.from({ length: players }, (_, p) => `
      <div class="result-card ${players > 1 && winner === p ? 'win' : ''}">
        <h3>${players > 1 ? `Player ${p + 1}` : esc(g.card.title)}</h3>
        <div class="big">${g.scores[p]}</div>
        <ul>
          <li>Correct: ${g.correct[p]} / ${g.asked[p]} (${Math.round(accs[p] * 100)}%)</li>
          <li>First-try answers: ${g.firstTry[p]}</li>
          <li>Best streak: ${g.best[p]}</li>
        </ul>
      </div>`).join('') + (g.practice ? '<p class="fine">Practice round: country names were showing, so this score isn’t entered in the Hall of Fame.</p>' : '');

    const best = players > 1 ? Math.max(0, winner) : 0;
    this.pendingScore = { card: g.card.id, score: g.scores[best], mode: g.mode, acc: Math.round(accs[best] * 100) };
    const table = store.get(SCORE_KEY, {})[g.card.id] || [];
    const qualifies = !g.practice && this.pendingScore.score > 0 && (table.length < 10 || this.pendingScore.score > table[table.length - 1].score);
    $('#initials-form').hidden = !qualifies;
    $('#initials').value = this.settings.initials || '';
    this.setStrip(`${esc(g.card.title)} · results`, players > 1 ? `Final score — Player 1: ${g.scores[0]} · Player 2: ${g.scores[1]}` : `Final score: ${g.scores[0]} · ${Math.round(accs[0] * 100)}% correct`);
    this.seg.time.set('--');
    this.seg.entry.set('--');
    this.setTries(null);
    setTimeout(() => {
      if (this.game !== g) return;
      this.show('results');
      if (qualifies) $('#initials').focus();
    }, 900);
  }

  saveHighScore() {
    const s = this.pendingScore;
    if (!s) return;
    const name = ($('#initials').value || 'AAA').toUpperCase().slice(0, 3);
    this.settings.initials = name;
    this.save();
    const all = store.get(SCORE_KEY, {});
    const list = all[s.card] || [];
    list.push({ name, score: s.score, mode: s.mode, acc: s.acc, date: new Date().toISOString().slice(0, 10) });
    list.sort((a, b) => b.score - a.score);
    all[s.card] = list.slice(0, 10);
    store.set(SCORE_KEY, all);
    this.pendingScore = null;
    $('#initials-form').hidden = true;
    this.sound.correct();
    this.openScores(s.card);
  }

  openScores(cardId = this.selectedCard) {
    const tabs = $('#score-tabs');
    tabs.innerHTML = CARDS.map((c) => `<button class="tab" type="button" role="tab" data-card="${c.id}" style="--c:${c.color}" aria-selected="${c.id === cardId}">${esc(c.title)}</button>`).join('');
    const render = (id) => {
      const list = store.get(SCORE_KEY, {})[id] || [];
      $$('.tab', tabs).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.card === id)));
      $('#score-body').innerHTML = list.length
        ? list.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.score}</td><td>${s.mode === 'hunt' ? 'HUNT' : 'SPOTS'}</td><td>${s.acc}%</td><td>${esc(s.date)}</td></tr>`).join('')
        : '<tr><td colspan="6">No safaris logged yet — be the first!</td></tr>';
    };
    tabs.onclick = (e) => {
      const t = e.target.closest('.tab');
      if (t) { this.sound.key(); render(t.dataset.card); }
    };
    render(cardId);
    this.show('scores');
  }

  pause() {
    if (!this.game || this.game.phase === 'done') return;
    this.paused = true;
    clearTimeout(this.nextTimer);
    this.sound.hush();
    this.show('pause');
  }

  resume() {
    this.paused = false;
    this.show(null);
    if (this.game?.phase === 'feedback') this.nextTimer = setTimeout(() => this.next(), 2500);
  }

  quit() {
    this.paused = false;
    this.toMenu();
  }

  // ---------------- map overlay ----------------

  mark(countryName, fill, stroke) {
    const f = this.geo.feature(countryName);
    if (!f) return;
    this.marks.push({ feature: f, fill, stroke, width: 5 });
    this.paintMarks();
  }

  setHover(f) {
    if (f === this.hoverFeature) return;
    this.hoverFeature = f;
    this.paintMarks();
  }

  paintMarks() {
    const items = [...this.marks];
    if (this.hoverFeature && !this.hoverFeature.properties.isIce) items.push({ feature: this.hoverFeature, fill: 'rgba(255,240,140,0.5)', stroke: 'rgba(255,170,0,0.95)', width: 4 });
    if (this.world.setMarks) {
      this.world.setMarks(items);
      return;
    }
    this.painter.paintOverlay(items, this.world.overlayTarget);
    this.world.refreshOverlay();
  }

  showTooltip(x, y, name, sub = '') {
    const rect = this.el.stage.getBoundingClientRect();
    const t = this.el.tooltip;
    t.hidden = !name;
    if (!name) return;
    t.innerHTML = `${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    const left = Math.min(x - rect.left, rect.width - t.offsetWidth - 20);
    t.style.left = `${Math.max(0, left)}px`;
    t.style.top = `${y - rect.top}px`;
  }

  hoverUpdate() {
    const p = this.pointer;
    if (!p || !p.dirty || !this.geo) return;
    p.dirty = false;
    const hunting = this.game?.mode === 'hunt' && this.game.phase === 'ask';
    if (p.buttons || this.current || !(this.view === 'explore' || hunting)) {
      this.setHover(null);
      this.el.tooltip.hidden = true;
      return;
    }
    const hit = this.world.pick(p.x, p.y);
    const f = hit ? this.geo.countryAt(hit.lonlat) : null;
    if (this.quality !== 'lite') this.setHover(f);
    if (this.view === 'explore' && hit) this.showTooltip(p.x, p.y, f ? f.properties.name : 'Open water', `${fmtLat(hit.lonlat[1])} ${fmtLon(hit.lonlat[0])}`);
    else this.el.tooltip.hidden = true;
  }

  // ---------------- per-frame ----------------

  frame(dt) {
    this.skyTime += dt * 1000 * (SKY_SPEED[this.settings.sky] || 1);
    const date = new Date(this.skyTime);
    const sky = skyAt(date);
    this.world.setSky(sky);
    const now = performance.now();
    if (now - this.skyLabelAt > 250) {
      this.skyLabelAt = now;
      const hh = String(date.getUTCHours()).padStart(2, '0');
      const mm = String(date.getUTCMinutes()).padStart(2, '0');
      const day = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
      const moon = this.world.width < 560 ? '' : ` ${sky.moon.phase}`;
      this.el.sky.innerHTML = `☀ <b>${hh}:${mm}</b> UTC · ${day} · ☾${moon} ${Math.round(sky.moon.illum * 100)}%`;
    }
    this.spots.update();
    this.hoverUpdate();
    this.tickTimer(dt);
  }

  // ---------------- settings ----------------

  save() { store.set('gs3d.settings', this.settings); }

  applySettingsToUI() {
    const s = this.settings;
    $('#btn-sound').setAttribute('aria-pressed', String(s.sound));
    $('#btn-sound span').textContent = s.sound ? '🔊' : '🔇';
    $('#btn-labels').setAttribute('aria-pressed', String(s.labels));
    $('#set-sound').checked = s.sound;
    $('#set-voice').checked = s.voice;
    $('#set-labels').checked = s.labels;
    $('#set-daynight').checked = s.dayNight;
    $('#set-style').value = s.style;
    $('#set-sky').value = s.sky;
    $('#set-quality').value = s.quality;
  }

  toggleSetting(key) {
    this.sound.unlock();
    this.setSetting(key, !this.settings[key]);
  }

  setSetting(key, value) {
    const prev = this.settings[key];
    this.settings[key] = value;
    this.save();
    this.applySettingsToUI();
    if (key === 'sound') { this.sound.muted = !value; if (value) this.sound.key(); else this.sound.hush(); }
    if (key === 'voice') { this.sound.voice = value; if (value) this.sound.say('Talking console on.'); else this.sound.hush(); }
    if (key === 'labels' || key === 'style') {
      this.repaintMap();
      if (key === 'labels' && value && this.game && this.game.phase !== 'done') {
        this.game.practice = true;
        this.toast('Practice mode', 'info', 'Names on — this round won’t be ranked');
      }
    }
    if (key === 'dayNight') this.world?.setDayNight(value);
    if (key === 'quality' && value !== prev) {
      this.toast('Restarting graphics…', 'info');
      setTimeout(() => location.reload(), 600);
    }
  }

  openSettings() {
    this.sound.unlock();
    this.sound.key();
    if (this.current === 'settings') return this.closeSettings();
    this.returnTo = this.current;
    if (this.game?.phase === 'ask') this.paused = true;
    this.show('settings');
  }

  closeSettings() {
    this.sound.key();
    const back = this.returnTo && this.returnTo !== 'settings' ? this.returnTo : null;
    this.show(back);
    if (!back && this.game?.phase === 'ask') this.paused = false;
    if (!back && this.view === 'menu') this.show('menu');
  }

  async repaintMap() {
    if (this.world.setStyle) {
      this.world.setStyle({ style: this.settings.style, labels: this.settings.labels });
      return;
    }
    if (!this.painter) return;
    if (this.world.setMapImage) {
      this.world.setMapImage(`assets/map-${this.settings.style === 'terrain' ? 'terrain' : 'classic'}${this.settings.labels ? '-labels' : ''}.webp`);
      this.world.refreshDetail();
      return;
    }
    const done = await this.painter.paintBase({ style: this.settings.style, labels: this.settings.labels });
    if (done) this.world.setMapCanvas(this.painter.canvas);
  }

  // Simple mode: sharp close-ups need the detailed (1:50m) map data, fetched the first time you zoom in.
  // Once loaded it also becomes the data used to identify countries, so small islands are found too.
  async paintDetail(canvas, matrix, scale) {
    if (!this.detailGeo) {
      this.detailGeo = Geo.load('data/countries-50m.json').then((g) => {
        this.geo = g;
        this.painter.geo = g;
        this.painter.overlayPaths.clear();
        this.detailMap = new MapPainter(g, 2048, 1);
        return g;
      });
    }
    await this.detailGeo;
    return this.detailMap.paintDetail(canvas, matrix, scale, { style: this.settings.style, labels: this.settings.labels });
  }

  fullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }
}
