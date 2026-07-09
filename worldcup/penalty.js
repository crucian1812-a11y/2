// ============================================================
// ЧМ-2026 · серия пенальти на canvas.
//
// Механика: серия до 5 ударов с каждой стороны (+ до первой ошибки).
// Вы бьёте: мышь/палец — прицел, зажать — набор силы, отпустить — удар.
//   Чем сильнее удар, тем труднее вратарю, но выше разброс.
// Вы в воротах: соперник бьёт, нужно успеть выбрать зону прыжка.
// ============================================================

import { TEAMS, SQUADS } from './data.js';

const QF_TEAMS = ['FRA', 'MAR', 'ESP', 'BEL', 'NOR', 'ENG', 'ARG', 'SUI'];
const $ = (s) => document.querySelector(s);

// Геометрия сцены (в координатах canvas 900×620)
const W = 900, H = 620;
const GOAL = { x: 190, y: 150, w: 520, h: 190 };     // рамка ворот
const BALL_START = { x: W / 2, y: 545 };
const KEEPER_BASE = { x: W / 2, y: GOAL.y + GOAL.h - 12 };

let ctx, canvas;

const game = {
  phase: 'idle',        // idle | aim | charge | shoot | defend | done
  you: null, cpu: null, // коды команд
  yourKicks: [], cpuKicks: [], // true=гол, false=промах/сейв
  round: 0,
  shooting: true,       // true: бьёте вы
  aim: { x: W / 2, y: GOAL.y + GOAL.h / 2 },
  power: 0, charging: false, chargeDir: 1,
  ball: { x: BALL_START.x, y: BALL_START.y, scale: 1, t: 0 },
  flight: null,         // параметры полёта мяча
  keeper: { pose: 'idle', dir: 0, t: 0, targetZone: null },
  defendZone: null, defendTimer: null,
  over: false,
  raf: null,
};

// ---------- Инициализация ----------

export function initPenalty() {
  canvas = $('#pen-canvas');
  ctx = canvas.getContext('2d');

  const grid = $('#pen-teams');
  QF_TEAMS.forEach((code) => {
    const btn = document.createElement('button');
    btn.className = 'team-btn';
    btn.innerHTML = `<span class="flag">${TEAMS[code].flag}</span>${TEAMS[code].name}`;
    btn.addEventListener('click', () => startShootout(code));
    grid.appendChild(btn);
  });

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  $('#pen-restart').addEventListener('click', () => {
    $('#pen-game').hidden = true;
    $('#pen-setup').hidden = false;
    cancelAnimationFrame(game.raf);
  });
}

function startShootout(code) {
  game.you = code;
  const others = QF_TEAMS.filter((c) => c !== code);
  game.cpu = others[Math.floor(Math.random() * others.length)];
  game.yourKicks = [];
  game.cpuKicks = [];
  game.round = 0;
  game.shooting = true;
  game.over = false;
  $('#pen-setup').hidden = true;
  $('#pen-game').hidden = false;
  $('#pen-restart').hidden = true;
  $('#pen-hud-you').textContent = `${TEAMS[game.you].flag} ${TEAMS[game.you].name}`;
  $('#pen-hud-cpu').textContent = `${TEAMS[game.cpu].name} ${TEAMS[game.cpu].flag}`;
  updateHud();
  beginKick();
  cancelAnimationFrame(game.raf);
  loop();
}

// ---------- Ход серии ----------

function kicksToWin() {
  // Досрочная развязка невозможна? Проверяем математику серии из 5
  const y = game.yourKicks, c = game.cpuKicks;
  const yg = y.filter(Boolean).length, cg = c.filter(Boolean).length;
  const yLeft = Math.max(0, 5 - y.length), cLeft = Math.max(0, 5 - c.length);
  if (y.length <= 5 || c.length <= 5) {
    if (yg > cg + cLeft) return 'you';
    if (cg > yg + yLeft) return 'cpu';
  }
  // После 5 ударов — до первой разницы при равном числе ударов
  if (y.length >= 5 && c.length >= 5 && y.length === c.length && yg !== cg) {
    return yg > cg ? 'you' : 'cpu';
  }
  return null;
}

function beginKick() {
  game.ball = { x: BALL_START.x, y: BALL_START.y, scale: 1, t: 0 };
  game.keeper = { pose: 'idle', dir: 0, t: 0, targetZone: null };
  game.flight = null;
  game.power = 0;
  game.charging = false;
  game.defendZone = null;

  if (game.shooting) {
    game.phase = 'aim';
    setHint('🎯 Веди прицел мышью, зажми — сила, отпусти — удар!');
  } else {
    game.phase = 'defend';
    setHint('🧤 Ты в воротах! Кликни зону, куда прыгнуть — соперник уже разбегается…');
    // ИИ выбирает цель заранее; у игрока ~1.6 секунды на решение
    const zx = Math.floor(Math.random() * 3), zy = Math.floor(Math.random() * 2);
    game.keeper.targetZone = { zx, zy };
    clearTimeout(game.defendTimer);
    game.defendTimer = setTimeout(() => cpuShoot(), 1600);
  }
}

function setHint(text) { $('#pen-hint').textContent = text; }

function updateHud() {
  const yg = game.yourKicks.filter(Boolean).length;
  const cg = game.cpuKicks.filter(Boolean).length;
  $('#pen-hud-score').textContent = `${yg} : ${cg}`;
  renderDots($('#pen-dots-you'), game.yourKicks);
  renderDots($('#pen-dots-cpu'), game.cpuKicks);
}

function renderDots(el, kicks) {
  el.innerHTML = '';
  const total = Math.max(5, kicks.length);
  for (let i = 0; i < total; i += 1) {
    const d = document.createElement('span');
    d.className = 'pen-dot';
    if (i < kicks.length) d.classList.add(kicks[i] ? 'goal' : 'miss');
    el.appendChild(d);
  }
}

function flash(text, color = '#fff') {
  const el = $('#pen-msg');
  el.hidden = false;
  el.style.color = color;
  el.textContent = text;
  setTimeout(() => { el.hidden = true; }, 1100);
}

// ---------- Ввод ----------

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width * W,
    y: (e.clientY - r.top) / r.height * H,
  };
}

function onMove(e) {
  if (game.phase !== 'aim' && game.phase !== 'charge') return;
  const p = canvasPos(e);
  // Прицел можно увести чуть за рамку — тогда рискуешь промазать
  game.aim.x = Math.max(GOAL.x - 60, Math.min(GOAL.x + GOAL.w + 60, p.x));
  game.aim.y = Math.max(GOAL.y - 45, Math.min(GOAL.y + GOAL.h + 25, p.y));
}

function onDown(e) {
  if (game.phase === 'aim') {
    onMove(e);
    game.phase = 'charge';
    game.charging = true;
    game.power = 0;
    game.chargeDir = 1;
  } else if (game.phase === 'defend' && !game.flight) {
    const p = canvasPos(e);
    const zx = Math.max(0, Math.min(2, Math.floor((p.x - GOAL.x) / (GOAL.w / 3))));
    const zy = Math.max(0, Math.min(1, Math.floor((p.y - GOAL.y) / (GOAL.h / 2))));
    game.defendZone = { zx, zy };
    setHint('Прыжок выбран!');
  }
}

function onUp() {
  if (game.phase !== 'charge') return;
  game.charging = false;
  playerShoot();
}

// ---------- Удар игрока ----------

function playerShoot() {
  game.phase = 'shoot';
  const power = game.power; // 0..1

  // Разброс: растёт с силой и у самых углов
  const edge = Math.min(
    Math.abs(game.aim.x - GOAL.x), Math.abs(game.aim.x - (GOAL.x + GOAL.w)),
  ) / GOAL.w;
  const err = 14 + power * 34 + (edge < 0.12 ? 16 : 0);
  const tx = game.aim.x + (Math.random() * 2 - 1) * err;
  const ty = game.aim.y + (Math.random() * 2 - 1) * err * 0.8;

  // Вратарь: читает удар с вероятностью, зависящей от силы
  const readChance = 0.62 - power * 0.3;
  const shotZone = zoneOf(tx, ty);
  let dive;
  if (Math.random() < readChance && shotZone) {
    dive = shotZone; // угадал направление
  } else {
    dive = { zx: Math.floor(Math.random() * 3), zy: Math.random() < 0.65 ? 1 : 0 };
  }
  launchBall(tx, ty, power, dive, true);
}

// ---------- Удар соперника ----------

function cpuShoot() {
  if (game.phase !== 'defend' || game.flight) return;
  const z = game.keeper.targetZone;
  const cx = GOAL.x + (z.zx + 0.5) * (GOAL.w / 3) + (Math.random() * 2 - 1) * 40;
  const cy = GOAL.y + (z.zy + 0.5) * (GOAL.h / 2) + (Math.random() * 2 - 1) * 28;
  const power = 0.55 + Math.random() * 0.4;
  // 8% — соперник бьёт мимо сам
  const missShot = Math.random() < 0.08;
  const tx = missShot ? (Math.random() < 0.5 ? GOAL.x - 45 : GOAL.x + GOAL.w + 45) : cx;
  const dive = game.defendZone; // куда прыгнули вы (может быть null — остались в центре)
  launchBall(tx, cy, power, dive, false);
}

// ---------- Полёт мяча и исход ----------

function zoneOf(x, y) {
  if (x < GOAL.x || x > GOAL.x + GOAL.w || y < GOAL.y || y > GOAL.y + GOAL.h) return null;
  return {
    zx: Math.min(2, Math.floor((x - GOAL.x) / (GOAL.w / 3))),
    zy: Math.min(1, Math.floor((y - GOAL.y) / (GOAL.h / 2))),
  };
}

function launchBall(tx, ty, power, dive, youShooting) {
  const duration = 34 - power * 12; // кадров полёта
  game.flight = {
    fromX: BALL_START.x, fromY: BALL_START.y,
    tx, ty, t: 0, duration, dive, youShooting, resolved: false,
  };
  // Вратарь прыгает чуть позже удара
  setTimeout(() => {
    if (!dive) { game.keeper.pose = 'stay'; return; }
    game.keeper.pose = 'dive';
    game.keeper.dir = dive.zx - 1;           // -1 влево, 0 центр, 1 вправо
    game.keeper.zy = dive.zy;
    game.keeper.t = 0;
  }, youShooting ? 90 : 60);
}

function resolveKick(fl) {
  const zone = zoneOf(fl.tx, fl.ty);
  let goal;
  if (!zone) {
    goal = false; // мимо ворот
    flash('МИМО!', '#ff6b5e');
  } else {
    const dive = fl.dive;
    let saveChance = 0;
    if (dive) {
      const dx = Math.abs(dive.zx - zone.zx);
      const dy = Math.abs(dive.zy - zone.zy);
      if (dx === 0 && dy === 0) saveChance = 0.78;       // прыжок точно в зону
      else if (dx === 0) saveChance = 0.38;              // та же вертикаль
      else if (dx === 1 && dy === 0) saveChance = 0.1;   // соседняя зона
    } else if (zone.zx === 1) {
      saveChance = 0.5; // вратарь остался в центре, удар в центр
    }
    // Сильный удар тяжелее тащить
    saveChance *= fl.youShooting ? (1 - game.power * 0.25) : 0.95;
    goal = Math.random() > saveChance;
    if (goal) flash('ГОЛ!', '#3ddc7a');
    else flash('СЕЙВ!', '#ffc94d');
  }

  if (fl.youShooting) game.yourKicks.push(goal);
  else game.cpuKicks.push(goal);
  updateHud();

  const winner = kicksToWin();
  if (winner) return endShootout(winner);

  // Следующий удар
  game.shooting = !game.shooting;
  setTimeout(beginKick, 1300);
}

function endShootout(winner) {
  game.phase = 'done';
  game.over = true;
  const you = winner === 'you';
  setHint(you ? `🏆 ${TEAMS[game.you].name} побеждает в серии!` : `😢 ${TEAMS[game.cpu].name} оказался точнее…`);
  flash(you ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ', you ? '#3ddc7a' : '#ff6b5e');
  if (you) confetti();
  $('#pen-restart').hidden = false;
}

export function confetti(n = 120) {
  const colors = ['#3ddc7a', '#ffc94d', '#6ab7ff', '#ff6b5e', '#ffffff'];
  for (let i = 0; i < n; i += 1) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.width = 6 + Math.random() * 6 + 'px';
    c.style.height = 8 + Math.random() * 8 + 'px';
    c.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.style.animationDuration = 2.4 + Math.random() * 2.4 + 's';
    c.style.animationDelay = Math.random() * 0.8 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 6200);
  }
}

// ---------- Отрисовка ----------

function loop() {
  update();
  draw();
  game.raf = requestAnimationFrame(loop);
}

function update() {
  if (game.charging) {
    game.power += 0.025 * game.chargeDir;
    if (game.power >= 1) { game.power = 1; game.chargeDir = -1; }
    if (game.power <= 0) { game.power = 0; game.chargeDir = 1; }
  }
  if (game.keeper.pose === 'dive') game.keeper.t = Math.min(1, game.keeper.t + 0.09);

  const fl = game.flight;
  if (fl && !fl.resolved) {
    fl.t += 1;
    const k = Math.min(1, fl.t / fl.duration);
    const e = 1 - Math.pow(1 - k, 2); // ease-out
    game.ball.x = fl.fromX + (fl.tx - fl.fromX) * e;
    // Дуга: подъём и падение к цели
    const arc = Math.sin(k * Math.PI) * 60;
    game.ball.y = fl.fromY + (fl.ty - fl.fromY) * e - arc;
    game.ball.scale = 1 - 0.62 * e;
    if (k >= 1) {
      fl.resolved = true;
      resolveKick(fl);
    }
  }
}

function draw() {
  // Небо и трибуны
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0d1730');
  sky.addColorStop(0.45, '#14224a');
  sky.addColorStop(0.46, '#22304f');
  sky.addColorStop(1, '#1a4a2e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  drawCrowd();
  drawPitch();
  drawGoal();
  drawKeeper();
  if ((game.phase === 'aim' || game.phase === 'charge') && game.shooting) drawAim();
  if (game.phase === 'defend' && !game.flight) drawDefendGrid();
  drawBall();
  if (game.phase === 'charge') drawPowerBar();
}

let crowdSeed = null;
function drawCrowd() {
  // Трибуны: детерминированные «зрители», генерируем один раз
  if (!crowdSeed) {
    crowdSeed = [];
    for (let i = 0; i < 900; i += 1) {
      crowdSeed.push({
        x: Math.random() * W,
        y: 18 + Math.random() * 240,
        c: ['#4a5a80', '#6a4a55', '#4a6a5c', '#7a6a4a', '#5a5a6a'][Math.floor(Math.random() * 5)],
      });
    }
  }
  ctx.fillStyle = '#182647';
  ctx.fillRect(0, 0, W, 268);
  for (const p of crowdSeed) {
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x, p.y, 3, 3);
  }
  // Прожекторы
  ctx.fillStyle = 'rgba(255,255,220,0.05)';
  ctx.beginPath();
  ctx.moveTo(80, 0); ctx.lineTo(340, 268); ctx.lineTo(560, 268); ctx.lineTo(240, 0);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W - 80, 0); ctx.lineTo(W - 340, 268); ctx.lineTo(W - 560, 268); ctx.lineTo(W - 240, 0);
  ctx.fill();
}

function drawPitch() {
  // Газон с полосами (перспектива)
  for (let i = 0; i < 8; i += 1) {
    const y1 = 268 + i * 44;
    ctx.fillStyle = i % 2 ? '#1e7a42' : '#22894b';
    ctx.fillRect(0, y1, W, 44 + 4);
  }
  // Линия штрафной и точка
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(60, 470); ctx.lineTo(W - 60, 470);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(BALL_START.x, BALL_START.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

function drawGoal() {
  const { x, y, w, h } = GOAL;
  // Сетка
  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i += 1) {
    const gx = x + (w / 16) * i;
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + (i - 8) * 1.4, y + h); ctx.stroke();
  }
  for (let i = 0; i <= 7; i += 1) {
    const gy = y + (h / 7) * i;
    ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy + 3); ctx.stroke();
  }
  // Штанги и перекладина
  ctx.strokeStyle = '#f4f7ff';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawKeeper() {
  const k = game.keeper;
  let kx = KEEPER_BASE.x, ky = KEEPER_BASE.y, rot = 0;
  if (k.pose === 'dive') {
    const reach = k.t * (GOAL.w / 2 - 40);
    kx += k.dir * reach;
    ky -= k.t * (k.zy === 0 ? 95 : 25);
    rot = k.dir * k.t * 1.15;
  } else {
    // Лёгкое покачивание на месте
    kx += Math.sin(Date.now() / 300) * 6;
  }
  ctx.save();
  ctx.translate(kx, ky);
  ctx.rotate(rot);
  // Тело
  ctx.fillStyle = '#ffc94d';
  ctx.fillRect(-13, -58, 26, 44);
  // Голова
  ctx.beginPath();
  ctx.arc(0, -70, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#e8b98a';
  ctx.fill();
  // Руки: раскинуты при прыжке
  ctx.strokeStyle = '#ffc94d';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (k.pose === 'dive') {
    ctx.moveTo(0, -48); ctx.lineTo(k.dir * 42, -86);
    ctx.moveTo(0, -44); ctx.lineTo(k.dir * 48, -60);
  } else {
    ctx.moveTo(-12, -50); ctx.lineTo(-30, -24);
    ctx.moveTo(12, -50); ctx.lineTo(30, -24);
  }
  ctx.stroke();
  // Ноги
  ctx.strokeStyle = '#20304f';
  ctx.beginPath();
  ctx.moveTo(-7, -14); ctx.lineTo(-10, 12);
  ctx.moveTo(7, -14); ctx.lineTo(10, 12);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.restore();
}

function drawBall() {
  const b = game.ball;
  const r = 15 * b.scale;
  // Тень
  ctx.beginPath();
  ctx.ellipse(b.x, b.y + r * 0.9, r * 1.1, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.fill();
  // Мяч
  const grad = ctx.createRadialGradient(b.x - r / 3, b.y - r / 3, r / 4, b.x, b.y, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#c9d2e0');
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  // Пятиугольники
  ctx.fillStyle = '#22304f';
  const spin = game.flight ? game.flight.t * 0.5 : 0;
  for (let i = 0; i < 3; i += 1) {
    const a = spin + (i / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(b.x + Math.cos(a) * r * 0.55, b.y + Math.sin(a) * r * 0.55, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAim() {
  const { x, y } = game.aim;
  ctx.strokeStyle = '#3ddc7a';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 24, y); ctx.lineTo(x - 8, y);
  ctx.moveTo(x + 8, y); ctx.lineTo(x + 24, y);
  ctx.moveTo(x, y - 24); ctx.lineTo(x, y - 8);
  ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 24);
  ctx.stroke();
}

function drawDefendGrid() {
  // 6 зон для выбора прыжка
  ctx.save();
  for (let zx = 0; zx < 3; zx += 1) {
    for (let zy = 0; zy < 2; zy += 1) {
      const gx = GOAL.x + zx * (GOAL.w / 3);
      const gy = GOAL.y + zy * (GOAL.h / 2);
      const picked = game.defendZone && game.defendZone.zx === zx && game.defendZone.zy === zy;
      ctx.fillStyle = picked ? 'rgba(61,220,122,.35)' : 'rgba(255,255,255,.07)';
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.fillRect(gx + 3, gy + 3, GOAL.w / 3 - 6, GOAL.h / 2 - 6);
      ctx.strokeRect(gx + 3, gy + 3, GOAL.w / 3 - 6, GOAL.h / 2 - 6);
    }
  }
  ctx.restore();
}

function drawPowerBar() {
  const bw = 320, bh = 20;
  const bx = W / 2 - bw / 2, by = H - 40;
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fillRect(bx - 4, by - 4, bw + 8, bh + 8);
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  g.addColorStop(0, '#3ddc7a');
  g.addColorStop(0.7, '#ffc94d');
  g.addColorStop(1, '#ff6b5e');
  ctx.fillStyle = g;
  ctx.fillRect(bx, by, bw * game.power, bh);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px Manrope';
  ctx.textAlign = 'center';
  ctx.fillText('СИЛА УДАРА', W / 2, by - 10);
}
