const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ---- GAME CONFIG ----
const WORLD_W = 4000, WORLD_H = 4000;
const SEGMENT_RADIUS = 10;
const FOOD_COUNT = 1200;
const BOT_COUNT = 20;
const TICK_RATE = 30; // ms per server tick (33fps)
const BOOST_DRAIN = 15;
const BOOST_REGEN = 12;
const HIT_DIST = (SEGMENT_RADIUS * 1.5) ** 2;
const FOOD_CHECK_DIST = (SEGMENT_RADIUS + 8) ** 2;

// ---- STATE ----
let players = {}; // socket.id -> player object
let bots = [];
let foods = [];

// ---- HELPERS ----
function randColor() {
  const colors = [
    ['#00ff88','#006633'], ['#00c8ff','#004466'], ['#ff4466','#660022'],
    ['#ffdd00','#665500'], ['#ff8844','#662211'], ['#cc44ff','#440066'],
    ['#44ffcc','#006644'], ['#ff44cc','#660044'], ['#88ff44','#224400'],
    ['#4488ff','#001166'], ['#ffaa44','#664400'], ['#ff6644','#661100'],
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function makeFood(x, y) {
  const hue = Math.floor(Math.random() * 360);
  return {
    id: Math.random().toString(36).slice(2),
    x: x ?? Math.random() * WORLD_W,
    y: y ?? Math.random() * WORLD_H,
    r: 4 + Math.random() * 4,
    color: `hsl(${hue},100%,65%)`,
  };
}

function makeSnake(x, y, length, color, colorDark, name, id) {
  const segments = [];
  for (let i = 0; i < length; i++) {
    segments.push({ x: x - i * 14, y });
  }
  return {
    id,
    segments,
    angle: Math.random() * Math.PI * 2,
    speed: 1.8,
    color,
    colorDark,
    name,
    alive: true,
    boostEnergy: 100,
    targetAngle: 0,
    boosting: false,
    botTimer: Math.floor(Math.random() * 60),
    botTarget: null,
    isBot: false,
  };
}

function spawnBots() {
  const botNames = ['Zyklop','Cobra','Drache','Viper','Python','Anakonda',
    'Mamba','Natter','Kreuzotter','Ringelnatter','Boa','Krait',
    'Taipan','Mokassin','Koralle','Gabun','Baumboa','Sandotter','Puffotter','Königskobra'];
  bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const x = 300 + Math.random() * (WORLD_W - 600);
    const y = 300 + Math.random() * (WORLD_H - 600);
    const [c, cd] = randColor();
    const bot = makeSnake(x, y, 15 + Math.floor(Math.random() * 20), c, cd, botNames[i % botNames.length], 'bot_' + i);
    bot.isBot = true;
    bots.push(bot);
  }
}

function initFoods() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) foods.push(makeFood());
}

function killSnake(snake) {
  snake.alive = false;
  const drop = Math.floor(snake.segments.length * 0.7);
  const newFoods = [];
  for (let i = 0; i < drop; i++) {
    const seg = snake.segments[Math.floor(Math.random() * snake.segments.length)];
    const f = makeFood(seg.x + (Math.random()-0.5)*20, seg.y + (Math.random()-0.5)*20);
    foods.push(f);
    newFoods.push(f);
  }
  io.emit('snakeDied', { id: snake.id, newFoods });
}

function updateSnake(snake) {
  if (!snake.alive) return;

  let diff = snake.targetAngle - snake.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turn = Math.min(Math.abs(diff), 0.08) * Math.sign(diff);
  if (Math.abs(diff) < 0.02) snake.angle = snake.targetAngle;
  else snake.angle += turn;

  let speed = snake.speed;
  const isBoosting = snake.boosting && snake.boostEnergy > 0;
  if (isBoosting) {
    speed *= 2.5;
    snake.boostEnergy = Math.max(0, snake.boostEnergy - BOOST_DRAIN);
    if (Math.random() < 0.08 && snake.segments.length > 10) {
      const tail = snake.segments[snake.segments.length - 1];
      const f = makeFood(tail.x + (Math.random()-0.5)*10, tail.y + (Math.random()-0.5)*10);
      foods.push(f);
      snake.segments.pop();
    }
  } else {
    snake.boostEnergy = Math.min(100, snake.boostEnergy + BOOST_REGEN);
  }

  const head = snake.segments[0];
  const nx = head.x + Math.cos(snake.angle) * speed;
  const ny = head.y + Math.sin(snake.angle) * speed;

  if (nx < 0 || nx > WORLD_W || ny < 0 || ny > WORLD_H) {
    killSnake(snake);
    return;
  }

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
    bot.botTimer = 30 + Math.floor(Math.random() * 60);
    let best = Infinity;
    for (const f of foods) {
      const d = (f.x-head.x)**2 + (f.y-head.y)**2;
      if (d < best && d < 160000) { best = d; tx = f.x; ty = f.y; }
    }
    // Chase nearest player
    for (const p of Object.values(players)) {
      if (!p.alive) continue;
      const d = (p.segments[0].x-head.x)**2 + (p.segments[0].y-head.y)**2;
      if (d < 90000 && Math.random() < 0.2) { tx = p.segments[0].x; ty = p.segments[0].y; }
    }
    bot.botTarget = { x: tx, y: ty };
  }

  if (bot.botTarget) { tx = bot.botTarget.x; ty = bot.botTarget.y; }
  const margin = 200;
  if (head.x < margin) tx = head.x + 300;
  if (head.x > WORLD_W - margin) tx = head.x - 300;
  if (head.y < margin) ty = head.y + 300;
  if (head.y > WORLD_H - margin) ty = head.y - 300;

  bot.targetAngle = Math.atan2(ty - head.y, tx - head.x);
  bot.boosting = Math.random() < 0.03 && bot.boostEnergy > 40;
  updateSnake(bot);
}

function checkCollisions() {
  const allSnakes = [...Object.values(players), ...bots];

  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.segments[0];

    // Eat food
    const eatenFoodIds = [];
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      const dx = head.x - f.x, dy = head.y - f.y;
      if (dx*dx + dy*dy < FOOD_CHECK_DIST) {
        if (snake.segments.length < 600) {
          const tail = snake.segments[snake.segments.length - 1];
          snake.segments.push({ x: tail.x, y: tail.y });
        }
        eatenFoodIds.push(f.id);
        foods.splice(i, 1);
        if (foods.length < FOOD_COUNT * 0.8) foods.push(makeFood());
      }
    }
    if (eatenFoodIds.length > 0) {
      io.emit('foodEaten', { snakeId: snake.id, foodIds: eatenFoodIds, length: snake.segments.length });
    }
  }

  // Snake vs snake collisions
  for (const snake of allSnakes) {
    if (!snake.alive) continue;
    const head = snake.segments[0];

    for (const other of allSnakes) {
      if (!other.alive || other.id === snake.id) continue;
      // Head vs body
      const limit = Math.min(other.segments.length, 80);
      for (let i = 10; i < limit; i += 2) {
        const dx = head.x - other.segments[i].x, dy = head.y - other.segments[i].y;
        if (dx*dx + dy*dy < HIT_DIST) {
          killSnake(snake);
          // Killer gets a bonus
          if (!other.isBot && players[other.id]) {
            for (let g = 0; g < 30; g++) {
              const tail = other.segments[other.segments.length - 1];
              other.segments.push({ x: tail.x, y: tail.y });
            }
          }
          break;
        }
      }
    }
  }

  // Respawn dead bots
  for (let i = 0; i < bots.length; i++) {
    if (!bots[i].alive) {
      const x = 300 + Math.random() * (WORLD_W - 600);
      const y = 300 + Math.random() * (WORLD_H - 600);
      bots[i] = makeSnake(x, y, 15, bots[i].color, bots[i].colorDark, bots[i].name, 'bot_' + i);
      bots[i].isBot = true;
    }
  }
}

// ---- INIT ----
initFoods();
spawnBots();

// ---- GAME LOOP ----
setInterval(() => {
  // Update bots
  for (const bot of bots) updateBot(bot);

  // Update players (server-authoritative movement)
  for (const p of Object.values(players)) updateSnake(p);

  checkCollisions();

  // Broadcast game state
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      colorDark: p.colorDark,
      angle: p.angle,
      alive: p.alive,
      boostEnergy: p.boostEnergy,
      // Send only first 100 segments to reduce bandwidth, rest interpolated
      segments: p.segments.slice(0, 120),
      length: p.segments.length,
    })),
    bots: bots.filter(b => b.alive).map(b => ({
      id: b.id,
      name: b.name,
      color: b.color,
      colorDark: b.colorDark,
      angle: b.angle,
      alive: b.alive,
      segments: b.segments.slice(0, 80),
      length: b.segments.length,
    })),
  };
  io.emit('gameState', state);

}, TICK_RATE);

// Broadcast food state every 5 ticks to keep in sync
let foodTick = 0;
setInterval(() => {
  foodTick++;
  if (foodTick % 5 === 0) {
    io.emit('foodState', foods);
  }
}, TICK_RATE);

// ---- SOCKET EVENTS ----
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join', ({ name, color, colorDark }) => {
    const x = 500 + Math.random() * (WORLD_W - 1000);
    const y = 500 + Math.random() * (WORLD_H - 1000);
    const player = makeSnake(x, y, 20, color || '#00ff88', colorDark || '#006633', name || 'Spieler', socket.id);
    players[socket.id] = player;

    // Send initial state to new player
    socket.emit('init', {
      myId: socket.id,
      foods,
      worldW: WORLD_W,
      worldH: WORLD_H,
    });
    console.log(`${name} joined. Players: ${Object.keys(players).length}`);
  });

  socket.on('input', ({ targetAngle, boosting }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.targetAngle = targetAngle;
    p.boosting = boosting && p.boostEnergy > 0;
  });

  socket.on('respawn', ({ name, color, colorDark }) => {
    const x = 500 + Math.random() * (WORLD_W - 1000);
    const y = 500 + Math.random() * (WORLD_H - 1000);
    players[socket.id] = makeSnake(x, y, 20, color, colorDark, name, socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    if (players[socket.id]) {
      killSnake(players[socket.id]);
      delete players[socket.id];
    }
  });
});

app.get('/', (req, res) => res.send('Slither Server läuft ✅'));

server.listen(PORT, () => console.log(`Slither server on port ${PORT}`));
