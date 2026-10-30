// Numbered answer spots, drawn as crisp DOM buttons over the 3D view.
// Each spot is pinned to its exact place by a leader line; crowded spots are nudged apart
// every frame (simple spring relaxation) so they stay readable at any zoom or angle.
export class Spots {
  constructor(stage, world, { onPick, onHover } = {}) {
    this.world = world;
    this.onPick = onPick;
    this.onHover = onHover;
    this.layer = stage.querySelector('#spots');
    this.canvas = stage.querySelector('#leaders');
    this.ctx = this.canvas.getContext('2d');
    this.items = [];
    this.visible = true;
    this.p = { x: 0, y: 0, visible: true };
  }

  set(items) {
    this.clear();
    this.radius = 0; // measured from CSS on the first frame
    this.items = items.map((it, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'spot';
      el.style.setProperty('--d', `${i * 35}ms`);
      el.innerHTML = `<b>${it.n}</b>`;
      el.setAttribute('aria-label', `Spot number ${it.n}`);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPick?.(it.n);
      });
      el.addEventListener('pointerenter', () => this.onHover?.(it.n));
      this.layer.appendChild(el);
      return { ...it, el, bx: null, by: null, ax: 0, ay: 0, on: false };
    });
    this.layer.classList.add('is-live');
  }

  clear() {
    for (const it of this.items) it.el.remove();
    this.items = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.layer.classList.remove('is-live');
  }

  byNumber(n) {
    return this.items.find((it) => it.n === n);
  }

  setState(n, state) {
    const it = this.byNumber(n);
    if (!it) return;
    it.el.classList.remove('is-wrong', 'is-correct', 'is-reveal');
    if (state === 'wrong') {
      void it.el.offsetWidth; // restart the shake animation
      it.el.classList.add('is-wrong');
    } else if (state) it.el.classList.add(`is-${state}`);
  }

  markDone(n, done = true) {
    this.byNumber(n)?.el.classList.toggle('is-done', done);
  }

  resetStates() {
    for (const it of this.items) it.el.classList.remove('is-wrong', 'is-correct', 'is-reveal');
  }

  update() {
    const { world, ctx } = this;
    const w = world.width;
    const h = world.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.items.length || !this.visible) return;

    if (!this.radius) this.radius = (this.items[0].el.offsetWidth || 30) / 2;
    const r = this.radius;
    const lift = r + 9;
    const live = [];
    for (const it of this.items) {
      const p = world.project(it.lon, it.lat, 0, this.p);
      it.ax = p.x;
      it.ay = p.y;
      it.on = p.visible && p.x > -40 && p.x < w + 40 && p.y > -40 && p.y < h + 40;
      if (!it.on) continue;
      if (it.bx === null) { it.bx = p.x; it.by = p.y - lift; }
      live.push(it);
    }

    // Relaxation: spring toward "just above the anchor", push apart when overlapping.
    const minD = r * 2 + 4;
    for (let iter = 0; iter < 8; iter++) {
      for (const it of live) {
        it.bx += (it.ax - it.bx) * 0.12;
        it.by += (it.ay - lift - it.by) * 0.12;
      }
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i];
          const b = live[j];
          let dx = b.bx - a.bx;
          let dy = b.by - a.by;
          let d = Math.hypot(dx, dy);
          if (d >= minD) continue;
          if (d < 0.01) { dx = 1; dy = 0; d = 1; }
          const push = (minD - d) / 2;
          a.bx -= (dx / d) * push;
          a.by -= (dy / d) * push;
          b.bx += (dx / d) * push;
          b.by += (dy / d) * push;
        }
        // keep bubbles off their own and neighbouring anchor dots
        const a = live[i];
        for (const o of live) {
          const dx = a.bx - o.ax;
          const dy = a.by - o.ay;
          const d = Math.hypot(dx, dy) || 0.01;
          const need = r + 5;
          if (d < need) { a.bx += (dx / d) * (need - d); a.by += (dy / d) * (need - d); }
        }
      }
    }

    ctx.lineCap = 'round';
    for (const it of this.items) {
      it.el.style.visibility = it.on ? 'visible' : 'hidden';
      if (!it.on) continue;
      it.bx = Math.max(r + 2, Math.min(w - r - 2, it.bx));
      it.by = Math.max(r + 2, Math.min(h - r - 2, it.by));
      it.el.style.transform = `translate(${it.bx - r}px, ${it.by - r}px)`;
      const dx = it.bx - it.ax;
      const dy = it.by - it.ay;
      const d = Math.hypot(dx, dy);
      if (d > r) {
        ctx.beginPath();
        ctx.moveTo(it.ax, it.ay);
        ctx.lineTo(it.bx - (dx / d) * r, it.by - (dy / d) * r);
        ctx.strokeStyle = 'rgba(10,16,28,0.7)';
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(it.ax, it.ay, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0a101c';
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();
    }
  }
}
