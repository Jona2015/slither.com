const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 10000,
  perMessageDeflate: true,        // enable compression
  httpCompression: true,
});

// ---- CONFIG ----
const WORLD_W = 4000, WORLD_H = 4000;
const SEGMENT_RADIUS = 10;
const FOOD_COUNT = 800;           // reduced from 1200
const BOT_COUNT = 12;             // reduced from 20
const TICK_RATE = 50;             // 20fps server tick (was 33ms/30fps — less network load)
const BOOST_DRAIN = 0.15;
const BOOST_REGEN = 0.12;
const HIT_DIST = (SEGMENT_RADIUS * 1.5) ** 2;
const FOOD_CHECK_DIST = (SEGMENT_RADIUS + 8) ** 2;
const VIEW = 1200;                // viewport radius for culling

// ---- STATE ----
let players = {};
let bots = [];
let foods = [];

function rnd(min, max) { return min + Math.random() * (max - min); }

function makeFood(x, y) {
  const hue = Math.floor(Math.random() * 360);
  return {
    id: Math.random().toString(36).slice(2),
    x: x != null ? x : rnd(50, WORLD_W - 50),
    y: y != null ? y : rnd(50, WORLD_H - 50),
    r: 4 + Math.random() * 4,
    color: `hsl(${hue},100%,65%)`,
  };
}

function makeSnake(x, y, len, color, colorDark, name, isBot) {
  const segs = [];
  for (let i = 0; i < len; i++) segs.push({ x: x - i * 14, y });
  return {
    segments: segs,
    angle: Math.random() * Math.PI * 2,
    targetAngle: 0,
    speed: 3.2,
    color, colorDark, name,
    alive: true,
    boosting: false,
    boostEnergy: 100,
    score: 0,
    isBot,
    id: null,
    botTimer: Math.floor(rnd(0, 60)),
    botTarget: null,
  };
}

const BOT_COLORS = [
  ['#ff4466','#660022'],['#00c8ff','#004466'],['#ffdd00','#665500'],
  ['#ff8844','#662211'],['#cc44ff','#440066'],['#44ffcc','#006644'],
  ['#ff44cc','#660044'],['#88ff44','#224400'],['#4488ff','#001166'],
  ['#ffaa44','#664400'],['#ff6644','#661100'],['#44ffff','#004444'],
];
const BOT_NAMES = ['Zyklop','Cobra','Drache','Viper','Python','Anakonda',
  'Mamba','Natter','Kreuzotter','Ringelnatter','Boa','Krait'];

function spawnBots() {
  bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const [c,cd] = BOT_COLORS[i % BOT_COLORS.length];
    const b = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 15+Math.floor(rnd(0,20)), c, cd, BOT_NAMES[i%BOT_NAMES.length], true);
    b.id = 'bot_' + i;
    bots.push(b);
  }
}

function initFoods() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) foods.push(makeFood());
}

function killSnake(snake) {
  snake.alive = false;
  const drop = Math.floor(snake.segments.length * 0.5);
  for (let i = 0; i < drop; i++) {
    const seg = snake.segments[Math.floor(Math.random() * snake.segments.length)];
    foods.push(makeFood(seg.x + rnd(-15,15), seg.y + rnd(-15,15)));
  }
  while (foods.length > FOOD_COUNT * 1.5) foods.shift();
  if (!snake.isBot) {
    const sock = io.sockets.sockets.get(snake.id);
    if (sock) sock.emit('died', { score: snake.segments.length });
  }
}

function updateSnake(snake, targetAngle, isBoosting) {
  if (!snake.alive) return;
  let diff = targetAngle - snake.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turn = Math.min(Math.abs(diff), 0.08) * Math.sign(diff);
  if (Math.abs(diff) < 0.02) snake.angle = targetAngle;
  else snake.angle += turn;

  let speed = snake.speed;
  if (isBoosting && snake.boostEnergy > 0) {
    speed *= 2.5;
    snake.boostEnergy = Math.max(0, snake.boostEnergy - BOOST_DRAIN);
    if (Math.random() < 0.08 && snake.segments.length > 10) {
      const tail = snake.segments[snake.segments.length - 1];
      foods.push(makeFood(tail.x + rnd(-8,8), tail.y + rnd(-8,8)));
      snake.segments.pop();
    }
  } else {
    snake.boostEnergy = Math.min(100, snake.boostEnergy + BOOST_REGEN);
  }

  const head = snake.segments[0];
  const nx = head.x + Math.cos(snake.angle) * speed;
  const ny = head.y + Math.sin(snake.angle) * speed;
  if (nx < 0 || nx > WORLD_W || ny < 0 || ny > WORLD_H) { killSnake(snake); return; }

  for (let i = snake.segments.length - 1; i > 0; i--) {
    snake.segments[i].x = snake.segments[i-1].x;
    snake.segments[i].y = snake.segments[i-1].y;
  }
  snake.segments[0].x = nx;
  snake.segments[0].y = ny;
}

function updateBot(bot) {
  if (!bot.alive) return;
  bot.botTimer--;
  const head = bot.segments[0];
  let tx = head.x + Math.cos(bot.angle) * 200;
  let ty = head.y + Math.sin(bot.angle) * 200;

  if (bot.botTimer <= 0) {
    bot.botTimer = 30 + Math.floor(rnd(0,60));
    let best = Infinity;
    for (const f of foods) {
      const d = (f.x-head.x)**2 + (f.y-head.y)**2;
      if (d < best && d < 160000) { best = d; tx = f.x; ty = f.y; }
    }
    bot.botTarget = { x: tx, y: ty };
  }
  if (bot.botTarget) { tx = bot.botTarget.x; ty = bot.botTarget.y; }
  const margin = 200;
  if (head.x < margin) tx = head.x + 300;
  if (head.x > WORLD_W - margin) tx = head.x - 300;
  if (head.y < margin) ty = head.y + 300;
  if (head.y > WORLD_H - margin) ty = head.y - 300;

  updateSnake(bot, Math.atan2(ty-head.y, tx-head.x), Math.random() < 0.03 && bot.boostEnergy > 40);
}

function checkCollisions() {
  const allSnakes = [...Object.values(players), ...bots];
  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.segments[0];

    // Eat food
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      const dx = head.x-f.x, dy = head.y-f.y;
      if (dx*dx+dy*dy < FOOD_CHECK_DIST) {
        if (snake.segments.length < 600) {
          const tail = snake.segments[snake.segments.length-1];
          snake.segments.push({ x: tail.x, y: tail.y });
        }
        snake.score++;
        foods.splice(i,1);
        if (foods.length < FOOD_COUNT) foods.push(makeFood());
      }
    }
    // Hit other snakes
    for (const other of allSnakes) {
      if (!other.alive || other === snake) continue;
      if (Math.abs(other.segments[0].x-head.x) > 600) continue;
      const limit = Math.min(other.segments.length, 80);
      for (let i = 10; i < limit; i += 2) {
        const dx = head.x-other.segments[i].x, dy = head.y-other.segments[i].y;
        if (dx*dx+dy*dy < HIT_DIST) { killSnake(snake); other.score+=50; break; }
      }
    }
  }
  // Respawn bots
  for (let i = 0; i < bots.length; i++) {
    if (!bots[i].alive) {
      const [c,cd] = BOT_COLORS[i%BOT_COLORS.length];
      const b = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 15, c, cd, BOT_NAMES[i%BOT_NAMES.length], true);
      b.id = 'bot_' + i;
      bots[i] = b;
    }
  }
}

spawnBots();
initFoods();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', ({ name, color, colorDark }) => {
    const snake = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 20, color||'#00ff88', colorDark||'#006633', name||'Spieler', false);
    snake.id = socket.id;
    snake.targetAngle = snake.angle;
    players[socket.id] = snake;
    socket.emit('init', { worldW: WORLD_W, worldH: WORLD_H });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.targetAngle = angle;
    p.boosting = boosting;
  });

  socket.on('respawn', ({ name, color, colorDark }) => {
    const snake = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 20, color||'#00ff88', colorDark||'#006633', name||'Spieler', false);
    snake.id = socket.id;
    snake.targetAngle = snake.angle;
    players[socket.id] = snake;
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) killSnake(p);
    delete players[socket.id];
    console.log('Disconnected:', socket.id);
  });
});

// ---- GAME LOOP ----
setInterval(() => {
  // Update all snakes
  for (const id in players) {
    const p = players[id];
    if (p.alive) updateSnake(p, p.targetAngle ?? p.angle, p.boosting);
  }
  for (const bot of bots) updateBot(bot);
  checkCollisions();

  // Build leaderboard once
  const allSnakes = [...Object.values(players), ...bots];
  const leaderboard = allSnakes
    .filter(s => s.alive)
    .sort((a,b) => b.segments.length - a.segments.length)
    .slice(0, 8)
    .map(s => ({ name: s.name, score: s.segments.length, isBot: s.isBot }));

  // Send each player only what they can see (view culling)
  for (const id in players) {
    const p = players[id];
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;

    const head = p.alive ? p.segments[0] : { x: WORLD_W/2, y: WORLD_H/2 };

    // Only send visible snakes — and limit segments sent
    const others = allSnakes
      .filter(s => s !== p && s.alive &&
        Math.abs(s.segments[0].x - head.x) < VIEW &&
        Math.abs(s.segments[0].y - head.y) < VIEW)
      .map(s => ({
        segs: s.segments.slice(0, 60).map(sg => [Math.round(sg.x), Math.round(sg.y)]), // compressed coords
        a: Math.round(s.angle * 100) / 100,
        c: s.color,
        cd: s.colorDark,
        n: s.name,
        l: s.segments.length,
      }));

    // Only send visible food
    const nearFoods = foods
      .filter(f => Math.abs(f.x - head.x) < VIEW && Math.abs(f.y - head.y) < VIEW)
      .map(f => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), r: f.r, c: f.color }));

    sock.emit('state', {
      s: p.alive ? {
        segs: p.segments.map(sg => [Math.round(sg.x), Math.round(sg.y)]),
        a: Math.round(p.angle * 100) / 100,
        be: Math.round(p.boostEnergy),
        sc: p.segments.length,
        al: true,
      } : { al: false },
      o: others,
      f: nearFoods,
      lb: leaderboard,
    });
  }
}, TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SLITHER server on port ${PORT}`));


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000,
});

// ---- CONFIG ----
const WORLD_W = 4000, WORLD_H = 4000;
const SEGMENT_RADIUS = 10;
const FOOD_COUNT = 1200;
const BOT_COUNT = 20;
const TICK_RATE = 33; // ~30fps
const BOOST_DRAIN = 0.15;
const BOOST_REGEN = 0.12;
const HIT_DIST = (SEGMENT_RADIUS * 1.5) ** 2;
const FOOD_CHECK_DIST = (SEGMENT_RADIUS + 8) ** 2;

// ---- STATE ----
let players = {};
let bots = [];
let foods = [];

function rnd(min, max) { return min + Math.random() * (max - min); }

function makeFood(x, y) {
  const hue = Math.floor(Math.random() * 360);
  return {
    id: Math.random().toString(36).slice(2),
    x: x ?? rnd(50, WORLD_W - 50),
    y: y ?? rnd(50, WORLD_H - 50),
    r: 4 + Math.random() * 4,
    color: `hsl(${hue},100%,65%)`,
  };
}

function makeSnake(x, y, len, color, colorDark, name, isBot) {
  const segs = [];
  for (let i = 0; i < len; i++) segs.push({ x: x - i * 14, y });
  return {
    segments: segs,
    angle: Math.random() * Math.PI * 2,
    targetAngle: 0,
    speed: 3.2,
    color, colorDark, name,
    alive: true, isBot,
    boostEnergy: 100,
    boosting: false,
    score: 0,
    botTimer: Math.floor(rnd(0, 80)),
    botTarget: null,
    id: null,
  };
}

const BOT_COLORS = [
  ['#ff4466','#660022'],['#00c8ff','#004466'],['#ffdd00','#665500'],
  ['#ff8844','#662211'],['#cc44ff','#440066'],['#44ffcc','#006644'],
  ['#ff44cc','#660044'],['#88ff44','#224400'],['#4488ff','#001166'],
  ['#ffaa44','#664400'],['#ff6644','#661100'],['#44ffff','#004444'],
  ['#aa00ff','#330055'],['#00ffaa','#005533'],['#ffff00','#555500'],
  ['#ff2200','#550000'],['#55ffaa','#115533'],['#aaff00','#334400'],
  ['#ff5500','#552200'],['#00aaff','#003355'],
];
const BOT_NAMES = [
  'Cobra','Viper','Python','Mamba','Drache','Anakonda','Krait','Taipan',
  'Mokassin','Koralle','Gabun','Boa','Puffotter','Königskobra',
  'Klapperschlange','Tigerschlange','Schwarzmamba','Seeschlange','Hornviper','Grubenotter'
];

function spawnBots() {
  bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const [c, cd] = BOT_COLORS[i % BOT_COLORS.length];
    bots.push(makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 15+Math.floor(rnd(0,20)), c, cd, BOT_NAMES[i%BOT_NAMES.length], true));
  }
}

function initFoods() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) foods.push(makeFood());
}

function updateSnake(snake, targetAngle, isBoosting) {
  if (!snake.alive) return;
  let diff = targetAngle - snake.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turn = Math.min(Math.abs(diff), 0.1) * Math.sign(diff);
  if (Math.abs(diff) < 0.02) snake.angle = targetAngle;
  else snake.angle += turn;

  let speed = snake.speed;
  if (isBoosting && snake.boostEnergy > 0) {
    speed *= 2.5;
    snake.boostEnergy = Math.max(0, snake.boostEnergy - BOOST_DRAIN);
    if (Math.random() < 0.08 && snake.segments.length > 10) {
      const tail = snake.segments[snake.segments.length - 1];
      foods.push(makeFood(tail.x + rnd(-10,10), tail.y + rnd(-10,10)));
      snake.segments.pop();
    }
  } else {
    snake.boostEnergy = Math.min(100, snake.boostEnergy + BOOST_REGEN);
  }

  const head = snake.segments[0];
  const nx = head.x + Math.cos(snake.angle) * speed;
  const ny = head.y + Math.sin(snake.angle) * speed;

  if (nx < 0 || nx > WORLD_W || ny < 0 || ny > WORLD_H) { killSnake(snake); return; }

  for (let i = snake.segments.length - 1; i > 0; i--) {
    snake.segments[i].x = snake.segments[i-1].x;
    snake.segments[i].y = snake.segments[i-1].y;
  }
  snake.segments[0].x = nx;
  snake.segments[0].y = ny;
}

function killSnake(snake) {
  if (!snake.alive) return;
  snake.alive = false;
  const drop = Math.floor(snake.segments.length * 0.7);
  for (let i = 0; i < drop; i++) {
    const seg = snake.segments[Math.floor(Math.random() * snake.segments.length)];
    foods.push(makeFood(seg.x + rnd(-20,20), seg.y + rnd(-20,20)));
  }
  while (foods.length > FOOD_COUNT * 1.5) foods.shift();

  // Notify player if it's a real player
  if (snake.id) {
    const sock = io.sockets.sockets.get(snake.id);
    if (sock) sock.emit('dead', { score: snake.segments.length });
  }
}

function updateBot(bot) {
  if (!bot.alive) return;
  bot.botTimer--;
  const head = bot.segments[0];
  let tx = head.x + Math.cos(bot.angle)*200, ty = head.y + Math.sin(bot.angle)*200;

  if (bot.botTimer <= 0) {
    bot.botTimer = 30 + Math.floor(rnd(0,60));
    let best = Infinity;
    for (const f of foods) {
      const d = (f.x-head.x)**2 + (f.y-head.y)**2;
      if (d < best && d < 400*400) { best=d; tx=f.x; ty=f.y; }
    }
    bot.botTarget = { x:tx, y:ty };
  }
  if (bot.botTarget) { tx=bot.botTarget.x; ty=bot.botTarget.y; }
  const margin = 150;
  if (head.x < margin) tx = head.x+200;
  if (head.x > WORLD_W-margin) tx = head.x-200;
  if (head.y < margin) ty = head.y+200;
  if (head.y > WORLD_H-margin) ty = head.y-200;
  updateSnake(bot, Math.atan2(ty-head.y, tx-head.x), Math.random()<0.03 && bot.boostEnergy>50);
}

function checkCollisions() {
  const allSnakes = [...Object.values(players), ...bots];
  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.segments[0];
    // Eat food
    for (let i = foods.length-1; i >= 0; i--) {
      const f = foods[i];
      const dx = head.x-f.x, dy = head.y-f.y;
      if (dx*dx+dy*dy < FOOD_CHECK_DIST) {
        if (snake.segments.length < 600) {
          const tail = snake.segments[snake.segments.length-1];
          snake.segments.push({x:tail.x, y:tail.y});
        }
        snake.score++;
        foods.splice(i,1);
        if (foods.length < FOOD_COUNT) foods.push(makeFood());
      }
    }
    // Hit other snakes
    for (const other of allSnakes) {
      if (!other.alive || other === snake) continue;
      if (Math.abs(other.segments[0].x-head.x) > 600) continue;
      const limit = Math.min(other.segments.length, 80);
      for (let i = 10; i < limit; i += 2) {
        const dx = head.x-other.segments[i].x, dy = head.y-other.segments[i].y;
        if (dx*dx+dy*dy < HIT_DIST) { killSnake(snake); other.score+=50; break; }
      }
    }
  }
  // Respawn bots
  for (let i = 0; i < bots.length; i++) {
    if (!bots[i].alive) {
      const [c,cd] = BOT_COLORS[i%BOT_COLORS.length];
      bots[i] = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 15, c, cd, BOT_NAMES[i%BOT_NAMES.length], true);
    }
  }
}

spawnBots();
initFoods();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', ({ name, color, colorDark }) => {
    const snake = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 20, color||'#00ff88', colorDark||'#006633', name||'Spieler', false);
    snake.id = socket.id;
    snake.targetAngle = snake.angle;
    players[socket.id] = snake;
    socket.emit('init', { worldW: WORLD_W, worldH: WORLD_H });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.targetAngle = angle;
    p.boosting = boosting;
  });

  socket.on('respawn', ({ name, color, colorDark }) => {
    const snake = makeSnake(rnd(300,WORLD_W-300), rnd(300,WORLD_H-300), 20, color||'#00ff88', colorDark||'#006633', name||'Spieler', false);
    snake.id = socket.id;
    snake.targetAngle = snake.angle;
    players[socket.id] = snake;
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) killSnake(p);
    delete players[socket.id];
    console.log('Disconnected:', socket.id);
  });
});

// Game loop
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    if (p.alive) updateSnake(p, p.targetAngle ?? p.angle, p.boosting);
  }
  for (const bot of bots) updateBot(bot);
  checkCollisions();

  const allSnakes = [...Object.values(players), ...bots];
  const leaderboard = allSnakes
    .filter(s => s.alive)
    .sort((a,b) => b.segments.length - a.segments.length)
    .slice(0,10)
    .map(s => ({ name: s.name, score: s.segments.length, id: s.id }));

  for (const id in players) {
    const p = players[id];
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;

    const head = p.alive ? p.segments[0] : { x:WORLD_W/2, y:WORLD_H/2 };
    const VIEW = 1400;

    const others = allSnakes
      .filter(s => s !== p && s.alive && Math.abs(s.segments[0].x-head.x) < VIEW && Math.abs(s.segments[0].y-head.y) < VIEW)
      .map(s => ({
        segments: s.segments.slice(0, 100),
        angle: s.angle,
        color: s.color,
        colorDark: s.colorDark,
        name: s.name,
      }));

    const nearFoods = foods.filter(f => Math.abs(f.x-head.x) < VIEW && Math.abs(f.y-head.y) < VIEW);

    sock.emit('state', {
      self: p.alive ? {
        segments: p.segments,
        angle: p.angle,
        alive: true,
        boostEnergy: p.boostEnergy,
        score: p.segments.length,
      } : { alive: false },
      others,
      foods: nearFoods,
      leaderboard,
    });
  }
}, TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SLITHER server on port ${PORT}`));
