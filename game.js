'use strict';
// ============================================================
//  BEAT CATCHER v3 — 3×3 Grid + Hover-to-Catch
//  Systems: BeatAnalyzer · Audio · DrawSystem · Beat
//           · BeatSystem · Particles · Shake · Health
//           · Score · GridBG · Render · Patterns · Game
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
  // Grid
  GRID_RATIO:  0.82,           // grid occupies this fraction of min(W,H)

  // Beat travel & catch
  BEAT_R_MIN:  5,
  BEAT_R_MAX: 36,

  // Slash
  SLASH_MIN_PTS:   2,
  SLASH_HIT_MULT:  1.5,

  // Scoring
  SCORE_PERFECT: 300,
  SCORE_GOOD:    150,
  SCORE_MULTI:   80,
  MULT_STEPS:    [0, 5, 15, 30, 60],

  // Health
  HP_START:    100,
  HP_HIT_GAIN: 3,
  HP_MISS:     22,
  HP_WHIFF:    10,

  // Difficulty
  DIFF: {
    easy:   { BPM: 100, travelBeats: 5, catchBeats: 1.5, slashMs: 1100, maxLanes: 3, hpDrain: 0   },
    medium: { BPM: 145, travelBeats: 4, catchBeats: 1.0, slashMs:  850, maxLanes: 5, hpDrain: 0   },
    hard:   { BPM: 185, travelBeats: 3, catchBeats: 0.65,slashMs:  650, maxLanes: 8, hpDrain: 1.5 },
  },
};

// 3×3 grid: 8 outer cells mapped to lane 0–7
// Layout:
//   [0][1][2]
//   [3][C][4]
//   [5][6][7]
// col/row in grid coords (0-2)
const LANE_TO_CELL = [
  [0,0], // 0 → top-left
  [1,0], // 1 → top-center
  [2,0], // 2 → top-right
  [0,1], // 3 → middle-left
  [2,1], // 4 → middle-right
  [0,2], // 5 → bottom-left
  [1,2], // 6 → bottom-center
  [2,2], // 7 → bottom-right
];
const CENTER_COL = 1, CENTER_ROW = 1;

// ============================================================
//  BEAT ANALYZER  (MP3 → onset timestamps)
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
    const half = 4;
    let sum = 0, cnt = 0;
    for (let j = Math.max(0,i-half); j <= Math.min(onset.length-1,i+half); j++) {
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
    this.ctx    = null;
    this.master = null;
    this.srcNode= null;
    this.enabled= true;
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

  playBuffer(decodedBuffer, startDelayMs = 200) {
    if (!this.ctx) return 0;
    if (this.srcNode) { try { this.srcNode.stop(); } catch(e){} }
    const src = this.ctx.createBufferSource();
    src.buffer = decodedBuffer;
    src.connect(this.master);
    const when = this.ctx.currentTime + startDelayMs/1000;
    src.start(when);
    this.srcNode = src;
    return now() + startDelayMs;
  }

  stopTrack() {
    if (this.srcNode) { try { this.srcNode.stop(); } catch(e){} this.srcNode = null; }
  }

  _osc(type, freq, t, dur, peakGain, endGain = 0.001) {
    if (!this.enabled || !this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
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
    for (let i=0;i<len;i++) d[i]=Math.random()*2-1;
    const src=this.ctx.createBufferSource(); src.buffer=buf;
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(gain,t); g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    let node=src;
    if(hpFreq>0){const hp=this.ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=hpFreq;src.connect(hp);node=hp;}
    node.connect(g); g.connect(this.master);
    src.start(t); src.stop(t+dur+0.01);
  }

  kick(t) {
    if(!this.enabled||!this.ctx)return;
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.frequency.setValueAtTime(120,t); o.frequency.exponentialRampToValueAtTime(28,t+0.4);
    g.gain.setValueAtTime(1,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.42);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t+0.43);
  }

  snare(t)  { this._osc('triangle',180,t,0.15,0.7); this._noise(t,0.18,0.5,1800); }
  hihat(t, open=false) { this._noise(t, open?0.22:0.055, 0.3, 7800); }

  synth(t, freq, dur=0.15) {
    if(!this.enabled||!this.ctx)return;
    const o=this.ctx.createOscillator(), lp=this.ctx.createBiquadFilter(), g=this.ctx.createGain();
    o.type='sawtooth'; o.frequency.value=freq;
    lp.type='lowpass'; lp.frequency.setValueAtTime(2400,t); lp.frequency.exponentialRampToValueAtTime(500,t+dur);
    g.gain.setValueAtTime(0.22,t); g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    o.connect(lp); lp.connect(g); g.connect(this.master);
    o.start(t); o.stop(t+dur+0.01);
  }

  scheduleBar(t, BPM, beatIdx) {
    if(!this.enabled||!this.ctx)return;
    const bd=60/BPM, beat=beatIdx%4;
    if(beat===0)this.kick(t);
    if(beat===2)this.snare(t);
    this.hihat(t,beat===2||beat===0);
    const PENTA=[261.63,293.66,329.63,392,440,523.25,587.33,659.25,783.99,880];
    const MELODY=[0,2,4,6,3,5,7,4,2,6,1,5,3,7,0,4];
    this.synth(t, PENTA[MELODY[beatIdx%MELODY.length]], bd*0.42);
  }

  playHit(perfect) {
    if(!this.enabled||!this.ctx)return;
    const t=this.ctx.currentTime;
    this.synth(t, perfect?880:660, 0.12);
    if(perfect)this.synth(t+0.04,1320,0.08);
  }

  playMiss() {
    if(!this.enabled||!this.ctx)return;
    this._osc('sawtooth',200,this.ctx.currentTime,0.2,0.28);
  }

  playMulti(count) {
    if(!this.enabled||!this.ctx||count<2)return;
    const t=this.ctx.currentTime;
    const freqs=[440,660,880,1100,1320];
    for(let i=0;i<Math.min(count,freqs.length);i++)this.synth(t+i*0.03,freqs[i],0.1);
  }
}

// ============================================================
//  DRAW SYSTEM  — track mouse; hold to draw, release to slash
// ============================================================
class DrawSystem {
  constructor(canvas) {
    this.canvas    = canvas;
    this.state     = 'idle';
    this.preview   = [];
    this.deployed  = [];
    this.deployedAt= 0;
    this.deployDur = 1000;
    this.hitCount  = 0;
    // Mouse position (always tracked, even when not drawing)
    this.mouseX    = -9999;
    this.mouseY    = -9999;
    this._bind();
  }

  _bind() {
    const cv = this.canvas;
    const pos = (e) => {
      const r=cv.getBoundingClientRect();
      const sx=cv.width/r.width, sy=cv.height/r.height;
      return {x:(e.clientX-r.left)*sx, y:(e.clientY-r.top)*sy};
    };

    const down = (e) => {
      if(this.state==='deployed')return;
      this.state='drawing';
      this.preview=[];
      const p=pos(e);
      this.mouseX=p.x; this.mouseY=p.y;
      this.preview.push(p);
    };
    const move = (e) => {
      const p=pos(e);
      this.mouseX=p.x; this.mouseY=p.y;
      if(this.state!=='drawing')return;
      const last=this.preview[this.preview.length-1];
      if(!last||dist(p.x,p.y,last.x,last.y)>4)this.preview.push(p);
    };
    const up = () => {
      if(this.state!=='drawing')return;
      if(this.preview.length>=CFG.SLASH_MIN_PTS){
        this.deployed  = [...this.preview];
        this.deployedAt= now();
        this.hitCount  = 0;
        this.state='deployed';
      } else {
        this.state='idle';
      }
      this.preview=[];
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
    if(this.state==='deployed' && now()-this.deployedAt >= this.deployDur){
      this.state='idle';
      this.deployed=[];
    }
  }

  get deployAge() { return this.state==='deployed' ? (now()-this.deployedAt)/this.deployDur : 1; }
  get isDeployed() { return this.state==='deployed'; }
  get isDrawing()  { return this.state==='drawing'; }
}

// ============================================================
//  GEOMETRY — segment × circle
// ============================================================
function segCircle(ax,ay,bx,by,cx,cy,r) {
  const dx=bx-ax, dy=by-ay;
  const fx=ax-cx, fy=ay-cy;
  const a=dx*dx+dy*dy;
  if(a<0.001) return dist(ax,ay,cx,cy)<=r;
  const b=2*(fx*dx+fy*dy);
  const c=fx*fx+fy*fy-r*r;
  let disc=b*b-4*a*c;
  if(disc<0)return false;
  disc=Math.sqrt(disc);
  const t1=(-b-disc)/(2*a), t2=(-b+disc)/(2*a);
  return (t1>=0&&t1<=1)||(t2>=0&&t2<=1)||(t1<0&&t2>1);
}

function slashHitsBeat(points, bx, by, br) {
  for(let i=0;i<points.length-1;i++){
    if(segCircle(points[i].x,points[i].y,points[i+1].x,points[i+1].y,bx,by,br))return true;
  }
  for(const p of points) if(dist(p.x,p.y,bx,by)<=br)return true;
  return false;
}

// ============================================================
//  BEAT  — travels from outer grid cell to centre cell
// ============================================================
class Beat {
  constructor(id, laneIdx, type, spawnTime, arrivalTime, catchMs, sx, sy, ex, ey) {
    this.id          = id;
    this.laneIdx     = laneIdx;
    this.type        = type;
    this.spawnTime   = spawnTime;
    this.arrivalTime = arrivalTime;
    this.catchStart  = arrivalTime - catchMs*0.4;
    this.catchEnd    = arrivalTime + catchMs*0.6;

    // Grid positions
    this.sx = sx; this.sy = sy;   // outer cell centre (spawn)
    this.ex = ex; this.ey = ey;   // centre cell centre (target)

    // Direction angle for decorative arrows
    this.angle = Math.atan2(ey-sy, ex-sx);

    this.state    = 'traveling';
    this.alpha    = 1;
    this.hitRating= null;
    this._dieT    = 0;
    this._scored  = false;
    this.glowSeed = Math.random()*TAU;

    this.holdMs     = 0;
    this.holdNeeded = 500;
  }

  get travelProgress() {
    return clamp((now()-this.spawnTime)/(this.arrivalTime-this.spawnTime),0,1);
  }

  pos() {
    const t = this.travelProgress;
    return { x: lerp(this.sx, this.ex, t), y: lerp(this.sy, this.ey, t) };
  }

  outerPos() { return { x: this.sx, y: this.sy }; }

  get radius() {
    return lerp(CFG.BEAT_R_MIN, CFG.BEAT_R_MAX, this.travelProgress);
  }

  get catchProgress() {
    const win = this.catchEnd - this.catchStart;
    return clamp((now()-this.catchStart)/win, 0, 1);
  }

  get alive() { return this.alpha > 0.01; }
}

// ============================================================
//  BEAT SYSTEM
// ============================================================
class BeatSystem {
  constructor() { this.beats=[]; this._id=0; }

  spawn(laneIdx, type, spawnTime, arrivalTime, catchMs, sx, sy, ex, ey) {
    this.beats.push(new Beat(this._id++, laneIdx, type, spawnTime, arrivalTime, catchMs, sx, sy, ex, ey));
  }

  update(dt) {
    const t = now();
    for(const b of this.beats){
      if(b.state==='traveling' && t>=b.catchStart) b.state='catchable';
      if(b.state==='catchable' && t>b.catchEnd)    { b.state='miss'; b._dieT=t; }
      if(b.state==='hit'||b.state==='miss')         b.alpha=clamp(b.alpha-dt/280,0,1);
    }
    this.beats=this.beats.filter(b=>b.alive);
  }
}

// ============================================================
//  PARTICLE SYSTEM
// ============================================================
class Particle {
  constructor(x,y,vx,vy,color,size,life){
    this.x=x;this.y=y;this.vx=vx;this.vy=vy;
    this.color=color;this.size=size;this.life=life;this.maxLife=life;
  }
  update(dt){
    this.x+=this.vx*dt*0.001; this.y+=this.vy*dt*0.001;
    this.vx*=0.93; this.vy*=0.93; this.size*=0.97; this.life-=dt;
  }
  get alpha(){ return clamp(this.life/this.maxLife,0,1); }
  get alive(){ return this.life>0&&this.size>0.3; }
}

class ParticleSystem {
  constructor(){this.p=[];}
  emit(x,y,color,count=12,speed=260){
    for(let i=0;i<count;i++){
      const a=i/count*TAU+Math.random()*0.5;
      const s=speed*(0.4+Math.random()*0.8);
      this.p.push(new Particle(x+(Math.random()-.5)*8,y+(Math.random()-.5)*8,
        Math.cos(a)*s,Math.sin(a)*s,color,3+Math.random()*5,380+Math.random()*420));
    }
  }
  burst(x,y,color,count=24,speed=400){ this.emit(x,y,color,count,speed); }
  update(dt){ for(const p of this.p)p.update(dt); this.p=this.p.filter(p=>p.alive); }
}

// ============================================================
//  SHAKE SYSTEM
// ============================================================
class ShakeSystem {
  constructor(){ this.amt=0; this.x=0; this.y=0; }
  shake(amount){ this.amt=Math.max(this.amt,amount); }
  update(dt){
    if(this.amt>0.5){
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
  constructor(){ this.hp=CFG.HP_START; this.flashT=0; }
  hit()  { this.hp=Math.min(100,this.hp+CFG.HP_HIT_GAIN); }
  miss() { this.hp=Math.max(0,this.hp-CFG.HP_MISS);  this.flashT=now(); }
  whiff(){ this.hp=Math.max(0,this.hp-CFG.HP_WHIFF); this.flashT=now(); }
  drain(dt,ratePerSec){ this.hp=Math.max(0,this.hp-ratePerSec*dt/1000); }
  get dead(){ return this.hp<=0; }
  get flashAlpha(){ return Math.max(0,1-(now()-this.flashT)/400); }
  get color(){
    if(this.hp>60)return C.GREEN;
    if(this.hp>35)return C.YELLOW;
    if(this.hp>15)return C.ORANGE;
    return C.RED;
  }
}

// ============================================================
//  SCORE SYSTEM
// ============================================================
class ScoreSystem {
  constructor(){
    this.score=0; this.combo=0; this.maxCombo=0;
    this.perfects=0; this.goods=0; this.misses=0; this.total=0;
    this.screenFlash=0; this.popups=[]; this.rings=[];
  }

  get accuracy(){
    if(this.total===0)return 100;
    return Math.round(((this.perfects+this.goods)/this.total)*100);
  }

  _mult(){
    const s=CFG.MULT_STEPS;
    for(let i=s.length-1;i>=0;i--)if(this.combo>=s[i])return i+1;
    return 1;
  }

  _pop(text,x,y,color,life=900){
    this.popups.push({text,x,y,color,born:now(),life});
  }

  hit(rating,x,y,multiCount=1){
    this.total++;
    const mult=this._mult();
    let pts=0;
    if(rating==='perfect'){pts=CFG.SCORE_PERFECT*mult;this.perfects++;}
    else                  {pts=CFG.SCORE_GOOD*mult;   this.goods++;}
    if(multiCount>1) pts+=CFG.SCORE_MULTI*mult*(multiCount-1);
    this.score+=pts; this.combo++; this.maxCombo=Math.max(this.maxCombo,this.combo);
    if(this.combo>0&&this.combo%10===0)this.screenFlash=0.3;
    const col=comboColor(this.combo);
    this._pop(rating==='perfect'?'PERFECT!':'GOOD!',x,y,rating==='perfect'?C.CYAN:C.GREEN);
    if(pts)this._pop(`+${pts}`,x+24,y+26,C.WHITE,700);
    if(multiCount>1)this._pop(`${multiCount}× MULTI!`,x,y-40,C.MAGENTA,1100);
    this.rings.push({x,y,color:col,born:now(),life:500});
  }

  miss(x,y){
    this.total++; this.misses++; this.combo=0;
    this._pop('MISS',x,y,C.RED,700);
  }

  whiff(x,y){
    this.combo=0;
    this._pop('WHIFF!',x,y,C.ORANGE,800);
  }

  update(){
    const t=now();
    this.popups=this.popups.filter(p=>t-p.born<p.life);
    this.rings =this.rings.filter(r=>t-r.born<r.life);
    this.screenFlash=Math.max(0,this.screenFlash-0.022);
  }
}

// ============================================================
//  GRID BACKGROUND — expanding squares + grid glow
// ============================================================
class GridBG {
  constructor(){ this.pulses=[]; }

  onBeat(t){ this.pulses.push({born:t, life:2000}); }

  update(){ this.pulses=this.pulses.filter(p=>now()-p.born<p.life); }

  draw(ctx, left, top, cellSize, beatPhase, themeColor) {
    ctx.save();
    const gridSize = cellSize*3;

    // Expanding square pulses
    const t=now();
    for(const p of this.pulses){
      const age=(t-p.born)/p.life;
      const expand=age*gridSize*0.8;
      const cx=left+gridSize/2, cy=top+gridSize/2;
      ctx.globalAlpha=(1-age)*0.12;
      ctx.strokeStyle=themeColor;
      ctx.lineWidth=2;
      ctx.shadowBlur=10; ctx.shadowColor=themeColor;
      ctx.strokeRect(cx-expand/2, cy-expand/2, expand, expand);
    }
    ctx.globalAlpha=1; ctx.shadowBlur=0;

    // Corner-to-corner diagonal lines (depth lines)
    const cx=left+gridSize/2, cy=top+gridSize/2;
    ctx.globalAlpha=0.04;
    ctx.strokeStyle='#0044aa';
    ctx.lineWidth=1;
    const corners=[
      [left,top],[left+gridSize,top],[left+gridSize,top+gridSize],[left,top+gridSize]
    ];
    for(const [px,py] of corners){
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(px,py); ctx.stroke();
    }

    ctx.restore();
  }
}

// ============================================================
//  RENDER SYSTEM
// ============================================================
class RenderSystem {
  constructor(canvas){
    this.cv=canvas; this.ctx=canvas.getContext('2d');
    this.W=canvas.width; this.H=canvas.height;
  }
  resize(w,h){ this.cv.width=w; this.cv.height=h; this.W=w; this.H=h; }

  clear(){
    this.ctx.fillStyle=C.BG;
    this.ctx.fillRect(0,0,this.W,this.H);
  }

  // Draw the 3×3 grid
  drawGrid(left, top, cellSize, beatPhase, themeColor) {
    const ctx=this.ctx;
    const gs=cellSize*3;
    ctx.save();

    // Grid lines
    const pulse=0.15+0.08*Math.sin(beatPhase*TAU);
    ctx.strokeStyle=themeColor;
    ctx.globalAlpha=pulse;
    ctx.lineWidth=1.5;
    ctx.shadowBlur=12; ctx.shadowColor=themeColor;

    for(let i=0;i<=3;i++){
      const x=left+i*cellSize;
      ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,top+gs); ctx.stroke();
      const y=top+i*cellSize;
      ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(left+gs,y); ctx.stroke();
    }

    // Center cell highlight
    ctx.shadowBlur=0;
    const cx2=left+cellSize, cy2=top+cellSize;
    const cPulse=0.06+0.04*Math.sin(beatPhase*TAU);
    ctx.globalAlpha=cPulse;
    ctx.fillStyle=themeColor;
    ctx.fillRect(cx2,cy2,cellSize,cellSize);

    // Center dot
    ctx.globalAlpha=0.6+0.2*Math.sin(beatPhase*TAU);
    ctx.fillStyle=themeColor;
    ctx.shadowBlur=18; ctx.shadowColor=themeColor;
    ctx.beginPath();
    ctx.arc(left+cellSize*1.5, top+cellSize*1.5, 5, 0, TAU);
    ctx.fill();

    ctx.shadowBlur=0; ctx.globalAlpha=1;
    ctx.restore();
  }

  // Outer cell approach indicator
  drawApproachIndicator(beat, themeColor) {
    const ctx=this.ctx;
    if(beat.state!=='traveling'&&beat.state!=='catchable')return;
    const op=beat.outerPos();
    const tp=clamp(1-(beat.arrivalTime-now())/(beat.arrivalTime-beat.spawnTime),0,1);
    const maxR=CFG.BEAT_R_MAX*5;
    const curR=lerp(maxR, CFG.BEAT_R_MAX*1.15, tp);
    const alpha=tp*0.6+0.1;
    const color=BEAT_C[beat.type]||C.CYAN;
    ctx.save();
    ctx.globalAlpha=alpha*beat.alpha;
    ctx.strokeStyle=color; ctx.lineWidth=2;
    ctx.shadowBlur=10; ctx.shadowColor=color;
    ctx.beginPath(); ctx.arc(op.x,op.y,curR,0,TAU); ctx.stroke();
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.restore();
  }

  // Beat circle — grows as it approaches centre
  drawBeat(beat) {
    const ctx=this.ctx;
    const p=beat.pos();
    const r=beat.radius;
    const color=BEAT_C[beat.type]||C.CYAN;
    const t=now();

    ctx.save();
    ctx.globalAlpha=beat.alpha;

    const catchPulse=(beat.state==='catchable')?0.5+0.5*Math.sin(t*0.018+beat.glowSeed):0;
    ctx.shadowBlur=18+catchPulse*24; ctx.shadowColor=color;

    if(beat.type==='hold'){
      ctx.strokeStyle=color; ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(p.x,p.y,r,0,TAU); ctx.stroke();
      ctx.lineWidth=1.5; ctx.globalAlpha*=0.4;
      ctx.beginPath(); ctx.arc(p.x,p.y,r*1.55,0,TAU); ctx.stroke();
      ctx.globalAlpha=beat.alpha;
      if(beat.holdMs>0){
        ctx.strokeStyle=C.WHITE; ctx.lineWidth=3; ctx.shadowColor=C.WHITE; ctx.shadowBlur=12;
        ctx.beginPath();
        ctx.arc(p.x,p.y,r,-Math.PI/2,-Math.PI/2+TAU*(beat.holdMs/beat.holdNeeded));
        ctx.stroke();
      }
    } else {
      const g=ctx.createRadialGradient(p.x-r*.3,p.y-r*.3,0,p.x,p.y,r);
      g.addColorStop(0,color+'FF'); g.addColorStop(0.5,color+'BB'); g.addColorStop(1,color+'22');
      ctx.fillStyle=g;
      ctx.beginPath(); ctx.arc(p.x,p.y,r,0,TAU); ctx.fill();
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();
    }

    if(beat.state==='catchable'){
      const ringR=r*(1+catchPulse*0.4);
      ctx.strokeStyle=color; ctx.lineWidth=1.5;
      ctx.globalAlpha=beat.alpha*catchPulse*0.7;
      ctx.beginPath(); ctx.arc(p.x,p.y,ringR,0,TAU); ctx.stroke();
      ctx.globalAlpha=beat.alpha;
    }

    if(beat.type==='directional'){
      const ang=beat.angle;
      const al=r*1.7;
      const ax=p.x+Math.cos(ang)*al, ay=p.y+Math.sin(ang)*al;
      const hl=10;
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.shadowBlur=8;
      ctx.beginPath();
      ctx.moveTo(p.x,p.y); ctx.lineTo(ax,ay);
      ctx.moveTo(ax,ay); ctx.lineTo(ax-hl*Math.cos(ang-0.5),ay-hl*Math.sin(ang-0.5));
      ctx.moveTo(ax,ay); ctx.lineTo(ax-hl*Math.cos(ang+0.5),ay-hl*Math.sin(ang+0.5));
      ctx.stroke();
    }

    if(beat.type==='chain'){
      for(let i=1;i<=3;i++){
        const frac=i/4;
        const tp2=beat.travelProgress;
        const tx=lerp(beat.sx,beat.ex,tp2-frac*tp2*0.35);
        const ty=lerp(beat.sy,beat.ey,tp2-frac*tp2*0.35);
        ctx.globalAlpha=beat.alpha*(1-frac)*0.55;
        ctx.fillStyle=color; ctx.shadowBlur=6;
        ctx.beginPath(); ctx.arc(tx,ty,r*(0.4-frac*0.1),0,TAU); ctx.fill();
      }
      ctx.globalAlpha=beat.alpha;
    }

    ctx.shadowBlur=0;
    ctx.restore();
  }

  // Draw hover cursor highlight when near a catchable beat
  drawHoverHighlight(beat) {
    const ctx=this.ctx;
    const p=beat.pos();
    const r=beat.radius*1.6;
    const color=BEAT_C[beat.type]||C.CYAN;
    ctx.save();
    ctx.globalAlpha=0.35;
    ctx.strokeStyle=C.WHITE;
    ctx.lineWidth=3;
    ctx.shadowBlur=20; ctx.shadowColor=color;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.arc(p.x,p.y,r,0,TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur=0; ctx.restore();
  }

  drawPreview(pts){
    if(pts.length<2)return;
    const ctx=this.ctx;
    ctx.save();
    ctx.strokeStyle='rgba(200,220,255,0.35)'; ctx.lineWidth=3;
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.setLineDash([6,8]);
    ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  }

  drawSlash(pts,age,hitCount){
    if(pts.length<2)return;
    const ctx=this.ctx;
    const alpha=Math.max(0,1-age*0.75);
    const width=Math.max(2,9*(1-age*0.6));
    let color=C.CYAN;
    if(hitCount>=4)color=C.WHITE;
    else if(hitCount>=3)color=C.GOLD;
    else if(hitCount>=2)color=C.GREEN;

    ctx.save();
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.globalAlpha=alpha*0.3;
    ctx.strokeStyle=color; ctx.lineWidth=width*2.5;
    ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();

    ctx.globalAlpha=alpha;
    ctx.strokeStyle=color; ctx.lineWidth=width;
    ctx.shadowBlur=28*(1-age); ctx.shadowColor=color;
    ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();
    ctx.shadowBlur=0; ctx.globalAlpha=1;
    ctx.restore();
  }

  drawParticle(p){
    const ctx=this.ctx;
    ctx.save();
    ctx.globalAlpha=p.alpha;
    ctx.fillStyle=p.color;
    ctx.shadowBlur=8; ctx.shadowColor=p.color;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,TAU); ctx.fill();
    ctx.shadowBlur=0; ctx.restore();
  }

  drawRing(ring){
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

  drawPopup(popup){
    const ctx=this.ctx;
    const age=(now()-popup.born)/popup.life;
    if(age>=1)return;
    const fa=age<0.65?1:1-(age-0.65)/0.35;
    ctx.save();
    ctx.globalAlpha=fa;
    ctx.font='bold 20px Orbitron,monospace';
    ctx.fillStyle=popup.color;
    ctx.shadowBlur=16; ctx.shadowColor=popup.color;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(popup.text,popup.x,popup.y-age*38);
    ctx.shadowBlur=0; ctx.restore();
  }

  drawHealth(hp,color,flashAlpha,W,H){
    const ctx=this.ctx;
    ctx.save();
    const barH=8, y=H-barH;
    ctx.fillStyle='rgba(0,0,0,0.5)';
    ctx.fillRect(0,y,W,barH);
    const w=W*(hp/100);
    ctx.fillStyle=color;
    ctx.shadowBlur=10; ctx.shadowColor=color;
    ctx.fillRect(0,y,w,barH);
    ctx.shadowBlur=0;
    if(flashAlpha>0){
      ctx.globalAlpha=flashAlpha*0.4;
      ctx.fillStyle=C.RED;
      ctx.fillRect(0,0,W,H);
    }
    ctx.globalAlpha=1;
    ctx.restore();
  }

  drawHUD(score,combo,mult,beatPhase,themeColor,W){
    const ctx=this.ctx;
    ctx.save();

    ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fillRect(0,0,W,4);
    ctx.fillStyle=themeColor; ctx.shadowBlur=6; ctx.shadowColor=themeColor;
    ctx.fillRect(0,0,W*beatPhase,4); ctx.shadowBlur=0;

    ctx.font='bold 30px Orbitron,monospace';
    ctx.fillStyle=themeColor;
    ctx.shadowBlur=14; ctx.shadowColor=themeColor;
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(String(score).padStart(9,'0'),22,14);
    ctx.font='11px Orbitron,monospace'; ctx.fillStyle='#334455'; ctx.shadowBlur=0;
    ctx.fillText('SCORE',22,52);

    if(combo>0){
      ctx.font='bold 28px Orbitron,monospace';
      ctx.fillStyle=themeColor; ctx.shadowBlur=16; ctx.shadowColor=themeColor;
      ctx.textAlign='right'; ctx.textBaseline='top';
      ctx.fillText(`${combo}×`,W-22,14);
      ctx.font='11px Orbitron,monospace'; ctx.fillStyle='#334455'; ctx.shadowBlur=0;
      ctx.fillText('COMBO',W-22,52);
    }

    if(mult>1){
      ctx.font='bold 15px Orbitron,monospace';
      ctx.fillStyle=mult>=5?C.WHITE:mult>=4?C.GOLD:mult>=3?C.MAGENTA:C.ORANGE;
      ctx.shadowBlur=10; ctx.shadowColor=ctx.fillStyle;
      ctx.textAlign='right';
      ctx.fillText(`${mult}× MULT`,W-22,66);
    }

    ctx.restore();
  }

  drawFlash(intensity,color=C.CYAN){
    if(intensity<=0)return;
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=intensity;
    ctx.fillStyle=color; ctx.fillRect(0,0,this.W,this.H);
    ctx.restore();
  }

  drawCountdown(text,alpha){
    if(alpha<=0)return;
    const ctx=this.ctx;
    ctx.save();
    ctx.globalAlpha=alpha;
    ctx.font='bold 100px Orbitron,monospace';
    ctx.fillStyle=C.CYAN; ctx.shadowBlur=50; ctx.shadowColor=C.CYAN;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text,this.W/2,this.H/2);
    ctx.shadowBlur=0; ctx.restore();
  }

  drawHint(text,alpha,W,H){
    if(alpha<=0)return;
    const ctx=this.ctx;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.font='13px Orbitron,monospace'; ctx.fillStyle='#445566';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(text,W/2,H-16);
    ctx.restore();
  }
}

// ============================================================
//  RHYTHM SYSTEM
// ============================================================
class RhythmSystem {
  constructor(BPM){
    this.BPM=BPM; this.beatMs=60000/BPM;
    this.startTime=0; this.nextBeatIdx=0; this.nextBeatTime=0;
    this.running=false; this.onBeat=null;
  }
  start(){
    this.startTime=now(); this.nextBeatIdx=0;
    this.nextBeatTime=this.startTime; this.running=true;
  }
  stop(){ this.running=false; }
  update(){
    if(!this.running)return;
    const t=now();
    while(t>=this.nextBeatTime){
      if(this.onBeat)this.onBeat(this.nextBeatIdx,this.nextBeatTime);
      this.nextBeatIdx++;
      this.nextBeatTime=this.startTime+this.nextBeatIdx*this.beatMs;
    }
  }
  beatPhase(){
    const elapsed=Math.max(0,now()-this.startTime);
    return clamp(elapsed%this.beatMs/this.beatMs,0,1);
  }
}

// ============================================================
//  PATTERN GENERATOR
//  Lane indices for 3×3 grid: 0=TL,1=TC,2=TR,3=ML,4=MR,5=BL,6=BC,7=BR
// ============================================================
function generatePattern(difficulty){
  const pattern=[];
  function push(beat,lanes,type='normal'){
    pattern.push({beat,lanes:Array.isArray(lanes)?lanes:[lanes],type});
  }

  if(difficulty==='easy'){
    // Cardinals (top/bottom/left/right = lanes 1,6,3,4), then corners
    let b=4;
    const seq=[1,6,3,4,1,4,6,3,0,2,5,7,1,3,6,4,0,7,2,5,1,6];
    for(let i=0;i<22;i++){ push(b,[seq[i%seq.length]],'normal'); b+=3; }

  } else if(difficulty==='medium'){
    let b=4;
    // Pairs across the grid (opposite cells)
    const pairs=[[0,7],[1,6],[2,5],[3,4],[0,2,5,7],[1,3,4,6],[0,6],[2,4],[1,7],[3,5]];
    for(let i=0;i<36;i++){
      const chord=pairs[i%pairs.length];
      const type=i>12&&i%5===0?'chain':i>20&&i%7===0?'hold':'normal';
      push(b,chord,type);
      if(type==='chain') push(b+0.5,[chord[(i+2)%chord.length]],'normal');
      b+=i<12?2.5:i<24?1.5:1;
    }

  } else { // hard
    let b=4;
    // Grid-based shapes: pairs/triples requiring directional slashes
    const shapes=[
      [0,7],        // TL→BR diagonal
      [2,5],        // TR→BL diagonal
      [1,6],        // TC→BC vertical
      [3,4],        // ML→MR horizontal
      [0,2,5,7],   // all corners (X)
      [1,3,4,6],   // all edges (cross)
      [0,1,2],     // top row
      [5,6,7],     // bottom row
      [0,3,5],     // left column
      [2,4,7],     // right column
      [0,1,2,3,4,5,6,7], // all 8
      [0,4,7],     // TL-MR-BR triangle
      [2,3,5],     // TR-ML-BL triangle
      [1,3,4],     // TC-ML-MR cluster
    ];
    let si=0;
    while(b<140){
      const shape=shapes[si%shapes.length];
      const type=Math.random()<0.2?'chain':Math.random()<0.15?'hold':Math.random()<0.12?'directional':'normal';
      push(b,shape,type);
      if(type==='chain'){
        push(b+0.33,[shape[(si+3)%shape.length]],'normal');
        if(si%3===0) push(b+0.66,[shape[(si+5)%shape.length]],'normal');
      }
      si++;
      const interval=Math.max(0.5,1.8-si*0.025);
      b+=interval;
    }
  }

  pattern.sort((a,b)=>a.beat-b.beat);
  return pattern;
}

// ============================================================
//  GAME
// ============================================================
class Game {
  constructor(){
    this.canvas  = document.getElementById('gameCanvas');
    this.state   = 'menu';
    this.diff    = 'easy';

    this.audio   = new AudioSystem();
    this.draw    = new DrawSystem(this.canvas);
    this.renderer= new RenderSystem(this.canvas);

    this.rhythm   = null;
    this.beats    = null;
    this.particles= null;
    this.shake    = null;
    this.health   = null;
    this.score    = null;
    this.gridbg   = null;

    this._customBuffer = null;
    this._customBeatmap= null;
    this._customBPM    = null;

    this._spawnQueue    = [];
    this._lastArrivalMs = 0;
    this._introStart    = 0;
    this._hintAlpha     = 1;
    this._hintFadeAt    = 0;
    this._deployHadBeats= false;

    this._lastT = 0;

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
    return { gridSize, cellSize, left, top, W, H };
  }

  _cellCenter(col, row, grid) {
    return {
      x: grid.left + (col+0.5)*grid.cellSize,
      y: grid.top  + (row+0.5)*grid.cellSize,
    };
  }

  // ------- setup -------

  _bindResize(){
    const r=()=>{
      const w=window.innerWidth, h=window.innerHeight;
      this.renderer.resize(w,h);
      this.canvas.style.width=w+'px'; this.canvas.style.height=h+'px';
    };
    window.addEventListener('resize',r); r();
  }

  _bindUI(){
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

  _showMenu(){
    this.state='menu';
    if(this.rhythm)this.rhythm.stop();
    this.audio.stopTrack();
    document.getElementById('screen-menu').classList.remove('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');
  }

  async _handleUpload(file){
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
    } catch(err){
      console.error(err);
      this._customBuffer=null; this._customBeatmap=null;
      document.getElementById('track-label').textContent='Load failed — using built-in';
    }

    document.getElementById('screen-loading').classList.add('hidden');
    document.getElementById('screen-menu').classList.remove('hidden');
  }

  // ------- game start -------

  _startGame(){
    this.audio.init();
    const dc=CFG.DIFF[this.diff];

    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');

    this.beats    = new BeatSystem();
    this.particles= new ParticleSystem();
    this.shake    = new ShakeSystem();
    this.health   = new HealthSystem();
    this.score    = new ScoreSystem();
    this.gridbg   = new GridBG();

    this.draw.state='idle'; this.draw.preview=[]; this.draw.deployed=[];
    this.draw.deployDur=dc.slashMs;

    const BPM=this._customBPM||dc.BPM;
    const beatMs=60000/BPM;
    const travelMs=dc.travelBeats*beatMs;
    const catchMs=dc.catchBeats*beatMs;

    let pattern;
    if(this._customBeatmap){
      pattern=this._buildCustomPattern(this._customBeatmap,dc);
    } else {
      pattern=generatePattern(this.diff);
    }

    const startMs=now()+600;

    this._spawnQueue=[];
    for(const entry of pattern){
      const arrivalMs=startMs+entry.beat*beatMs;
      const spawnMs=arrivalMs-travelMs;
      for(const lane of entry.lanes){
        this._spawnQueue.push({
          laneIdx: lane%8,
          type: entry.type,
          spawnMs,
          arrivalMs,
          catchMs,
        });
      }
    }
    this._spawnQueue.sort((a,b)=>a.spawnMs-b.spawnMs);
    this._lastArrivalMs=this._spawnQueue.length>0
      ? this._spawnQueue[this._spawnQueue.length-1].arrivalMs
      : startMs+8000;

    this.rhythm=new RhythmSystem(BPM);
    this.rhythm.startTime=startMs;
    this.rhythm.nextBeatTime=startMs;
    this.rhythm.nextBeatIdx=0;
    this.rhythm.running=true;
    this.rhythm.onBeat=(idx,beatT)=>this._onBeat(idx,beatT,BPM);

    if(this._customBuffer&&this.audio.ctx){
      const src=this.audio.ctx.createBufferSource();
      src.buffer=this._customBuffer; src.connect(this.audio.master);
      const when=this.audio.ctx.currentTime+(startMs-now())/1000;
      src.start(Math.max(this.audio.ctx.currentTime,when));
      this.audio.srcNode=src;
    }

    this._introStart=now();
    this._hintAlpha=1;
    this._hintFadeAt=startMs+5000;
    this._deployHadBeats=false;
    this.state='playing';
  }

  _buildCustomPattern(onsetSec,dc){
    const BPM=this._customBPM||dc.BPM;
    const beatMs=60000/BPM;

    const groups=[];
    let i=0;
    while(i<onsetSec.length){
      const grp=[onsetSec[i]];
      let j=i+1;
      while(j<onsetSec.length && onsetSec[j]-onsetSec[i]<0.08){
        grp.push(onsetSec[j]); j++;
      }
      groups.push({t:onsetSec[i], count:grp.length});
      i=j;
    }

    return groups.map((g,idx)=>{
      const beatIdx=(g.t*1000)/beatMs;
      const numLanes=Math.min(g.count,dc.maxLanes||3);
      const offset=idx*2;
      const lanes=Array.from({length:numLanes},(_,k)=>(offset+k*3)%8);
      return {beat:beatIdx, lanes, type:'normal'};
    });
  }

  _endGame(cleared=false){
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

  _onBeat(beatIdx,beatT,BPM){
    if(this.audio.ctx&&!this._customBuffer){
      const at=this.audio.ctx.currentTime+(beatT-now())/1000;
      this.audio.scheduleBar(Math.max(this.audio.ctx.currentTime,at),BPM,beatIdx);
    }
    if(this.gridbg) this.gridbg.onBeat(beatT);
  }

  _processSpawnQueue(){
    const t=now();
    if(this._spawnQueue.length===0)return;
    // Pre-compute grid once per frame only if needed
    let grid=null;
    while(this._spawnQueue.length>0&&this._spawnQueue[0].spawnMs<=t){
      const q=this._spawnQueue.shift();
      if(!grid) grid=this._getGrid();
      const [col,row]=LANE_TO_CELL[q.laneIdx%8];
      const outer=this._cellCenter(col,row,grid);
      const center=this._cellCenter(CENTER_COL,CENTER_ROW,grid);
      this.beats.spawn(q.laneIdx,q.type,q.spawnMs,q.arrivalMs,q.catchMs,
                       outer.x,outer.y,center.x,center.y);
    }
  }

  // ------- hit detection -------

  // Hover-to-catch: single beats auto-hit when mouse is over them
  _checkHoverCatch(){
    if(this.draw.isDrawing||this.draw.isDeployed)return; // slash mode takes over
    const mx=this.draw.mouseX, my=this.draw.mouseY;
    if(mx===-9999)return;

    for(const b of this.beats.beats){
      if(b.state!=='catchable'||b._scored)continue;
      const p=b.pos();
      const hoverR=b.radius*1.5;
      if(dist(mx,my,p.x,p.y)>hoverR)continue;

      b._scored=true;
      b.state='hit'; b.alpha=1;
      const grade=b.catchProgress<0.15||b.catchProgress>0.85?'good':'perfect';
      const color=BEAT_C[b.type]||C.CYAN;
      this.particles.burst(p.x,p.y,color,18,360);
      this.audio.playHit(grade==='perfect');
      this.health.hit();
      this.score.hit(grade,p.x,p.y,1);
    }
  }

  // Slash hit detection (multi-beat)
  _checkDeployedSlash(){
    if(!this.draw.isDeployed||this.draw.deployed.length<2)return;
    const pts=this.draw.deployed;

    for(const b of this.beats.beats){
      if(b.state==='catchable') this._deployHadBeats=true;
      if(b.state!=='catchable'||b._scored)continue;
      const p=b.pos();
      const detR=b.radius*CFG.SLASH_HIT_MULT;
      if(!slashHitsBeat(pts,p.x,p.y,detR))continue;

      b._scored=true;
      b.state='hit'; b.alpha=1;
      const grade=b.catchProgress<0.15||b.catchProgress>0.85?'good':'perfect';
      this.draw.hitCount++;
      this._deployHadBeats=true;

      const color=BEAT_C[b.type]||C.CYAN;
      this.particles.burst(p.x,p.y,color,18,360);
      this.audio.playHit(grade==='perfect');
      this.health.hit();
      this.score.hit(grade,p.x,p.y,this.draw.hitCount);
    }
  }

  _checkWhiffOnExpire(){
    if(this.draw.state!=='idle'||this.draw.deployed.length===0)return;
    if(this.draw.hitCount===0&&this._deployHadBeats){
      const cx=this.renderer.W/2, cy=this.renderer.H/2;
      this.score.whiff(cx,cy);
      this.health.whiff();
      this.shake.shake(8);
    }
    if(this.draw.hitCount>1){
      const cx=this.renderer.W/2, cy=this.renderer.H/2;
      this.audio.playMulti(this.draw.hitCount);
      this.particles.burst(cx,cy,C.WHITE,28,480);
      if(this.draw.hitCount>=4) this.shake.shake(5);
    }
    this._deployHadBeats=false;
    this.draw.deployed=[];
  }

  _checkMisses(){
    for(const b of this.beats.beats){
      if(b.state==='miss'&&!b._scored){
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

  _loop(timestamp){
    const dt=Math.min(timestamp-this._lastT,100);
    this._lastT=timestamp;
    if(this.state==='playing')this._update(dt);
    this._render();
    requestAnimationFrame(t=>this._loop(t));
  }

  _update(dt){
    const t=now();
    const dc=CFG.DIFF[this.diff];

    this.rhythm.update();
    this.draw.update();
    this._processSpawnQueue();
    this.beats.update(dt);

    this._checkHoverCatch();
    this._checkDeployedSlash();
    this._checkWhiffOnExpire();
    this._checkMisses();

    this.particles.update(dt);
    this.score.update();
    this.shake.update(dt);
    this.gridbg.update();

    if(dc.hpDrain>0) this.health.drain(dt,dc.hpDrain);

    if(t>this._hintFadeAt) this._hintAlpha=Math.max(0,this._hintAlpha-dt/1200);

    if(this.health.dead){ this._endGame(false); return; }

    if(this._spawnQueue.length===0&&this.beats.beats.length===0&&t>this._lastArrivalMs+2500){
      this._endGame(true);
    }
  }

  _render(){
    const r=this.renderer;
    const W=r.W, H=r.H;
    const t=now();

    r.clear();

    if(this.state==='menu') return;

    const grid=this._getGrid();
    const phase=this.rhythm?this.rhythm.beatPhase():0;
    const theme=this.score?comboColor(this.score.combo):C.CYAN;
    const cx=grid.left+grid.gridSize/2;
    const cy=grid.top+grid.gridSize/2;

    const ctx=r.ctx;
    ctx.save();
    if(this.shake&&(this.shake.x||this.shake.y)){
      ctx.translate(this.shake.x,this.shake.y);
    }

    // --- Background ---
    if(this.gridbg) this.gridbg.draw(ctx,grid.left,grid.top,grid.cellSize,phase,theme);

    // --- Grid ---
    r.drawGrid(grid.left,grid.top,grid.cellSize,phase,theme);

    // --- Approach indicators ---
    if(this.beats){
      for(const b of this.beats.beats) r.drawApproachIndicator(b,theme);
    }

    // --- Hover highlight ---
    if(this.beats&&!this.draw.isDrawing&&!this.draw.isDeployed){
      const mx=this.draw.mouseX, my=this.draw.mouseY;
      if(mx!==-9999){
        for(const b of this.beats.beats){
          if(b.state!=='catchable'||b._scored)continue;
          const p=b.pos();
          if(dist(mx,my,p.x,p.y)<=b.radius*2.2){
            r.drawHoverHighlight(b);
          }
        }
      }
    }

    // --- Beats ---
    if(this.beats){
      const sorted=[...this.beats.beats].sort((a,b)=>a.travelProgress-b.travelProgress);
      for(const b of sorted) r.drawBeat(b);
    }

    // --- Slash ---
    if(this.draw.isDrawing&&this.draw.preview.length>1)
      r.drawPreview(this.draw.preview);
    if(this.draw.isDeployed&&this.draw.deployed.length>1)
      r.drawSlash(this.draw.deployed,this.draw.deployAge,this.draw.hitCount);

    // --- Particles ---
    if(this.particles) for(const p of this.particles.p) r.drawParticle(p);

    // --- Rings & popups ---
    if(this.score){
      for(const ring of this.score.rings) r.drawRing(ring);
      for(const pop of this.score.popups) r.drawPopup(pop);
    }

    ctx.restore();

    // --- HUD ---
    if(this.score&&this.health&&this.rhythm){
      r.drawHUD(this.score.score,this.score.combo,this.score._mult(),phase,theme,W);
      r.drawHealth(this.health.hp,this.health.color,this.health.flashAlpha,W,H);
      r.drawFlash(this.score.screenFlash,theme);
    }

    // --- Countdown ---
    const ie=t-this._introStart;
    if(ie<3000){
      const cd=Math.ceil((3000-ie)/1000);
      const ca=1-(ie%1000)/1000;
      r.drawCountdown(cd===0?'GO!':String(cd),ca);
    }

    // --- Hint ---
    r.drawHint('Hover over beats · Hold & drag to slash multiple',this._hintAlpha,W,H);

    // --- HP critical vignette ---
    if(this.health&&this.health.hp<30){
      ctx.save();
      const intensity=(30-this.health.hp)/30*0.35*(0.6+0.4*Math.sin(t*0.008));
      ctx.globalAlpha=intensity;
      const grad=ctx.createRadialGradient(cx,cy,Math.min(W,H)*0.3,cx,cy,Math.max(W,H)*0.8);
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
