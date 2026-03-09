'use strict';
// ============================================================
//  BEAT CATCHER v4 — 3D Grid, Straight Slash, Hover-to-Catch
// ============================================================

const TAU = Math.PI * 2;
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist  = (ax, ay, bx, by) => Math.hypot(bx-ax, by-ay);
const now   = () => performance.now();

// ============================================================
//  COLOUR PALETTE
// ============================================================
const C = {
  BG:      '#020210',
  CYAN:    '#00FFFF',
  MAGENTA: '#FF00FF',
  YELLOW:  '#FFFF00',
  GREEN:   '#00FF88',
  ORANGE:  '#FF8800',
  RED:     '#FF3355',
  WHITE:   '#FFFFFF',
  PURPLE:  '#CC00FF',
  GOLD:    '#FFD700',
};

const BEAT_C = { normal: C.CYAN, hold: C.YELLOW, chain: C.MAGENTA, directional: C.PURPLE };

const COMBO_COLORS = [C.CYAN, C.GREEN, C.YELLOW, C.ORANGE, C.MAGENTA, C.WHITE];
function comboColor(combo) {
  const idx = Math.min(Math.floor(combo / 10), COMBO_COLORS.length - 1);
  return COMBO_COLORS[idx];
}

// ============================================================
//  CONFIG
// ============================================================
const CFG = {
  GRID_RATIO:      0.80,   // grid occupies this fraction of min(W,H)
  DEPTH_FACTOR:    0.62,   // how far inner corners pull toward vanishing point
  BEAT_R_START:    3,      // radius at spawn (tiny, far)
  // BEAT_R_MAX set per-spawn = cellSize * 0.40

  SLASH_MIN_LEN:   30,     // px minimum drag to register as slash
  SLASH_HIT_MULT:  1.1,    // hit detection radius multiplier
  SLASH_DISPLAY_MS:350,    // how long slash line stays visible

  SCORE_PERFECT: 300,
  SCORE_GOOD:    150,
  SCORE_MULTI:   80,
  MULT_STEPS:    [0, 5, 15, 30, 60],

  HP_START:    100,
  HP_HIT_GAIN: 3,
  HP_MISS:     22,
  HP_WHIFF:    8,

  DIFF: {
    easy:   { BPM: 100, travelBeats: 5, catchBeats: 1.5, maxLanes: 3, hpDrain: 0   },
    medium: { BPM: 145, travelBeats: 4, catchBeats: 1.0, maxLanes: 5, hpDrain: 0   },
    hard:   { BPM: 185, travelBeats: 3, catchBeats: 0.65,maxLanes: 8, hpDrain: 1.5 },
  },
};

// 3×3 grid outer cell → lane mapping
// Layout:  [0][1][2]
//          [3][C][4]
//          [5][6][7]
const LANE_TO_CELL = [
  [0,0],[1,0],[2,0],
  [0,1],      [2,1],
  [0,2],[1,2],[2,2],
];
const CENTER_COL = 1, CENTER_ROW = 1;

// ============================================================
//  BEAT ANALYZER
// ============================================================
async function analyzeAudio(arrayBuffer, progressCb) {
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await actx.decodeAudioData(arrayBuffer);
  progressCb(0.3);

  const raw = decoded.getChannelData(0);
  const sr  = decoded.sampleRate;
  const hop = Math.floor(sr * 0.02);
  const win = hop * 2;

  const energies = [];
  for (let i = 0; i + win < raw.length; i += hop) {
    let e = 0;
    for (let j = 0; j < win; j++) e += raw[i+j] * raw[i+j];
    energies.push(Math.sqrt(e / win));
  }
  progressCb(0.55);

  const onset = [0];
  for (let i = 1; i < energies.length; i++)
    onset.push(Math.max(0, energies[i] - energies[i-1]));

  const smoothed = onset.map((v, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0,i-4); j <= Math.min(onset.length-1,i+4); j++) {
      sum += onset[j]; cnt++;
    }
    return sum / cnt;
  });
  progressCb(0.75);

  const mean = smoothed.reduce((a,b)=>a+b,0) / smoothed.length;
  const sq   = smoothed.reduce((a,b)=>a+b*b,0) / smoothed.length;
  const std  = Math.sqrt(Math.max(0, sq - mean*mean));
  const threshold = mean + std * 1.2;
  const minGapFrames = Math.floor(0.12 * sr / hop);

  const beats = [];
  let lastFrame = -minGapFrames;
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] > smoothed[i-1] && smoothed[i] > smoothed[i+1] &&
        smoothed[i] > threshold && i - lastFrame >= minGapFrames) {
      beats.push(i * hop / sr);
      lastFrame = i;
    }
  }
  progressCb(1.0);

  let bpm = 130;
  if (beats.length > 2) {
    const iois = [];
    for (let i = 1; i < beats.length; i++) iois.push(beats[i] - beats[i-1]);
    iois.sort((a,b)=>a-b);
    const med = iois[Math.floor(iois.length/2)];
    bpm = clamp(Math.round(60 / med), 60, 240);
  }

  await actx.close();
  return { beats, bpm, duration: decoded.duration };
}

// ============================================================
//  AUDIO SYSTEM
// ============================================================
class AudioSystem {
  constructor() {
    this.ctx     = null;
    this.master  = null;
    this.srcNode = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    } catch(e) { this.enabled = false; }
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }

  stopTrack() {
    if (this.srcNode) { try { this.srcNode.stop(); } catch(e){} this.srcNode = null; }
  }

  _osc(type, freq, t, dur, peakGain, endGain = 0.001) {
    if (!this.enabled || !this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(peakGain, t);
    g.gain.exponentialRampToValueAtTime(endGain, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.01);
  }

  _noise(t, dur, gain, hpFreq=0) {
    if (!this.enabled || !this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * Math.max(dur, 0.05));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0; i<len; i++) d[i] = Math.random()*2-1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain,t); g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    let node = src;
    if (hpFreq>0) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = hpFreq;
      src.connect(hp); node = hp;
    }
    node.connect(g); g.connect(this.master);
    src.start(t); src.stop(t+dur+0.01);
  }

  kick(t) {
    if (!this.enabled||!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(120,t); o.frequency.exponentialRampToValueAtTime(28,t+0.4);
    g.gain.setValueAtTime(1,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.42);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t+0.43);
  }

  snare(t) { this._osc('triangle',180,t,0.15,0.7); this._noise(t,0.18,0.5,1800); }
  hihat(t, open=false) { this._noise(t, open?0.22:0.055, 0.3, 7800); }

  synth(t, freq, dur=0.15) {
    if (!this.enabled||!this.ctx) return;
    const o = this.ctx.createOscillator(), lp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq;
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(2400,t); lp.frequency.exponentialRampToValueAtTime(500,t+dur);
    g.gain.setValueAtTime(0.22,t); g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    o.connect(lp); lp.connect(g); g.connect(this.master);
    o.start(t); o.stop(t+dur+0.01);
  }

  scheduleBar(t, BPM, beatIdx) {
    if (!this.enabled||!this.ctx) return;
    const bd = 60/BPM, beat = beatIdx%4;
    if (beat===0) this.kick(t);
    if (beat===2) this.snare(t);
    this.hihat(t, beat===0||beat===2);
    const PENTA = [261.63,293.66,329.63,392,440,523.25,587.33,659.25,783.99,880];
    const MELODY = [0,2,4,6,3,5,7,4,2,6,1,5,3,7,0,4];
    this.synth(t, PENTA[MELODY[beatIdx%MELODY.length]], bd*0.42);
  }

  playHit(perfect) {
    if (!this.enabled||!this.ctx) return;
    const t = this.ctx.currentTime;
    this.synth(t, perfect?880:660, 0.12);
    if (perfect) this.synth(t+0.04, 1320, 0.08);
  }

  playMiss() {
    if (!this.enabled||!this.ctx) return;
    this._osc('sawtooth', 200, this.ctx.currentTime, 0.2, 0.28);
  }

  playMulti(count) {
    if (!this.enabled||!this.ctx||count<2) return;
    const t = this.ctx.currentTime;
    [440,660,880,1100,1320].slice(0,count).forEach((f,i) => this.synth(t+i*0.03,f,0.1));
  }

  playWhiff() {
    if (!this.enabled||!this.ctx) return;
    this._osc('sawtooth', 120, this.ctx.currentTime, 0.15, 0.15);
  }
}

// ============================================================
//  DRAW SYSTEM — straight-line slash, zero cooldown
// ============================================================
class DrawSystem {
  constructor(canvas) {
    this.canvas  = canvas;
    this.isDown  = false;
    this.startX  = 0; this.startY = 0;
    this.mouseX  = -9999; this.mouseY = -9999;
    // Last completed slash (display only, non-blocking)
    this.slashDisplay = null; // {x0,y0,x1,y1,bornAt,hitCount}
    // Set to slash data when mouse is released; game consumes it next frame
    this.pendingCheck = null; // {x0,y0,x1,y1} | null
    this._bind();
  }

  _bind() {
    const cv = this.canvas;
    const toCanvas = (e) => {
      const r = cv.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (cv.width  / r.width),
        y: (e.clientY - r.top)  * (cv.height / r.height),
      };
    };

    const down = (e) => {
      const p = toCanvas(e);
      this.isDown  = true;
      this.startX  = p.x; this.startY  = p.y;
      this.mouseX  = p.x; this.mouseY  = p.y;
    };

    const move = (e) => {
      const p = toCanvas(e);
      this.mouseX = p.x; this.mouseY = p.y;
    };

    const up = () => {
      if (!this.isDown) return;
      this.isDown = false;
      const len = dist(this.startX, this.startY, this.mouseX, this.mouseY);
      if (len >= CFG.SLASH_MIN_LEN) {
        const s = {x0:this.startX, y0:this.startY, x1:this.mouseX, y1:this.mouseY};
        this.pendingCheck  = s;
        this.slashDisplay  = {...s, bornAt: now(), hitCount: 0};
      }
    };

    cv.addEventListener('mousedown',  e=>{ e.preventDefault(); down(e); });
    cv.addEventListener('mousemove',  e=>{ move(e); });
    cv.addEventListener('mouseup',    ()=>up());
    cv.addEventListener('mouseleave', ()=>{ up(); this.mouseX=-9999; this.mouseY=-9999; });

    cv.addEventListener('touchstart', e=>{ e.preventDefault(); down(e.touches[0]); },{passive:false});
    cv.addEventListener('touchmove',  e=>{ e.preventDefault(); move(e.touches[0]); },{passive:false});
    cv.addEventListener('touchend',   e=>{ e.preventDefault(); up(); },{passive:false});
  }

  update() {
    if (this.slashDisplay && now() - this.slashDisplay.bornAt > CFG.SLASH_DISPLAY_MS) {
      this.slashDisplay = null;
    }
  }

  get isDrawing() { return this.isDown; }
}

// ============================================================
//  GEOMETRY — segment × circle
// ============================================================
function segCircle(ax,ay,bx,by,cx,cy,r) {
  const dx=bx-ax, dy=by-ay;
  const fx=ax-cx, fy=ay-cy;
  const a=dx*dx+dy*dy;
  if (a<0.001) return dist(ax,ay,cx,cy)<=r;
  const b=2*(fx*dx+fy*dy);
  const c=fx*fx+fy*fy-r*r;
  let disc=b*b-4*a*c;
  if (disc<0) return false;
  disc=Math.sqrt(disc);
  const t1=(-b-disc)/(2*a), t2=(-b+disc)/(2*a);
  return (t1>=0&&t1<=1)||(t2>=0&&t2<=1)||(t1<0&&t2>1);
}

// ============================================================
//  BEAT — stays in its outer cell, grows toward viewer
// ============================================================
class Beat {
  constructor(id, laneIdx, type, spawnTime, arrivalTime, catchMs,
              sx, sy,   // near: cell centre on screen (close)
              bx, by,   // far:  deep-in-tunnel vanishing position
              maxRadius) {
    this.id          = id;
    this.laneIdx     = laneIdx;
    this.type        = type;
    this.spawnTime   = spawnTime;
    this.arrivalTime = arrivalTime;
    this.catchStart  = arrivalTime - catchMs * 0.4;
    this.catchEnd    = arrivalTime + catchMs * 0.6;

    this.sx = sx; this.sy = sy;
    this.bx = bx; this.by = by;
    this.maxRadius = maxRadius;

    this.state     = 'traveling';
    this.alpha     = 1;
    this.hitRating = null;
    this._scored   = false;
    this.glowSeed  = Math.random() * TAU;
  }

  get travelProgress() {
    return clamp((now()-this.spawnTime)/(this.arrivalTime-this.spawnTime), 0, 1);
  }

  // Visual position: lerps from far (bx,by) to near (sx,sy)
  pos() {
    const t = this.travelProgress;
    return { x: lerp(this.bx, this.sx, t), y: lerp(this.by, this.sy, t) };
  }

  // Always the cell centre — used for hover detection
  get cellCenter() { return { x: this.sx, y: this.sy }; }

  get radius() { return lerp(CFG.BEAT_R_START, this.maxRadius, this.travelProgress); }

  get catchProgress() {
    return clamp((now()-this.catchStart)/(this.catchEnd-this.catchStart), 0, 1);
  }

  get alive() { return this.alpha > 0.01; }
}

// ============================================================
//  BEAT SYSTEM
// ============================================================
class BeatSystem {
  constructor() { this.beats=[]; this._id=0; }

  spawn(laneIdx, type, spawnTime, arrivalTime, catchMs, sx, sy, bx, by, maxR) {
    this.beats.push(new Beat(this._id++, laneIdx, type, spawnTime, arrivalTime, catchMs,
                             sx, sy, bx, by, maxR));
  }

  update(dt) {
    const t = now();
    for (const b of this.beats) {
      if (b.state==='traveling' && t>=b.catchStart) b.state='catchable';
      if (b.state==='catchable' && t>b.catchEnd)    { b.state='miss'; }
      if (b.state==='hit'||b.state==='miss') b.alpha = clamp(b.alpha-dt/260, 0, 1);
    }
    this.beats = this.beats.filter(b=>b.alive);
  }
}

// ============================================================
//  PARTICLE SYSTEM
// ============================================================
class Particle {
  constructor(x,y,vx,vy,color,size,life) {
    this.x=x; this.y=y; this.vx=vx; this.vy=vy;
    this.color=color; this.size=size; this.life=life; this.maxLife=life;
  }
  update(dt) {
    this.x+=this.vx*dt*.001; this.y+=this.vy*dt*.001;
    this.vx*=0.92; this.vy*=0.92; this.size*=0.97; this.life-=dt;
  }
  get alpha() { return clamp(this.life/this.maxLife, 0, 1); }
  get alive() { return this.life>0 && this.size>0.3; }
}

class ParticleSystem {
  constructor() { this.p=[]; }
  emit(x,y,color,count=12,speed=260) {
    for (let i=0; i<count; i++) {
      const a=i/count*TAU+Math.random()*.5, s=speed*(.4+Math.random()*.8);
      this.p.push(new Particle(x+(Math.random()-.5)*8, y+(Math.random()-.5)*8,
        Math.cos(a)*s, Math.sin(a)*s, color, 3+Math.random()*5, 380+Math.random()*420));
    }
  }
  burst(x,y,color,count=24,speed=400) { this.emit(x,y,color,count,speed); }
  update(dt) { for (const p of this.p) p.update(dt); this.p=this.p.filter(p=>p.alive); }
}

// ============================================================
//  SHAKE SYSTEM
// ============================================================
class ShakeSystem {
  constructor() { this.amt=0; this.x=0; this.y=0; }
  shake(amount) { this.amt=Math.max(this.amt,amount); }
  update(dt) {
    if (this.amt>0.5) {
      this.x=(Math.random()-.5)*this.amt;
      this.y=(Math.random()-.5)*this.amt;
      this.amt*=Math.pow(0.001,dt/1000);
    } else { this.amt=0; this.x=0; this.y=0; }
  }
}

// ============================================================
//  HEALTH SYSTEM
// ============================================================
class HealthSystem {
  constructor() { this.hp=CFG.HP_START; this.flashT=0; }
  hit()   { this.hp=Math.min(100, this.hp+CFG.HP_HIT_GAIN); }
  miss()  { this.hp=Math.max(0, this.hp-CFG.HP_MISS);  this.flashT=now(); }
  whiff() { this.hp=Math.max(0, this.hp-CFG.HP_WHIFF); this.flashT=now(); }
  drain(dt, ratePerSec) { this.hp=Math.max(0, this.hp-ratePerSec*dt/1000); }
  get dead() { return this.hp<=0; }
  get flashAlpha() { return Math.max(0, 1-(now()-this.flashT)/400); }
  get color() {
    if (this.hp>60) return C.GREEN;
    if (this.hp>35) return C.YELLOW;
    if (this.hp>15) return C.ORANGE;
    return C.RED;
  }
}

// ============================================================
//  SCORE SYSTEM
// ============================================================
class ScoreSystem {
  constructor() {
    this.score=0; this.combo=0; this.maxCombo=0;
    this.perfects=0; this.goods=0; this.misses=0; this.total=0;
    this.screenFlash=0; this.popups=[]; this.rings=[];
  }

  get accuracy() {
    if (this.total===0) return 100;
    return Math.round(((this.perfects+this.goods)/this.total)*100);
  }

  _mult() {
    const s=CFG.MULT_STEPS;
    for (let i=s.length-1; i>=0; i--) if (this.combo>=s[i]) return i+1;
    return 1;
  }

  _pop(text,x,y,color,life=900) {
    this.popups.push({text,x,y,color,born:now(),life});
  }

  hit(rating,x,y,multiCount=1) {
    this.total++;
    const mult=this._mult();
    let pts = rating==='perfect'
      ? CFG.SCORE_PERFECT*mult : CFG.SCORE_GOOD*mult;
    if (rating==='perfect') this.perfects++; else this.goods++;
    if (multiCount>1) pts+=CFG.SCORE_MULTI*mult*(multiCount-1);
    this.score+=pts; this.combo++; this.maxCombo=Math.max(this.maxCombo,this.combo);
    if (this.combo>0&&this.combo%10===0) this.screenFlash=0.3;
    const col=comboColor(this.combo);
    this._pop(rating==='perfect'?'PERFECT!':'GOOD!', x,y, rating==='perfect'?C.CYAN:C.GREEN);
    if (pts) this._pop(`+${pts}`, x+24,y+26, C.WHITE, 700);
    if (multiCount>1) this._pop(`${multiCount}× MULTI!`, x,y-40, C.MAGENTA, 1100);
    this.rings.push({x,y,color:col,born:now(),life:500});
  }

  miss(x,y) {
    this.total++; this.misses++; this.combo=0;
    this._pop('MISS', x,y, C.RED, 700);
  }

  whiff(x,y) {
    // Whiff costs score (no combo reset beyond what's already 0)
    const penalty = Math.round(CFG.SCORE_PERFECT * 0.5);
    this.score = Math.max(0, this.score - penalty);
    this.combo = 0;
    this._pop('WHIFF!', x,y, C.ORANGE, 800);
    this._pop(`-${penalty}`, x,y+28, C.RED, 700);
  }

  update() {
    const t=now();
    this.popups=this.popups.filter(p=>t-p.born<p.life);
    this.rings =this.rings.filter(r=>t-r.born<r.life);
    this.screenFlash=Math.max(0, this.screenFlash-0.022);
  }
}

// ============================================================
//  GRID BACKGROUND — beat-pulse expanding squares
// ============================================================
class GridBG {
  constructor() { this.pulses=[]; }
  onBeat(t) { this.pulses.push({born:t, life:1800}); }
  update()  { this.pulses=this.pulses.filter(p=>now()-p.born<p.life); }

  draw(ctx, left, top, cellSize, beatPhase, themeColor) {
    const gs = cellSize*3;
    const vpx = left + gs/2, vpy = top + gs/2;
    ctx.save();

    // Expanding square pulses from vanishing point
    const t = now();
    for (const p of this.pulses) {
      const age = (t-p.born)/p.life;
      const r = age * gs * 0.6;
      ctx.globalAlpha = (1-age) * 0.1;
      ctx.strokeStyle = themeColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(vpx-r/2, vpy-r/2, r, r);
    }

    // Depth lines: centre → each outer cell corner
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#0055cc';
    ctx.lineWidth = 1;
    const pts = [
      [left, top], [left+cellSize, top], [left+cellSize*2, top], [left+gs, top],
      [left+gs, top+cellSize], [left+gs, top+cellSize*2], [left+gs, top+gs],
      [left+cellSize*2, top+gs], [left+cellSize, top+gs], [left, top+gs],
      [left, top+cellSize*2], [left, top+cellSize],
    ];
    for (const [px,py] of pts) {
      ctx.beginPath(); ctx.moveTo(vpx,vpy); ctx.lineTo(px,py); ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ============================================================
//  RENDER SYSTEM
// ============================================================
class RenderSystem {
  constructor(canvas) {
    this.cv=canvas; this.ctx=canvas.getContext('2d');
    this.W=canvas.width; this.H=canvas.height;
  }
  resize(w,h) { this.cv.width=w; this.cv.height=h; this.W=w; this.H=h; }
  clear() { this.ctx.fillStyle=C.BG; this.ctx.fillRect(0,0,this.W,this.H); }

  // Draw the 3D perspective cell for an outer lane
  drawCell3D(left, top, cellSize, vpx, vpy, beatPhase, themeColor, isActive) {
    const ctx = this.ctx;
    const df = CFG.DEPTH_FACTOR;

    // Outer cell corners
    const oc = [
      [left, top], [left+cellSize, top],
      [left+cellSize, top+cellSize], [left, top+cellSize],
    ];
    // Inner corners (perspective-projected toward vanishing point)
    const ic = oc.map(([px,py]) => [lerp(px,vpx,df), lerp(py,vpy,df)]);

    ctx.save();

    // Dark back face
    ctx.fillStyle = 'rgba(0,0,15,0.75)';
    ctx.beginPath();
    ctx.moveTo(ic[0][0],ic[0][1]);
    for (let i=1;i<4;i++) ctx.lineTo(ic[i][0],ic[i][1]);
    ctx.closePath(); ctx.fill();

    // Side walls (trapezoids) — subtle shading
    const wallColors = ['rgba(0,30,60,0.25)','rgba(0,20,50,0.2)','rgba(0,25,55,0.25)','rgba(0,20,50,0.2)'];
    for (let i=0; i<4; i++) {
      const ni = (i+1)%4;
      ctx.fillStyle = wallColors[i];
      ctx.beginPath();
      ctx.moveTo(oc[i][0],oc[i][1]); ctx.lineTo(oc[ni][0],oc[ni][1]);
      ctx.lineTo(ic[ni][0],ic[ni][1]); ctx.lineTo(ic[i][0],ic[i][1]);
      ctx.closePath(); ctx.fill();
    }

    // Depth corner lines
    const pulse = 0.12 + (isActive ? 0.18 : 0) + 0.05*Math.sin(beatPhase*TAU);
    ctx.strokeStyle = themeColor;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 6; ctx.shadowColor = themeColor;
    for (let i=0; i<4; i++) {
      ctx.beginPath();
      ctx.moveTo(oc[i][0],oc[i][1]); ctx.lineTo(ic[i][0],ic[i][1]);
      ctx.stroke();
    }

    // Inner square glow
    ctx.strokeStyle = themeColor;
    ctx.globalAlpha = pulse * 0.9;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ic[0][0],ic[0][1]);
    for (let i=1;i<4;i++) ctx.lineTo(ic[i][0],ic[i][1]);
    ctx.closePath(); ctx.stroke();

    // Outer cell border
    ctx.strokeStyle = themeColor;
    ctx.globalAlpha = pulse * 0.6;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 12;
    ctx.strokeRect(left, top, cellSize, cellSize);

    ctx.shadowBlur=0; ctx.globalAlpha=1;
    ctx.restore();
  }

  // Centre cell — glowing target
  drawCenterCell(left, top, cellSize, beatPhase, themeColor) {
    const ctx = this.ctx;
    ctx.save();
    const pulse = 0.05 + 0.04*Math.sin(beatPhase*TAU);
    ctx.fillStyle = themeColor;
    ctx.globalAlpha = pulse;
    ctx.fillRect(left, top, cellSize, cellSize);

    ctx.globalAlpha = 0.5 + 0.25*Math.sin(beatPhase*TAU);
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 20; ctx.shadowColor = themeColor;
    ctx.strokeRect(left, top, cellSize, cellSize);

    // Centre dot
    ctx.fillStyle = themeColor;
    ctx.globalAlpha = 0.7 + 0.3*Math.sin(beatPhase*TAU);
    ctx.beginPath(); ctx.arc(left+cellSize/2, top+cellSize/2, 6, 0, TAU); ctx.fill();

    ctx.shadowBlur=0; ctx.globalAlpha=1;
    ctx.restore();
  }

  // Grid outer border
  drawGridBorder(left, top, cellSize, beatPhase, themeColor) {
    const ctx = this.ctx;
    const gs = cellSize*3;
    ctx.save();
    ctx.strokeStyle = themeColor;
    ctx.globalAlpha = 0.3 + 0.1*Math.sin(beatPhase*TAU);
    ctx.lineWidth = 2;
    ctx.shadowBlur = 16; ctx.shadowColor = themeColor;
    ctx.strokeRect(left, top, gs, gs);
    ctx.shadowBlur=0; ctx.globalAlpha=1;
    ctx.restore();
  }

  // Beat — stays in cell, grows toward viewer (3D illusion)
  drawBeat(beat, beatPhase) {
    const ctx = this.ctx;
    const p = beat.pos();
    const r = beat.radius;
    const color = BEAT_C[beat.type] || C.CYAN;
    const t = now();

    ctx.save();
    ctx.globalAlpha = beat.alpha;

    const catchPulse = beat.state==='catchable'
      ? 0.5 + 0.5*Math.sin(t*0.018+beat.glowSeed) : 0;
    const glow = 20 + catchPulse*30 + r*0.8;
    ctx.shadowBlur = glow; ctx.shadowColor = color;

    // Main circle with radial gradient (bright core → transparent edge)
    const g = ctx.createRadialGradient(p.x-r*.25, p.y-r*.25, 0, p.x, p.y, r);
    g.addColorStop(0, color+'FF');
    g.addColorStop(0.5, color+'CC');
    g.addColorStop(1, color+'11');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();

    // Hard outline
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();

    // Catchable pulse ring
    if (beat.state==='catchable') {
      ctx.strokeStyle = color;
      ctx.globalAlpha = beat.alpha * catchPulse * 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r*(1+catchPulse*.35), 0, TAU); ctx.stroke();
      ctx.globalAlpha = beat.alpha;
    }

    // "Depth trail" — a faint line from visual pos back toward far point
    if (beat.travelProgress > 0.1 && beat.travelProgress < 0.98) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = beat.alpha * beat.travelProgress * 0.2;
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
      ctx.setLineDash([3,6]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(beat.bx, beat.by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = beat.alpha;
    }

    ctx.shadowBlur=0; ctx.restore();
  }

  // Hover highlight when cursor is over a catchable beat's cell
  drawHoverHighlight(beat) {
    const ctx = this.ctx;
    const cc = beat.cellCenter;
    const r = beat.maxRadius * 1.3;
    const color = BEAT_C[beat.type] || C.CYAN;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = C.WHITE;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 18; ctx.shadowColor = color;
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.arc(cc.x, cc.y, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur=0; ctx.restore();
  }

  // Preview: straight line from startX,startY to current mouse
  drawSlashPreview(x0, y0, x1, y1) {
    const ctx = this.ctx;
    const len = dist(x0,y0,x1,y1);
    if (len < 10) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(180,210,255,0.4)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.setLineDash([8,10]);
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    ctx.setLineDash([]);
    // Arrow head at end
    const ang = Math.atan2(y1-y0, x1-x0);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = C.CYAN;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 10; ctx.shadowColor = C.CYAN;
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x1-14*Math.cos(ang-0.45), y1-14*Math.sin(ang-0.45));
    ctx.moveTo(x1,y1);
    ctx.lineTo(x1-14*Math.cos(ang+0.45), y1-14*Math.sin(ang+0.45));
    ctx.stroke();
    ctx.shadowBlur=0; ctx.restore();
  }

  // Deployed slash — sharp glowing line that fades
  drawSlash(sd) {
    if (!sd) return;
    const ctx = this.ctx;
    const age = (now()-sd.bornAt)/CFG.SLASH_DISPLAY_MS;
    if (age>=1) return;
    const alpha = Math.pow(1-age, 0.6);
    const width = Math.max(1.5, 7*(1-age));
    let color = C.CYAN;
    if (sd.hitCount>=4) color=C.WHITE;
    else if (sd.hitCount>=3) color=C.GOLD;
    else if (sd.hitCount>=2) color=C.GREEN;

    ctx.save();
    // Glow bloom
    ctx.globalAlpha = alpha*0.25;
    ctx.strokeStyle = color; ctx.lineWidth = width*3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sd.x0,sd.y0); ctx.lineTo(sd.x1,sd.y1); ctx.stroke();
    // Core
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.shadowBlur = 24*(1-age*0.5); ctx.shadowColor = color;
    ctx.beginPath(); ctx.moveTo(sd.x0,sd.y0); ctx.lineTo(sd.x1,sd.y1); ctx.stroke();
    // Start/end points
    ctx.fillStyle = color;
    ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(sd.x0,sd.y0,width*1.2,0,TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(sd.x1,sd.y1,width*1.5,0,TAU); ctx.fill();
    ctx.shadowBlur=0; ctx.globalAlpha=1; ctx.restore();
  }

  drawParticle(p) {
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=p.alpha;
    ctx.fillStyle=p.color; ctx.shadowBlur=8; ctx.shadowColor=p.color;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,TAU); ctx.fill();
    ctx.shadowBlur=0; ctx.restore();
  }

  drawRing(ring) {
    const ctx=this.ctx;
    const age=(now()-ring.born)/ring.life;
    if(age>=1)return;
    ctx.save();
    ctx.globalAlpha=(1-age)*0.85;
    ctx.strokeStyle=ring.color; ctx.lineWidth=3*(1-age);
    ctx.shadowBlur=22; ctx.shadowColor=ring.color;
    ctx.beginPath(); ctx.arc(ring.x,ring.y,18+age*72,0,TAU); ctx.stroke();
    ctx.shadowBlur=0; ctx.restore();
  }

  drawPopup(popup) {
    const ctx=this.ctx;
    const age=(now()-popup.born)/popup.life;
    if(age>=1)return;
    const fa=age<0.65?1:1-(age-0.65)/0.35;
    ctx.save(); ctx.globalAlpha=fa;
    ctx.font='bold 20px Orbitron,monospace';
    ctx.fillStyle=popup.color; ctx.shadowBlur=16; ctx.shadowColor=popup.color;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(popup.text, popup.x, popup.y-age*36);
    ctx.shadowBlur=0; ctx.restore();
  }

  drawHealth(hp,color,flashAlpha,W,H) {
    const ctx=this.ctx;
    ctx.save();
    const barH=8, y=H-barH;
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(0,y,W,barH);
    ctx.fillStyle=color; ctx.shadowBlur=10; ctx.shadowColor=color;
    ctx.fillRect(0,y,W*(hp/100),barH);
    ctx.shadowBlur=0;
    if(flashAlpha>0){
      ctx.globalAlpha=flashAlpha*0.4; ctx.fillStyle=C.RED; ctx.fillRect(0,0,W,H);
    }
    ctx.globalAlpha=1; ctx.restore();
  }

  drawHUD(score,combo,mult,beatPhase,themeColor,W) {
    const ctx=this.ctx;
    ctx.save();
    ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fillRect(0,0,W,4);
    ctx.fillStyle=themeColor; ctx.shadowBlur=6; ctx.shadowColor=themeColor;
    ctx.fillRect(0,0,W*beatPhase,4); ctx.shadowBlur=0;

    ctx.font='bold 30px Orbitron,monospace';
    ctx.fillStyle=themeColor; ctx.shadowBlur=14; ctx.shadowColor=themeColor;
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(String(score).padStart(9,'0'), 22, 14);
    ctx.font='11px Orbitron,monospace'; ctx.fillStyle='#334455'; ctx.shadowBlur=0;
    ctx.fillText('SCORE', 22, 52);

    if(combo>0){
      ctx.font='bold 28px Orbitron,monospace';
      ctx.fillStyle=themeColor; ctx.shadowBlur=16; ctx.shadowColor=themeColor;
      ctx.textAlign='right'; ctx.textBaseline='top';
      ctx.fillText(`${combo}×`, W-22, 14);
      ctx.font='11px Orbitron,monospace'; ctx.fillStyle='#334455'; ctx.shadowBlur=0;
      ctx.fillText('COMBO', W-22, 52);
    }

    if(mult>1){
      ctx.font='bold 15px Orbitron,monospace';
      ctx.fillStyle=mult>=5?C.WHITE:mult>=4?C.GOLD:mult>=3?C.MAGENTA:C.ORANGE;
      ctx.shadowBlur=10; ctx.shadowColor=ctx.fillStyle;
      ctx.textAlign='right';
      ctx.fillText(`${mult}× MULT`, W-22, 66);
    }
    ctx.restore();
  }

  drawFlash(intensity, color=C.CYAN) {
    if(intensity<=0)return;
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=intensity;
    ctx.fillStyle=color; ctx.fillRect(0,0,this.W,this.H);
    ctx.restore();
  }

  drawCountdown(text, alpha) {
    if(alpha<=0)return;
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.font='bold 100px Orbitron,monospace';
    ctx.fillStyle=C.CYAN; ctx.shadowBlur=50; ctx.shadowColor=C.CYAN;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, this.W/2, this.H/2);
    ctx.shadowBlur=0; ctx.restore();
  }

  drawHint(text, alpha, W, H) {
    if(alpha<=0)return;
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.font='13px Orbitron,monospace'; ctx.fillStyle='#445566';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(text, W/2, H-16);
    ctx.restore();
  }
}

// ============================================================
//  RHYTHM SYSTEM
// ============================================================
class RhythmSystem {
  constructor(BPM) {
    this.BPM=BPM; this.beatMs=60000/BPM;
    this.startTime=0; this.nextBeatIdx=0; this.nextBeatTime=0;
    this.running=false; this.onBeat=null;
  }
  start() {
    this.startTime=now(); this.nextBeatIdx=0;
    this.nextBeatTime=this.startTime; this.running=true;
  }
  stop() { this.running=false; }
  update() {
    if(!this.running)return;
    const t=now();
    while(t>=this.nextBeatTime){
      if(this.onBeat)this.onBeat(this.nextBeatIdx,this.nextBeatTime);
      this.nextBeatIdx++;
      this.nextBeatTime=this.startTime+this.nextBeatIdx*this.beatMs;
    }
  }
  beatPhase() {
    const elapsed=Math.max(0,now()-this.startTime);
    return clamp(elapsed%this.beatMs/this.beatMs, 0, 1);
  }
}

// ============================================================
//  PATTERN GENERATOR
//  All beat positions are integer multiples of beats for tight sync
//  Lane indices: 0=TL,1=TC,2=TR,3=ML,4=MR,5=BL,6=BC,7=BR
// ============================================================
function generatePattern(difficulty) {
  const pattern = [];
  function push(beat, lanes, type='normal') {
    pattern.push({beat, lanes: Array.isArray(lanes)?lanes:[lanes], type});
  }

  if (difficulty==='easy') {
    // One beat at a time, lands on whole beats
    let b=4;
    const seq=[1,6,3,4, 1,4, 0,7, 2,5, 1,3,4,6, 0,2,5,7, 1,6];
    for (let i=0; i<seq.length; i++) { push(b,[seq[i]],'normal'); b+=3; }

  } else if (difficulty==='medium') {
    let b=4;
    // Pairs on whole beats, spacing decreases
    const pairs=[[0,7],[1,6],[2,5],[3,4],[0,2,5,7],[1,3,4,6],[0,6],[2,4],[1,7],[3,5]];
    for (let i=0; i<30; i++) {
      const chord=pairs[i%pairs.length];
      const type=i>10&&i%5===0?'chain':i>18&&i%7===0?'hold':'normal';
      push(b, chord, type);
      if (type==='chain') push(b+1, [chord[(i+2)%chord.length]], 'normal');
      b += i<10?3:i<20?2:1;
    }

  } else { // hard
    let b=4;
    const shapes=[
      [0,7],[2,5],[1,6],[3,4],
      [0,2,5,7],[1,3,4,6],
      [0,1,2],[5,6,7],[0,3,5],[2,4,7],
      [0,1,2,3,4,5,6,7],
      [0,4,7],[2,3,5],[1,4,6],
    ];
    let si=0;
    while(b<140){
      const shape=shapes[si%shapes.length];
      const type=Math.random()<0.2?'chain':Math.random()<0.15?'hold':Math.random()<0.1?'directional':'normal';
      push(b, shape, type);
      if(type==='chain'){
        push(b+1, [shape[(si+3)%shape.length]], 'normal');
        if(si%3===0) push(b+2, [shape[(si+5)%shape.length]], 'normal');
      }
      si++;
      b += Math.max(1, Math.round(1.8 - si*0.025));
    }
  }

  pattern.sort((a,b)=>a.beat-b.beat);
  return pattern;
}

// ============================================================
//  GAME
// ============================================================
class Game {
  constructor() {
    this.canvas   = document.getElementById('gameCanvas');
    this.state    = 'menu';
    this.diff     = 'easy';

    this.audio    = new AudioSystem();
    this.draw     = new DrawSystem(this.canvas);
    this.renderer = new RenderSystem(this.canvas);

    this.rhythm   = null;
    this.beats    = null;
    this.particles= null;
    this.shake    = null;
    this.health   = null;
    this.score    = null;
    this.gridbg   = null;

    this._customBuffer  = null;
    this._customBeatmap = null;
    this._customBPM     = null;

    this._spawnQueue    = [];
    this._lastArrivalMs = 0;
    this._introStart    = 0;
    this._hintAlpha     = 1;
    this._hintFadeAt    = 0;
    this._lastT         = 0;

    this._bindResize();
    this._bindUI();
    requestAnimationFrame(t=>this._loop(t));
  }

  // ------- grid helpers -------

  _getGrid() {
    const W=this.renderer.W, H=this.renderer.H;
    const gridSize=Math.min(W,H)*CFG.GRID_RATIO;
    const cellSize=gridSize/3;
    const left=(W-gridSize)/2;
    const top=(H-gridSize)/2;
    return { gridSize, cellSize, left, top, W, H,
             vpx: left+gridSize/2, vpy: top+gridSize/2 };
  }

  _cellCenter(col, row, grid) {
    return {
      x: grid.left + (col+0.5)*grid.cellSize,
      y: grid.top  + (row+0.5)*grid.cellSize,
    };
  }

  _cellTopLeft(col, row, grid) {
    return {
      x: grid.left + col*grid.cellSize,
      y: grid.top  + row*grid.cellSize,
    };
  }

  // ------- setup -------

  _bindResize() {
    const r=()=>{
      const w=window.innerWidth, h=window.innerHeight;
      this.renderer.resize(w,h);
      this.canvas.style.width=w+'px'; this.canvas.style.height=h+'px';
    };
    window.addEventListener('resize',r); r();
  }

  _bindUI() {
    document.querySelectorAll('.diff-btn').forEach(b=>{
      b.addEventListener('click',()=>{
        document.querySelectorAll('.diff-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active'); this.diff=b.dataset.diff;
      });
    });

    document.getElementById('btn-play').addEventListener('click',()=>this._startGame());
    document.getElementById('btn-retry').addEventListener('click',()=>this._startGame());
    document.getElementById('btn-menu').addEventListener('click',()=>this._showMenu());

    const inp=document.getElementById('mp3-input');
    document.getElementById('btn-upload').addEventListener('click',()=>inp.click());
    inp.addEventListener('change',e=>{
      const file=e.target.files[0];
      if(file)this._handleUpload(file);
    });

    document.addEventListener('pointerdown',()=>this.audio.resume(),{once:true});
    document.addEventListener('keydown',e=>{
      if(e.code==='Escape'&&this.state==='playing')this._endGame(false);
    });
  }

  _showMenu() {
    this.state='menu';
    if(this.rhythm)this.rhythm.stop();
    this.audio.stopTrack();
    document.getElementById('screen-menu').classList.remove('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');
  }

  async _handleUpload(file) {
    this.audio.init();
    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-loading').classList.remove('hidden');
    const bar=document.getElementById('loading-bar-fill');
    const status=document.getElementById('loading-status');

    try {
      const ab=await file.arrayBuffer();
      status.textContent='Decoding audio…';
      const result=await analyzeAudio(ab,p=>{
        bar.style.width=(p*100)+'%';
        if(p>0.5)status.textContent='Detecting beats…';
        if(p>0.8)status.textContent='Building beatmap…';
      });
      const ab2=await file.arrayBuffer();
      const actx=this.audio.ctx||new AudioContext();
      this._customBuffer=await actx.decodeAudioData(ab2);
      this._customBeatmap=result.beats;
      this._customBPM=result.bpm;
      document.getElementById('track-label').textContent=file.name;
      status.textContent=`Found ${result.beats.length} beats · ${result.bpm} BPM`;
    } catch(err) {
      console.error(err);
      this._customBuffer=null; this._customBeatmap=null;
      document.getElementById('track-label').textContent='Load failed — using built-in';
    }

    document.getElementById('screen-loading').classList.add('hidden');
    document.getElementById('screen-menu').classList.remove('hidden');
  }

  // ------- game start -------

  _startGame() {
    this.audio.init();
    const dc=CFG.DIFF[this.diff];

    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');

    this.beats    =new BeatSystem();
    this.particles=new ParticleSystem();
    this.shake    =new ShakeSystem();
    this.health   =new HealthSystem();
    this.score    =new ScoreSystem();
    this.gridbg   =new GridBG();

    this.draw.isDown=false; this.draw.pendingCheck=null; this.draw.slashDisplay=null;

    const BPM=this._customBPM||dc.BPM;
    const beatMs=60000/BPM;
    const travelMs=dc.travelBeats*beatMs;
    const catchMs=dc.catchBeats*beatMs;
    const startMs=now()+600;

    let pattern;
    if (this._customBeatmap) {
      pattern=this._buildCustomPattern(this._customBeatmap, dc, startMs, beatMs);
    } else {
      pattern=generatePattern(this.diff);
    }

    this._spawnQueue=[];
    for (const entry of pattern) {
      const arrivalMs=startMs+entry.beat*beatMs;
      const spawnMs=arrivalMs-travelMs;
      for (const lane of entry.lanes) {
        this._spawnQueue.push({laneIdx:lane%8, type:entry.type, spawnMs, arrivalMs, catchMs});
      }
    }
    this._spawnQueue.sort((a,b)=>a.spawnMs-b.spawnMs);
    this._lastArrivalMs=this._spawnQueue.length>0
      ? this._spawnQueue[this._spawnQueue.length-1].arrivalMs : startMs+8000;

    this.rhythm=new RhythmSystem(BPM);
    this.rhythm.startTime=startMs;
    this.rhythm.nextBeatTime=startMs;
    this.rhythm.nextBeatIdx=0;
    this.rhythm.running=true;
    this.rhythm.onBeat=(idx,beatT)=>this._onBeat(idx,beatT,BPM);

    if (this._customBuffer&&this.audio.ctx) {
      const src=this.audio.ctx.createBufferSource();
      src.buffer=this._customBuffer; src.connect(this.audio.master);
      const when=this.audio.ctx.currentTime+(startMs-now())/1000;
      src.start(Math.max(this.audio.ctx.currentTime,when));
      this.audio.srcNode=src;
    }

    this._introStart=now();
    this._hintAlpha=1;
    this._hintFadeAt=startMs+5000;
    this.state='playing';
  }

  // Build queue from exact onset timestamps — beats land on transients
  _buildCustomPattern(onsetSec, dc, startMs, beatMs) {
    const groups=[];
    let i=0;
    while (i<onsetSec.length) {
      const grp=[onsetSec[i]];
      let j=i+1;
      while (j<onsetSec.length && onsetSec[j]-onsetSec[i]<0.08) {
        grp.push(onsetSec[j]); j++;
      }
      groups.push({t:onsetSec[i], count:grp.length});
      i=j;
    }

    return groups.map((g,idx)=>{
      // Use exact onset time — no BPM rounding drift
      const exactArrivalMs = startMs + g.t*1000;
      const beatIdx = (exactArrivalMs - startMs) / beatMs;
      const numLanes = Math.min(g.count, dc.maxLanes||3);
      const offset = idx*2;
      const lanes = Array.from({length:numLanes}, (_,k)=>(offset+k*3)%8);
      return {beat:beatIdx, lanes, type:'normal'};
    });
  }

  _endGame(cleared=false) {
    this.state='gameover';
    if(this.rhythm)this.rhythm.stop();
    this.audio.stopTrack();
    document.getElementById('gameover-heading').textContent=cleared?'CLEARED!':'GAME OVER';
    document.getElementById('gameover-heading').className='gameover-title'+(cleared?' cleared':'');
    document.getElementById('res-score').textContent    =this.score.score;
    document.getElementById('res-combo').textContent    =this.score.maxCombo;
    document.getElementById('res-accuracy').textContent =this.score.accuracy+'%';
    document.getElementById('res-perfects').textContent =this.score.perfects;
    document.getElementById('res-goods').textContent    =this.score.goods;
    document.getElementById('res-misses').textContent   =this.score.misses;
    document.getElementById('screen-gameover').classList.remove('hidden');
  }

  // ------- beat events -------

  _onBeat(beatIdx, beatT, BPM) {
    if (this.audio.ctx&&!this._customBuffer) {
      const at=this.audio.ctx.currentTime+(beatT-now())/1000;
      this.audio.scheduleBar(Math.max(this.audio.ctx.currentTime,at), BPM, beatIdx);
    }
    if (this.gridbg) this.gridbg.onBeat(beatT);
  }

  _processSpawnQueue() {
    const t=now();
    if (!this._spawnQueue.length) return;
    let grid=null;
    while (this._spawnQueue.length && this._spawnQueue[0].spawnMs<=t) {
      const q=this._spawnQueue.shift();
      if (!grid) grid=this._getGrid();
      const [col,row]=LANE_TO_CELL[q.laneIdx%8];
      const outer=this._cellCenter(col,row,grid);
      // Far position: outer cell center pulled toward vanishing point
      const bx=lerp(outer.x, grid.vpx, CFG.DEPTH_FACTOR);
      const by=lerp(outer.y, grid.vpy, CFG.DEPTH_FACTOR);
      const maxR=grid.cellSize*0.40;
      this.beats.spawn(q.laneIdx, q.type, q.spawnMs, q.arrivalMs, q.catchMs,
                       outer.x, outer.y, bx, by, maxR);
    }
  }

  // ------- hit detection -------

  // Hover-to-catch: no click needed, just mouse over
  _checkHoverCatch() {
    if (this.draw.isDrawing) return; // slash mode takes priority
    const mx=this.draw.mouseX, my=this.draw.mouseY;
    if (mx===-9999) return;

    for (const b of this.beats.beats) {
      if (b.state!=='catchable'||b._scored) continue;
      // Check against visual position (which is near cell center when catchable)
      const p = b.pos();
      if (dist(mx,my,p.x,p.y) > b.radius*1.6) continue;

      b._scored=true; b.state='hit'; b.alpha=1;
      const grade=b.catchProgress<0.15||b.catchProgress>0.85?'good':'perfect';
      const color=BEAT_C[b.type]||C.CYAN;
      this.particles.burst(p.x,p.y,color,18,360);
      this.audio.playHit(grade==='perfect');
      this.health.hit();
      this.score.hit(grade,p.x,p.y,1);
      this.shake.shake(2);
    }
  }

  // Slash check — runs once on release (pendingCheck)
  _checkSlash(slash) {
    const pts=[{x:slash.x0,y:slash.y0},{x:slash.x1,y:slash.y1}];
    let hitCount=0, hadBeats=false;

    for (const b of this.beats.beats) {
      if (b.state==='catchable') hadBeats=true;
      if (b.state!=='catchable'||b._scored) continue;
      const p=b.pos();
      const detR=b.radius*CFG.SLASH_HIT_MULT;
      if (!segCircle(pts[0].x,pts[0].y,pts[1].x,pts[1].y,p.x,p.y,detR)) continue;

      b._scored=true; b.state='hit'; b.alpha=1;
      const grade=b.catchProgress<0.15||b.catchProgress>0.85?'good':'perfect';
      hitCount++;
      const color=BEAT_C[b.type]||C.CYAN;
      this.particles.burst(p.x,p.y,color,18,360);
      this.audio.playHit(grade==='perfect');
      this.health.hit();
      this.score.hit(grade,p.x,p.y,hitCount);
    }

    if (this.draw.slashDisplay) this.draw.slashDisplay.hitCount=hitCount;

    if (hitCount===0 && hadBeats) {
      const cx=this.renderer.W/2, cy=this.renderer.H/2;
      this.score.whiff(cx,cy);
      this.health.whiff();
      this.shake.shake(7);
      this.audio.playWhiff();
    }
    if (hitCount>1) {
      const cx=this.renderer.W/2, cy=this.renderer.H/2;
      this.audio.playMulti(hitCount);
      this.particles.burst(cx,cy,C.WHITE,24,450);
      if (hitCount>=4) this.shake.shake(5);
    }
  }

  _checkMisses() {
    for (const b of this.beats.beats) {
      if (b.state==='miss'&&!b._scored) {
        b._scored=true;
        const p=b.pos();
        this.score.miss(p.x,p.y);
        this.health.miss();
        this.shake.shake(12);
        this.particles.emit(p.x,p.y,C.RED,8,140);
        this.audio.playMiss();
      }
    }
  }

  // ------- main loop -------

  _loop(timestamp) {
    const dt=Math.min(timestamp-this._lastT,100);
    this._lastT=timestamp;
    if (this.state==='playing') this._update(dt);
    this._render();
    requestAnimationFrame(t=>this._loop(t));
  }

  _update(dt) {
    const t=now();
    const dc=CFG.DIFF[this.diff];

    this.rhythm.update();
    this.draw.update();
    this._processSpawnQueue();
    this.beats.update(dt);

    this._checkHoverCatch();

    if (this.draw.pendingCheck) {
      this._checkSlash(this.draw.pendingCheck);
      this.draw.pendingCheck=null;
    }

    this._checkMisses();
    this.particles.update(dt);
    this.score.update();
    this.shake.update(dt);
    this.gridbg.update();

    if (dc.hpDrain>0) this.health.drain(dt,dc.hpDrain);
    if (t>this._hintFadeAt) this._hintAlpha=Math.max(0,this._hintAlpha-dt/1200);
    if (this.health.dead) { this._endGame(false); return; }
    if (!this._spawnQueue.length && !this.beats.beats.length && t>this._lastArrivalMs+2500) {
      this._endGame(true);
    }
  }

  _render() {
    const r=this.renderer;
    const W=r.W, H=r.H;
    const t=now();

    r.clear();
    if (this.state==='menu') return;

    const grid=this._getGrid();
    const phase=this.rhythm?this.rhythm.beatPhase():0;
    const theme=this.score?comboColor(this.score.combo):C.CYAN;
    const cx=grid.vpx, cy=grid.vpy;

    const ctx=r.ctx;
    ctx.save();
    if (this.shake&&(this.shake.x||this.shake.y)) ctx.translate(this.shake.x,this.shake.y);

    // --- Grid background ---
    if (this.gridbg) this.gridbg.draw(ctx,grid.left,grid.top,grid.cellSize,phase,theme);

    // --- 3D cells: outer 8 ---
    const activeLanes=new Set(this.beats.beats.filter(b=>b.state!=='traveling'?false:true||b.state==='catchable').map(b=>b.laneIdx));
    for (let li=0; li<8; li++) {
      const [col,row]=LANE_TO_CELL[li];
      const tl=this._cellTopLeft(col,row,grid);
      const isActive=this.beats.beats.some(b=>b.laneIdx===li&&(b.state==='traveling'||b.state==='catchable'));
      r.drawCell3D(tl.x,tl.y,grid.cellSize,grid.vpx,grid.vpy,phase,theme,isActive);
    }

    // --- Centre cell ---
    {
      const tl=this._cellTopLeft(CENTER_COL,CENTER_ROW,grid);
      r.drawCenterCell(tl.x,tl.y,grid.cellSize,phase,theme);
    }

    // --- Grid border ---
    r.drawGridBorder(grid.left,grid.top,grid.cellSize,phase,theme);

    // --- Hover highlight ---
    if (!this.draw.isDrawing) {
      const mx=this.draw.mouseX, my=this.draw.mouseY;
      if (mx!==-9999 && this.beats) {
        for (const b of this.beats.beats) {
          if (b.state!=='catchable'||b._scored) continue;
          const p=b.pos();
          if (dist(mx,my,p.x,p.y)<=b.radius*2.5) r.drawHoverHighlight(b);
        }
      }
    }

    // --- Beats (back to front) ---
    if (this.beats) {
      const sorted=[...this.beats.beats].sort((a,b)=>a.travelProgress-b.travelProgress);
      for (const b of sorted) r.drawBeat(b,phase);
    }

    // --- Slash preview (straight line while dragging) ---
    if (this.draw.isDrawing) {
      r.drawSlashPreview(this.draw.startX,this.draw.startY,this.draw.mouseX,this.draw.mouseY);
    }

    // --- Deployed slash display ---
    r.drawSlash(this.draw.slashDisplay);

    // --- Particles ---
    if (this.particles) for (const p of this.particles.p) r.drawParticle(p);

    // --- Score rings & popups ---
    if (this.score) {
      for (const ring of this.score.rings) r.drawRing(ring);
      for (const pop of this.score.popups) r.drawPopup(pop);
    }

    ctx.restore();

    // --- HUD ---
    if (this.score&&this.health&&this.rhythm) {
      r.drawHUD(this.score.score,this.score.combo,this.score._mult(),phase,theme,W);
      r.drawHealth(this.health.hp,this.health.color,this.health.flashAlpha,W,H);
      r.drawFlash(this.score.screenFlash,theme);
    }

    // --- Countdown ---
    const ie=t-this._introStart;
    if (ie<3000) {
      const cd=Math.ceil((3000-ie)/1000);
      r.drawCountdown(cd===0?'GO!':String(cd), 1-(ie%1000)/1000);
    }

    // --- Hint ---
    r.drawHint('Hover to catch · Click & drag to slash multiple',this._hintAlpha,W,H);

    // --- HP critical vignette ---
    if (this.health&&this.health.hp<30) {
      ctx.save();
      const intensity=(30-this.health.hp)/30*0.35*(0.6+0.4*Math.sin(t*0.008));
      ctx.globalAlpha=intensity;
      const grad=ctx.createRadialGradient(cx,cy,Math.min(W,H)*.3,cx,cy,Math.max(W,H)*.8);
      grad.addColorStop(0,'transparent'); grad.addColorStop(1,C.RED);
      ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
      ctx.restore();
    }
  }
}

// ============================================================
//  BOOT
// ============================================================
window.addEventListener('DOMContentLoaded', ()=>{ window._game=new Game(); });
