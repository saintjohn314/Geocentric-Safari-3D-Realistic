// Seven-segment LED readout (SVG), like the red displays on the original electronic quiz consoles.
const SEGMENTS = {
  a: [20, 5, 'h'], b: [35, 21, 'v'], c: [35, 53, 'v'], d: [20, 69, 'h'], e: [5, 53, 'v'], f: [5, 21, 'v'], g: [20, 37, 'h'],
};
const CHARS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  '-': 'g', ' ': '', _: 'd', A: 'abcefg', b: 'cdefg', C: 'adef', c: 'deg', d: 'bcdeg', E: 'adefg', F: 'aefg', G: 'acdef',
  H: 'bcefg', h: 'cefg', I: 'bc', J: 'bcde', L: 'def', n: 'ceg', O: 'abcdef', o: 'cdeg', P: 'abefg', r: 'eg', S: 'acdfg',
  t: 'defg', U: 'bcdef', u: 'cde', y: 'bcdfg',
};

function segPath(cx, cy, dir) {
  const L = 26;
  const T = 6.5;
  const h = L / 2;
  const t = T / 2;
  const pts = dir === 'h'
    ? [[cx - h, cy], [cx - h + t, cy - t], [cx + h - t, cy - t], [cx + h, cy], [cx + h - t, cy + t], [cx - h + t, cy + t]]
    : [[cx, cy - h], [cx + t, cy - h + t], [cx + t, cy + h - t], [cx, cy + h], [cx - t, cy + h - t], [cx - t, cy - h + t]];
  return pts.map((p) => p.join(',')).join(' ');
}

export class SevenSeg {
  constructor(el, digits, { colour = 'red' } = {}) {
    this.el = el;
    this.digits = digits;
    this.value = null;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${digits * 44 + 6} 76`);
    svg.setAttribute('class', `seg seg--${colour}`);
    svg.setAttribute('aria-hidden', 'true');
    this.cells = [];
    for (let i = 0; i < digits; i++) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('transform', `translate(${i * 44 + 10} 2) skewX(-7)`);
      const cell = {};
      for (const [name, [x, y, dir]] of Object.entries(SEGMENTS)) {
        const p = document.createElementNS(ns, 'polygon');
        p.setAttribute('points', segPath(x, y, dir));
        g.appendChild(p);
        cell[name] = p;
      }
      svg.appendChild(g);
      this.cells.push(cell);
    }
    el.appendChild(svg);
    this.set('');
  }

  set(value, { pad = ' ', align = 'right' } = {}) {
    let s = String(value);
    if (s.length > this.digits) s = s.slice(-this.digits);
    s = align === 'right' ? s.padStart(this.digits, pad) : s.padEnd(this.digits, pad);
    if (s === this.value) return;
    this.value = s;
    [...s].forEach((ch, i) => {
      const on = CHARS[ch] ?? CHARS[ch.toUpperCase()] ?? '';
      for (const [name, poly] of Object.entries(this.cells[i])) poly.classList.toggle('on', on.includes(name));
    });
  }
}
