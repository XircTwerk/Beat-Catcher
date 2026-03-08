'use strict';

// ============================================================
//  BEAT CATCHER — game.js
//  Systems: Audio · Input · Rhythm · Beat · Particle · Score
//           · Render · Game
// ============================================================


// ============================================================
//  CONFIG
// ============================================================
const CFG = {
  // Grid
  CELL_SIZE: 140,             // px per grid cell

  // Beat travel
  TRAVEL_BEATS: 4,            // beats to travel from spawn to centre

  // Beat visuals
  BEAT_RADIUS: 22,            // px

  // Hit detection (relative to beat arrival time)
  PERFECT_WINDOW: 80,         // ±ms for PERFECT
  GOOD_WINDOW:    160,        // ±ms for GOOD
  MISS_LINGER:    220,        // ms beat stays at centre before becoming a miss

  // Trail
  TRAIL_DURATION:     750,    // ms a trail point lives
  TRAIL_MIN_DIST:     3,      // min px between stored trail points

  // Scoring
  SCORE_PERFECT: 100,
  SCORE_GOOD:    50,
  WEAVE_STREAK_THRESHOLD: 3,  // consecutive hits without releasing = weave bonus
  WEAVE_BONUS: 50,

  // Multiplier combo thresholds  [min_combo → multiplier]
  MULT_STEPS: [0, 10, 20, 40],

  // Particles
  PARTICLE_COUNT_HIT:  12,
  PARTICLE_COUNT_MISS:  6,

  // Difficulty presets
  DIFF: {
    easy:   { BPM:  90, label: 'EASY'   },
    medium: { BPM: 120, label: 'MEDIUM' },
    hard:   { BPM: 150, label: 'HARD'   },
  },
};

// Colour palette
const C = {
  BG:      '#040414',
  CYAN:    '#00FFFF',
  MAGENTA: '#FF00FF',
  YELLOW:  '#FFFF00',
  PURPLE:  '#BB00FF',
  GREEN:   '#00FF88',
  ORANGE:  '#FF8800',
  RED:     '#FF3355',
  WHITE:   '#FFFFFF',
  GRID:    '#001844',
  DIM:     '#223355',
};

// Beat type colour map
const BEAT_COLOR = {
  normal:      C.CYAN,
  hold:        C.YELLOW,
  chain:       C.MAGENTA,
  directional: C.PURPLE,
};

// ============================================================
//  UTILS
// ============================================================
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist  = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const now   = () => performance.now();
const TAU   = Math.PI * 2;


// ============================================================
//  AUDIO SYSTEM
//  All sounds generated with Web Audio API — no audio files.
// ============================================================
class AudioSystem {
  constructor() {
    this.ctx         = null;
    this.masterGain  = null;
    this.enabled     = true;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.55;
      this.masterGain.connect(this.ctx.destination);
    } catch (e) {
      console.warn('Web Audio not available.', e);
      this.enabled = false;
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // -- Private helpers --

  _osc(type, freq, t, duration, gainPeak, gainEnd) {
    if (!this.ctx) return;
    const osc  = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(gainPeak, t);
    gain.gain.exponentialRampToValueAtTime(gainEnd, t + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + duration + 0.01);
    return { osc, gain };
  }

  _noise(t, duration, gainPeak, hpFreq = 0) {
    if (!this.ctx) return;
    const sr  = this.ctx.sampleRate;
    const len = Math.floor(sr * Math.max(duration, 0.05));
    const buf = this.ctx.createBuffer(1, len, sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const src  = this.ctx.createBufferSource();
    src.buffer = buf;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(gainPeak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    let node = src;
    if (hpFreq > 0) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = hpFreq;
      src.connect(hp);
      node = hp;
    }
    node.connect(gain);
    gain.connect(this.masterGain);
    src.start(t);
    src.stop(t + duration + 0.01);
  }

  // -- Public sounds --

  kick(t) {
    if (!this.enabled || !this.ctx) return;
    const node = this._osc('sine', 110, t, 0.45, 1.0, 0.001);
    if (node) {
      node.osc.frequency.exponentialRampToValueAtTime(30, t + 0.35);
    }
  }

  hihat(t, open = false) {
    if (!this.enabled || !this.ctx) return;
    this._noise(t, open ? 0.25 : 0.06, 0.35, 7500);
  }

  snare(t) {
    if (!this.enabled || !this.ctx) return;
    this._osc('triangle', 200, t, 0.15, 0.8, 0.001);
    this._noise(t, 0.15, 0.4, 1500);
  }

  synth(t, freq, dur = 0.15) {
    if (!this.enabled || !this.ctx) return;
    const node = this._osc('sawtooth', freq, t, dur, 0.25, 0.001);
    if (node) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2200, t);
      lp.frequency.exponentialRampToValueAtTime(400, t + dur);
      // reconnect through filter
      node.osc.disconnect();
      node.osc.connect(lp);
      lp.connect(node.gain);
    }
  }

  playHit(perfect) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.synth(t,        perfect ? 880 : 660, 0.12);
    if (perfect) this.synth(t + 0.04, 1320, 0.08);
  }

  playMiss() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    this._osc('sawtooth', 180, t, 0.18, 0.25, 0.001);
  }

  // Schedule a full rhythmic bar starting at Web Audio time `t`
  scheduleBar(t, BPM, barBeat) {
    if (!this.enabled || !this.ctx) return;
    const bd = 60 / BPM;

    // --- Drum pattern (4/4) ---
    const beat = barBeat % 4;
    this.kick (t);                               // kick every 4 beats on 1
    if (beat === 2) this.snare(t);               // snare on 3
    this.hihat(t, beat === 2);                   // hats every beat, open on 3

    // --- Arpeggiated synth melody (pentatonic) ---
    const PENTA = [261.63, 293.66, 329.63, 392.00, 440.00,
                   523.25, 587.33, 659.25, 783.99, 880.00];
    const MELODY = [0, 2, 4, 6, 3, 5, 2, 7, 4, 6, 1, 5];
    const noteIdx = MELODY[(barBeat) % MELODY.length];
    this.synth(t, PENTA[noteIdx], bd * 0.45);
  }
}


// ============================================================
//  INPUT SYSTEM
//  Tracks mouse / touch, stores a fading trail of points.
// ============================================================
class InputSystem {
  constructor(canvas) {
    this.canvas    = canvas;
    this.isDrawing = false;
    this.trail     = [];     // [{x, y, time}]
    this.mx        = 0;
    this.my        = 0;
    this._bind();
  }

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('mousedown',  e => this._down(e));
    cv.addEventListener('mousemove',  e => this._move(e));
    cv.addEventListener('mouseup',    e => this._up());
    cv.addEventListener('mouseleave', e => this._up());

    cv.addEventListener('touchstart', e => { e.preventDefault(); this._down(e.touches[0]); }, { passive: false });
    cv.addEventListener('touchmove',  e => { e.preventDefault(); this._move(e.touches[0]); }, { passive: false });
    cv.addEventListener('touchend',   e => { e.preventDefault(); this._up(); },               { passive: false });
  }

  _pos(e) {
    const r  = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width  / r.width;
    const sy = this.canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  _down(e) {
    this.isDrawing = true;
    const p = this._pos(e);
    this.mx = p.x; this.my = p.y;
    this._push(p.x, p.y);
  }

  _move(e) {
    const p = this._pos(e);
    this.mx = p.x; this.my = p.y;
    if (this.isDrawing) this._push(p.x, p.y);
  }

  _up() { this.isDrawing = false; }

  _push(x, y) {
    const t = now();
    if (this.trail.length > 0) {
      const last = this.trail[this.trail.length - 1];
      if (dist(x, y, last.x, last.y) < CFG.TRAIL_MIN_DIST) return;
    }
    this.trail.push({ x, y, time: t });
  }

  update() {
    const cutoff = now() - CFG.TRAIL_DURATION;
    // keep only recent points
    let i = 0;
    while (i < this.trail.length && this.trail[i].time < cutoff) i++;
    if (i > 0) this.trail.splice(0, i);
  }
}


// ============================================================
//  RHYTHM SYSTEM
//  Fires onBeat callbacks with precise timing.
// ============================================================
class RhythmSystem {
  constructor(BPM) {
    this.BPM          = BPM;
    this.beatMs       = 60000 / BPM;
    this.startTime    = 0;
    this.nextBeatIdx  = 0;
    this.nextBeatTime = 0;
    this.running      = false;
    this.onBeat       = null;  // (beatIndex, beatTimestamp) => void
  }

  start() {
    this.startTime    = now();
    this.nextBeatIdx  = 0;
    this.nextBeatTime = this.startTime;
    this.running      = true;
  }

  stop() { this.running = false; }

  update() {
    if (!this.running) return;
    const t = now();
    while (t >= this.nextBeatTime) {
      if (this.onBeat) this.onBeat(this.nextBeatIdx, this.nextBeatTime);
      this.nextBeatIdx++;
      this.nextBeatTime = this.startTime + this.nextBeatIdx * this.beatMs;
    }
  }

  // Fractional progress through the current beat (0–1) — for visual pulsing
  beatPhase() {
    if (!this.running) return 0;
    const elapsed = Math.max(0, now() - this.startTime);
    return (elapsed % this.beatMs) / this.beatMs;
  }
}


// ============================================================
//  BEAT
//  Represents a single incoming beat circle.
// ============================================================
class Beat {
  constructor(id, cellIndex, type, spawnTime, arrivalTime, sx, sy, ex, ey) {
    this.id         = id;
    this.cellIndex  = cellIndex;
    this.type       = type;
    this.spawnTime  = spawnTime;
    this.arrivalTime= arrivalTime;   // exact ms when it should hit centre
    this.sx = sx; this.sy = sy;     // spawn world position
    this.ex = ex; this.ey = ey;     // centre world position

    this.state      = 'traveling';  // 'traveling'|'catchable'|'hit'|'miss'
    this.rating     = null;         // 'perfect'|'good'
    this.dieTime    = 0;
    this.alpha      = 1;
    this.glowSeed   = Math.random() * TAU;

    // Hold-beat state
    this.holdMs     = 0;
    this.holdNeeded = 500;          // ms to hold for full credit

    // Whether miss was already processed by score system
    this._missScored = false;
  }

  // 0–1 travel progress (clamped so beat stays at centre after arriving)
  get progress() {
    const dur = this.arrivalTime - this.spawnTime;
    return clamp((now() - this.spawnTime) / dur, 0, 1);
  }

  // Current world position
  get x() { return lerp(this.sx, this.ex, this.progress); }
  get y() { return lerp(this.sy, this.ey, this.progress); }

  get alive() {
    return (this.state !== 'hit' && this.state !== 'miss') || this.alpha > 0;
  }
}


// ============================================================
//  BEAT SYSTEM
//  Owns all live beats, updates their state each frame.
// ============================================================
class BeatSystem {
  constructor() {
    this.beats  = [];
    this._nextId = 0;
  }

  spawn(cellIndex, type, spawnTime, arrivalTime, sx, sy, ex, ey) {
    this.beats.push(new Beat(
      this._nextId++, cellIndex, type,
      spawnTime, arrivalTime,
      sx, sy, ex, ey
    ));
  }

  update(dt) {
    const t = now();
    for (const b of this.beats) {
      if (b.state === 'traveling' && b.progress >= 1.0) {
        b.state   = 'catchable';
        b.dieTime = t + CFG.MISS_LINGER;
      }

      if (b.state === 'catchable' && t > b.dieTime) {
        b.state = 'miss';
      }

      // Fade out after hit or miss
      if (b.state === 'hit' || b.state === 'miss') {
        b.alpha = clamp(b.alpha - dt / 300, 0, 1);
      }
    }

    this.beats = this.beats.filter(b => b.alive);
  }
}


// ============================================================
//  PARTICLE SYSTEM
// ============================================================
class Particle {
  constructor(x, y, vx, vy, color, size, life) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.color = color;
    this.size  = size;
    this.life  = life;
    this.maxLife = life;
  }

  update(dt) {
    this.x  += this.vx * dt * 0.001;
    this.y  += this.vy * dt * 0.001;
    this.vx *= 0.94;
    this.vy *= 0.94;
    this.size *= 0.97;
    this.life -= dt;
  }

  get alpha() { return clamp(this.life / this.maxLife, 0, 1); }
  get alive()  { return this.life > 0 && this.size > 0.3; }
}

class ParticleSystem {
  constructor() { this.particles = []; }

  emit(x, y, color, count = 12, spread = 220) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU + Math.random() * 0.6;
      const speed = spread * (0.4 + Math.random() * 0.8);
      this.particles.push(new Particle(
        x + (Math.random() - 0.5) * 8,
        y + (Math.random() - 0.5) * 8,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        color,
        2 + Math.random() * 4,
        350 + Math.random() * 350
      ));
    }
  }

  update(dt) {
    for (const p of this.particles) p.update(dt);
    this.particles = this.particles.filter(p => p.alive);
  }
}


// ============================================================
//  SCORE SYSTEM
//  Tracks score, combo, popups, and weave streaks.
// ============================================================
class ScoreSystem {
  constructor() {
    this.score       = 0;
    this.combo       = 0;
    this.maxCombo    = 0;
    this.perfects    = 0;
    this.goods       = 0;
    this.misses      = 0;
    this.totalBeats  = 0;
    this.weaveStreak = 0;   // hits while mouse held without release
    this.screenFlash = 0;   // 0..1 flash intensity
    this.popups      = [];  // { text, x, y, color, born, life }
    this.rings       = [];  // { x, y, color, born, life }
  }

  get accuracy() {
    if (this.totalBeats === 0) return 100;
    return Math.round(((this.perfects + this.goods) / this.totalBeats) * 100);
  }

  _mult() {
    const steps = CFG.MULT_STEPS;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (this.combo >= steps[i]) return i + 1;
    }
    return 1;
  }

  _popup(text, x, y, color, life = 800) {
    this.popups.push({ text, x, y, color, born: now(), life });
  }

  hit(rating, x, y, isWeave) {
    this.totalBeats++;
    const mult = this._mult();
    let pts = 0;

    if (rating === 'perfect') { pts = CFG.SCORE_PERFECT * mult; this.perfects++; }
    else                      { pts = CFG.SCORE_GOOD    * mult; this.goods++;    }

    this.score += pts;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);

    // Weave bonus
    if (isWeave) {
      this.weaveStreak++;
      if (this.weaveStreak >= CFG.WEAVE_STREAK_THRESHOLD) {
        const bonus = CFG.WEAVE_BONUS * mult;
        this.score += bonus;
        this._popup('WEAVE!', x, y - 44, C.MAGENTA, 1000);
      }
    } else {
      this.weaveStreak = 0;
    }

    // Flash at combo milestones
    if (this.combo > 0 && this.combo % 10 === 0) this.screenFlash = 0.25;

    this._popup(rating === 'perfect' ? 'PERFECT!' : 'GOOD!', x, y,
                rating === 'perfect' ? C.CYAN : C.GREEN, 800);
    if (pts) this._popup(`+${pts}`, x + 22, y + 24, C.WHITE, 600);

    this.rings.push({ x, y, color: BEAT_COLOR.normal, born: now(), life: 500 });
  }

  miss(x, y) {
    this.totalBeats++;
    this.misses++;
    this.combo       = 0;
    this.weaveStreak = 0;
    this._popup('MISS', x, y, C.RED, 600);
  }

  resetWeave() { this.weaveStreak = 0; }

  update() {
    const t = now();
    this.popups = this.popups.filter(p => t - p.born < p.life);
    this.rings  = this.rings.filter( r => t - r.born < r.life);
    this.screenFlash = Math.max(0, this.screenFlash - 0.025);
  }
}


// ============================================================
//  RENDER SYSTEM
//  All drawing goes through here. Canvas 2D only.
// ============================================================
class RenderSystem {
  constructor(canvas) {
    this.cv  = canvas;
    this.ctx = canvas.getContext('2d');
    this.W   = canvas.width;
    this.H   = canvas.height;
  }

  resize(w, h) {
    this.cv.width  = w;
    this.cv.height = h;
    this.W = w; this.H = h;
  }

  // Applies glow then restores
  _glow(color, blur, fn) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur  = blur;
    fn();
    ctx.restore();
  }

  clear() {
    this.ctx.fillStyle = C.BG;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // Subtle star-field background
  drawStars(seed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(100,150,255,0.5)';
    // Deterministic "random" stars using fixed positions
    for (let i = 0; i < 80; i++) {
      const sx = ((i * 197 + 13) % this.W);
      const sy = ((i * 311 + 71) % this.H);
      const alpha = 0.1 + 0.4 * ((i * 73) % 10) / 10;
      const twinkle = 0.5 + 0.5 * Math.sin(seed * TAU * 0.3 + i * 1.37);
      ctx.globalAlpha = alpha * twinkle;
      ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.restore();
  }

  // 3×3 neon grid
  drawGrid(cells, beatPhase) {
    const ctx      = this.ctx;
    const cs       = CFG.CELL_SIZE;
    const center   = cells[4];
    const gridX    = center.cx - cs * 1.5;
    const gridY    = center.cy - cs * 1.5;
    const gridSize = cs * 3;

    ctx.save();
    ctx.strokeStyle = C.GRID;
    ctx.lineWidth   = 1;
    ctx.shadowBlur  = 6;
    ctx.shadowColor = '#002266';

    for (let i = 0; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(gridX + i * cs, gridY);
      ctx.lineTo(gridX + i * cs, gridY + gridSize);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(gridX,           gridY + i * cs);
      ctx.lineTo(gridX + gridSize, gridY + i * cs);
      ctx.stroke();
    }

    // Pulsing centre cell highlight
    const pulse = 0.25 + 0.12 * Math.sin(beatPhase * TAU);
    ctx.strokeStyle = `rgba(0, 255, 255, ${pulse})`;
    ctx.lineWidth   = 2;
    ctx.shadowBlur  = 18;
    ctx.shadowColor = C.CYAN;
    ctx.strokeRect(center.cx - cs / 2, center.cy - cs / 2, cs, cs);

    // Target ring at centre
    const ringAlpha = 0.3 + 0.2 * Math.sin(beatPhase * TAU);
    ctx.strokeStyle = `rgba(0,255,255,${ringAlpha})`;
    ctx.lineWidth   = 1.5;
    ctx.shadowBlur  = 10;
    ctx.beginPath();
    ctx.arc(center.cx, center.cy, CFG.BEAT_RADIUS * 2.2, 0, TAU);
    ctx.stroke();

    // Small crosshair
    const ch = 8;
    ctx.strokeStyle = `rgba(0,255,255,${0.2 + 0.15 * Math.sin(beatPhase * TAU)})`;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(center.cx - ch, center.cy); ctx.lineTo(center.cx + ch, center.cy);
    ctx.moveTo(center.cx, center.cy - ch); ctx.lineTo(center.cx, center.cy + ch);
    ctx.stroke();

    ctx.restore();
  }

  // Player's glowing mouse trail
  drawTrail(trail) {
    if (trail.length < 2) return;
    const ctx = this.ctx;
    const t   = now();

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      const age = 1 - (t - b.time) / CFG.TRAIL_DURATION;
      if (age <= 0) continue;

      const w = age * 9;

      // Outer glow pass
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(0,220,255,${age * 0.25})`;
      ctx.lineWidth   = w * 2.5;
      ctx.shadowBlur  = 0;
      ctx.stroke();

      // Core pass
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(180,240,255,${age * 0.95})`;
      ctx.lineWidth   = w;
      ctx.shadowBlur  = 22 * age;
      ctx.shadowColor = C.CYAN;
      ctx.stroke();
    }

    // Bright tip
    const tip = trail[trail.length - 1];
    const tipAge = 1 - (t - tip.time) / CFG.TRAIL_DURATION;
    if (tipAge > 0.6) {
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 5, 0, TAU);
      ctx.fillStyle  = C.WHITE;
      ctx.shadowBlur = 25;
      ctx.shadowColor = C.CYAN;
      ctx.fill();
    }

    ctx.restore();
  }

  // A single beat circle
  drawBeat(beat) {
    const ctx   = this.ctx;
    const x     = beat.x;
    const y     = beat.y;
    const color = BEAT_COLOR[beat.type] || C.CYAN;
    const r     = CFG.BEAT_RADIUS;
    const t     = now();

    // Pulse scale
    const pulse = 1 + 0.07 * Math.sin(t * 0.006 + beat.glowSeed);
    const radius = r * pulse;

    ctx.save();
    ctx.globalAlpha = beat.alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 24;

    // Ghost travel line (fades as beat nears centre)
    if (beat.state === 'traveling' && beat.progress < 0.85) {
      const ghostAlpha = (0.85 - beat.progress) * 0.4;
      ctx.save();
      ctx.globalAlpha = beat.alpha * ghostAlpha;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1;
      ctx.shadowBlur  = 4;
      ctx.setLineDash([5, 9]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(beat.ex, beat.ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (beat.type === 'hold') {
      // Concentric rings for hold beats
      ctx.strokeStyle = color;
      ctx.lineWidth   = 3;
      ctx.beginPath(); ctx.arc(x, y, radius,       0, TAU); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.globalAlpha *= 0.5;
      ctx.beginPath(); ctx.arc(x, y, radius * 1.5, 0, TAU); ctx.stroke();
      ctx.globalAlpha = beat.alpha;

      // Hold progress arc
      if (beat.holdMs > 0) {
        ctx.strokeStyle = C.WHITE;
        ctx.lineWidth   = 3;
        ctx.shadowColor = C.WHITE;
        ctx.beginPath();
        ctx.arc(x, y, radius, -Math.PI / 2,
                -Math.PI / 2 + TAU * (beat.holdMs / beat.holdNeeded));
        ctx.stroke();
      }
    } else {
      // Filled radial gradient circle
      const grad = ctx.createRadialGradient(
        x - radius * 0.3, y - radius * 0.3, 0,
        x, y, radius
      );
      grad.addColorStop(0,   color + 'FF');
      grad.addColorStop(0.55, color + 'BB');
      grad.addColorStop(1,   color + '22');
      ctx.fillStyle   = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // Directional arrow
    if (beat.type === 'directional') {
      const dx  = beat.ex - beat.sx;
      const dy  = beat.ey - beat.sy;
      const len = Math.hypot(dx, dy);
      const nx  = dx / len;
      const ny  = dy / len;
      const al  = radius * 1.6;
      const ax  = x + nx * al;
      const ay  = y + ny * al;
      const ah  = 9;
      const ang = Math.atan2(ny, nx);

      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.shadowBlur  = 12;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(ax, ay);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ah * Math.cos(ang - 0.45), ay - ah * Math.sin(ang - 0.45));
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ah * Math.cos(ang + 0.45), ay - ah * Math.sin(ang + 0.45));
      ctx.stroke();
    }

    // Chain indicator: a small dot trail behind the beat
    if (beat.type === 'chain') {
      for (let i = 1; i <= 3; i++) {
        const tr  = i / 3;
        const tx  = lerp(x, beat.sx, tr * 0.3);
        const ty  = lerp(y, beat.sy, tr * 0.3);
        const ta  = (1 - tr) * 0.5;
        ctx.globalAlpha = beat.alpha * ta;
        ctx.fillStyle   = color;
        ctx.shadowBlur  = 8;
        ctx.beginPath();
        ctx.arc(tx, ty, radius * 0.35 * (1 - tr * 0.5), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = beat.alpha;
    }

    ctx.restore();
  }

  // Expanding hit ring
  drawRing(ring) {
    const ctx = this.ctx;
    const age = (now() - ring.born) / ring.life;
    if (age >= 1) return;
    ctx.save();
    ctx.globalAlpha = (1 - age) * 0.9;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth   = 3 * (1 - age);
    ctx.shadowBlur  = 20;
    ctx.shadowColor = ring.color;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, 20 + age * 65, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawParticle(p) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = p.alpha * 0.9;
    ctx.fillStyle   = p.color;
    ctx.shadowBlur  = 8;
    ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawPopup(popup) {
    const ctx = this.ctx;
    const age = (now() - popup.born) / popup.life;
    if (age >= 1) return;
    const fadeAlpha = age < 0.65 ? 1 : 1 - (age - 0.65) / 0.35;
    const ry = popup.y - age * 35;

    ctx.save();
    ctx.globalAlpha  = fadeAlpha;
    ctx.font         = 'bold 17px Orbitron, monospace';
    ctx.fillStyle    = popup.color;
    ctx.shadowBlur   = 14;
    ctx.shadowColor  = popup.color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(popup.text, popup.x, ry);
    ctx.restore();
  }

  drawHUD(score, combo, mult, beatPhase, accuracy) {
    const ctx = this.ctx;
    const W   = this.W;

    ctx.save();

    // Beat progress bar (top edge, thin line)
    ctx.fillStyle = C.DIM;
    ctx.fillRect(0, 0, W, 3);
    ctx.fillStyle   = C.CYAN;
    ctx.shadowBlur  = 6;
    ctx.shadowColor = C.CYAN;
    ctx.fillRect(0, 0, W * beatPhase, 3);

    // Score (top-left)
    ctx.font         = 'bold 26px Orbitron, monospace';
    ctx.fillStyle    = C.CYAN;
    ctx.shadowBlur   = 12;
    ctx.shadowColor  = C.CYAN;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(score).padStart(8, '0'), 18, 14);

    ctx.font      = '10px Orbitron, monospace';
    ctx.fillStyle = '#446688';
    ctx.shadowBlur = 0;
    ctx.fillText('SCORE', 18, 46);

    // Combo (top-right)
    if (combo > 0) {
      const comboColor = mult >= 4 ? C.YELLOW : mult >= 3 ? C.ORANGE : mult >= 2 ? C.MAGENTA : C.CYAN;
      ctx.font      = 'bold 24px Orbitron, monospace';
      ctx.fillStyle = comboColor;
      ctx.shadowBlur  = 14;
      ctx.shadowColor = comboColor;
      ctx.textAlign   = 'right';
      ctx.fillText(`${combo}x`, W - 18, 14);

      ctx.font      = '10px Orbitron, monospace';
      ctx.fillStyle = '#446688';
      ctx.shadowBlur = 0;
      ctx.fillText('COMBO', W - 18, 46);

      if (mult > 1) {
        ctx.font      = 'bold 13px Orbitron, monospace';
        ctx.fillStyle = comboColor;
        ctx.shadowBlur  = 8;
        ctx.shadowColor = comboColor;
        ctx.fillText(`${mult}× MULT`, W - 18, 64);
      }
    }

    ctx.restore();
  }

  // Cyan flash on big combos / perfect streaks
  drawFlash(intensity) {
    if (intensity <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = intensity;
    ctx.fillStyle   = C.CYAN;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
  }

  // Countdown / intro text
  drawCountdown(text, alpha) {
    if (alpha <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.font         = 'bold 64px Orbitron, monospace';
    ctx.fillStyle    = C.CYAN;
    ctx.shadowBlur   = 40;
    ctx.shadowColor  = C.CYAN;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.W / 2, this.H / 2);
    ctx.restore();
  }

  // Hint shown at start
  drawHint(alpha) {
    if (alpha <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.font         = '13px Orbitron, monospace';
    ctx.fillStyle    = '#667799';
    ctx.shadowBlur   = 0;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Hold mouse button and draw to catch beats at the centre',
                 this.W / 2, this.H - 22);
    ctx.restore();
  }
}


// ============================================================
//  PATTERN GENERATOR
//  Returns array of { beat, cellIndex, type }
//  beat = song beat on which the beat should ARRIVE at centre.
// ============================================================
function generatePattern(difficulty) {
  const pattern = [];

  // Cell-index aliases (3×3 grid, centre = 4)
  const N = 1, NE = 2, E = 5, SE = 8, S = 7, SW = 6, W = 3, NW = 0;
  const cardinals  = [N, E, S, W];
  const diagonals  = [NE, SE, SW, NW];
  const all8       = [N, NE, E, SE, S, SW, W, NW];

  if (difficulty === 'easy') {
    // One beat every 2 beats, cardinal then diagonal introductions
    const seq = [N, S, E, W, NW, SE, NE, SW, N, E, S, W, NE, SW, SE, NW];
    let b = 6;
    for (let i = 0; i < 28; i++) {
      pattern.push({ beat: b, cellIndex: seq[i % seq.length], type: 'normal' });
      b += 2;
    }

  } else if (difficulty === 'medium') {
    // Mix of 1- and 1.5-beat intervals, includes chains and holds
    const seq = [N, E, S, W, NE, SW, SE, NW, N, SE, E, SW];
    let b = 4;
    for (let i = 0; i < 40; i++) {
      let type = 'normal';
      if (i > 8 && i % 6 === 0)        type = 'chain';
      else if (i > 16 && i % 9 === 0)  type = 'hold';

      pattern.push({ beat: b, cellIndex: seq[i % seq.length], type });

      if (type === 'chain') {
        // Second chain beat half a beat later
        pattern.push({ beat: b + 0.5, cellIndex: seq[(i + 4) % seq.length], type: 'normal' });
      }

      b += (i < 12 ? 2 : i < 24 ? 1.5 : 1);
    }

  } else { // hard
    const seq = [...all8, ...all8.slice().reverse()];
    let b = 4;
    for (let i = 0; i < 60; i++) {
      const r = Math.random();
      let type = 'normal';
      if      (r < 0.18) type = 'chain';
      else if (r < 0.30) type = 'directional';
      else if (r < 0.40) type = 'hold';

      pattern.push({ beat: b, cellIndex: seq[i % seq.length], type });

      if (type === 'chain') {
        pattern.push({ beat: b + 0.5, cellIndex: seq[(i + 3) % seq.length], type: 'normal' });
      }

      // Gradually accelerate spacing
      const interval = Math.max(0.5, 1.5 - i * 0.016);
      b += interval;
    }
  }

  // Ensure chronological order
  pattern.sort((a, b) => a.beat - b.beat);
  return pattern;
}


// ============================================================
//  GAME
//  Top-level orchestrator. One instance per session.
// ============================================================
class Game {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.state  = 'menu';     // 'menu' | 'intro' | 'playing' | 'gameover'
    this.diff   = 'easy';

    this.audio    = new AudioSystem();
    this.input    = new InputSystem(this.canvas);
    this.renderer = new RenderSystem(this.canvas);

    // Instantiated on game start:
    this.rhythm   = null;
    this.beats    = null;
    this.particles= null;
    this.score    = null;

    // Spawn queue built at start
    this._spawnQueue = [];

    // Countdown / intro
    this._introCountdown = 0;
    this._introStartTime = 0;

    // Hint fade
    this._hintAlpha    = 1;
    this._hintFadeTime = 0;

    // Grid cell positions computed from canvas size
    this.cells = [];

    // Last frame timestamp for dt
    this._lastT = 0;
    this._raf   = null;

    this._setupGrid();
    this._bindUI();
    this._bindResize();
    this._loop(0);
  }

  // -- Grid setup --

  _setupGrid() {
    const W  = this.renderer.W;
    const H  = this.renderer.H;
    const cs = CFG.CELL_SIZE;
    const cx = W / 2;
    const cy = H / 2;
    this.cells = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        this.cells.push({
          col, row,
          cx: cx + (col - 1) * cs,
          cy: cy + (row - 1) * cs,
        });
      }
    }
  }

  // -- UI bindings --

  _bindUI() {
    // Menu difficulty buttons
    document.querySelectorAll('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.diff = btn.dataset.diff;
      });
    });

    document.getElementById('btn-play').addEventListener('click', () => this._startGame());
    document.getElementById('btn-retry').addEventListener('click', () => this._startGame());
    document.getElementById('btn-menu').addEventListener('click', () => this._showMenu());

    // Resume audio context on first user gesture (browser requirement)
    document.addEventListener('pointerdown', () => this.audio.resume(), { once: true });

    document.addEventListener('keydown', e => {
      if (e.code === 'Escape' && this.state === 'playing') this._endGame();
    });
  }

  _bindResize() {
    const doit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w   = window.innerWidth;
      const h   = window.innerHeight;
      this.renderer.resize(w, h);
      this.canvas.style.width  = w + 'px';
      this.canvas.style.height = h + 'px';
      this._setupGrid();
    };
    window.addEventListener('resize', doit);
    doit();
  }

  // -- Game lifecycle --

  _showMenu() {
    this.state = 'menu';
    if (this.rhythm) this.rhythm.stop();
    document.getElementById('screen-menu').classList.remove('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');
  }

  _startGame() {
    const diffCfg = CFG.DIFF[this.diff];

    // Hide overlays
    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');

    // Init audio on first play
    this.audio.init();

    // Fresh systems
    this.rhythm    = new RhythmSystem(diffCfg.BPM);
    this.beats     = new BeatSystem();
    this.particles = new ParticleSystem();
    this.score     = new ScoreSystem();

    // Build spawn queue
    const travelMs  = CFG.TRAVEL_BEATS * (60000 / diffCfg.BPM);
    const pattern   = generatePattern(this.diff);
    const startTime = now() + 500; // small buffer before first beat

    this._spawnQueue = pattern.map(entry => {
      const arrivalTime = startTime + entry.beat * (60000 / diffCfg.BPM);
      return {
        cellIndex:   entry.cellIndex,
        type:        entry.type,
        arrivalTime,
        spawnTime:   arrivalTime - travelMs,
      };
    }).sort((a, b) => a.spawnTime - b.spawnTime);

    this._totalBeats  = pattern.length;
    this._lastBeatArrival = this._spawnQueue.length > 0
      ? this._spawnQueue[this._spawnQueue.length - 1].arrivalTime
      : startTime;

    // Start rhythm aligned to startTime (slight future offset so audio context warms up)
    this.rhythm.onBeat       = (idx, beatTimestamp) => this._onBeat(idx, beatTimestamp, startTime);
    this.rhythm.startTime    = startTime;
    this.rhythm.nextBeatTime = startTime;
    this.rhythm.nextBeatIdx  = 0;
    this.rhythm.running      = true;

    // Intro countdown
    this._introCountdown = 3;
    this._introStartTime = now();

    this._hintAlpha    = 1;
    this._hintFadeTime = startTime + 4000; // fade hint after 4s of play

    this.state = 'playing';
  }

  _endGame() {
    this.state = 'gameover';
    if (this.rhythm) this.rhythm.stop();

    document.getElementById('result-score').textContent    = this.score.score;
    document.getElementById('result-combo').textContent    = this.score.maxCombo;
    document.getElementById('result-accuracy').textContent = this.score.accuracy + '%';
    document.getElementById('result-perfects').textContent = this.score.perfects;
    document.getElementById('result-goods').textContent    = this.score.goods;
    document.getElementById('result-misses').textContent   = this.score.misses;

    document.getElementById('screen-gameover').classList.remove('hidden');
  }

  // -- Beat scheduling --

  _onBeat(beatIdx, beatTimestamp, startTime) {
    // Schedule audio (convert from performance.now ms to Web Audio seconds)
    if (this.audio.ctx) {
      const audioNow   = this.audio.ctx.currentTime;
      const msFromNow  = beatTimestamp - now();
      const audioT     = audioNow + msFromNow / 1000;
      this.audio.scheduleBar(Math.max(audioT, audioNow), this.rhythm.BPM, beatIdx);
    }
  }

  _processSpawnQueue() {
    const t = now();
    while (this._spawnQueue.length > 0 && this._spawnQueue[0].spawnTime <= t) {
      const q      = this._spawnQueue.shift();
      const cell   = this.cells[q.cellIndex];
      const centre = this.cells[4];
      this.beats.spawn(
        q.cellIndex, q.type,
        q.spawnTime, q.arrivalTime,
        cell.cx, cell.cy,
        centre.cx, centre.cy
      );
    }
  }

  // -- Hit detection --

  _checkHits(dt) {
    const trail  = this.input.trail;
    const t      = now();
    const centre = this.cells[4];

    for (const beat of this.beats.beats) {
      if (beat.state === 'hit' || beat.state === 'miss') continue;

      const timingOffset = t - beat.arrivalTime;

      // Only check within GOOD window (before or after arrival)
      if (timingOffset < -CFG.GOOD_WINDOW || timingOffset > CFG.MISS_LINGER) continue;

      const bx = beat.x;
      const by = beat.y;
      const checkR = CFG.BEAT_RADIUS * 2.2;

      if (beat.type === 'hold') {
        // Hold: must keep cursor over centre continuously
        let over = false;
        for (const p of trail) {
          if (t - p.time < 100 && dist(p.x, p.y, bx, by) <= checkR) {
            over = true; break;
          }
        }
        if (over) {
          beat.holdMs += dt;
          if (beat.holdMs >= beat.holdNeeded) {
            this._registerHit(beat, 'perfect', centre);
          }
        } else {
          beat.holdMs = Math.max(0, beat.holdMs - dt * 1.5);
        }
        continue;
      }

      // Normal / chain / directional: any trail point within radius
      for (const p of trail) {
        if (dist(p.x, p.y, bx, by) > checkR) continue;

        // Grade by timing
        const absOff = Math.abs(timingOffset);
        const rating = absOff <= CFG.PERFECT_WINDOW ? 'perfect' : 'good';
        this._registerHit(beat, rating, centre);
        break;
      }
    }
  }

  _registerHit(beat, rating, centre) {
    beat.state  = 'hit';
    beat.rating = rating;

    const isWeave = this.input.isDrawing;
    this.score.hit(rating, centre.cx, centre.cy, isWeave);

    const color = BEAT_COLOR[beat.type] || C.CYAN;
    this.particles.emit(centre.cx, centre.cy, color, CFG.PARTICLE_COUNT_HIT);
    this.audio.playHit(rating === 'perfect');
  }

  _checkMisses() {
    const centre = this.cells[4];
    for (const beat of this.beats.beats) {
      if (beat.state === 'miss' && !beat._missScored) {
        beat._missScored = true;
        this.score.miss(centre.cx, centre.cy);
        this.particles.emit(centre.cx, centre.cy, C.RED, CFG.PARTICLE_COUNT_MISS, 120);
        this.audio.playMiss();
      }
    }
  }

  // -- Main loop --

  _loop(timestamp) {
    const dt = Math.min(timestamp - this._lastT, 100); // cap at 100ms
    this._lastT = timestamp;

    if (this.state === 'playing') this._update(dt);
    this._render();

    this._raf = requestAnimationFrame(t => this._loop(t));
  }

  _update(dt) {
    const t = now();

    this.rhythm.update();
    this.input.update();
    this._processSpawnQueue();
    this.beats.update(dt);
    this._checkHits(dt);
    this._checkMisses();
    this.particles.update(dt);
    this.score.update();

    // Reset weave counter when mouse released
    if (!this.input.isDrawing) this.score.resetWeave();

    // Hint fade
    if (t > this._hintFadeTime) {
      this._hintAlpha = Math.max(0, this._hintAlpha - dt / 1500);
    }

    // End condition: all pattern beats resolved + short grace period
    if (this._spawnQueue.length === 0 && this.beats.beats.length === 0 &&
        t > this._lastBeatArrival + 2000) {
      this._endGame();
    }
  }

  _render() {
    const r = this.renderer;
    const t = now();

    r.clear();

    if (this.state === 'menu') {
      // Animated background for menu
      r.drawStars(t * 0.0003);
      return;
    }

    // Playing / game-over share the canvas background
    r.drawStars(t * 0.0003);

    if (this.state === 'playing') {
      const phase = this.rhythm ? this.rhythm.beatPhase() : 0;

      r.drawGrid(this.cells, phase);

      // Beats (behind trail)
      for (const beat of this.beats.beats) r.drawBeat(beat);

      // Player trail
      r.drawTrail(this.input.trail);

      // Particles
      for (const p of this.particles.particles) r.drawParticle(p);

      // Hit rings
      for (const ring of this.score.rings) r.drawRing(ring);

      // Floating score popups
      for (const popup of this.score.popups) r.drawPopup(popup);

      // HUD
      const mult = this.score._mult();
      r.drawHUD(this.score.score, this.score.combo, mult, phase, this.score.accuracy);

      // Screen flash
      r.drawFlash(this.score.screenFlash);

      // Hint
      r.drawHint(this._hintAlpha);

      // Intro countdown
      const introElapsed = t - this._introStartTime;
      const introDuration = 3000; // 3 s countdown before beats start
      if (introElapsed < introDuration) {
        const remaining = Math.ceil((introDuration - introElapsed) / 1000);
        const alpha = 1 - (introElapsed % 1000) / 1000;
        r.drawCountdown(remaining.toString(), alpha);
      }
    }
  }
}


// ============================================================
//  BOOT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  // Initialise once DOM is ready
  window._game = new Game();
});
