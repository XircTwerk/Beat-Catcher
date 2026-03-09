'use strict';
// ============================================================
//  BEAT SLASH v5
//  Fruit-Ninja-style rhythm slasher with osu! approach circles
// ============================================================

const TAU   = Math.PI * 2;
const lerp  = (a,b,t) => a+(b-a)*t;
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const dist  = (ax,ay,bx,by) => Math.hypot(bx-ax,by-ay);
const now   = () => performance.now();
const rand  = (lo,hi) => lo + Math.random()*(hi-lo);
const pick  = arr => arr[Math.floor(Math.random()*arr.length)];

// ============================================================
//  COLOURS
// ============================================================
const C = {
  BG:'#010108', CYAN:'#00FFFF', MAGENTA:'#FF00FF', YELLOW:'#FFFF00',
  GREEN:'#00FF88', ORANGE:'#FF8800', RED:'#FF3355',
  WHITE:'#FFFFFF', PURPLE:'#CC00FF', GOLD:'#FFD700', PINK:'#FF6699',
};
// per note-type colour
const TYPE_C = {
  normal:'#00FFFF', chain:'#FF00FF', hold:'#FFFF00', burst:'#FF8800',
};

// ============================================================
//  5 DIFFICULTIES
// ============================================================
const DIFFS = {
  1:{ stars:1, name:'BEGINNER', bpm:75,  travelBeats:7,   catchFrac:[0.78,1.12], notesRange:[1,2], groupBeat:3,   hpDrain:0,   spacing:110 },
  2:{ stars:2, name:'EASY',     bpm:100, travelBeats:5.5, catchFrac:[0.80,1.10], notesRange:[1,3], groupBeat:2.5, hpDrain:0,   spacing:100 },
  3:{ stars:3, name:'NORMAL',   bpm:140, travelBeats:4,   catchFrac:[0.82,1.08], notesRange:[2,4], groupBeat:2,   hpDrain:0,   spacing:90  },
  4:{ stars:4, name:'HARD',     bpm:185, travelBeats:3,   catchFrac:[0.84,1.07], notesRange:[3,5], groupBeat:1.5, hpDrain:1.5, spacing:80  },
  5:{ stars:5, name:'EXTREME',  bpm:220, travelBeats:2.5, catchFrac:[0.86,1.05], notesRange:[3,6], groupBeat:1,   hpDrain:3,   spacing:72  },
};

// Scoring
const SC = {
  PERFECT:350, GOOD:180, MULTI:90,
  HP_HIT:4, HP_MISS:24, HP_WHIFF:10,
  MULT_STEPS:[0,5,15,35,70],
};

// Ranks  (accuracy-based; SS also needs full combo)
const RANKS = [
  {id:'SS',min:99,fc:true},
  {id:'S', min:95,fc:false},
  {id:'A', min:88,fc:false},
  {id:'B', min:75,fc:false},
  {id:'C', min:60,fc:false},
  {id:'D', min:45,fc:false},
  {id:'F', min:0, fc:false},
];

function calcRank(accuracy, isFullCombo) {
  for (const r of RANKS) {
    if (accuracy >= r.min && (!r.fc || isFullCombo)) return r.id;
  }
  return 'F';
}

function rankStars(rank) {
  return {SS:5,S:5,A:4,B:3,C:2,D:1,F:0}[rank]||0;
}

function rankCssClass(rank) {
  return 'rank-'+rank.toLowerCase().replace('+','');
}

// ============================================================
//  MUSICAL KEY DETECTION  (Goertzel chromagram)
// ============================================================
function goertzel(samples, freq, sr) {
  const N = Math.min(samples.length, 4096);
  const k = freq * N / sr;
  const w = TAU * k / N;
  const coeff = 2 * Math.cos(w);
  let s1=0, s2=0;
  for (let i=0; i<N; i++) {
    const s = (samples[i]||0) + coeff*s1 - s2;
    s2=s1; s1=s;
  }
  return s1*s1 + s2*s2 - coeff*s1*s2;
}

async function detectKey(audioBuffer) {
  const sr   = audioBuffer.sampleRate;
  const data = audioBuffer.getChannelData(0);
  const chroma = new Float32Array(12);

  // Sample 8 windows spread through the track
  const winLen = Math.min(data.length, 4096);
  const numWin = 8;
  const step   = Math.floor((data.length - winLen) / numWin);

  for (let w=0; w<numWin; w++) {
    const off = w * step;
    const win = data.subarray(off, off + winLen);
    for (let pc=0; pc<12; pc++) {
      let e = 0;
      // C2 = 65.41 Hz, sum energy across 5 octaves
      const baseF = 65.41 * Math.pow(2, pc/12);
      for (let oct=0; oct<6; oct++) {
        const f = baseF * Math.pow(2, oct);
        if (f > sr/2) break;
        e += goertzel(win, f, sr);
      }
      chroma[pc] += e;
    }
  }

  // Dominant pitch class
  let tonic = 0;
  for (let i=1; i<12; i++) if (chroma[i] > chroma[tonic]) tonic = i;

  // Major vs minor: compare major third (4 semi) vs minor third (3 semi)
  const isMinor = chroma[(tonic+3)%12] > chroma[(tonic+4)%12];

  // Pentatonic intervals
  const majPent = [0,2,4,7,9];
  const minPent = [0,3,5,7,10];
  const pent    = (isMinor ? minPent : majPent).map(i=>(tonic+i)%12);

  // Build two octaves of hit frequencies (A3 = 220 Hz reference)
  const A3 = 220, A4 = 440;
  const hitFreqs = [];
  for (const pc of pent) {
    const f3 = A3 * Math.pow(2, (pc - 9) / 12);
    const f4 = A4 * Math.pow(2, (pc - 9) / 12);
    hitFreqs.push(f3 * 2, f4 * 2); // up an octave for a brighter sound
  }

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return { key: NOTE_NAMES[tonic]+(isMinor?'m':''), hitFreqs };
}

// ============================================================
//  AUDIO BEAT ANALYSIS
// ============================================================
async function analyzeAudio(arrayBuffer, progressCb) {
  const actx   = new (window.AudioContext||window.webkitAudioContext)();
  const decoded = await actx.decodeAudioData(arrayBuffer);
  progressCb(0.3);

  const raw = decoded.getChannelData(0);
  const sr  = decoded.sampleRate;
  const hop = Math.floor(sr * 0.02);
  const win = hop * 2;

  const energies = [];
  for (let i=0; i+win<raw.length; i+=hop) {
    let e=0; for (let j=0;j<win;j++) e+=raw[i+j]*raw[i+j];
    energies.push(Math.sqrt(e/win));
  }
  progressCb(0.55);

  const onset = [0];
  for (let i=1; i<energies.length; i++) onset.push(Math.max(0,energies[i]-energies[i-1]));

  const smoothed = onset.map((v,i)=>{
    let s=0,c=0;
    for (let j=Math.max(0,i-4); j<=Math.min(onset.length-1,i+4); j++){s+=onset[j];c++;}
    return s/c;
  });
  progressCb(0.75);

  const mean = smoothed.reduce((a,b)=>a+b,0)/smoothed.length;
  const sq   = smoothed.reduce((a,b)=>a+b*b,0)/smoothed.length;
  const std  = Math.sqrt(Math.max(0,sq-mean*mean));
  const thr  = mean + std*1.2;
  const gap  = Math.floor(0.12*sr/hop);

  const beats=[]; let last=-gap;
  for (let i=1;i<smoothed.length-1;i++){
    if (smoothed[i]>smoothed[i-1]&&smoothed[i]>smoothed[i+1]&&smoothed[i]>thr&&i-last>=gap){
      beats.push(i*hop/sr); last=i;
    }
  }
  progressCb(0.9);

  // BPM from median IOI
  let bpm=130;
  if (beats.length>2){
    const iois=[]; for(let i=1;i<beats.length;i++) iois.push(beats[i]-beats[i-1]);
    iois.sort((a,b)=>a-b);
    const med=iois[Math.floor(iois.length/2)];
    bpm=clamp(Math.round(60/med),55,250);
  }

  // Key detection
  let keyInfo = { key:'?', hitFreqs:[] };
  try { keyInfo = await detectKey(decoded); } catch(e){}
  progressCb(1.0);

  await actx.close();
  return { beats, bpm, duration:decoded.duration, keyInfo };
}

// ============================================================
//  AUDIO SYSTEM
// ============================================================
class AudioSystem {
  constructor(){
    this.ctx=null; this.master=null; this.srcNode=null; this.enabled=true;
  }
  init(){
    if(this.ctx){ this.resume(); return; }
    try{
      this.ctx=new(window.AudioContext||window.webkitAudioContext)();
      this.master=this.ctx.createGain(); this.master.gain.value=0.65;
      this.master.connect(this.ctx.destination);
    }catch(e){ this.enabled=false; }
  }
  resume(){ if(this.ctx?.state==='suspended') this.ctx.resume(); }
  get currentTime(){ return this.ctx?this.ctx.currentTime:0; }
  stopTrack(){ if(this.srcNode){ try{this.srcNode.stop();}catch(e){} this.srcNode=null; } }

  _osc(type,freq,t,dur,g0,g1=0.001){
    if(!this.enabled||!this.ctx)return;
    const o=this.ctx.createOscillator(),g=this.ctx.createGain();
    o.type=type; o.frequency.value=freq;
    g.gain.setValueAtTime(g0,t); g.gain.exponentialRampToValueAtTime(g1,t+dur);
    o.connect(g);g.connect(this.master);o.start(t);o.stop(t+dur+0.01);
  }
  _noise(t,dur,gain,hp=0){
    if(!this.enabled||!this.ctx)return;
    const len=Math.floor(this.ctx.sampleRate*Math.max(dur,0.05));
    const buf=this.ctx.createBuffer(1,len,this.ctx.sampleRate);
    const d=buf.getChannelData(0); for(let i=0;i<len;i++)d[i]=Math.random()*2-1;
    const src=this.ctx.createBufferSource(); src.buffer=buf;
    const gn=this.ctx.createGain();
    gn.gain.setValueAtTime(gain,t);gn.gain.exponentialRampToValueAtTime(0.001,t+dur);
    if(hp>0){const f=this.ctx.createBiquadFilter();f.type='highpass';f.frequency.value=hp;src.connect(f);f.connect(gn);}
    else src.connect(gn);
    gn.connect(this.master);src.start(t);src.stop(t+dur+0.01);
  }

  kick(t){
    if(!this.enabled||!this.ctx)return;
    const o=this.ctx.createOscillator(),g=this.ctx.createGain();
    o.frequency.setValueAtTime(120,t);o.frequency.exponentialRampToValueAtTime(28,t+0.4);
    g.gain.setValueAtTime(1,t);g.gain.exponentialRampToValueAtTime(0.001,t+0.42);
    o.connect(g);g.connect(this.master);o.start(t);o.stop(t+0.43);
  }
  snare(t){ this._osc('triangle',180,t,0.15,0.7); this._noise(t,0.18,0.5,1800); }
  hihat(t,open=false){ this._noise(t,open?0.22:0.055,0.3,7800); }

  scheduleBar(t,BPM,beatIdx){
    if(!this.enabled||!this.ctx)return;
    const bd=60/BPM, beat=beatIdx%4;
    if(beat===0)this.kick(t);
    if(beat===2)this.snare(t);
    this.hihat(t,beat===0||beat===2);
    // Melodic synth line
    const PENTA=[261.63,293.66,329.63,392,440,523.25,587.33,659.25,783.99,880];
    const SEQ=[0,2,4,6,3,5,7,4,2,6,1,5,3,7,0,4];
    this._bell(t,PENTA[SEQ[beatIdx%SEQ.length]],bd*0.4);
  }

  _bell(t,freq,dur){
    if(!this.enabled||!this.ctx)return;
    const o=this.ctx.createOscillator(),o2=this.ctx.createOscillator(),g=this.ctx.createGain();
    o.type='sine'; o.frequency.value=freq;
    o2.type='sine'; o2.frequency.value=freq*2.76;
    g.gain.setValueAtTime(0.15,t);g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    o.connect(g);o2.connect(g);g.connect(this.master);
    o.start(t);o2.start(t);o.stop(t+dur+0.01);o2.stop(t+dur+0.01);
  }

  // Hit sound — plays a frequency from the detected musical key
  playHit(freq, perfect=false){
    if(!this.enabled||!this.ctx)return;
    const t=this.ctx.currentTime;
    const vol=perfect?0.38:0.28;
    this._bell(t, freq, 0.28);
    if(perfect){ this._bell(t+0.05, freq*1.5, 0.18); }
  }

  playMiss(){
    if(!this.enabled||!this.ctx)return;
    this._osc('sawtooth',90,this.ctx.currentTime,0.22,0.22);
    this._noise(this.ctx.currentTime,0.1,0.12,400);
  }

  playWhiff(){
    if(!this.enabled||!this.ctx)return;
    this._osc('sawtooth',110,this.ctx.currentTime,0.18,0.18);
  }

  playMulti(count){
    if(!this.enabled||!this.ctx||count<2)return;
    const t=this.ctx.currentTime;
    [440,660,880,1100,1320].slice(0,count).forEach((f,i)=>this._bell(t+i*0.03,f,0.12));
  }

  playSlashWhoosh(){
    if(!this.enabled||!this.ctx)return;
    const t=this.ctx.currentTime;
    this._noise(t,0.07,0.12,2000);
  }
}

// ============================================================
//  VOICE SYSTEM  (Web Speech API)
// ============================================================
class VoiceSystem {
  constructor(){ this.rec=null; this.active=false; this.onWord=null; }

  start(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){ console.warn('Speech recognition not supported'); return; }
    this.rec=new SR();
    this.rec.continuous=true; this.rec.interimResults=true;
    this.rec.lang='en-US';
    this.rec.onresult=(e)=>{
      for(let i=e.resultIndex;i<e.results.length;i++){
        if(e.results[i].isFinal){
          const words=e.results[i][0].transcript.trim().split(/\s+/);
          words.forEach(()=>{ if(this.onWord) this.onWord(); });
        }
      }
    };
    this.rec.onerror=()=>{};
    this.rec.start();
    this.active=true;
  }

  stop(){ if(this.rec){ try{this.rec.stop();}catch(e){} this.rec=null; } this.active=false; }
}

// ============================================================
//  SLASH DRAW SYSTEM — straight line, zero cooldown
// ============================================================
class SlashSystem {
  constructor(canvas){
    this.cv=canvas;
    this.isDown=false;
    this.startX=0; this.startY=0;
    this.mouseX=-9999; this.mouseY=-9999;
    this.trail=[];             // mouse positions while holding (for preview only)
    this.slashDisplay=null;    // {x0,y0,x1,y1,bornAt,hitCount,color}
    this.pendingCheck=null;    // {x0,y0,x1,y1} consumed by game each frame
    this.speed=0;              // current drag speed (for slash energy visual)
    this._bind();
  }

  _bind(){
    const cv=this.cv;
    const toCV=(e)=>{
      const r=cv.getBoundingClientRect();
      return { x:(e.clientX-r.left)*(cv.width/r.width), y:(e.clientY-r.top)*(cv.height/r.height) };
    };

    const down=(e)=>{
      const p=toCV(e);
      this.isDown=true;
      this.startX=p.x; this.startY=p.y;
      this.mouseX=p.x; this.mouseY=p.y;
      this.trail=[{x:p.x,y:p.y,t:now()}];
    };
    const move=(e)=>{
      const p=toCV(e);
      const prev=this.trail[this.trail.length-1];
      if(prev){ const dt=now()-prev.t; if(dt>0) this.speed=dist(prev.x,prev.y,p.x,p.y)/dt; }
      this.mouseX=p.x; this.mouseY=p.y;
      if(this.isDown) this.trail.push({x:p.x,y:p.y,t:now()});
    };
    const up=()=>{
      if(!this.isDown)return;
      this.isDown=false;
      const len=dist(this.startX,this.startY,this.mouseX,this.mouseY);
      if(len>=28){
        const s={x0:this.startX,y0:this.startY,x1:this.mouseX,y1:this.mouseY};
        this.pendingCheck=s;
        this.slashDisplay={...s,bornAt:now(),hitCount:0,color:C.WHITE};
      }
      this.trail=[];
    };

    cv.addEventListener('mousedown', e=>{e.preventDefault();down(e);});
    cv.addEventListener('mousemove', e=>move(e));
    cv.addEventListener('mouseup',   ()=>up());
    cv.addEventListener('mouseleave',()=>{ up(); this.mouseX=-9999; this.mouseY=-9999; });
    cv.addEventListener('touchstart',e=>{e.preventDefault();down(e.touches[0]);},{passive:false});
    cv.addEventListener('touchmove', e=>{e.preventDefault();move(e.touches[0]);},{passive:false});
    cv.addEventListener('touchend',  e=>{e.preventDefault();up();},{passive:false});
  }

  update(){
    if(this.slashDisplay && now()-this.slashDisplay.bornAt > 380) this.slashDisplay=null;
  }
}

// ============================================================
//  SEGMENT × CIRCLE INTERSECTION
// ============================================================
function segCircle(ax,ay,bx,by,cx,cy,r){
  const dx=bx-ax,dy=by-ay;
  const fx=ax-cx,fy=ay-cy;
  const a=dx*dx+dy*dy;
  if(a<0.001) return dist(ax,ay,cx,cy)<=r;
  const b=2*(fx*dx+fy*dy);
  const c=fx*fx+fy*fy-r*r;
  let d=b*b-4*a*c; if(d<0)return false;
  d=Math.sqrt(d);
  const t1=(-b-d)/(2*a),t2=(-b+d)/(2*a);
  return (t1>=0&&t1<=1)||(t2>=0&&t2<=1)||(t1<0&&t2>1);
}

// ============================================================
//  NOTE  — appears anywhere on screen, grows toward viewer
// ============================================================
class Note {
  constructor(id, x, y, spawnMs, arrivalMs, catchFrac, type, hitFreq, maxRadius, groupAngle){
    this.id=id; this.x=x; this.y=y;
    this.spawnMs=spawnMs; this.arrivalMs=arrivalMs;
    this.catchFrac=catchFrac; // [lo,hi] fraction of travelProgress
    this.type=type; this.hitFreq=hitFreq;
    this.maxRadius=maxRadius;
    this.groupAngle=groupAngle; // angle of the slash line (for visual hint)
    this.state='traveling'; // traveling|catchable|hit|miss
    this.alpha=1;
    this._scored=false;
    this._glowPhase=Math.random()*TAU;
    this.catchProgress=0;
  }

  get travelProgress(){
    return clamp((now()-this.spawnMs)/(this.arrivalMs-this.spawnMs),0,1);
  }
  // Radius grows from tiny to maxRadius as travelProgress → 1
  get radius(){
    const t=this.travelProgress;
    return lerp(3, this.maxRadius, Math.pow(t,0.65));
  }
  // Approach circle shrinks from 3× to 1× maxRadius
  get approachRadius(){
    const t=this.travelProgress;
    return lerp(this.maxRadius*3, this.maxRadius, Math.pow(t,0.65));
  }
  get alive(){ return this.alpha>0.015; }
}

// ============================================================
//  NOTE SYSTEM
// ============================================================
class NoteSystem {
  constructor(){ this.notes=[]; this._id=0; }

  spawn(x, y, spawnMs, arrivalMs, catchFrac, type, hitFreq, maxRadius, groupAngle){
    this.notes.push(new Note(this._id++,x,y,spawnMs,arrivalMs,catchFrac,type,hitFreq,maxRadius,groupAngle));
  }

  update(dt){
    const t=now();
    for(const n of this.notes){
      if(n.state==='traveling' && t >= n.arrivalMs - (n.arrivalMs-n.spawnMs)*(1-n.catchFrac[0])){
        n.state='catchable';
      }
      if(n.state==='catchable'){
        n.catchProgress=clamp((t-(n.arrivalMs-(n.arrivalMs-n.spawnMs)*(1-n.catchFrac[0])))
          /((n.arrivalMs-n.spawnMs)*(n.catchFrac[1]-n.catchFrac[0])),0,1);
        if(t > n.arrivalMs + (n.arrivalMs-n.spawnMs)*(n.catchFrac[1]-1)){
          n.state='miss';
        }
      }
      if(n.state==='hit'||n.state==='miss') n.alpha=clamp(n.alpha-dt/240,0,1);
    }
    this.notes=this.notes.filter(n=>n.alive);
  }
}

// ============================================================
//  PARTICLE SYSTEM
// ============================================================
class Particle{
  constructor(x,y,vx,vy,color,size,life,shape='circle'){
    this.x=x;this.y=y;this.vx=vx;this.vy=vy;
    this.color=color;this.size=size;this.life=life;this.maxLife=life;
    this.shape=shape;this.rot=Math.random()*TAU;this.rotV=(Math.random()-.5)*8;
  }
  update(dt){
    this.x+=this.vx*dt*0.001; this.y+=this.vy*dt*0.001;
    this.vx*=0.90; this.vy+=dt*0.3; // gravity
    this.size*=0.965; this.life-=dt;
    this.rot+=this.rotV*dt*0.001;
  }
  get alpha(){ return clamp(this.life/this.maxLife,0,1); }
  get alive(){ return this.life>0&&this.size>0.4; }
}

class Particles{
  constructor(){ this.pool=[]; }
  emit(x,y,color,count=12,speed=280,gravity=true){
    for(let i=0;i<count;i++){
      const a=rand(0,TAU), s=speed*(0.3+Math.random()*0.9);
      const shape=Math.random()<0.3?'rect':'circle';
      const p=new Particle(x+(Math.random()-.5)*10,y+(Math.random()-.5)*10,
        Math.cos(a)*s,Math.sin(a)*s,color,rand(2,7),rand(350,550),shape);
      if(!gravity)p.vy=Math.sin(a)*s;
      this.pool.push(p);
    }
  }
  burst(x,y,color,count=22,speed=420){ this.emit(x,y,color,count,speed); }
  slash(x0,y0,x1,y1,color,count=10){
    for(let i=0;i<count;i++){
      const t=Math.random();
      const px=lerp(x0,x1,t), py=lerp(y0,y1,t);
      const a=Math.atan2(y1-y0,x1-x0)+rand(-0.8,0.8);
      const s=rand(80,260);
      this.pool.push(new Particle(px,py,Math.cos(a)*s,Math.sin(a)*s,color,rand(2,5),rand(180,320)));
    }
  }
  update(dt){ for(const p of this.pool)p.update(dt); this.pool=this.pool.filter(p=>p.alive); }
}

// ============================================================
//  SCORE / COMBO / RANK
// ============================================================
class Score{
  constructor(){
    this.pts=0;this.combo=0;this.maxCombo=0;
    this.perfects=0;this.goods=0;this.misses=0;this.total=0;
    this.popups=[];this.rings=[];this.flashAmt=0;this.fullCombo=true;
  }
  get accuracy(){ return this.total===0?100:Math.round((this.perfects+this.goods)/this.total*100); }
  get rank(){ return calcRank(this.accuracy, this.fullCombo); }

  _mult(){
    const s=SC.MULT_STEPS;
    for(let i=s.length-1;i>=0;i--) if(this.combo>=s[i]) return i+1;
    return 1;
  }

  hit(grade,x,y,multi=1){
    this.total++;
    const m=this._mult();
    const base=grade==='perfect'?SC.PERFECT:SC.GOOD;
    const pts=base*m + (multi>1?SC.MULTI*m*(multi-1):0);
    this.pts+=pts; this.combo++; this.maxCombo=Math.max(this.maxCombo,this.combo);
    if(grade==='perfect')this.perfects++;else this.goods++;
    if(this.combo>0&&this.combo%10===0)this.flashAmt=0.35;

    const col=this.combo>=70?C.WHITE:this.combo>=40?C.GOLD:this.combo>=20?C.MAGENTA:this.combo>=10?C.GREEN:C.CYAN;
    this._pop(grade==='perfect'?'PERFECT!':'GOOD',x,y-14,grade==='perfect'?C.CYAN:C.GREEN,grade==='perfect'?1100:800);
    this._pop('+'+pts,x,y+18,C.WHITE,600);
    if(multi>1)this._pop(multi+'× MULTI!',x,y-50,C.MAGENTA,1100);
    if(m>1)this._pop(m+'× COMBO',x,y-76,col,700);
    this.rings.push({x,y,color:col,born:now(),life:500});
  }

  miss(x,y){
    this.total++;this.misses++;this.combo=0;this.fullCombo=false;
    this._pop('MISS',x,y,C.RED,800);
  }

  whiff(x,y){
    const pen=Math.round(SC.PERFECT*0.5);
    this.pts=Math.max(0,this.pts-pen);
    this.combo=0;
    this._pop('WHIFF',x,y,C.ORANGE,800);
    this._pop('-'+pen,x,y+28,C.RED,700);
  }

  _pop(text,x,y,color,life=900){
    this.popups.push({text,x,y,color,born:now(),life});
  }

  update(){
    const t=now();
    this.popups=this.popups.filter(p=>t-p.born<p.life);
    this.rings=this.rings.filter(r=>t-r.born<r.life);
    this.flashAmt=Math.max(0,this.flashAmt-0.02);
  }
}

// ============================================================
//  HEALTH
// ============================================================
class Health{
  constructor(){ this.hp=100; this.flashT=0; this.shakeAmt=0; }
  hit(){ this.hp=Math.min(100,this.hp+SC.HP_HIT); }
  miss(){ this.hp=Math.max(0,this.hp-SC.HP_MISS); this.flashT=now(); this.shakeAmt=Math.max(this.shakeAmt,14); }
  whiff(){ this.hp=Math.max(0,this.hp-SC.HP_WHIFF); this.flashT=now(); this.shakeAmt=Math.max(this.shakeAmt,7); }
  drain(dt,rate){ this.hp=Math.max(0,this.hp-rate*dt/1000); }
  get dead(){ return this.hp<=0; }
  get flashAlpha(){ return Math.max(0,1-(now()-this.flashT)/350); }
  get color(){
    if(this.hp>65)return C.GREEN;
    if(this.hp>38)return C.YELLOW;
    if(this.hp>18)return C.ORANGE;
    return C.RED;
  }
  update(dt){
    this.shakeAmt*=Math.pow(0.0001,dt/1000);
    if(this.shakeAmt<0.3)this.shakeAmt=0;
  }
  get shake(){ return this.shakeAmt>0?{x:(Math.random()-.5)*this.shakeAmt,y:(Math.random()-.5)*this.shakeAmt}:{x:0,y:0}; }
}

// ============================================================
//  RHYTHM SYSTEM
// ============================================================
class Rhythm{
  constructor(bpm){ this.bpm=bpm; this.beatMs=60000/bpm; this.startMs=0; this.nextIdx=0; this.nextT=0; this.running=false; this.onBeat=null; }
  start(startMs){ this.startMs=startMs; this.nextIdx=0; this.nextT=startMs; this.running=true; }
  stop(){ this.running=false; }
  update(){
    if(!this.running)return;
    const t=now();
    while(t>=this.nextT){
      if(this.onBeat)this.onBeat(this.nextIdx,this.nextT);
      this.nextIdx++;
      this.nextT=this.startMs+this.nextIdx*this.beatMs;
    }
  }
  get phase(){ return clamp(((now()-this.startMs)%this.beatMs)/this.beatMs,0,1); }
}

// ============================================================
//  PATTERN GENERATOR — linear/diagonal note groups
// ============================================================
// Slash angles: horizontal, diag/, vert, diag\  (4 directions)
const ANGLES=[0, Math.PI/4, Math.PI/2, Math.PI*3/4];

function buildGroup(W, H, count, spacing, angle){
  const dx=Math.cos(angle)*spacing;
  const dy=Math.sin(angle)*spacing;
  const totalW=Math.abs(dx*(count-1));
  const totalH=Math.abs(dy*(count-1));
  const mg=80;
  const cx=clamp(rand(mg+totalW/2,W-mg-totalW/2), mg+totalW/2, W-mg-totalW/2);
  const cy=clamp(rand(mg+totalH/2,H-mg-totalH/2), mg+totalH/2, H-mg-totalH/2);
  const positions=[];
  for(let i=0;i<count;i++){
    positions.push({ x:cx+dx*(i-(count-1)/2), y:cy+dy*(i-(count-1)/2) });
  }
  return { positions, angle };
}

// Procedural note groups aligned to beat grid
function generateGroups(diffCfg, W, H, startMs, totalBars=32){
  const beatMs=60000/diffCfg.bpm;
  const travelMs=diffCfg.travelBeats*beatMs;
  const groups=[];
  const { groupBeat, notesRange, spacing } = diffCfg;
  let beat=4; // start after 4 beats of intro

  const TYPES=['normal','normal','normal','chain','hold','burst'];
  let typeIdx=0;

  while(beat < totalBars*4){
    const count=Math.round(rand(notesRange[0], notesRange[1]));
    const angle=pick(ANGLES);
    const type=TYPES[typeIdx%TYPES.length]; typeIdx++;
    const group=buildGroup(W,H,count,spacing,angle);

    const arrivalMs=startMs+beat*beatMs;
    groups.push({ arrivalMs, positions:group.positions, angle:group.angle, type });

    beat+=groupBeat;
  }
  return groups;
}

// From detected onsets → groups
function onsetsToGroups(onsets, W, H, startMs, diffCfg){
  const { spacing, notesRange } = diffCfg;
  const result=[];
  let i=0;
  while(i<onsets.length){
    // Collect onsets within 80ms window → same simultaneous group
    const t0=onsets[i];
    const grp=[t0]; let j=i+1;
    while(j<onsets.length && onsets[j]-t0<0.08){ grp.push(onsets[j]); j++; }
    i=j;

    // Extra notes based on difficulty
    const minN=notesRange[0], maxN=notesRange[1];
    const count=clamp(grp.length + Math.floor(rand(0,minN)), minN, maxN);
    const angle=pick(ANGLES);
    const group=buildGroup(W,H,count,spacing,angle);

    result.push({ arrivalMs:startMs+t0*1000, positions:group.positions, angle:group.angle, type:'normal' });
  }
  return result;
}

// ============================================================
//  BACKGROUND PULSE RINGS
// ============================================================
class BgPulse{
  constructor(){ this.rings=[]; }
  onBeat(){ this.rings.push({born:now(),life:1600}); }
  draw(ctx,W,H,color){
    const cx=W/2,cy=H/2,t=now();
    const maxR=Math.hypot(cx,cy);
    for(const r of this.rings){
      const age=(t-r.born)/r.life;
      if(age>=1)continue;
      const radius=age*maxR;
      const alpha=(1-age)*0.08;
      ctx.save();
      ctx.globalAlpha=alpha;
      ctx.strokeStyle=color; ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(cx,cy,radius,0,TAU);ctx.stroke();
      ctx.restore();
    }
    this.rings=this.rings.filter(r=>t-r.born<r.life);
  }
}

// ============================================================
//  RENDER HELPERS
// ============================================================
function drawNote(ctx, note, phase){
  const {x,y,radius,approachRadius,maxRadius,type,alpha,state,catchProgress,_glowPhase}=note;
  const color=TYPE_C[type]||C.CYAN;
  const t=now();
  ctx.save();
  ctx.globalAlpha=alpha;

  // Depth pulse: note brightens as it approaches
  const depthGlow = lerp(0.3, 1.0, note.travelProgress);
  const catchPulse = state==='catchable' ? 0.5+0.5*Math.sin(t*0.02+_glowPhase) : 0;

  // ---- Approach circle ----
  if(state==='traveling'||state==='catchable'){
    const ar=approachRadius;
    const arAlpha=lerp(0.12, 0.5, note.travelProgress) + catchPulse*0.25;
    ctx.globalAlpha=alpha*arAlpha;
    ctx.strokeStyle=color;
    ctx.lineWidth=2.5;
    ctx.shadowBlur=state==='catchable'?24:8;
    ctx.shadowColor=color;
    ctx.beginPath();ctx.arc(x,y,ar,0,TAU);ctx.stroke();
    ctx.shadowBlur=0;
  }

  // ---- Main circle ----
  ctx.globalAlpha=alpha*depthGlow;
  const glow=radius*(1.8+catchPulse*1.2);
  ctx.shadowBlur=glow; ctx.shadowColor=color;

  // Radial gradient: bright core, fade to edge
  const g=ctx.createRadialGradient(x-radius*.22,y-radius*.22,0,x,y,radius);
  g.addColorStop(0,'#FFFFFF');
  g.addColorStop(0.3,color+'EE');
  g.addColorStop(0.85,color+'66');
  g.addColorStop(1,color+'00');
  ctx.fillStyle=g;
  ctx.beginPath();ctx.arc(x,y,radius,0,TAU);ctx.fill();

  // Hard edge ring
  ctx.strokeStyle=color;
  ctx.lineWidth=2.5;
  ctx.beginPath();ctx.arc(x,y,radius,0,TAU);ctx.stroke();

  // Directional hint (faint line showing the slash direction)
  if((state==='traveling'||state==='catchable')&&note.groupAngle!==undefined){
    const len=radius*1.8;
    const ang=note.groupAngle;
    ctx.globalAlpha=alpha*0.22*note.travelProgress;
    ctx.strokeStyle=color; ctx.lineWidth=1.5;
    ctx.shadowBlur=0;
    ctx.setLineDash([4,8]);
    ctx.beginPath();
    ctx.moveTo(x-Math.cos(ang)*len, y-Math.sin(ang)*len);
    ctx.lineTo(x+Math.cos(ang)*len, y+Math.sin(ang)*len);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.shadowBlur=0; ctx.restore();
}

function drawSlashDisplay(ctx, sd){
  if(!sd)return;
  const age=(now()-sd.bornAt)/380;
  if(age>=1)return;
  const alpha=Math.pow(1-age,0.55);
  const width=Math.max(1.5,8*(1-age*0.7));
  let color=C.CYAN;
  if(sd.hitCount>=5)color=C.WHITE;
  else if(sd.hitCount>=3)color=C.GOLD;
  else if(sd.hitCount>=2)color=C.GREEN;
  else if(sd.hitCount===0)color='#FF4466';

  ctx.save();
  // Wide outer glow
  ctx.globalAlpha=alpha*0.15;
  ctx.strokeStyle=color; ctx.lineWidth=width*6; ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(sd.x0,sd.y0);ctx.lineTo(sd.x1,sd.y1);ctx.stroke();
  // Mid bloom
  ctx.globalAlpha=alpha*0.35;
  ctx.lineWidth=width*2.5;
  ctx.beginPath();ctx.moveTo(sd.x0,sd.y0);ctx.lineTo(sd.x1,sd.y1);ctx.stroke();
  // Core
  ctx.globalAlpha=alpha;
  ctx.strokeStyle=C.WHITE; ctx.lineWidth=Math.max(1,width*0.7);
  ctx.shadowBlur=28*(1-age*0.6); ctx.shadowColor=color;
  ctx.beginPath();ctx.moveTo(sd.x0,sd.y0);ctx.lineTo(sd.x1,sd.y1);ctx.stroke();
  // Endpoints
  ctx.fillStyle=color; ctx.shadowBlur=20; ctx.shadowColor=color;
  ctx.beginPath();ctx.arc(sd.x0,sd.y0,width*1.1,0,TAU);ctx.fill();
  ctx.beginPath();ctx.arc(sd.x1,sd.y1,width*1.8,0,TAU);ctx.fill();
  ctx.shadowBlur=0; ctx.restore();
}

function drawSlashPreview(ctx, x0,y0,x1,y1, speed){
  const len=dist(x0,y0,x1,y1); if(len<20)return;
  const energy=clamp(speed/2,0,1);
  ctx.save();
  ctx.globalAlpha=0.18+energy*0.2;
  ctx.strokeStyle=C.WHITE; ctx.lineWidth=1.5+energy*3; ctx.lineCap='round';
  ctx.shadowBlur=8+energy*16; ctx.shadowColor=C.CYAN;
  ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
  // Arrow at end
  const ang=Math.atan2(y1-y0,x1-x0);
  ctx.globalAlpha=0.5+energy*0.4;
  ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(x1,y1);ctx.lineTo(x1-16*Math.cos(ang-.45),y1-16*Math.sin(ang-.45));
  ctx.moveTo(x1,y1);ctx.lineTo(x1-16*Math.cos(ang+.45),y1-16*Math.sin(ang+.45));
  ctx.stroke();
  ctx.shadowBlur=0; ctx.restore();
}

// ============================================================
//  GAME
// ============================================================
class Game{
  constructor(){
    this.canvas=document.getElementById('gameCanvas');
    this.ctx=this.canvas.getContext('2d');
    this.W=this.canvas.width; this.H=this.canvas.height;
    this.state='menu'; // menu|playing|gameover

    this.audio=new AudioSystem();
    this.slash=new SlashSystem(this.canvas);
    this.voice=new VoiceSystem();
    this.particles=new Particles();
    this.bgPulse=new BgPulse();

    this.notes=null; this.rhythm=null; this.score=null; this.health=null;

    this._diffStars=2; // default
    this._useVoice=false;
    this._customBuffer=null;
    this._customOnsets=null;
    this._customBPM=null;
    this._customKeyInfo=null;
    this._hitFreqs=null;  // array of frequencies to cycle through

    this._spawnQueue=[];  // {arrivalMs, x, y, type, angle, catchFrac, maxRadius}
    this._lastArrivalMs=0;
    this._startMs=0;
    this._beatCount=0;
    this._lastT=0;
    this._voiceSpawnCooldown=0;

    this._bindResize();
    this._bindUI();
    requestAnimationFrame(t=>this._loop(t));
  }

  // ------ resize ------
  _bindResize(){
    const r=()=>{
      const w=window.innerWidth,h=window.innerHeight;
      this.canvas.width=w; this.canvas.height=h;
      this.W=w; this.H=h;
      this.canvas.style.width=w+'px'; this.canvas.style.height=h+'px';
    };
    window.addEventListener('resize',r);r();
  }

  // ------ UI bindings ------
  _bindUI(){
    // 5-star difficulty buttons
    document.querySelectorAll('.diff-star-btn').forEach(b=>{
      b.addEventListener('click',()=>{
        document.querySelectorAll('.diff-star-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        this._diffStars=parseInt(b.dataset.diff);
        this._updateVoiceRow();
      });
    });

    document.getElementById('voice-toggle').addEventListener('change',e=>{
      this._useVoice=e.target.checked;
    });

    document.getElementById('btn-play').addEventListener('click',()=>this._startGame());
    document.getElementById('btn-retry').addEventListener('click',()=>this._startGame());
    document.getElementById('btn-menu').addEventListener('click',()=>this._showMenu());

    const inp=document.getElementById('mp3-input');
    document.getElementById('btn-upload').addEventListener('click',()=>inp.click());
    inp.addEventListener('change',e=>{ if(e.target.files[0])this._handleUpload(e.target.files[0]); });

    document.addEventListener('pointerdown',()=>this.audio.resume(),{once:true});
    document.addEventListener('keydown',e=>{ if(e.code==='Escape'&&this.state==='playing')this._endGame(false); });
  }

  _updateVoiceRow(){
    const row=document.getElementById('voice-row');
    if(this._diffStars>=4) row.classList.remove('hidden-soft');
    else row.classList.add('hidden-soft');
  }

  _showMenu(){
    this.state='menu';
    if(this.rhythm)this.rhythm.stop();
    this.audio.stopTrack();
    this.voice.stop();
    document.getElementById('screen-menu').classList.remove('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');
  }

  async _handleUpload(file){
    this.audio.init();
    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-loading').classList.remove('hidden');
    const bar=document.getElementById('loading-bar-fill');
    const status=document.getElementById('loading-status');
    try{
      const ab=await file.arrayBuffer();
      status.textContent='Decoding audio…';
      const result=await analyzeAudio(ab,p=>{
        bar.style.width=(p*100)+'%';
        if(p>0.4)status.textContent='Detecting beats…';
        if(p>0.7)status.textContent='Analysing musical key…';
        if(p>0.9)status.textContent=`Key: ${result?.keyInfo?.key||'?'} · Building beatmap…`;
      });
      const ab2=await file.arrayBuffer();
      const actx=this.audio.ctx||new AudioContext();
      this._customBuffer=await actx.decodeAudioData(ab2);
      this._customOnsets=result.beats;
      this._customBPM=result.bpm;
      this._customKeyInfo=result.keyInfo;
      document.getElementById('track-label').textContent=
        `${file.name} · ${result.bpm}BPM · Key: ${result.keyInfo.key}`;
      status.textContent=`${result.beats.length} beats · ${result.bpm} BPM · Key ${result.keyInfo.key}`;
    }catch(err){
      console.error(err);
      this._customBuffer=null; this._customOnsets=null;
      document.getElementById('track-label').textContent='Load failed — using built-in';
    }
    document.getElementById('screen-loading').classList.add('hidden');
    document.getElementById('screen-menu').classList.remove('hidden');
  }

  // ------ start game ------
  _startGame(){
    this.audio.init();
    const dc=DIFFS[this._diffStars];
    document.getElementById('screen-menu').classList.add('hidden');
    document.getElementById('screen-gameover').classList.add('hidden');

    this.notes=new NoteSystem();
    this.score=new Score();
    this.health=new Health();
    this.particles=new Particles();
    this.bgPulse=new BgPulse();

    this.slash.isDown=false; this.slash.pendingCheck=null; this.slash.slashDisplay=null;

    const bpm=this._customBPM||dc.bpm;
    const beatMs=60000/bpm;
    const travelMs=dc.travelBeats*beatMs;
    const startMs=now()+600;
    this._startMs=startMs;

    // Hit frequency pool
    if(this._customKeyInfo?.hitFreqs?.length>0){
      this._hitFreqs=this._customKeyInfo.hitFreqs;
    } else {
      // Default: C major pentatonic across two octaves
      const C4=261.63;
      this._hitFreqs=[0,2,4,7,9,12,14,16,19,21].map(i=>C4*Math.pow(2,i/12));
    }
    this._hitFreqIdx=0;

    // Build groups
    const groups=this._customOnsets
      ? onsetsToGroups(this._customOnsets, this.W, this.H, startMs, dc)
      : generateGroups(dc, this.W, this.H, startMs);

    // Build flat spawn queue from groups
    this._spawnQueue=[];
    const maxR=Math.min(this.W,this.H)*0.055;
    for(const grp of groups){
      const arrMs=grp.arrivalMs;
      const spawnMs=arrMs-travelMs;
      for(const pos of grp.positions){
        this._spawnQueue.push({
          x:pos.x, y:pos.y,
          arrivalMs:arrMs, spawnMs,
          type:grp.type,
          angle:grp.angle,
          catchFrac:dc.catchFrac,
          maxRadius:maxR,
        });
      }
    }
    this._spawnQueue.sort((a,b)=>a.spawnMs-b.spawnMs);
    this._lastArrivalMs=this._spawnQueue.length>0
      ? this._spawnQueue[this._spawnQueue.length-1].arrivalMs+2000 : startMs+8000;

    // Rhythm clock
    this.rhythm=new Rhythm(bpm);
    this.rhythm.start(startMs);
    this.rhythm.onBeat=(idx,beatT)=>this._onBeat(idx,beatT,bpm);

    // Play custom track
    if(this._customBuffer&&this.audio.ctx){
      const src=this.audio.ctx.createBufferSource();
      src.buffer=this._customBuffer; src.connect(this.audio.master);
      const when=this.audio.ctx.currentTime+(startMs-now())/1000;
      src.start(Math.max(this.audio.ctx.currentTime,when));
      this.audio.srcNode=src;
    }

    // Voice mode
    if(this._useVoice&&this._diffStars>=4){
      this.voice.onWord=()=>this._voiceSpawnNote();
      this.voice.start();
    }

    this._beatCount=0;
    this.state='playing';
  }

  _nextHitFreq(){
    if(!this._hitFreqs||!this._hitFreqs.length)return 440;
    const f=this._hitFreqs[this._hitFreqIdx%this._hitFreqs.length];
    this._hitFreqIdx++;
    return f;
  }

  _voiceSpawnNote(){
    if(this.state!=='playing')return;
    const dc=DIFFS[this._diffStars];
    const beatMs=60000/(this._customBPM||dc.bpm);
    const travelMs=dc.travelBeats*beatMs;
    const arrivalMs=now()+travelMs*0.9;
    const spawnMs=now();
    const maxR=Math.min(this.W,this.H)*0.055;
    // Single random note
    const x=rand(100,this.W-100), y=rand(100,this.H-100);
    const angle=pick(ANGLES);
    this.notes.spawn(x,y,spawnMs,arrivalMs,dc.catchFrac,'burst',this._nextHitFreq(),maxR,angle);
  }

  _endGame(cleared=false){
    this.state='gameover';
    if(this.rhythm)this.rhythm.stop();
    this.audio.stopTrack();
    this.voice.stop();

    const rank=this.score.rank;
    const stars=rankStars(rank);
    const starsStr='★'.repeat(stars)+'☆'.repeat(5-stars);

    document.getElementById('gameover-rank').textContent=rank;
    document.getElementById('gameover-rank').className='rank-badge '+rankCssClass(rank);
    document.getElementById('gameover-stars').textContent=starsStr;
    document.getElementById('gameover-heading').textContent=cleared?'CLEARED!':'GAME OVER';
    document.getElementById('gameover-heading').className='gameover-title'+(cleared?' cleared':'');
    document.getElementById('res-score').textContent    =this.score.pts.toLocaleString();
    document.getElementById('res-combo').textContent    =this.score.maxCombo;
    document.getElementById('res-accuracy').textContent =this.score.accuracy+'%';
    document.getElementById('res-perfects').textContent =this.score.perfects;
    document.getElementById('res-goods').textContent    =this.score.goods;
    document.getElementById('res-misses').textContent   =this.score.misses;
    document.getElementById('screen-gameover').classList.remove('hidden');
  }

  // ------ beat event ------
  _onBeat(idx, beatT, bpm){
    if(this.audio.ctx&&!this._customBuffer){
      const at=this.audio.ctx.currentTime+(beatT-now())/1000;
      this.audio.scheduleBar(Math.max(this.audio.ctx.currentTime,at),bpm,idx);
    }
    this.bgPulse.onBeat();
    this._beatCount++;
  }

  // ------ spawn queue ------
  _processSpawnQueue(){
    const t=now();
    while(this._spawnQueue.length&&this._spawnQueue[0].spawnMs<=t){
      const q=this._spawnQueue.shift();
      this.notes.spawn(q.x,q.y,q.spawnMs,q.arrivalMs,q.catchFrac,q.type,
                       this._nextHitFreq(),q.maxRadius,q.angle);
    }
  }

  // ------ slash hit detection ------
  _checkSlash(slash){
    const {x0,y0,x1,y1}=slash;
    let hitCount=0, hadBeats=false;

    for(const n of this.notes.notes){
      if(n.state==='catchable') hadBeats=true;
      if(n.state!=='catchable'||n._scored)continue;
      const detR=n.radius*1.15;
      if(!segCircle(x0,y0,x1,y1,n.x,n.y,detR))continue;

      n._scored=true; n.state='hit'; n.alpha=1;
      const perfect=n.catchProgress<0.35||n.catchProgress>0.65;
      const grade=perfect?'perfect':'good';
      hitCount++;

      const color=TYPE_C[n.type]||C.CYAN;
      this.particles.burst(n.x,n.y,color,20,480);
      // Musical hit sound in key
      this.audio.playHit(n.hitFreq, perfect);
      this.health.hit();
      this.score.hit(grade,n.x,n.y,hitCount);
    }

    // Slash particle trail
    if(this.slash.slashDisplay){
      this.slash.slashDisplay.hitCount=hitCount;
      const sc=hitCount>0?TYPE_C['normal']:C.PINK;
      this.particles.slash(x0,y0,x1,y1,sc,hitCount>0?14:6);
    }

    // Whoosh
    this.audio.playSlashWhoosh();

    // Whiff
    if(hitCount===0&&hadBeats){
      const cx=this.W/2,cy=this.H/2;
      this.score.whiff(cx,cy); this.health.whiff(); this.audio.playWhiff();
    }
    if(hitCount>1){
      this.audio.playMulti(hitCount);
      this.particles.burst(this.W/2,this.H/2,C.WHITE,20,500);
    }
  }

  _checkMisses(){
    for(const n of this.notes.notes){
      if(n.state==='miss'&&!n._scored){
        n._scored=true;
        this.score.miss(n.x,n.y);
        this.health.miss();
        this.particles.emit(n.x,n.y,C.RED,8,160);
        this.audio.playMiss();
      }
    }
  }

  // ------ main loop ------
  _loop(t){
    const dt=Math.min(t-this._lastT,100);
    this._lastT=t;
    if(this.state==='playing')this._update(dt);
    this._render();
    requestAnimationFrame(t=>this._loop(t));
  }

  _update(dt){
    const dc=DIFFS[this._diffStars];
    this.rhythm.update();
    this.slash.update();
    this._processSpawnQueue();
    this.notes.update(dt);

    if(this.slash.pendingCheck){
      this._checkSlash(this.slash.pendingCheck);
      this.slash.pendingCheck=null;
    }

    this._checkMisses();
    this.particles.update(dt);
    this.score.update();
    this.health.update(dt);
    if(dc.hpDrain>0) this.health.drain(dt,dc.hpDrain);

    if(this.health.dead){ this._endGame(false); return; }
    if(!this._spawnQueue.length&&!this.notes.notes.length&&now()>this._lastArrivalMs){
      this._endGame(true);
    }
  }

  // ------ render ------
  _render(){
    const ctx=this.ctx;
    const W=this.W, H=this.H;
    if(!W||!H)return;

    // Background
    ctx.fillStyle=C.BG; ctx.fillRect(0,0,W,H);

    if(this.state==='menu')return;

    const phase=this.rhythm?this.rhythm.phase:0;
    const rank=this.score?this.score.rank:'B';
    const combo=this.score?this.score.combo:0;
    const comboColor=combo>=70?C.WHITE:combo>=40?C.GOLD:combo>=20?C.MAGENTA:combo>=10?C.GREEN:C.CYAN;

    // Camera shake
    const sh=this.health?this.health.shake:{x:0,y:0};
    ctx.save();
    if(sh.x||sh.y) ctx.translate(sh.x,sh.y);

    // --- Background radial grid ---
    this._drawBgGrid(ctx,W,H,phase,comboColor);

    // --- BG pulse rings ---
    this.bgPulse.draw(ctx,W,H,comboColor);

    // --- Notes (sorted back-to-front by travelProgress) ---
    if(this.notes){
      const sorted=[...this.notes.notes].sort((a,b)=>a.travelProgress-b.travelProgress);
      for(const n of sorted) drawNote(ctx,n,phase);
    }

    // --- Slash preview ---
    if(this.slash.isDown){
      drawSlashPreview(ctx,this.slash.startX,this.slash.startY,this.slash.mouseX,this.slash.mouseY,this.slash.speed);
    }

    // --- Slash display ---
    drawSlashDisplay(ctx,this.slash.slashDisplay);

    // --- Particles ---
    for(const p of this.particles.pool) this._drawParticle(ctx,p);

    // --- Score rings ---
    if(this.score){
      for(const r of this.score.rings) this._drawRing(ctx,r);
      for(const p of this.score.popups) this._drawPopup(ctx,p);
    }

    ctx.restore();

    // --- HUD (no shake) ---
    this._drawHUD(ctx,W,H,phase,comboColor,rank);
  }

  _drawBgGrid(ctx,W,H,phase,color){
    const cx=W/2,cy=H/2;
    // Concentric glow circles
    ctx.save();
    for(let i=1;i<=4;i++){
      const r=(i/4)*Math.min(W,H)*0.55;
      const alpha=0.015+0.008*Math.sin(phase*TAU-i);
      ctx.globalAlpha=alpha; ctx.strokeStyle=color; ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.stroke();
    }
    // Radial lines
    for(let i=0;i<8;i++){
      const a=i/8*TAU;
      const alpha=0.018+0.008*Math.sin(phase*TAU);
      ctx.globalAlpha=alpha; ctx.strokeStyle=color; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(cx,cy);
      ctx.lineTo(cx+Math.cos(a)*Math.max(W,H),cy+Math.sin(a)*Math.max(W,H));
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawParticle(ctx,p){
    ctx.save(); ctx.globalAlpha=p.alpha;
    ctx.fillStyle=p.color; ctx.shadowBlur=6; ctx.shadowColor=p.color;
    if(p.shape==='rect'){
      ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillRect(-p.size,-p.size*0.5,p.size*2,p.size);
    } else {
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,TAU);ctx.fill();
    }
    ctx.shadowBlur=0; ctx.restore();
  }

  _drawRing(ctx,r){
    const age=(now()-r.born)/r.life; if(age>=1)return;
    ctx.save(); ctx.globalAlpha=(1-age)*0.8;
    ctx.strokeStyle=r.color; ctx.lineWidth=3*(1-age);
    ctx.shadowBlur=22; ctx.shadowColor=r.color;
    ctx.beginPath();ctx.arc(r.x,r.y,16+age*80,0,TAU);ctx.stroke();
    ctx.shadowBlur=0; ctx.restore();
  }

  _drawPopup(ctx,p){
    const age=(now()-p.born)/p.life; if(age>=1)return;
    const fa=age<0.6?1:1-(age-0.6)/0.4;
    ctx.save(); ctx.globalAlpha=fa;
    ctx.font='bold 18px Orbitron,monospace';
    ctx.fillStyle=p.color; ctx.shadowBlur=16; ctx.shadowColor=p.color;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.text,p.x,p.y-age*40);
    ctx.shadowBlur=0; ctx.restore();
  }

  _drawHUD(ctx,W,H,phase,comboColor,rank){
    const sc=this.score, hp=this.health, dc=DIFFS[this._diffStars];

    // ---- Score ----
    ctx.save();
    ctx.font='bold 28px Orbitron,monospace';
    ctx.fillStyle=comboColor; ctx.shadowBlur=14; ctx.shadowColor=comboColor;
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(sc?(sc.pts.toLocaleString().padStart(9,'0')):'000000000',18,16);
    ctx.font='9px Orbitron,monospace'; ctx.fillStyle='#223344'; ctx.shadowBlur=0;
    ctx.fillText('SCORE',18,50);

    // ---- Combo ----
    if(sc&&sc.combo>1){
      const comboY=H-80;
      ctx.font=`bold ${clamp(22+sc.combo*0.4,22,64)}px Orbitron,monospace`;
      ctx.fillStyle=comboColor; ctx.shadowBlur=20; ctx.shadowColor=comboColor;
      ctx.textAlign='center'; ctx.textBaseline='bottom';
      ctx.fillText(sc.combo+'×',W/2,comboY);
      ctx.font='9px Orbitron,monospace'; ctx.fillStyle='#223344'; ctx.shadowBlur=0;
      ctx.textBaseline='bottom';
      ctx.fillText('COMBO',W/2,comboY+14);
    }

    // ---- Multiplier ----
    if(sc){
      const m=sc._mult();
      if(m>1){
        const mc=m>=5?C.WHITE:m>=4?C.GOLD:m>=3?C.MAGENTA:C.ORANGE;
        ctx.font='bold 13px Orbitron,monospace';
        ctx.fillStyle=mc; ctx.shadowBlur=12; ctx.shadowColor=mc;
        ctx.textAlign='right'; ctx.textBaseline='top';
        ctx.fillText(m+'× MULT',W-18,16);
      }
    }

    // ---- Live rank (top right) ----
    if(sc){
      ctx.font='bold 22px Orbitron,monospace';
      const rc={SS:'#FFD700',S:'#FF8800',A:'#00FF88',B:'#00FFFF',C:'#FF00FF',D:'#FF3355',F:'#556677'}[rank]||C.CYAN;
      ctx.fillStyle=rc; ctx.shadowBlur=14; ctx.shadowColor=rc;
      ctx.textAlign='right'; ctx.textBaseline='top';
      ctx.fillText(rank,W-18,42);
    }

    // ---- Accuracy ----
    if(sc){
      ctx.font='11px Orbitron,monospace';
      ctx.fillStyle='#334455'; ctx.shadowBlur=0;
      ctx.textAlign='left'; ctx.textBaseline='top';
      ctx.fillText(sc.accuracy+'%',18,54);
    }

    // ---- HP bar (left edge, vertical) ----
    if(hp){
      const barW=5, barH=H*0.35, bx=8, by=(H-barH)/2;
      ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(bx,by,barW,barH);
      const fill=(hp.hp/100)*barH;
      const hpGrad=ctx.createLinearGradient(0,by+barH,0,by);
      hpGrad.addColorStop(0,hp.color);hpGrad.addColorStop(1,C.WHITE);
      ctx.fillStyle=hpGrad; ctx.shadowBlur=8; ctx.shadowColor=hp.color;
      ctx.fillRect(bx,by+barH-fill,barW,fill);
      ctx.shadowBlur=0;
    }

    // ---- Beat progress line (top) ----
    ctx.fillStyle='rgba(0,0,0,0.3)'; ctx.fillRect(0,0,W,3);
    ctx.fillStyle=comboColor; ctx.shadowBlur=6; ctx.shadowColor=comboColor;
    ctx.fillRect(0,0,W*phase,3); ctx.shadowBlur=0;

    // ---- HP flash ----
    if(hp&&hp.flashAlpha>0){
      ctx.globalAlpha=hp.flashAlpha*0.35;
      ctx.fillStyle=C.RED;ctx.fillRect(0,0,W,H);
    }
    ctx.globalAlpha=1;

    // ---- Combo flash ----
    if(sc&&sc.flashAmt>0){
      ctx.globalAlpha=sc.flashAmt*0.15;
      ctx.fillStyle=comboColor;ctx.fillRect(0,0,W,H);
    }
    ctx.globalAlpha=1;

    // ---- Difficulty stars ----
    ctx.font='13px Orbitron,monospace';
    ctx.fillStyle=C.YELLOW; ctx.shadowBlur=8; ctx.shadowColor=C.YELLOW;
    ctx.textAlign='right'; ctx.textBaseline='bottom';
    ctx.fillText('★'.repeat(this._diffStars)+'☆'.repeat(5-this._diffStars),W-18,H-12);
    ctx.shadowBlur=0;

    // ---- Voice indicator ----
    if(this.voice.active){
      ctx.font='10px Orbitron,monospace';
      const vAlpha=0.4+0.4*Math.sin(now()*0.008);
      ctx.globalAlpha=vAlpha; ctx.fillStyle=C.GREEN;
      ctx.textAlign='left'; ctx.textBaseline='bottom';
      ctx.fillText('🎤 VOICE',18,H-12);
    }
    ctx.globalAlpha=1;

    // ---- Critical HP vignette ----
    if(hp&&hp.hp<30){
      const t=now();
      const intensity=(30-hp.hp)/30*0.4*(0.5+0.5*Math.sin(t*0.007));
      const grad=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.25,W/2,H/2,Math.max(W,H)*0.85);
      grad.addColorStop(0,'transparent');grad.addColorStop(1,C.RED);
      ctx.globalAlpha=intensity; ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
      ctx.globalAlpha=1;
    }

    ctx.restore();
  }
}

// ============================================================
//  BOOT
// ============================================================
window.addEventListener('DOMContentLoaded',()=>{ window._game=new Game(); });
