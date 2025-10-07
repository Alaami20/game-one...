<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Runner – Person with Jump/Duck Effects</title>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
<style>
  :root { color-scheme: light dark; }
  html, body { margin:0; height:100%; background:#0e1116; font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
  .wrap { display:grid; place-items:center; height:100%; }
  #ui { position:fixed; top:10px; left:50%; transform:translateX(-50%); display:flex; gap:12px; align-items:center; user-select:none; z-index:2 }
  #score, #hiscore { font-weight:700; font-variant-numeric: tabular-nums; padding:6px 10px; background:#0d0f13; border:1px solid #20252f; border-radius:10px; color:#e9eef6 }
  .btn { padding:6px 10px; border:1px solid #20252f; border-radius:10px; background:#0d0f13; color:#e9eef6; cursor:pointer; }
  canvas { width:min(92vw, 960px); height:auto; max-height:82vh; background:#0b0f13; border:1px solid #20252f; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
</style>
</head>
<body>
  <div id="ui">
    <span id="score">Score: 00000</span>
    <span id="hiscore">HI: 00000</span>
    <button id="pause" class="btn">Pause (P)</button>
  </div>
  <div class="wrap">
    <canvas id="game" width="960" height="300"></canvas>
  </div>

<script>
(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // World/physics
  const GROUND_Y = H - 54;
  const GRAVITY = 2400;
  const JUMP_VY = -820;
  const START_SPEED = 360, MAX_SPEED = 880, ACCEL = 14;

  // Player “feel” helpers
  const COYOTE_TIME = 0.08;     // leniency after leaving ground
  const JUMP_BUFFER = 0.12;     // leniency before landing
  const MAX_JUMP_HOLD = 0.22;   // variable jump height window
  const STEP_FREQ = 8.5;        // run cycle
  const PERSON_SCALE = 1.0;     // easy size tweak

  // HUD
  const fmt = n => String(Math.floor(n)).padStart(5, "0");
  const loadHi = () => Number(localStorage.getItem("runner_hi")||0);
  const saveHi = v => localStorage.setItem("runner_hi", String(Math.floor(v)));

  // State
  let state, last = performance.now(), started=false, paused=false;

  // Random helpers
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const rint = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;

  // Entities
  function makePlayer(){
    return {
      x: 110,
      y: GROUND_Y - 48,
      vy: 0,
      w: 26,           // used for collisions only
      h: 48,
      onGround: true,
      duck: false,
      anim: 0,         // run cycle time
      coyote: 0,
      jumpBuf: 0,
      jumpHeld: -1,    // -1 means not holding
      stretchX: 1, stretchY: 1,
      slide: 0,        // slide timer when ducking
    };
  }
  function makeCactus(x){
    const v = [{w:22,h:42},{w:26,h:48},{w:32,h:54},{w:50,h:48},{w:66,h:54}][rint(0,4)];
    return { x, y:GROUND_Y - v.h, w:v.w, h:v.h, type:'cactus' };
  }
  function makeBird(x){
    const heights = [GROUND_Y-80, GROUND_Y-110, GROUND_Y-54];
    return { x, y: heights[rint(0,2)], w:46, h:32, flap:0, type:'bird' };
  }
  function makeCloud(x){ return { x, y:rint(24,140), w:rint(46,90), h:rint(18,34) }; }
  function makeDust(x,y,hard=false,dir=1){
    return {
      x, y, r: hard? rint(3,5): rint(2,3),
      vx:(Math.random()*80+80)*dir*(Math.random()<.5?-1:1),
      vy:-(Math.random()*80+30),
      a:1, ttl:0.5
    };
  }
  function makeStreak(x,y,len=30,th=2){
    return { x, y, len, th, ttl:0.18, a:1 };
  }
  function reset(){
    state = {
      t:0, score:0, hiscore:loadHi(),
      speed:START_SPEED,
      player: makePlayer(),
      obstacles: [],
      clouds: [], hillsFar: [], hillsNear: [],
      nextSpawnX: W + 260,
      gameOver:false, msg:"Tap / Space to start",
      particles: [], streaks: [],
      cam:{shakeX:0, shakeY:0, shakeT:0, bob:0}
    };
    for(let i=0;i<5;i++) state.clouds.push(makeCloud(rint(0,W)));
  }

  // Input
  const keys = new Set();
  addEventListener("keydown", e=>{
    if(["Space","ArrowUp","ArrowDown","KeyW","KeyS","KeyP"].includes(e.code)) e.preventDefault();
    if(e.repeat) return;
    keys.add(e.code);
    if(!started && (e.code==="Space"||e.code==="ArrowUp"||e.code==="KeyW")){ started=true; state.msg=""; }
    if(e.code==="KeyP") paused=!paused;
    bufferJump();
  });
  addEventListener("keyup", e=>{
    keys.delete(e.code);
    if (["Space","ArrowUp","KeyW"].includes(e.code)) state.player.jumpHeld=-1;
  });
  canvas.addEventListener("pointerdown", ()=>{
    if(!started){ started=true; state.msg=""; return; }
    if(state.gameOver){ reset(); return; }
    bufferJump();
  });
  document.getElementById("pause").addEventListener("click", ()=> paused=!paused);

  function bufferJump(){ state.player.jumpBuf = JUMP_BUFFER; }

  // Effects
  function shake(intensity=8, time=0.15){
    state.cam.shakeInt = intensity; state.cam.shakeT = time;
  }

  // Spawn control
  function ensureSpawns(){
    if(state.obstacles.length===0){
      state.obstacles.push(makeCactus(W + rint(0,80)));
      state.nextSpawnX = W + rint(360,720);
    } else {
      const last = state.obstacles.at(-1);
      if (last.x < W - state.nextSpawnX){
        if (state.score > 260 && Math.random() < 0.22) state.obstacles.push(makeBird(W + rint(20,80)));
        else state.obstacles.push(makeCactus(W + rint(0,40)));
        const gapBase = clamp(720 - state.score*0.7, 360, 720);
        state.nextSpawnX = rint(360, Math.floor(gapBase));
      }
    }
  }

  // Update
  function update(dt){
    if(!started || paused) return;
    if(state.gameOver){
      if(keys.has("Space")||keys.has("Enter")) reset();
      return;
    }

    state.t += dt;
    state.speed = clamp(state.speed + ACCEL*dt, START_SPEED, MAX_SPEED);
    ensureSpawns();

    // Move clouds
    for(const c of state.clouds) c.x -= 32*dt;
    state.clouds = state.clouds.filter(c => c.x+c.w>-20);
    if(state.clouds.length<7 || state.clouds.at(-1).x < W-220) state.clouds.push(makeCloud(W + rint(40,120)));

    // Move obstacles
    for(const o of state.obstacles){
      o.x -= state.speed*dt;
      if(o.type==='bird'){ o.flap=(o.flap+dt*10)%(Math.PI*2); o.y += Math.sin(o.flap)*18*dt; }
    }
    state.obstacles = state.obstacles.filter(o => o.x+o.w>-40);

    // Player control + physics
    const p = state.player;
    const wantDuck = keys.has("ArrowDown")||keys.has("KeyS");
    p.duck = wantDuck && p.onGround;
    if(p.duck) p.slide = Math.min(0.25, p.slide + dt);
    else p.slide = Math.max(0, p.slide - dt*2.5);

    // coyote/jump buffer
    if(!p.onGround) p.coyote = Math.max(0, p.coyote - dt);
    p.jumpBuf = Math.max(0, p.jumpBuf - dt);

    // Consume a buffered jump if allowed
    if ((p.onGround || p.coyote>0) && p.jumpBuf>0){
      p.vy = JUMP_VY; p.onGround=false; p.coyote=0; p.jumpBuf=0; p.jumpHeld=0;
      // UP effects: whoosh + upward dust
      for(let i=0;i<6;i++) state.particles.push(makeDust(p.x+8, GROUND_Y, false, 1));
      state.streaks.push(makeStreak(p.x-8, p.y+12, 36, 3));
      p.stretchX = 0.94; p.stretchY = 1.08;
    }

    // variable jump (hold to go higher)
    const holding = (keys.has("Space")||keys.has("ArrowUp")||keys.has("KeyW")) && p.jumpHeld>=0;
    if (p.jumpHeld>=0) p.jumpHeld += dt;

    const boost = (holding && p.jumpHeld < MAX_JUMP_HOLD && p.vy < 0) ? 0.55 : 1.0;
    p.vy += GRAVITY * boost * dt;
    p.y  += p.vy * dt;

    // Ground collide
    const ph = p.duck ? 34 : 48; // crouch shrinks height
    p.h = ph;
    const gy = GROUND_Y - ph;
    if (p.y >= gy){
      if(!p.onGround && Math.abs(p.vy) > 300){
        shake(clamp(Math.abs(p.vy)/80, 6, 12), 0.15);
        for(let i=0;i<8;i++) state.particles.push(makeDust(p.x+10, GROUND_Y, true, 1));
        p.stretchX = 1.08; p.stretchY = 0.92; // land squash
      }
      p.y = gy; p.vy=0; p.onGround=true; p.coyote=COYOTE_TIME;
    } else {
      p.onGround=false;
    }

    // Slide effects while ducking
    if (p.duck && Math.random()<0.4){
      state.particles.push({x:p.x-4, y:GROUND_Y-2, r:rint(1,2), vx:-state.speed*0.2, vy: -rint(10,30), a:0.8, ttl:0.25});
      state.streaks.push(makeStreak(p.x-12, p.y+ph-6, 22+rint(-4,6), 2));
    }

    // Run cycle (for legs/arms pose)
    p.anim += dt*STEP_FREQ;

    // Ease squash back
    p.stretchX += (1 - p.stretchX)*Math.min(1, dt*12);
    p.stretchY += (1 - p.stretchY)*Math.min(1, dt*12);

    // Camera bob + shake
    state.cam.bob = p.onGround ? Math.sin(p.anim*2*Math.PI)*2.4 : 0.6;
    if (state.cam.shakeT>0){
      state.cam.shakeT -= dt;
      const I = state.cam.shakeInt||8;
      state.cam.shakeX = (Math.random()*2-1)*I;
      state.cam.shakeY = (Math.random()*2-1)*I;
    } else { state.cam.shakeX = state.cam.shakeY = 0; }

    // Particles
    for(const q of state.particles){
      q.ttl -= dt; q.a = q.ttl/0.5;
      q.x += (q.vx||0)*dt; q.y += (q.vy||0)*dt;
      q.vy = (q.vy||0) + 1200*dt;
    }
    state.particles = state.particles.filter(q => q.ttl>0 && q.y < H+10);

    // Streaks
    for(const s of state.streaks){ s.ttl -= dt; s.a = s.ttl/0.18; }
    state.streaks = state.streaks.filter(s => s.ttl>0);

    // Score
    state.score += dt*10;
    if (state.score > state.hiscore){ state.hiscore = state.score; saveHi(state.hiscore); }

    // Collisions
    const pr = {x:state.player.x, y:state.player.y, w:26, h:state.player.h};
    for(const o of state.obstacles){
      const rr = {x:o.x, y:o.y, w:o.w, h:o.h};
      if (!(pr.x+pr.w<rr.x || rr.x+rr.w<pr.x || pr.y+pr.h<rr.y || rr.y+rr.h<pr.y)){
        state.gameOver = true; shake(14,0.25); break;
      }
    }

    // HUD
    document.getElementById("score").textContent = "Score: " + fmt(state.score);
    document.getElementById("hiscore").textContent = "HI: " + fmt(state.hiscore);
  }

  // Drawing helpers
  function cloud(x,y,w,h){
    ctx.beginPath(); ctx.roundRect(x,y,w,h,12); ctx.fill();
    ctx.roundRect(x+w*0.2, y-8, w*0.6, h, 12); ctx.fill();
  }
  function drawCactus(o,camX,camY){
    ctx.fillStyle="#2eb872";
    ctx.beginPath(); ctx.roundRect(o.x+camX, o.y+camY, o.w, o.h, 5); ctx.fill();
    ctx.fillStyle="#1e7a4d";
    ctx.fillRect(o.x+camX+o.w*0.2, o.y+camY+o.h*0.2, 2, o.h*0.6);
    ctx.fillRect(o.x+camX+o.w*0.6, o.y+camY+o.h*0.25, 2, o.h*0.5);
  }
  function drawBird(o,camX,camY){
    ctx.save();
    ctx.translate(o.x+camX, o.y+camY);
    ctx.fillStyle="#dfe7f2";
    ctx.roundRect(0, 6, o.w-12, o.h-10, 6); ctx.fill();
    ctx.roundRect(o.w-20, 0, 20, 16, 6); ctx.fill();
    ctx.beginPath(); ctx.moveTo(o.w, 8); ctx.lineTo(o.w+8,12); ctx.lineTo(o.w,16); ctx.closePath(); ctx.fill();
    const wingY = Math.sin(o.flap*2)*6;
    ctx.fillRect(10, 4+wingY, 22, 6);
    ctx.restore();
  }

  // PERSON: simple vector runner (head/body/arms/legs) with poses
  function drawPerson(p, camX, camY){
    ctx.save();
    const PX = p.x + camX, PY = p.y + camY;
    ctx.translate(PX, PY);
    ctx.translate(0, p.h); // draw from feet upward
    ctx.scale(p.stretchX*PERSON_SCALE, p.stretchY*PERSON_SCALE);
    ctx.translate(0, -p.h);

    const skin = "#f3e4d7";
    const cloth = "#a7c3ff";
    const dark  = "#0e1116";

    // body sizes
    const headR = 9;
    const torsoH = 22;
    const torsoW = 14;
    const armL = 16;
    const legL = 18;

    // run phase 0..1
    const phase = (p.anim % 1);

    // Pose: duck or run/air
    const isDuck = p.duck && p.onGround;
    const isAir = !p.onGround;

    // Torso tilt
    let torsoTilt = isDuck ? 0.25 : (isAir ? 0.05 : 0.12 * Math.sin(phase*2*Math.PI));
    // head offset
    let headY = isDuck ? -torsoH+6 : -torsoH-2;

    // Arms & legs angles
    const runSwing = Math.sin(phase*2*Math.PI);
    let armA1 = isDuck ? 0.9 : (isAir ? 0.2 :  0.8*runSwing);
    let armA2 = isDuck ? 0.6 : (isAir ? -0.2 : -0.8*runSwing);
    let legA1 = isDuck ? 0.2 : (isAir ? 0.35 : -0.9*runSwing);
    let legA2 = isDuck ? -0.05: (isAir ? 0.10 :  0.9*runSwing);

    // Shadow
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0+8, p.h+4, 16, 4, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.translate(8, p.h-2); // hips origin

    // Legs
    ctx.strokeStyle = dark; ctx.lineWidth = 3; ctx.lineCap="round";
    // Back leg
    ctx.save(); ctx.rotate(legA1);
    line(0,0, 0, legL);
    ctx.restore();
    // Front leg
    ctx.save(); ctx.rotate(legA2);
    line(0,0, 0, legL);
    ctx.restore();

    // Torso
    ctx.save();
    ctx.rotate(-torsoTilt);
    ctx.fillStyle = cloth;
    roundRectCentered(0, -torsoH, torsoW, torsoH, 6, true, false);

    // Arms from shoulder
    ctx.translate(0, -torsoH+6);
    // back arm
    ctx.save(); ctx.rotate(armA1);
    line(0,0, 0, armL);
    ctx.restore();
    // front arm
    ctx.save(); ctx.rotate(armA2);
    line(0,0, 0, armL);
    ctx.restore();

    // Head
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI*2);
    ctx.fill();

    // Eye
    ctx.fillStyle = dark;
    ctx.fillRect(-2, headY-2, 3, 3);

    ctx.restore();
    ctx.restore();

    // Helpers
    function line(x1,y1,x2,y2){ ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
    function roundRectCentered(cx,cy,w,h,r,fill,stroke){
      const x=cx-w/2, y=cy;
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y,   x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x,   y+h, r);
      ctx.arcTo(x,   y+h, x,   y,   r);
      ctx.arcTo(x,   y,   x+w, y,   r);
      if(fill) ctx.fill(); if(stroke) ctx.stroke();
    }
  }

  // Render
  function render(){
    const camX = state.cam.shakeX;
    const camY = state.cam.bob + state.cam.shakeY + (state.player.onGround?0:-Math.min(4, Math.max(-4, state.player.vy*0.01)));

    // Sky
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,"#0b1220"); g.addColorStop(1,"#0a0d14");
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);

    // Clouds
    ctx.fillStyle="#a7b4c8"; ctx.globalAlpha=0.65;
    for(const c of state.clouds) cloud(c.x+camX, c.y+camY, c.w, c.h);
    ctx.globalAlpha=1;

    // Ground
    ctx.strokeStyle="#2a3546"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(0, GROUND_Y+1+camY); ctx.lineTo(W, GROUND_Y+1+camY); ctx.stroke();
    ctx.fillStyle="#0e1622"; ctx.fillRect(0, GROUND_Y+2+camY, W, H-(GROUND_Y+2+camY));

    // Obstacles
    for(const o of state.obstacles){
      if(o.type==='bird') drawBird(o, camX, camY);
      else drawCactus(o, camX, camY);
    }

    // Streaks (duck slide lines & jump whoosh)
    for(const s of state.streaks){
      ctx.globalAlpha = clamp(s.a,0,1);
      ctx.strokeStyle = "#9bb8ff"; ctx.lineWidth = s.th;
      ctx.beginPath(); ctx.moveTo(s.x+camX, s.y+camY);
      ctx.lineTo(s.x - s.len + camX, s.y + camY);
      ctx.stroke();
    }
    ctx.globalAlpha=1;

    // Particles (dust)
    for(const q of state.particles){
      ctx.globalAlpha = clamp(q.a,0,1);
      ctx.fillStyle = "#a0b3c7";
      ctx.beginPath(); ctx.arc(q.x+camX, q.y+camY, q.r, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha=1;

    // Player (person)
    drawPerson(state.player, camX, camY);

    // Messages
    if(!started){ banner("Tap / Space to start"); }
    else if(paused){ banner("Paused — P to resume"); }
    else if(state.gameOver){ banner("Game Over — Space/Tap to restart"); }
  }

  function banner(text){
    ctx.fillStyle="rgba(0,0,0,0.45)"; ctx.fillRect(0,0,W,H);
    ctx.fillStyle="#fff"; ctx.textAlign="center";
    ctx.font="bold 22px system-ui, Arial"; ctx.fillText(text, W/2, H/2);
    ctx.font="14px system-ui, Arial"; ctx.fillText("Jump: Space/↑ (hold) • Duck: ↓ • Pause: P", W/2, H/2+26);
  }

  // Main loop
  function loop(ts){
    const dt = Math.min(0.033,(ts-last)/1000); last = ts;
    update(dt); render();
    requestAnimationFrame(loop);
  }

  reset();
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>
