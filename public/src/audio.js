// All sound is synthesised with Web Audio (no files): console beeps, chimes and buzzers,
// plus optional spoken questions via the Web Speech API (a nod to the talking quiz consoles).
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voice = false;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(comp);
    const verb = ctx.createConvolver();
    const len = ctx.sampleRate * 1.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    verb.connect(wet).connect(comp);
    this.ctx = ctx;
    this.master = master;
    this.verb = verb;
  }

  tone(freq, start, dur, { type = 'square', vol = 0.12, attack = 0.005, glide = null, wet = true, filter = null } = {}) {
    if (this.muted || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc.connect(g);
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      node = g.connect(f);
    }
    node.connect(this.master);
    if (wet) node.connect(this.verb);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise(start, dur, { vol = 0.08, from = 400, to = 4000 } = {}) {
    if (this.muted || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  key() { this.tone(1320, 0, 0.06, { vol: 0.06, wet: false }); }
  blip() { this.tone(1760, 0, 0.035, { type: 'sine', vol: 0.035, wet: false }); }
  tick(urgent) { this.tone(urgent ? 1500 : 1000, 0, 0.03, { vol: urgent ? 0.07 : 0.04, wet: false }); }
  whoosh() { this.noise(0, 0.9, { vol: 0.06, from: 300, to: 2400 }); }

  boot() {
    [67, 72, 76, 79].forEach((n, i) => this.tone(NOTE(n), i * 0.09, 0.14, { vol: 0.08 }));
    [72, 76, 79, 84].forEach((n) => this.tone(NOTE(n), 0.4, 0.7, { type: 'triangle', vol: 0.07 }));
  }

  correct() {
    [84, 88, 91, 96].forEach((n, i) => {
      this.tone(NOTE(n), i * 0.075, 0.32, { type: 'triangle', vol: 0.13 });
      this.tone(NOTE(n + 12), i * 0.075, 0.18, { type: 'sine', vol: 0.04 });
    });
  }

  wrong() {
    this.tone(130, 0, 0.42, { type: 'sawtooth', vol: 0.12, filter: 900, wet: false });
    this.tone(137, 0, 0.42, { type: 'sawtooth', vol: 0.1, filter: 900, wet: false });
  }

  reveal() {
    for (let i = 0; i < 3; i++) {
      this.tone(NOTE(81), i * 0.22, 0.1, { vol: 0.07 });
      this.tone(NOTE(76), i * 0.22 + 0.11, 0.1, { vol: 0.07 });
    }
  }

  timeout() { this.tone(660, 0, 0.6, { vol: 0.09, glide: 180 }); }
  turn() { this.tone(NOTE(79), 0, 0.18, { type: 'triangle', vol: 0.09 }); this.tone(NOTE(74), 0.16, 0.28, { type: 'triangle', vol: 0.09 }); }

  fanfare() {
    const seq = [[72, 0], [76, 0.12], [79, 0.24], [84, 0.36], [79, 0.6], [84, 0.72]];
    seq.forEach(([n, t]) => this.tone(NOTE(n), t, 0.22, { vol: 0.09 }));
    [72, 76, 79, 84, 88].forEach((n) => this.tone(NOTE(n), 0.9, 1.2, { type: 'triangle', vol: 0.06 }));
  }

  say(text) {
    if (!this.voice || this.muted || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1.05;
    const voices = window.speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en[-_](US|GB)/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
    window.speechSynthesis.speak(u);
  }

  hush() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}
