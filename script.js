/* ==========================================================================
   INVASÃO — jogo inspirado no poema de Eliane Potiguara
   Motor construído em Canvas 2D + JavaScript puro, sem bibliotecas externas.
   Organizado em seções:
     1. Configuração e utilidades
     2. Áudio procedural (Web Audio API)
     3. Geração do mundo (tiles, objetos, NPCs, memórias)
     4. Entidades (Jogadora, NPCs, Soldados)
     5. Partículas e clima
     6. Câmera e renderização
     7. Sistema de história (estados, escolhas, memórias, finais)
     8. Entrada (teclado + toque / joystick virtual)
     9. Save/Load (localStorage)
    10. Loop principal e ligação da interface (UI)
   ========================================================================== */

/* ============================== 1. CONFIG ============================== */
const TILE = 32;
const WORLD_W = 90;   // tiles
const WORLD_H = 60;   // tiles
const VIEW_W = 960;
const VIEW_H = 540;

const TILE_GRASS=0, TILE_TREE=1, TILE_WATER=2, TILE_PATH=3, TILE_HUT=4,
      TILE_ROCK=5, TILE_SAND=6, TILE_FLOWER=7, TILE_RUIN=8, TILE_CAVE=9,
      TILE_BRIDGE=10, TILE_HUTDOOR=11;

function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function dist(x1,y1,x2,y2){ return Math.hypot(x1-x2, y1-y2); }
function lerp(a,b,t){ return a+(b-a)*t; }

// gerador pseudo-aleatório determinístico (mesma "semente" = mesmo mapa sempre)
function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260619);

/* ============================== 2. ÁUDIO ============================== */
const AudioEngine = {
  ctx: null, master: null, musicGain: null, sfxGain: null,
  chaseGain: null, peaceGain: null, ambientGain: null,
  started: false, heartbeatTimer: null, footstepTimer: 0,
  init(){
    if(this.started) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 1; this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.6; this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.7; this.sfxGain.connect(this.master);
    this.peaceGain = this.ctx.createGain(); this.peaceGain.gain.value = 0.5; this.peaceGain.connect(this.musicGain);
    this.chaseGain = this.ctx.createGain(); this.chaseGain.gain.value = 0.0001; this.chaseGain.connect(this.musicGain);
    this.ambientGain = this.ctx.createGain(); this.ambientGain.gain.value = 0.25; this.ambientGain.connect(this.master);
    this.started = true;
    this.startPeaceMusic();
    this.startAmbient();
  },
  setVolumes(music, sfx){ this.musicGain.gain.value = music; this.sfxGain.gain.value = sfx; },
  noiseBuffer(dur){
    const n = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<n;i++) d[i] = Math.random()*2-1;
    return buf;
  },
  startAmbient(){
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(2); src.loop = true;
    const filt = this.ctx.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=500; filt.Q.value=0.6;
    src.connect(filt); filt.connect(this.ambientGain); src.start();
    this.windSrc = src; this.windFilter = filt;
  },
  setRain(on){
    if(on && !this.rainSrc){
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2); src.loop = true;
      const filt = this.ctx.createBiquadFilter(); filt.type='highpass'; filt.frequency.value=1800;
      const g = this.ctx.createGain(); g.gain.value = 0.35;
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start();
      this.rainSrc = src; this.rainGain = g;
    } else if(!on && this.rainSrc){
      try{ this.rainSrc.stop(); }catch(e){}
      this.rainSrc = null;
    }
  },
  playFootstep(running){
    if(!this.started) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.08);
    const filt = this.ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value = running?900:600;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.18,now); g.gain.exponentialRampToValueAtTime(0.001, now+0.08);
    src.connect(filt); filt.connect(g); g.connect(this.sfxGain);
    src.start(); src.stop(now+0.09);
  },
  playChime(freq=660){
    if(!this.started) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type='sine'; o.frequency.value=freq;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001,now);
    g.gain.exponentialRampToValueAtTime(0.25, now+0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now+1.4);
    o.connect(g); g.connect(this.sfxGain);
    o.start(); o.stop(now+1.5);
  },
  playThud(){
    if(!this.started) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(90,now);
    o.frequency.exponentialRampToValueAtTime(40, now+0.25);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5,now); g.gain.exponentialRampToValueAtTime(0.001,now+0.3);
    o.connect(g); g.connect(this.sfxGain);
    o.start(); o.stop(now+0.32);
  },
  startPeaceMusic(){
    const notes = [261.6,329.6,392.0,440.0,392.0,329.6];
    let i=0;
    this.peaceInterval = setInterval(()=>{
      if(!this.started) return;
      const now=this.ctx.currentTime;
      const o=this.ctx.createOscillator(); o.type='triangle'; o.frequency.value=notes[i%notes.length]/2;
      const g=this.ctx.createGain(); g.gain.setValueAtTime(0.0001,now);
      g.gain.exponentialRampToValueAtTime(0.22,now+0.4);
      g.gain.exponentialRampToValueAtTime(0.0001,now+2.2);
      o.connect(g); g.connect(this.peaceGain);
      o.start(); o.stop(now+2.3);
      i++;
    }, 1400);
  },
  startChaseMusic(){
    if(this.chaseInterval) return;
    this.chaseGain.gain.linearRampToValueAtTime(0.55, this.ctx.currentTime+1);
    this.peaceGain.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime+1);
    let beat=0;
    this.chaseInterval = setInterval(()=>{
      if(!this.started) return;
      const now=this.ctx.currentTime;
      const o=this.ctx.createOscillator(); o.type='sawtooth'; o.frequency.value = beat%2===0?110:130;
      const g=this.ctx.createGain(); g.gain.setValueAtTime(0.0001,now);
      g.gain.exponentialRampToValueAtTime(0.25,now+0.03);
      g.gain.exponentialRampToValueAtTime(0.0001,now+0.35);
      o.connect(g); g.connect(this.chaseGain);
      o.start(); o.stop(now+0.4);
      beat++;
    }, 320);
  },
  stopChaseMusic(){
    if(!this.chaseInterval) return;
    clearInterval(this.chaseInterval); this.chaseInterval=null;
    if(this.started){
      this.chaseGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime+1);
      this.peaceGain.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime+1);
    }
  },
  startHeartbeat(){
    if(this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(()=>{ this.playThud(); setTimeout(()=>this.playThud(),180); }, 620);
  },
  stopHeartbeat(){ if(this.heartbeatTimer){ clearInterval(this.heartbeatTimer); this.heartbeatTimer=null; } }
};

/* ============================== 3. MUNDO ============================== */
let world = { tiles: null, trees:[], huts:[], memories:[], npcs:[], caveTile:null, waypointsPatrol:[] };

function idx(x,y){ return y*WORLD_W+x; }
function tileAt(x,y){
  if(x<0||y<0||x>=WORLD_W||y>=WORLD_H) return TILE_ROCK;
  return world.tiles[idx(x,y)];
}
function setTile(x,y,v){ if(x>=0&&y>=0&&x<WORLD_W&&y<WORLD_H) world.tiles[idx(x,y)] = v; }
function walkable(tx,ty){
  const t = tileAt(tx,ty);
  return t!==TILE_TREE && t!==TILE_WATER && t!==TILE_ROCK && t!==TILE_HUT;
}

function generateWorld(){
  const tiles = new Uint8Array(WORLD_W*WORLD_H);
  const cx = Math.floor(WORLD_W*0.45), cy = Math.floor(WORLD_H*0.55);

  for(let y=0;y<WORLD_H;y++){
    for(let x=0;x<WORLD_W;x++){
      tiles[idx(x,y)] = TILE_GRASS;
    }
  }
  // montanhas ao norte
  for(let y=0;y<7;y++) for(let x=0;x<WORLD_W;x++){
    if(y<4 || rng()<0.5) tiles[idx(x,y)] = TILE_ROCK;
  }
  // entrada da caverna nas montanhas
  const caveX = Math.floor(WORLD_W*0.72), caveY = 6;
  for(let dx=-1;dx<=1;dx++) tiles[idx(caveX+dx,caveY)] = TILE_CAVE;
  world.caveTile = {x:caveX, y:caveY};

  // rio serpenteando de norte a sul
  const riverBaseX = Math.floor(WORLD_W*0.22);
  for(let y=6;y<WORLD_H;y++){
    const rx = riverBaseX + Math.round(Math.sin(y*0.15)*6);
    for(let w=-1;w<=1;w++) tiles[idx(rx+w,y)] = TILE_WATER;
    tiles[idx(rx-2,y)] = (tiles[idx(rx-2,y)]===TILE_WATER)?TILE_WATER:TILE_SAND;
    tiles[idx(rx+2,y)] = (tiles[idx(rx+2,y)]===TILE_WATER)?TILE_WATER:TILE_SAND;
  }
  // ponte
  const bridgeY = 30;
  const rxAtBridge = riverBaseX + Math.round(Math.sin(bridgeY*0.15)*6);
  for(let w=-1;w<=1;w++) tiles[idx(rxAtBridge+w,bridgeY)] = TILE_BRIDGE;

  // clareira da aldeia (círculo)
  const villageR = 9;
  for(let y=cy-villageR;y<=cy+villageR;y++){
    for(let x=cx-villageR;x<=cx+villageR;x++){
      if(dist(x,y,cx,cy) < villageR) tiles[idx(x,y)] = TILE_GRASS;
    }
  }
  // caminhos em cruz na aldeia
  for(let x=cx-villageR;x<=cx+villageR;x++) tiles[idx(x,cy)] = TILE_PATH;
  for(let y=cy-villageR;y<=cy+villageR;y++) tiles[idx(cx,y)] = TILE_PATH;

  // cabanas em círculo
  const huts = [];
  const hutCount = 7;
  for(let i=0;i<hutCount;i++){
    const ang = (i/hutCount)*Math.PI*2;
    const hx = Math.round(cx + Math.cos(ang)*6.5);
    const hy = Math.round(cy + Math.sin(ang)*6.5);
    tiles[idx(hx,hy)] = TILE_HUT;
    tiles[idx(hx,hy+1)] = TILE_HUTDOOR;
    huts.push({x:hx,y:hy, ruined:false});
  }
  world.huts = huts;

  // floresta ao redor, evitando aldeia/rio/caminhos
  const trees = [];
  for(let y=7;y<WORLD_H;y++){
    for(let x=0;x<WORLD_W;x++){
      const t = tiles[idx(x,y)];
      if(t!==TILE_GRASS) continue;
      const dv = dist(x,y,cx,cy);
      if(dv < villageR+2) continue;
      if(rng() < 0.22){
        tiles[idx(x,y)] = TILE_TREE;
        trees.push({x,y});
      } else if(rng() < 0.03){
        tiles[idx(x,y)] = TILE_FLOWER;
      }
    }
  }
  world.trees = trees;
  world.tiles = tiles;

  // itens de memória espalhados pela floresta
  world.memories = [
    {id:'cocar', name:'Cocar', icon:'🪶', x:cx-22, y:cy+4,
     text:'O cocar do avô. Cada pena guardava uma história contada à beira do fogo.'},
    {id:'maraca', name:'Maracá', icon:'🎵', x:cx+6, y:cy-20,
     text:'O som do maracá guiava as danças. As crianças riam tentando acompanhar o ritmo.'},
    {id:'arco', name:'Arco', icon:'🏹', x:cx+20, y:cy+10,
     text:'Seu pai lhe ensinou a mirar sem pressa. "A floresta espera", ele dizia.'},
    {id:'ceramica', name:'Cerâmica', icon:'🏺', x:cx-8, y:cy+18,
     text:'Vasos moldados com barro do rio, guardados por gerações de mulheres da aldeia.'},
    {id:'pintura', name:'Pintura Corporal', icon:'🎨', x:cx-26, y:cy-8,
     text:'O jenipapo pintava histórias na pele. Cada traço tinha um significado.'},
    {id:'sementes', name:'Sementes', icon:'🌱', x:cx+2, y:cy+24,
     text:'Sementes guardadas para a próxima colheita — uma promessa de que haverá amanhã.'},
  ].map(m=>({...m, found:false}));

  // NPCs
  world.npcs = [
    {id:'anciao', name:'Ancião', icon:'👴', x:cx-4, y:cy-3,
     lines:['A terra fala com quem sabe escutar, filha.','As montanhas ali guardam uma caverna segura, caso o vento mude.','Nossos avós já resistiram antes. Nós também resistiremos.']},
    {id:'curandeira', name:'Curandeira', icon:'🌿', x:cx+3, y:cy-5,
     lines:['Estas ervas curam o corpo, mas a memória cura o espírito.','Leve isto com você. Nunca se sabe o que o caminho reserva.','Cuide do seu filho como a terra cuida das sementes.']},
    {id:'cacador', name:'Caçador', icon:'🏹', x:cx-6, y:cy+3,
     lines:['O rio está calmo hoje. Bom para pescar.','Vi pegadas estranhas perto da fronteira da mata ontem...','Fique atenta, pequena. A floresta sempre avisa antes.']},
    {id:'crianca1', name:'Criança', icon:'🧒', x:cx+2, y:cy+2,
     lines:['Você viu o passarinho amarelo perto do rio?','Vamos brincar depois, tia!','Minha avó disse que as estrelas são nossos ancestrais.']},
    {id:'mae', name:'Filho', icon:'👶', x:cx, y:cy-1,
     lines:['Mamãe, olha o que eu achei!','Me conta a história da lua de novo?','Eu quero ser forte como você.']},
  ];
}

/* ============================== 4. ENTIDADES ============================== */
const player = {
  x: 0, y: 0, w: 20, h: 26,
  dir: 'down', moving: false, running: false, animFrame: 0, animTimer: 0,
  health: 100, courage: 10, hunger: 100, thirst: 100, stamina: 100,
  hidden: false, hideCooldown: 0,
  inventory: {}, // memory id -> true
};

function initPlayerStart(){
  const cx = Math.floor(WORLD_W*0.45), cy = Math.floor(WORLD_H*0.55);
  player.x = cx*TILE; player.y = (cy-1)*TILE;
  player.health=100; player.courage=10; player.hunger=100; player.thirst=100; player.stamina=100;
  player.hidden=false; player.inventory={};
}

let soldiers = [];
function spawnSoldiers(){
  const cx = Math.floor(WORLD_W*0.45), cy = Math.floor(WORLD_H*0.55);
  soldiers = [
    {x:(cx-14)*TILE, y:(cy-2)*TILE, dir:1, angle:0, state:'patrol',
     path:[{x:cx-14,y:cy-2},{x:cx-14,y:cy+6},{x:cx-4,y:cy+6},{x:cx-4,y:cy-2}], wp:0, alertTimer:0},
    {x:(cx+14)*TILE, y:(cy+2)*TILE, dir:1, angle:Math.PI, state:'patrol',
     path:[{x:cx+14,y:cy+2},{x:cx+14,y:cy-6},{x:cx+4,y:cy-6},{x:cx+4,y:cy+2}], wp:0, alertTimer:0},
    {x:(cx)*TILE, y:(cy+16)*TILE, dir:1, angle:Math.PI/2, state:'patrol',
     path:[{x:cx,y:cy+16},{x:cx+10,y:cy+16},{x:cx+10,y:cy+22},{x:cx,y:cy+22}], wp:0, alertTimer:0},
  ];
}

/* ============================== 5. PARTÍCULAS ============================== */
let particles = [];
function spawnParticle(type){
  const cam = camera;
  particles.push({
    type,
    x: cam.x + Math.random()*VIEW_W,
    y: type==='rain' ? cam.y - 10 : cam.y + Math.random()*VIEW_H,
    vx: type==='rain' ? -40 : (Math.random()-0.5)*10,
    vy: type==='rain' ? 420 : (type==='firefly'? (Math.random()-0.5)*8 : 8+Math.random()*8),
    life: 1, age:0, size: type==='leaf'?3+Math.random()*2:(type==='rain'?10:2),
    sway: Math.random()*Math.PI*2,
  });
}
function updateParticles(dt){
  const density = story.stage==='invasion' ? {rain:6, leaf:0, firefly:0} : {rain:0, leaf:1, firefly: story.isNight?1:0};
  if(Math.random()<density.rain*dt) spawnParticle('rain');
  if(Math.random()<density.leaf*dt) spawnParticle('leaf');
  if(Math.random()<density.firefly*dt) spawnParticle('firefly');
  for(const p of particles){
    p.age += dt;
    if(p.type==='leaf'){ p.sway += dt*2; p.x += Math.sin(p.sway)*8*dt; p.y += p.vy*dt; }
    else { p.x += p.vx*dt; p.y += p.vy*dt; }
  }
  particles = particles.filter(p=> p.age < 8 && p.y < camera.y+VIEW_H+40);
}
function drawParticles(ctx){
  for(const p of particles){
    const sx = p.x-camera.x, sy = p.y-camera.y;
    if(sx<-20||sx>VIEW_W+20||sy<-20||sy>VIEW_H+20) continue;
    if(p.type==='rain'){
      ctx.strokeStyle='rgba(200,220,255,0.5)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(sx-6,sy+p.size); ctx.stroke();
    } else if(p.type==='leaf'){
      ctx.fillStyle='rgba(180,150,60,0.7)';
      ctx.fillRect(sx,sy,p.size,p.size);
    } else if(p.type==='firefly'){
      const a = 0.4+0.6*Math.abs(Math.sin(p.age*4));
      ctx.fillStyle=`rgba(255,240,150,${a})`;
      ctx.beginPath(); ctx.arc(sx,sy,2,0,Math.PI*2); ctx.fill();
    }
  }
}

/* ============================== 6. CÂMERA / RENDER ============================== */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = VIEW_W; canvas.height = VIEW_H;
const camera = {x:0,y:0};

function updateCamera(){
  camera.x = clamp(player.x - VIEW_W/2, 0, WORLD_W*TILE - VIEW_W);
  camera.y = clamp(player.y - VIEW_H/2, 0, WORLD_H*TILE - VIEW_H);
}

function resizeCanvas(){
  const wrap = document.getElementById('game-container');
  const scale = Math.min(wrap.clientWidth/VIEW_W, wrap.clientHeight/VIEW_H);
  canvas.style.width = (VIEW_W*scale)+'px';
  canvas.style.height = (VIEW_H*scale)+'px';
}
window.addEventListener('resize', resizeCanvas);

function tileColor(t){
  switch(t){
    case TILE_GRASS: return '#3c5a34';
    case TILE_TREE: return '#2a3f22';
    case TILE_WATER: return '#2a5878';
    case TILE_PATH: return '#8a7550';
    case TILE_HUT: return '#6b4a34';
    case TILE_HUTDOOR: return '#4a3222';
    case TILE_ROCK: return '#5a5850';
    case TILE_SAND: return '#a99460';
    case TILE_FLOWER: return '#4a6b3a';
    case TILE_RUIN: return '#3a2f28';
    case TILE_CAVE: return '#161414';
    case TILE_BRIDGE: return '#8a6a40';
    default: return '#3c5a34';
  }
}

function drawTile(t,x,y){
  const c = tileColor(t);
  ctx.fillStyle = c;
  ctx.fillRect(x,y,TILE,TILE);
  // pequenos detalhes procedurais por tipo
  if(t===TILE_GRASS || t===TILE_FLOWER){
    ctx.fillStyle='rgba(0,0,0,0.06)';
    for(let i=0;i<3;i++){ ctx.fillRect(x+((i*13+x)%TILE), y+((i*7+y)%TILE),2,2); }
    if(t===TILE_FLOWER){
      ctx.fillStyle='#e8c94a';
      ctx.fillRect(x+TILE/2-2,y+TILE/2-2,4,4);
    }
  } else if(t===TILE_WATER){
    const shimmer = Math.sin((Date.now()/400)+x*0.1+y*0.1)*0.5+0.5;
    ctx.fillStyle = `rgba(180,220,255,${0.08+shimmer*0.12})`;
    ctx.fillRect(x,y+TILE*0.3,TILE,4);
  } else if(t===TILE_TREE){
    ctx.fillStyle='#4a2f1f'; ctx.fillRect(x+TILE/2-3,y+TILE*0.55,6,TILE*0.45);
    const sway = Math.sin(Date.now()/900 + x*0.05)*3;
    ctx.fillStyle='#355c2a';
    ctx.beginPath(); ctx.arc(x+TILE/2+sway, y+TILE*0.35, TILE*0.52, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#2c4a22';
    ctx.beginPath(); ctx.arc(x+TILE/2+sway*0.6, y+TILE*0.25, TILE*0.32, 0, Math.PI*2); ctx.fill();
  } else if(t===TILE_HUT){
    ctx.fillStyle='#8a6a40'; ctx.beginPath();
    ctx.moveTo(x,y+TILE*0.4); ctx.lineTo(x+TILE/2,y-TILE*0.3); ctx.lineTo(x+TILE,y+TILE*0.4); ctx.closePath(); ctx.fill();
  } else if(t===TILE_ROCK){
    ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(x+4,y+8,TILE-8,TILE-14);
  } else if(t===TILE_CAVE){
    ctx.fillStyle='#000'; ctx.beginPath(); ctx.ellipse(x+TILE/2,y+TILE*0.6,TILE*0.4,TILE*0.5,0,0,Math.PI*2); ctx.fill();
  } else if(t===TILE_RUIN){
    ctx.fillStyle='#1c1714'; ctx.fillRect(x+3,y+10,TILE-6,TILE-14);
    ctx.fillStyle='rgba(255,120,40,0.15)'; ctx.fillRect(x+8,y+16,4,4);
  }
}

function drawWorld(){
  const startX = Math.floor(camera.x/TILE)-1, endX = Math.ceil((camera.x+VIEW_W)/TILE)+1;
  const startY = Math.floor(camera.y/TILE)-1, endY = Math.ceil((camera.y+VIEW_H)/TILE)+1;
  for(let y=Math.max(0,startY); y<Math.min(WORLD_H,endY); y++){
    for(let x=Math.max(0,startX); x<Math.min(WORLD_W,endX); x++){
      drawTile(tileAt(x,y), x*TILE-camera.x, y*TILE-camera.y);
    }
  }
}

function drawHumanoid(sx, sy, opts){
  // opts: {bodyColor, skin, dir, moving, frame, accessory, alpha}
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  const bob = opts.moving ? Math.sin(opts.frame*0.9)*2 : 0;
  // sombra
  ctx.fillStyle='rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(sx+10, sy+30, 10,4,0,0,Math.PI*2); ctx.fill();
  // pernas
  ctx.fillStyle = opts.pantColor || '#3a2f22';
  const legOff = opts.moving ? Math.sin(opts.frame*0.9)*4 : 0;
  ctx.fillRect(sx+4, sy+18+bob, 5, 10+legOff*0.2);
  ctx.fillRect(sx+11, sy+18+bob, 5, 10-legOff*0.2);
  // corpo
  ctx.fillStyle = opts.bodyColor;
  ctx.fillRect(sx+2, sy+6+bob, 16, 14);
  // braços
  ctx.fillStyle = opts.skin;
  ctx.fillRect(sx, sy+8+bob, 3, 9);
  ctx.fillRect(sx+17, sy+8+bob, 3, 9);
  // cabeça
  ctx.fillStyle = opts.skin;
  ctx.beginPath(); ctx.arc(sx+10, sy+2+bob, 7, 0, Math.PI*2); ctx.fill();
  // cabelo
  ctx.fillStyle = opts.hair || '#1a1410';
  ctx.beginPath(); ctx.arc(sx+10, sy-1+bob, 7.3, Math.PI, Math.PI*2.15); ctx.fill();
  // acessório (cocar)
  if(opts.accessory==='cocar'){
    ctx.fillStyle='#c94a2a';
    for(let i=-3;i<=3;i++){ ctx.fillRect(sx+10+i*1.6-1, sy-8+bob-Math.abs(i), 2, 8); }
  }
  ctx.restore();
}

function drawPlayer(){
  const sx = player.x-camera.x, sy = player.y-camera.y;
  drawHumanoid(sx, sy, {
    bodyColor: '#a8562f', pantColor:'#5c3a24', skin:'#c98a5c', hair:'#241a12',
    moving: player.moving, frame: player.animFrame,
    accessory: player.inventory.cocar ? 'cocar' : null,
    alpha: player.hidden ? 0.35 : 1,
  });
  if(player.hidden){
    ctx.fillStyle='rgba(233,226,207,0.85)'; ctx.font='11px Georgia';
    ctx.fillText('escondida', sx-6, sy-14);
  }
}

function drawNPC(n){
  const sx = n.x*TILE-camera.x, sy = n.y*TILE-camera.y;
  if(sx<-30||sx>VIEW_W+30||sy<-30||sy>VIEW_H+30) return;
  const colors = {
    anciao:{body:'#6b5a3a', skin:'#c98a5c', hair:'#cfcfcf'},
    curandeira:{body:'#4a7a4a', skin:'#c98a5c', hair:'#241a12'},
    cacador:{body:'#7a5a2f', skin:'#c98a5c', hair:'#1a1410'},
    crianca1:{body:'#c9a04a', skin:'#d09a6c', hair:'#1a1410'},
    mae:{body:'#c9a04a', skin:'#d09a6c', hair:'#1a1410'},
  };
  const c = colors[n.id] || colors.anciao;
  drawHumanoid(sx-10, sy-13, {bodyColor:c.body, pantColor:'#3a2f22', skin:c.skin, hair:c.hair, moving:false, frame:0});
}

function drawMemoryItem(m){
  if(m.found) return;
  const sx = m.x*TILE-camera.x, sy = m.y*TILE-camera.y;
  if(sx<-30||sx>VIEW_W+30||sy<-30||sy>VIEW_H+30) return;
  const glow = 0.5+0.5*Math.sin(Date.now()/300);
  ctx.save();
  ctx.shadowColor = 'rgba(255,220,120,0.9)'; ctx.shadowBlur = 10+glow*10;
  ctx.font='22px serif'; ctx.textAlign='center';
  ctx.fillText(m.icon, sx+16, sy+22);
  ctx.restore();
}

function drawSoldier(s){
  const sx = s.x-camera.x, sy = s.y-camera.y;
  if(sx<-60||sx>VIEW_W+60||sy<-60||sy>VIEW_H+60) return;
  // cone de visão
  const range = 150, fov = 0.65;
  ctx.save();
  ctx.globalAlpha = s.state==='chase' ? 0.28 : 0.16;
  ctx.fillStyle = s.state==='chase' ? '#ff3b3b' : '#ffe27a';
  ctx.beginPath();
  ctx.moveTo(sx+10, sy+10);
  ctx.arc(sx+10, sy+10, range, s.angle-fov, s.angle+fov);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  drawHumanoid(sx, sy, {bodyColor:'#3a4a35', pantColor:'#2a3a28', skin:'#c9a878', hair:'#111', moving:true, frame:s.animFrame||0});
  if(story.isNight){
    ctx.save();
    const grad = ctx.createRadialGradient(sx+10,sy+10,2, sx+10,sy+10,60);
    grad.addColorStop(0,'rgba(255,230,150,0.25)'); grad.addColorStop(1,'rgba(255,230,150,0)');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(sx+10,sy+10,60,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

function drawLightingOverlay(){
  if(story.stage!=='invasion' && !story.isNight) return;
  ctx.save();
  ctx.fillStyle = story.stage==='invasion' ? 'rgba(8,10,14,0.45)' : 'rgba(10,14,28,0.35)';
  ctx.fillRect(0,0,VIEW_W,VIEW_H);
  // luz suave ao redor da jogadora
  const sx = player.x-camera.x+10, sy = player.y-camera.y+10;
  const grad = ctx.createRadialGradient(sx,sy,10,sx,sy,190);
  grad.addColorStop(0,'rgba(255,255,255,0)'); grad.addColorStop(1,'rgba(0,0,0,0.35)');
  ctx.globalCompositeOperation='multiply';
  // aplica escurecimento nas bordas (vinheta simples)
  ctx.globalCompositeOperation='source-over';
  ctx.restore();
}

function screenShake(){
  if(story.shakeTimer>0){
    story.shakeTimer -= 1;
    return {x:(Math.random()-0.5)*story.shakeMag, y:(Math.random()-0.5)*story.shakeMag};
  }
  return {x:0,y:0};
}

function render(){
  ctx.clearRect(0,0,VIEW_W,VIEW_H);
  const shake = screenShake();
  ctx.save();
  ctx.translate(shake.x, shake.y);
  drawWorld();
  // objetos ordenados por y (profundidade)
  const drawables = [];
  for(const n of world.npcs) if(!story.npcHidden(n.id)) drawables.push({y:n.y*TILE, draw:()=>drawNPC(n)});
  for(const m of world.memories) drawables.push({y:m.y*TILE, draw:()=>drawMemoryItem(m)});
  for(const s of soldiers) drawables.push({y:s.y, draw:()=>drawSoldier(s)});
  drawables.push({y:player.y, draw:drawPlayer});
  drawables.sort((a,b)=>a.y-b.y);
  for(const d of drawables) d.draw();

  drawParticles(ctx);
  drawLightingOverlay();
  ctx.restore();
}

/* ============================== 7. HISTÓRIA ============================== */
const story = {
  stage: 'peace', // peace -> invasion -> escape -> ended
  talkedTo: new Set(),
  flags: { savedElder:false, gotFood:false, helpedChild:false, hidBaby:false, waited:false },
  choicesDone: new Set(),
  isNight: false,
  shakeTimer: 0, shakeMag: 0,
  detectionTimer: 0,
  npcHidden(id){ return this.stage!=='peace' && (id==='crianca1'); },
  timeElapsed: 0,
};

function showPoemLine(text){
  const el = document.getElementById('poemLine');
  el.textContent = text; el.classList.remove('hidden');
  el.style.animation='none'; void el.offsetWidth; el.style.animation='';
  setTimeout(()=>el.classList.add('hidden'), 3600);
}

function fadeThenRun(fn, delay=900){
  const fo = document.getElementById('fadeOverlay');
  fo.classList.add('active');
  setTimeout(()=>{ fn(); setTimeout(()=>fo.classList.remove('active'), 120); }, delay);
}

/* ---- Diálogo simples ---- */
let dialogueQueue = [], dialogueActive=false;
function openDialogue(name, lines){
  dialogueQueue = [...lines];
  dialogueActive = true;
  document.getElementById('dialogueBox').classList.remove('hidden');
  document.getElementById('dialogueName').textContent = name;
  advanceDialogue();
}
function advanceDialogue(){
  if(dialogueQueue.length===0){
    dialogueActive=false;
    document.getElementById('dialogueBox').classList.add('hidden');
    return;
  }
  document.getElementById('dialogueText').textContent = dialogueQueue.shift();
}
document.getElementById('dialogueBox').addEventListener('click', advanceDialogue);

/* ---- Memórias / flashback ---- */
function openMemory(m){
  m.found = true;
  player.inventory[m.id] = true;
  player.courage = clamp(player.courage+12, 0, 100);
  AudioEngine.playChime(520+Object.keys(player.inventory).length*40);
  const overlay = document.getElementById('memoryOverlay');
  const mc = document.getElementById('memoryCanvas');
  mc.width=700; mc.height=394;
  const mctx = mc.getContext('2d');
  mctx.fillStyle='#181410'; mctx.fillRect(0,0,700,394);
  // cena simples e calorosa (fogueira + silhuetas)
  const grad = mctx.createRadialGradient(350,260,20,350,260,320);
  grad.addColorStop(0,'rgba(255,180,90,0.5)'); grad.addColorStop(1,'rgba(0,0,0,0)');
  mctx.fillStyle=grad; mctx.fillRect(0,0,700,394);
  mctx.fillStyle='#ff8c3a';
  mctx.beginPath(); mctx.moveTo(350,300); mctx.quadraticCurveTo(335,260,350,220); mctx.quadraticCurveTo(365,260,350,300); mctx.fill();
  for(let i=0;i<3;i++){
    mctx.fillStyle='rgba(20,15,10,0.9)';
    mctx.fillRect(260+i*90,270,26,60);
    mctx.beginPath(); mctx.arc(273+i*90,262,14,0,Math.PI*2); mctx.fill();
  }
  mctx.font='42px serif'; mctx.textAlign='center'; mctx.fillStyle='#f2e6c9';
  mctx.fillText(m.icon, 350, 120);
  document.getElementById('memoryText').textContent = m.text;
  overlay.classList.remove('hidden');
  updateHUD(); updateInventoryUI();
}
document.getElementById('memoryClose').addEventListener('click', ()=>{
  document.getElementById('memoryOverlay').classList.add('hidden');
});

/* ---- Escolhas ---- */
function openChoice(promptText, options){
  gamePaused = true;
  const overlay = document.getElementById('choiceOverlay');
  document.getElementById('choicePrompt').textContent = promptText;
  const box = document.getElementById('choiceOptions');
  box.innerHTML='';
  for(const opt of options){
    const btn = document.createElement('button');
    btn.className='menu-btn';
    btn.textContent = opt.label;
    btn.onclick = ()=>{
      overlay.classList.add('hidden');
      gamePaused=false;
      opt.effect();
    };
    box.appendChild(btn);
  }
  overlay.classList.remove('hidden');
}

const CHOICE_POINTS = [
  {id:'elder', x:0.32, y:0.30, radius:3.5, run(){
    openChoice('O ancião está preso sob os destroços de sua cabana. Os soldados se aproximam.', [
      {label:'Salvar o ancião', effect(){ story.flags.savedElder=true; player.courage=clamp(player.courage+15,0,100); showPoemLine('"As raízes nunca esquecem."'); }},
      {label:'Fugir e se esconder', effect(){ player.courage=clamp(player.courage-5,0,100); showPoemLine('"O silêncio também resiste."'); }},
    ]);
  }},
  {id:'food', x:0.58, y:0.62, radius:3.5, run(){
    openChoice('A despensa de alimentos ainda não foi encontrada pelos soldados.', [
      {label:'Buscar alimento para a viagem', effect(){ story.flags.gotFood=true; player.hunger=100; player.courage=clamp(player.courage+5,0,100); }},
      {label:'Seguir em frente sem se arriscar', effect(){ player.courage=clamp(player.courage+2,0,100); }},
    ]);
  }},
  {id:'child', x:0.40, y:0.72, radius:3.5, run(){
    openChoice('Uma criança perdida chora sozinha entre as árvores.', [
      {label:'Ajudar a criança perdida', effect(){ story.flags.helpedChild=true; player.courage=clamp(player.courage+15,0,100); showPoemLine('"Ninguém resiste sozinho."'); }},
      {label:'Não há tempo a perder', effect(){ player.courage=clamp(player.courage-5,0,100); }},
    ]);
  }},
  {id:'baby', x:0.63, y:0.45, radius:3.5, run(){
    openChoice('Perto do rio, você encontra uma cesta escondida entre os juncos.', [
      {label:'Esconder o filho na cesta e seguir sozinha', effect(){ story.flags.hidBaby=true; showPoemLine('"A terra ainda lembra."'); }},
      {label:'Manter o filho sempre com você', effect(){ player.courage=clamp(player.courage+8,0,100); }},
    ]);
  }},
  {id:'wait', x:0.72, y:0.13, radius:3.5, run(){
    openChoice('Você está perto da entrada da caverna, mas ouve passos ao longe.', [
      {label:'Esperar o silêncio retornar', effect(){ story.flags.waited=true; player.stamina=clamp(player.stamina+20,0,100); }},
      {label:'Correr agora para dentro', effect(){ player.stamina=clamp(player.stamina-15,0,100); player.courage=clamp(player.courage+5,0,100); }},
    ]);
  }},
];

/* ---- Transição para invasão ---- */
function triggerInvasion(){
  if(story.stage!=='peace') return;
  story.stage='transition';
  gamePaused = true;
  fadeThenRun(()=>{
    story.isNight = true;
    AudioEngine.setRain(true);
    // parte das cabanas viram ruínas
    for(const h of world.huts){
      if(rng()<0.6){ setTile(h.x,h.y,TILE_RUIN); h.ruined=true; }
    }
    spawnSoldiers();
    story.stage='invasion';
    story.shakeTimer=40; story.shakeMag=6;
    gamePaused=false;
    document.getElementById('objectiveText').textContent = 'Fuja, esconda-se e proteja seu filho. Alcance a caverna nas montanhas.';
    showPoemLine('"Quem diria que a gente tão guerreira..."');
    setTimeout(()=>showPoemLine('...fosse acabar um dia assim na vida.'), 4200);
  }, 1200);
}

/* ---- Final ---- */
function computeEnding(){
  const f = story.flags;
  const flagScore = (f.savedElder?1:0)+(f.gotFood?1:0)+(f.helpedChild?1:0)+(f.waited?1:0);
  const score = player.courage + flagScore*10;
  if(f.hidBaby && player.courage < 45){
    return 'sacrifice';
  }
  if(score >= 90 && flagScore>=3){
    return 'hope';
  }
  if(score >= 60){
    return 'resistance';
  }
  return 'survival';
}

const ENDING_TEXT = {
  survival: {
    title: 'Final I — Sobrevivência',
    lines: [
      'Você atravessa a caverna com o coração disparado.',
      'A aldeia fica para trás, em silêncio e fumaça.',
      'Vocês estão vivos — e isso, por hoje, é suficiente.',
      '"A terra ainda lembra."',
    ]
  },
  sacrifice: {
    title: 'Final II — Sacrifício',
    lines: [
      'Você esconde seu filho entre os juncos, protegido pela cesta.',
      'Fica para trás, atraindo os passos para longe dele.',
      'Não é o fim que se escolhe — é o amor que resiste até o último instante.',
      '"O silêncio também resiste."',
    ]
  },
  resistance: {
    title: 'Final III — Resistência',
    lines: [
      'Você guia os sobreviventes por caminhos que só sua gente conhece.',
      'O ancião caminha ao seu lado, vivo graças à sua coragem.',
      'A floresta se fecha atrás de vocês, escondendo o que resta do povo.',
      '"As raízes nunca esquecem."',
    ]
  },
  hope: {
    title: 'Final IV — Esperança',
    lines: [
      'Todos que você ajudou caminham agora ao seu lado.',
      'Seu filho carrega as sementes guardadas — a próxima colheita já começou.',
      'A escuridão não apagou a memória. Ela nunca apaga.',
      '"Enquanto houver memória, nenhum povo desaparece."',
    ]
  }
};

function reachCave(){
  if(story.stage!=='invasion') return;
  story.stage='ended';
  gamePaused = true;
  AudioEngine.stopChaseMusic(); AudioEngine.stopHeartbeat(); AudioEngine.setRain(false);
  const ending = computeEnding();
  playCutscene(ending);
}

function playCutscene(endingKey){
  const data = ENDING_TEXT[endingKey];
  const overlay = document.getElementById('cutsceneOverlay');
  const cc = document.getElementById('cutsceneCanvas');
  cc.width = VIEW_W; cc.height = VIEW_H;
  const cctx = cc.getContext('2d');
  overlay.classList.remove('hidden');
  const textEl = document.getElementById('cutsceneText');
  let i=0;
  function drawSceneBG(){
    const g = cctx.createLinearGradient(0,0,0,VIEW_H);
    g.addColorStop(0,'#0a0f1a'); g.addColorStop(1,'#1c2a1a');
    cctx.fillStyle=g; cctx.fillRect(0,0,VIEW_W,VIEW_H);
    // estrelas
    for(let s=0;s<60;s++){
      cctx.fillStyle=`rgba(255,255,255,${0.2+0.5*Math.sin(s+Date.now()/900)})`;
      cctx.fillRect((s*97)%VIEW_W, (s*53)%(VIEW_H*0.6), 2,2);
    }
    // silhueta de árvores
    cctx.fillStyle='#0d150c';
    for(let t=0;t<12;t++){ cctx.beginPath(); cctx.arc(t*90+40, VIEW_H-90, 70,0,Math.PI*2); cctx.fill(); }
    cctx.fillRect(0,VIEW_H-70,VIEW_W,70);
    cctx.font='bold 30px Georgia'; cctx.fillStyle='#f2e6c9'; cctx.textAlign='center';
    cctx.fillText(data.title, VIEW_W/2, 90);
  }
  let raf;
  function loop(){ drawSceneBG(); raf=requestAnimationFrame(loop); }
  loop();
  function showLine(){
    if(i>=data.lines.length){
      cancelAnimationFrame(raf);
      overlay.classList.add('hidden');
      showFinalCredits();
      return;
    }
    textEl.textContent = data.lines[i];
    i++;
    setTimeout(showLine, 3400);
  }
  showLine();
}

function showFinalCredits(){
  const overlay = document.getElementById('finalCreditsOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('finalCreditsScroll').style.animation='none';
  void document.getElementById('finalCreditsScroll').offsetWidth;
  document.getElementById('finalCreditsScroll').style.animation='';
  document.getElementById('finalMessage').classList.add('hidden');
  setTimeout(()=>{
    document.getElementById('finalCreditsScroll').classList.add('hidden');
    document.getElementById('finalMessage').classList.remove('hidden');
  }, 16000);
  setTimeout(()=>{
    overlay.classList.add('hidden');
    document.getElementById('finalCreditsScroll').classList.remove('hidden');
    goToMainMenu();
  }, 22000);
}

/* ============================== 8. ENTRADA ============================== */
const keys = {};
window.addEventListener('keydown', e=>{
  keys[e.key.toLowerCase()] = true;
  if(e.key==='Escape') togglePause();
  if(e.key==='Tab'){ e.preventDefault(); toggleInventory(); }
  if(e.key.toLowerCase()==='e') handleInteract();
});
window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

let touchVec = {x:0,y:0};
function setupJoystick(){
  const zone = document.getElementById('joystickZone');
  const stick = document.getElementById('joystickStick');
  let active=false, startPos={x:0,y:0};
  function handleStart(e){
    active=true;
    const t = e.touches ? e.touches[0] : e;
    startPos = {x:t.clientX, y:t.clientY};
  }
  function handleMove(e){
    if(!active) return;
    const t = e.touches ? e.touches[0] : e;
    let dx=t.clientX-startPos.x, dy=t.clientY-startPos.y;
    const max=40;
    const d = Math.hypot(dx,dy);
    if(d>max){ dx=dx/d*max; dy=dy/d*max; }
    stick.style.transform = `translate(${dx-26}px, ${dy-26}px)`;
    touchVec = {x:dx/max, y:dy/max};
    e.preventDefault();
  }
  function handleEnd(){
    active=false; touchVec={x:0,y:0};
    stick.style.transform='translate(-50%,-50%)';
  }
  zone.addEventListener('touchstart', handleStart, {passive:false});
  zone.addEventListener('touchmove', handleMove, {passive:false});
  zone.addEventListener('touchend', handleEnd);
  zone.addEventListener('mousedown', e=>{ handleStart(e); const mm=ev=>handleMove(ev); const mu=()=>{handleEnd(); window.removeEventListener('mousemove',mm); window.removeEventListener('mouseup',mu);}; window.addEventListener('mousemove',mm); window.addEventListener('mouseup',mu); });
}

let touchRunning=false;
function setupButtons(){
  document.getElementById('btnInteract').addEventListener('touchstart', e=>{e.preventDefault(); handleInteract();});
  document.getElementById('btnInteract').addEventListener('click', handleInteract);
  const runBtn = document.getElementById('btnRun');
  runBtn.addEventListener('touchstart', e=>{e.preventDefault(); touchRunning=true;});
  runBtn.addEventListener('touchend', e=>{e.preventDefault(); touchRunning=false;});
  runBtn.addEventListener('mousedown', ()=>touchRunning=true);
  runBtn.addEventListener('mouseup', ()=>touchRunning=false);
  document.getElementById('btnInv').addEventListener('click', toggleInventory);
  document.getElementById('btnPause').addEventListener('click', togglePause);
}

function handleInteract(){
  if(gamePaused || story.stage==='ended' || story.stage==='transition') return;
  AudioEngine.init();
  // esconder / sair de esconderijo
  if(player.hidden){ player.hidden=false; return; }
  // procura NPC próximo
  for(const n of world.npcs){
    if(story.npcHidden(n.id)) continue;
    if(dist(player.x/TILE, player.y/TILE, n.x, n.y) < 1.6){
      story.talkedTo.add(n.id);
      const idx2 = story.talkedTo.has(n.id+'_c') ? 1 : 0;
      openDialogue(n.name, [n.lines[Math.min(story.talkedTo.size%n.lines.length, n.lines.length-1)]]);
      checkPeaceProgress();
      return;
    }
  }
  // memória próxima
  for(const m of world.memories){
    if(m.found) continue;
    if(dist(player.x/TILE+0.6, player.y/TILE+0.6, m.x+0.5, m.y+0.5) < 1.4){
      openMemory(m);
      return;
    }
  }
  // esconderijo: árvore ou cabana próxima (só relevante depois da invasão)
  if(story.stage==='invasion'){
    const tx = Math.round(player.x/TILE), ty = Math.round(player.y/TILE);
    const near = [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]];
    for(const [nx,ny] of near){
      const t = tileAt(nx,ny);
      if(t===TILE_TREE || t===TILE_HUT || t===TILE_HUTDOOR){
        player.hidden = true;
        return;
      }
    }
  }
}

function checkPeaceProgress(){
  if(story.stage==='peace' && story.talkedTo.size >= 4){
    document.getElementById('objectiveText').textContent = 'Algo mudou no ar... volte para perto de casa.';
    setTimeout(()=>triggerInvasion(), 6000);
  }
}

/* ============================== 9. SAVE / LOAD ============================== */
const SAVE_KEY = 'invasao_save_v1';
function saveGame(){
  const data = {
    px: player.x, py: player.y, health: player.health, courage: player.courage,
    hunger: player.hunger, thirst: player.thirst, stamina: player.stamina,
    inventory: player.inventory, stage: story.stage, flags: story.flags,
    talkedTo: Array.from(story.talkedTo), memories: world.memories.map(m=>m.found),
  };
  try{ localStorage.setItem(SAVE_KEY, JSON.stringify(data)); }catch(e){}
}
function hasSave(){
  try{ return !!localStorage.getItem(SAVE_KEY); }catch(e){ return false; }
}
function loadGame(){
  try{
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if(!data) return false;
    player.x=data.px; player.y=data.py; player.health=data.health; player.courage=data.courage;
    player.hunger=data.hunger; player.thirst=data.thirst; player.stamina=data.stamina;
    player.inventory=data.inventory||{};
    story.stage = data.stage==='peace' ? 'peace' : 'invasion';
    story.flags = data.flags || story.flags;
    story.talkedTo = new Set(data.talkedTo||[]);
    (data.memories||[]).forEach((f,i)=>{ if(world.memories[i]) world.memories[i].found=f; });
    if(story.stage==='invasion'){
      story.isNight=true;
      for(const h of world.huts) if(h.ruined) setTile(h.x,h.y,TILE_RUIN);
      spawnSoldiers();
      AudioEngine.setRain(true);
    }
    return true;
  }catch(e){ return false; }
}

/* ============================== 10. LOOP / UI ============================== */
let gamePaused = false;
let lastTime = performance.now();

function updateHUD(){
  document.getElementById('barHealth').style.width = player.health+'%';
  document.getElementById('barCourage').style.width = player.courage+'%';
  document.getElementById('barHunger').style.width = player.hunger+'%';
  document.getElementById('barThirst').style.width = player.thirst+'%';
  document.getElementById('barStamina').style.width = player.stamina+'%';
}

function updateInventoryUI(){
  const grid = document.getElementById('inventoryGrid');
  grid.innerHTML='';
  for(const m of world.memories){
    const div = document.createElement('div');
    div.className = 'inv-item' + (m.found? '' : ' locked');
    div.innerHTML = `<div class="inv-icon">${m.found? m.icon : '❔'}</div><div class="inv-name">${m.found? m.name : '???'}</div>`;
    grid.appendChild(div);
  }
}

function toggleInventory(){
  const el = document.getElementById('inventoryScreen');
  const willOpen = el.classList.contains('hidden');
  if(willOpen){ updateInventoryUI(); gamePaused=true; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); gamePaused=false; }
}
document.getElementById('closeInventory').addEventListener('click', toggleInventory);

function togglePause(){
  if(story.stage==='ended' || story.stage==='transition') return;
  if(document.getElementById('mainMenu').classList.contains('hidden')===false) return;
  const el = document.getElementById('pauseScreen');
  const willOpen = el.classList.contains('hidden');
  gamePaused = willOpen;
  el.classList.toggle('hidden');
}

function updatePlayer(dt){
  if(gamePaused || player.hidden) { player.moving=false; return; }
  let mx=0,my=0;
  if(keys['w']||keys['arrowup']) my-=1;
  if(keys['s']||keys['arrowdown']) my+=1;
  if(keys['a']||keys['arrowleft']) mx-=1;
  if(keys['d']||keys['arrowright']) mx+=1;
  mx += touchVec.x; my += touchVec.y;
  const mag = Math.hypot(mx,my);
  player.running = (keys['shift'] || touchRunning) && player.stamina>2;
  if(mag>0.1){
    mx/=mag; my/=mag;
    const speed = (player.running?150:88) * dt;
    const nx = player.x + mx*speed, ny = player.y + my*speed;
    const tx = Math.floor((nx+10)/TILE), ty=Math.floor((player.y+20)/TILE);
    const ty2 = Math.floor((ny+20)/TILE), tx2=Math.floor((player.x+10)/TILE);
    if(walkable(tx,ty)) player.x = clamp(nx,0,WORLD_W*TILE-TILE);
    if(walkable(tx2,ty2)) player.y = clamp(ny,0,WORLD_H*TILE-TILE);
    player.moving = true;
    player.animTimer += dt;
    if(player.animTimer>0.15){ player.animFrame++; player.animTimer=0; AudioEngine.playFootstep(player.running); }
    if(Math.abs(mx)>Math.abs(my)) player.dir = mx>0?'right':'left'; else player.dir = my>0?'down':'up';
    if(player.running) player.stamina = clamp(player.stamina-14*dt,0,100);
  } else {
    player.moving=false;
  }
  if(!player.running) player.stamina = clamp(player.stamina+8*dt,0,100);
  player.hunger = clamp(player.hunger-0.35*dt,0,100);
  player.thirst = clamp(player.thirst-0.5*dt,0,100);
  if(player.hunger<=0 || player.thirst<=0) player.health = clamp(player.health-1.2*dt,0,100);

  // caverna alcançada
  const ptx = Math.round(player.x/TILE), pty=Math.round(player.y/TILE);
  if(story.stage==='invasion' && dist(ptx,pty, world.caveTile.x, world.caveTile.y) < 2.2){
    reachCave();
  }

  // pontos de escolha
  if(story.stage==='invasion'){
    for(const cp of CHOICE_POINTS){
      if(story.choicesDone.has(cp.id)) continue;
      const wx = cp.x*WORLD_W, wy = cp.y*WORLD_H;
      if(dist(player.x/TILE, player.y/TILE, wx, wy) < cp.radius){
        story.choicesDone.add(cp.id);
        cp.run();
      }
    }
  }
}

function updateSoldiers(dt){
  if(gamePaused || story.stage!=='invasion') return;
  let anyChasing=false;
  for(const s of soldiers){
    s.animFrame = (s.animFrame||0) + (s.state==='chase'?1:0.4);
    if(s.state==='patrol'){
      const wp = s.path[s.wp];
      const tx = wp.x*TILE, ty=wp.y*TILE;
      const d = dist(s.x,s.y,tx,ty);
      if(d<4){ s.wp = (s.wp+1)%s.path.length; }
      else {
        const ang = Math.atan2(ty-s.y, tx-s.x);
        s.angle = ang;
        s.x += Math.cos(ang)*50*dt; s.y += Math.sin(ang)*50*dt;
      }
      // detecção
      if(!player.hidden){
        const dp = dist(s.x,s.y, player.x, player.y);
        const angToPlayer = Math.atan2(player.y-s.y, player.x-s.x);
        let diff = Math.abs(angToPlayer - s.angle);
        if(diff>Math.PI) diff = Math.PI*2-diff;
        if(dp<150 && diff<0.65){
          s.state='chase'; s.alertTimer=4;
        }
      }
    } else if(s.state==='chase'){
      anyChasing=true;
      const ang = Math.atan2(player.y-s.y, player.x-s.x);
      s.angle = ang;
      const dp = dist(s.x,s.y,player.x,player.y);
      if(dp>16){ s.x += Math.cos(ang)*95*dt; s.y += Math.sin(ang)*95*dt; }
      if(player.hidden || dp>340){
        s.alertTimer -= dt;
        if(s.alertTimer<=0){ s.state='patrol'; }
      } else {
        s.alertTimer = 4;
      }
      if(dp<20 && !player.hidden){
        // pega a jogadora — recuo, sem violência gráfica
        player.health = clamp(player.health-18,0,100);
        player.courage = clamp(player.courage-6,0,100);
        story.shakeTimer=20; story.shakeMag=8;
        const ang2 = Math.atan2(player.y-s.y, player.x-s.x);
        player.x += Math.cos(ang2)*60; player.y += Math.sin(ang2)*60;
        s.state='patrol'; s.alertTimer=0;
        showPoemLine('"Cenário macabro te é reservado. Pra que lado tu corres?"');
        if(player.health<=0){
          respawnAtCheckpoint();
        }
      }
    }
  }
  document.getElementById('detectionWarning').classList.toggle('hidden', !anyChasing);
  if(anyChasing){ AudioEngine.startChaseMusic(); AudioEngine.startHeartbeat(); }
  else { AudioEngine.stopChaseMusic(); AudioEngine.stopHeartbeat(); }
}

function respawnAtCheckpoint(){
  gamePaused=true;
  fadeThenRun(()=>{
    player.health=60;
    const cx = Math.floor(WORLD_W*0.45), cy = Math.floor(WORLD_H*0.55);
    player.x = cx*TILE; player.y=(cy-1)*TILE;
    gamePaused=false;
  });
}

let saveTimer=0;
function gameLoop(now){
  const dt = Math.min((now-lastTime)/1000, 0.05);
  lastTime = now;
  if(!gamePaused){
    updatePlayer(dt);
    updateSoldiers(dt);
    updateParticles(dt);
    updateCamera();
    saveTimer += dt;
    if(saveTimer>5){ saveTimer=0; if(story.stage!=='ended') saveGame(); }
  }
  render();
  updateHUD();
  requestAnimationFrame(gameLoop);
}

/* ---- Menu de fundo animado ---- */
const menuBg = document.getElementById('menuBg');
const menuCtx = menuBg.getContext('2d');
function resizeMenuBg(){ menuBg.width = window.innerWidth; menuBg.height = window.innerHeight; }
window.addEventListener('resize', resizeMenuBg); resizeMenuBg();
function drawMenuBg(){
  const w=menuBg.width, h=menuBg.height;
  const g = menuCtx.createLinearGradient(0,0,0,h);
  g.addColorStop(0,'#0a1410'); g.addColorStop(1,'#1c2a18');
  menuCtx.fillStyle=g; menuCtx.fillRect(0,0,w,h);
  const t = Date.now()/1000;
  for(let i=0;i<40;i++){
    const x = (i*67 + Math.sin(t*0.5+i)*20) % w;
    const y = (i*53) % h;
    menuCtx.fillStyle=`rgba(255,255,255,${0.05+0.1*Math.sin(t+i)})`;
    menuCtx.beginPath(); menuCtx.arc(x,y,2,0,Math.PI*2); menuCtx.fill();
  }
  menuCtx.fillStyle='#0d1a0d';
  for(let i=0;i<10;i++){
    const x = i*(w/9);
    menuCtx.beginPath(); menuCtx.arc(x, h-80+Math.sin(t*0.3+i)*4, 90,0,Math.PI*2); menuCtx.fill();
  }
  requestAnimationFrame(drawMenuBg);
}
drawMenuBg();

/* ============================== Ligações da UI ============================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function goToMainMenu(){
  showScreen('mainMenu');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('mobileControls').classList.add('hidden');
  document.getElementById('btnContinue').disabled = !hasSave();
}

function startNewGame(){
  AudioEngine.init();
  generateWorld();
  initPlayerStart();
  soldiers=[];
  story.stage='peace'; story.isNight=false; story.talkedTo=new Set(); story.choicesDone=new Set();
  story.flags={savedElder:false,gotFood:false,helpedChild:false,hidBaby:false,waited:false};
  AudioEngine.setRain(false);
  document.getElementById('mainMenu').classList.add('hidden');
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('mobileControls').classList.remove('hidden');
  document.getElementById('objectiveText').textContent = 'Converse com seu povo. Explore a aldeia em paz.';
  showPoemLine('"Toda terra guarda uma memória."');
  gamePaused=false;
  resizeCanvas();
}

function continueGame(){
  AudioEngine.init();
  generateWorld();
  const ok = loadGame();
  if(!ok){ startNewGame(); return; }
  document.getElementById('mainMenu').classList.add('hidden');
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('mobileControls').classList.remove('hidden');
  document.getElementById('objectiveText').textContent = story.stage==='invasion'
    ? 'Fuja, esconda-se e proteja seu filho. Alcance a caverna nas montanhas.'
    : 'Converse com seu povo. Explore a aldeia em paz.';
  gamePaused=false;
  resizeCanvas();
}

document.getElementById('btnPlay').addEventListener('click', startNewGame);
document.getElementById('btnContinue').addEventListener('click', continueGame);
document.getElementById('btnHowTo').addEventListener('click', ()=>showScreen('howToScreen'));
document.getElementById('btnSettings').addEventListener('click', ()=>showScreen('settingsScreen'));
document.getElementById('btnCredits').addEventListener('click', ()=>showScreen('creditsScreen'));
document.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click', ()=>showScreen(b.dataset.back)));

document.getElementById('btnResume').addEventListener('click', togglePause);
document.getElementById('btnRestart').addEventListener('click', ()=>{
  document.getElementById('pauseScreen').classList.add('hidden');
  startNewGame();
});
document.getElementById('btnToMenu').addEventListener('click', ()=>{
  document.getElementById('pauseScreen').classList.add('hidden');
  gamePaused=false;
  saveGame();
  goToMainMenu();
});

document.getElementById('volMusic').addEventListener('input', e=>{
  if(AudioEngine.started) AudioEngine.musicGain.gain.value = e.target.value/100;
});
document.getElementById('volSfx').addEventListener('input', e=>{
  if(AudioEngine.started) AudioEngine.sfxGain.gain.value = e.target.value/100;
});
document.getElementById('uiScale').addEventListener('input', e=>{
  document.documentElement.style.setProperty('--ui-scale', e.target.value/100);
  document.getElementById('mobileControls').style.transform = `scale(${e.target.value/100})`;
  document.getElementById('mobileControls').style.transformOrigin = 'bottom right';
});

/* ============================== Inicialização ============================== */
generateWorld();
initPlayerStart();
setupJoystick();
setupButtons();
resizeCanvas();
goToMainMenu();
requestAnimationFrame(gameLoop);
