// ============================================================
// ЧМ-2026 · футбольный менеджер.
//
// Механика:
//  · Берёшь сборную из 1/4 финала и ведёшь её до финала по реальной
//    сетке (соперники по другим парам определяются симуляцией).
//  · Схема (5 вариантов) + тактика: настрой, прессинг, стиль.
//  · Сила команды считается по линиям (защита/середина/атака) из
//    рейтингов игроков; игрок не на своей позиции теряет 6 пунктов.
//  · Матч идёт минута за минутой: шансы на атаку зависят от контроля
//    середины, настроя и прессинга; исход атаки — от атаки против
//    обороны соперника. Усталость снижает рейтинг, высокий прессинг
//    ускоряет её вдвое. Карточки и травмы — как в жизни.
//  · Пауза в любой момент: смена тактики и до 5 замен.
//  · Ничья в основное время → овертайм → серия пенальти.
//  · ИИ-соперник сам меняет тактику по счёту и делает замены.
// ============================================================

import { TEAMS, SQUADS, DEFAULT_XI, BRACKET } from './data.js';
import { confetti } from './penalty.js';

const $ = (s) => document.querySelector(s);
const QF_PAIRS = [['FRA', 'MAR'], ['ESP', 'BEL'], ['NOR', 'ENG'], ['ARG', 'SUI']];
const STAGES = ['1/4 финала', 'Полуфинал', 'Финал'];

const FORMATIONS = {
  '4-3-3':   { DF: 4, MF: 3, FW: 3 },
  '4-4-2':   { DF: 4, MF: 4, FW: 2 },
  '4-2-3-1': { DF: 4, MF: 5, FW: 1 },
  '3-5-2':   { DF: 3, MF: 5, FW: 2 },
  '5-3-2':   { DF: 5, MF: 3, FW: 2 },
};

const OFF_POS_PENALTY = 6;

// ---------- Состояние ----------

const M = {
  teamCode: null,
  stageIdx: 0,
  opponents: [],       // соперники по стадиям (определяются по ходу)
  formation: '4-3-3',
  tactics: { mentality: 'bal', pressing: 'mid', style: 'pass' },
  squad: [],           // [{...player, stamina, yellow, red, injured, on}]
  xi: [],              // индексы игроков в M.squad
  match: null,
  history: [],         // результаты сыгранных стадий
};

// ---------- Утилиты ----------

const rnd = Math.random;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

function effRating(p, slotPos) {
  let r = p.r;
  if (slotPos && p.pos !== slotPos) r -= OFF_POS_PENALTY;
  return r * (0.72 + 0.28 * (p.stamina ?? 100) / 100);
}

function freshSquad(code) {
  return SQUADS[code].map((p) => ({ ...p, stamina: 100, yellow: 0, red: false, injured: false }));
}

// Слоты схемы: [{pos}] — вратарь всегда первый
function slots(formation) {
  const f = FORMATIONS[formation];
  return [{ pos: 'GK' },
    ...Array.from({ length: f.DF }, () => ({ pos: 'DF' })),
    ...Array.from({ length: f.MF }, () => ({ pos: 'MF' })),
    ...Array.from({ length: f.FW }, () => ({ pos: 'FW' }))];
}

// Автосостав: реальный стартовый XI, докомплектованный лучшими по позиции
function autoXI(squad, formation, code) {
  const want = slots(formation);
  const used = new Set();
  const xi = [];
  const preferred = (DEFAULT_XI[code] || [])
    .map((name) => squad.findIndex((p) => p.n === name))
    .filter((i) => i >= 0);

  for (const slot of want) {
    // сперва из реального старта, потом лучший доступный на позицию
    let idx = preferred.find((i) => !used.has(i) && squad[i].pos === slot.pos && !squad[i].injured && !squad[i].red);
    if (idx === undefined) {
      let best = -1, bestR = -1;
      squad.forEach((p, i) => {
        if (used.has(i) || p.injured || p.red) return;
        const r = p.r - (p.pos === slot.pos ? 0 : (p.pos === 'GK' || slot.pos === 'GK') ? 99 : OFF_POS_PENALTY);
        if (r > bestR) { bestR = r; best = i; }
      });
      idx = best;
    }
    used.add(idx);
    xi.push(idx);
  }
  return xi;
}

// Сила линий: защита / середина / атака
function lineStrength(squad, xi, formation, tactics) {
  const sl = slots(formation);
  const byLine = { GK: [], DF: [], MF: [], FW: [] };
  xi.forEach((pi, i) => byLine[sl[i].pos].push(effRating(squad[pi], sl[i].pos)));
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 55);
  const gk = avg(byLine.GK), df = avg(byLine.DF), mf = avg(byLine.MF), fw = avg(byLine.FW);

  let def = df * 0.5 + gk * 0.32 + mf * 0.18;
  let mid = mf * 0.72 + df * 0.14 + fw * 0.14;
  let att = fw * 0.55 + mf * 0.35 + df * 0.1;

  // Численность линий тоже влияет: 5 защитников оборонятся лучше и т.п.
  const f = FORMATIONS[formation];
  def += (f.DF - 4) * 1.6;
  att += (f.FW - 2) * 1.8;
  mid += (f.MF - 4) * 1.2;

  if (tactics.mentality === 'atk') { att += 4; def -= 4; }
  if (tactics.mentality === 'def') { att -= 4; def += 4; }
  if (tactics.pressing === 'high') { mid += 3; }
  if (tactics.pressing === 'low') { mid -= 2; def += 2; }

  return { def, mid, att };
}

// ---------- Инициализация UI ----------

export function initManager() {
  const grid = $('#mgr-teams');
  Object.keys(SQUADS).forEach((code) => {
    const power = Math.round(SQUADS[code].reduce((s, p) => s + p.r, 0) / SQUADS[code].length);
    const btn = document.createElement('button');
    btn.className = 'team-btn';
    btn.innerHTML = `<span class="flag">${TEAMS[code].flag}</span>${TEAMS[code].name}
      <span class="pow">средний рейтинг ${power}</span>`;
    btn.addEventListener('click', () => pickTeam(code));
    grid.appendChild(btn);
  });

  const fRow = $('#mgr-formations');
  Object.keys(FORMATIONS).forEach((f) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (f === M.formation ? ' active' : '');
    chip.textContent = f;
    chip.addEventListener('click', () => {
      M.formation = f;
      fRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.textContent === f));
      M.xi = autoXI(M.squad, f, M.teamCode);
      renderPrep();
    });
    fRow.appendChild(chip);
  });

  ['mentality', 'pressing', 'style'].forEach((key) => {
    $(`#mgr-${key === 'mentality' ? 'mentality' : key}`).addEventListener('change', (e) => {
      M.tactics[key] = e.target.value;
      renderStrength();
    });
  });

  $('#mgr-kickoff').addEventListener('click', startMatch);
  $('#mgr-pause').addEventListener('click', togglePause);
  $('#mgr-speed').addEventListener('click', cycleSpeed);
  $('#mgr-tactics-btn').addEventListener('click', () => openPausePanel('tactics'));
  $('#mgr-subs-btn').addEventListener('click', () => openPausePanel('subs'));
}

// ---------- Подготовка к матчу ----------

function pickTeam(code) {
  M.teamCode = code;
  M.stageIdx = 0;
  M.history = [];
  M.squad = freshSquad(code);
  M.xi = autoXI(M.squad, M.formation, code);
  // Реальный соперник по сетке 1/4
  const pair = QF_PAIRS.find((p) => p.includes(code));
  M.opponents = [pair[0] === code ? pair[1] : pair[0]];
  showPrep();
}

function showPrep() {
  $('#mgr-pick').hidden = true;
  $('#mgr-match').hidden = true;
  $('#mgr-result').hidden = true;
  $('#mgr-prep').hidden = false;
  const opp = M.opponents[M.stageIdx];
  $('#mgr-matchup').innerHTML = `
    <span class="stage">${STAGES[M.stageIdx]}</span>
    ${TEAMS[M.teamCode].flag} ${TEAMS[M.teamCode].name} — ${TEAMS[opp].name} ${TEAMS[opp].flag}`;
  renderPrep();
}

function renderPrep() {
  renderXI();
  renderStrength();
}

function renderXI() {
  const box = $('#mgr-xi');
  box.innerHTML = '';
  const sl = slots(M.formation);
  M.xi.forEach((pi, slotIdx) => {
    const p = M.squad[pi];
    const row = document.createElement('div');
    row.className = 'xi-row';
    if (p.pos !== sl[slotIdx].pos) row.classList.add('off-pos');
    row.innerHTML = `
      <span class="pos ${sl[slotIdx].pos}">${sl[slotIdx].pos}</span>
      <span>${p.n}${p.pos !== sl[slotIdx].pos ? ` <small>(${p.pos})</small>` : ''}</span>
      <span class="rating">${Math.round(effRating(p, sl[slotIdx].pos))}</span>
      <span class="stamina"></span>`;
    row.addEventListener('click', () => swapPicker(slotIdx));
    box.appendChild(row);
  });
}

// Выбор игрока на слот из тех, кто вне старта
function swapPicker(slotIdx) {
  const sl = slots(M.formation)[slotIdx];
  const benchIdx = M.squad
    .map((_, i) => i)
    .filter((i) => !M.xi.includes(i) && !M.squad[i].injured);
  const options = benchIdx
    .filter((i) => sl.pos === 'GK' ? M.squad[i].pos === 'GK' : M.squad[i].pos !== 'GK')
    .map((i) => `${i}::${M.squad[i].n} (${M.squad[i].pos}, ${M.squad[i].r})`);
  const cur = M.squad[M.xi[slotIdx]];
  const answer = prompt(
    `Кем заменить в старте: ${cur.n}?\n\n` +
    options.map((o, n) => `${n + 1}. ${o.split('::')[1]}`).join('\n') +
    '\n\nВведи номер (или пусто — отмена):');
  const num = parseInt(answer, 10);
  if (!num || num < 1 || num > options.length) return;
  M.xi[slotIdx] = parseInt(options[num - 1].split('::')[0], 10);
  renderPrep();
}

function renderStrength() {
  const s = lineStrength(M.squad, M.xi, M.formation, M.tactics);
  const bar = (label, v) => `
    <div class="strength-bar">
      <span>${label}</span>
      <div class="track"><div class="fill" style="width:${Math.min(100, (v - 60) / 35 * 100)}%"></div></div>
      <b>${Math.round(v)}</b>
    </div>`;
  $('#mgr-strength').innerHTML = bar('Атака', s.att) + bar('Середина', s.mid) + bar('Оборона', s.def);
}

// ---------- ИИ-соперник ----------

function makeAI(code) {
  const squad = freshSquad(code);
  const formation = pick(['4-3-3', '4-2-3-1', '4-4-2']);
  return {
    code, squad, formation,
    xi: autoXI(squad, formation, code),
    tactics: { mentality: 'bal', pressing: 'mid', style: pick(['pass', 'counter', 'wings']) },
    subsLeft: 5,
  };
}

// ИИ реагирует на счёт и усталость
function aiThink(ai, minute, diff) {
  if (minute > 60 && diff < 0) ai.tactics.mentality = 'atk';
  if (minute > 70 && diff > 0) ai.tactics.mentality = 'def';
  if (minute >= 60 && ai.subsLeft > 0 && (minute === 60 || minute === 72 || minute === 84)) {
    // Меняем самого уставшего полевого
    const sl = slots(ai.formation);
    let worst = -1, worstSt = 101;
    ai.xi.forEach((pi, i) => {
      if (sl[i].pos === 'GK') return;
      if (ai.squad[pi].stamina < worstSt) { worstSt = ai.squad[pi].stamina; worst = i; }
    });
    if (worst >= 0 && worstSt < 60) {
      const pos = sl[worst].pos;
      const benchBest = ai.squad
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => !ai.xi.includes(i) && !p.injured && !p.red && p.pos === pos)
        .sort((a, b) => b.p.r - a.p.r)[0];
      if (benchBest) {
        ai.xi[worst] = benchBest.i;
        ai.subsLeft -= 1;
        feed(M.match.minute, `Замена у соперника: выходит ${benchBest.p.n}.`, '');
      }
    }
  }
}

// ---------- Матч ----------

function startMatch() {
  const oppCode = M.opponents[M.stageIdx];
  M.match = {
    minute: 0,
    half: 1,
    maxMin: 90,
    extra: false,
    score: [0, 0],
    running: true,
    speed: 1,
    subsLeft: 5,
    timer: null,
    ai: makeAI(oppCode),
    finished: false,
  };
  $('#mgr-prep').hidden = true;
  $('#mgr-match').hidden = false;
  $('#mgr-feed').innerHTML = '';
  $('#sb-home').textContent = `${TEAMS[M.teamCode].flag} ${TEAMS[M.teamCode].name}`;
  $('#sb-away').textContent = `${TEAMS[oppCode].name} ${TEAMS[oppCode].flag}`;
  $('#mgr-subs-left').textContent = M.match.subsLeft;
  $('#mgr-pausepanel').hidden = true;
  feed(0, `${STAGES[M.stageIdx]}. Стадион гудит — поехали!`, '');
  updateScoreboard();
  renderLiveLineup();
  setPaused(false);
}

function setPaused(paused) {
  const m = M.match;
  m.running = !paused;
  $('#mgr-pause').textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  $('#mgr-tactics-btn').disabled = !paused;
  $('#mgr-subs-btn').disabled = !paused;
  if (!paused) {
    $('#mgr-pausepanel').hidden = true;
    clearInterval(m.timer);
    m.timer = setInterval(tick, 420 / m.speed);
  } else {
    clearInterval(m.timer);
  }
}

function togglePause() {
  if (M.match.finished) return;
  setPaused(M.match.running);
}

function cycleSpeed() {
  const m = M.match;
  m.speed = m.speed === 1 ? 2 : m.speed === 2 ? 4 : 1;
  $('#mgr-speed').textContent = `Скорость ×${m.speed}`;
  if (m.running) { clearInterval(m.timer); m.timer = setInterval(tick, 420 / m.speed); }
}

function updateScoreboard() {
  $('#sb-score').textContent = `${M.match.score[0]} : ${M.match.score[1]}`;
  $('#sb-min').textContent = `${M.match.minute}′${M.match.extra ? ' (доп.)' : ''}`;
}

function feed(minute, text, cls) {
  const el = document.createElement('div');
  el.className = `feed-item ${cls}`;
  el.innerHTML = `<span class="min">${minute}′</span><span>${text}</span>`;
  $('#mgr-feed').prepend(el);
}

// Живой список состава с усталостью
function renderLiveLineup() {
  const box = $('#mgr-lineup-you');
  const sl = slots(M.formation);
  box.innerHTML = `<h5>${TEAMS[M.teamCode].name} · ${M.formation}</h5>`;
  M.xi.forEach((pi, i) => {
    const p = M.squad[pi];
    const row = document.createElement('div');
    row.className = 'xi-row';
    if (p.stamina < 55) row.classList.add('tired');
    row.style.cursor = 'default';
    row.innerHTML = `
      <span class="pos ${sl[i].pos}">${sl[i].pos}</span>
      <span>${p.n}${p.yellow ? ' 🟨' : ''}${p.red ? ' 🟥' : ''}</span>
      <span class="rating">${Math.round(effRating(p, sl[i].pos))}</span>
      <span class="stamina">${Math.round(p.stamina)}%</span>`;
    box.appendChild(row);
  });
}

// ---------- Минута матча ----------

function tick() {
  const m = M.match;
  m.minute += 1;

  // Усталость
  const drain = (squad, xi, pressing) => {
    const k = pressing === 'high' ? 1.7 : pressing === 'low' ? 0.8 : 1.1;
    xi.forEach((pi) => { squad[pi].stamina = Math.max(20, squad[pi].stamina - 0.5 * k * (0.8 + rnd() * 0.4)); });
  };
  drain(M.squad, M.xi, M.tactics.pressing);
  drain(m.ai.squad, m.ai.xi, m.ai.tactics.pressing);

  // Силы на текущую минуту
  const you = lineStrength(M.squad, M.xi, M.formation, M.tactics);
  const ai = lineStrength(m.ai.squad, m.ai.xi, m.ai.formation, m.ai.tactics);

  // Вероятность атаки в эту минуту
  const midShare = you.mid / (you.mid + ai.mid);
  let pYou = 0.13 * (0.5 + midShare);
  let pAi = 0.13 * (1.5 - midShare);
  if (M.tactics.mentality === 'atk') pYou *= 1.25;
  if (M.tactics.mentality === 'def') pYou *= 0.75;
  if (m.ai.tactics.mentality === 'atk') pAi *= 1.25;
  if (m.ai.tactics.mentality === 'def') pAi *= 0.75;
  // Контратакующий стиль наказывает атакующего соперника
  if (M.tactics.style === 'counter' && m.ai.tactics.mentality === 'atk') pYou *= 1.3;
  if (m.ai.tactics.style === 'counter' && M.tactics.mentality === 'atk') pAi *= 1.3;

  if (rnd() < pYou) attack(true, you, ai);
  else if (rnd() < pAi) attack(false, ai, you);

  // Редкие события: травма у вас
  if (rnd() < 0.0016) injury();

  m.ai && aiThink(m.ai, m.minute, m.score[1] - m.score[0]);

  updateScoreboard();
  if (m.minute % 3 === 0) renderLiveLineup();

  // Перерыв и конец таймов
  if (m.minute === 45 && m.half === 1) {
    m.half = 2;
    feed(45, '⏸ Перерыв. Можно скорректировать тактику и сделать замены.', '');
    setPaused(true);
    return;
  }
  if (m.minute >= m.maxMin) endOfTime();
}

// Розыгрыш атаки
function attack(byYou, atkSide, defSide) {
  const m = M.match;
  const squad = byYou ? M.squad : m.ai.squad;
  const xi = byYou ? M.xi : m.ai.xi;
  const formation = byYou ? M.formation : m.ai.formation;
  const style = byYou ? M.tactics.style : m.ai.tactics.style;
  const teamName = byYou ? TEAMS[M.teamCode].name : TEAMS[m.ai.code].name;

  // Качество момента: атака против обороны
  const ratio = atkSide.att / defSide.def;
  let pGoal = 0.22 * Math.pow(ratio, 3);
  if (style === 'pass') pGoal *= 1.05;      // моменты качественнее
  if (style === 'wings') pGoal *= rnd() < 0.5 ? 1.25 : 0.85; // навесы — лотерея

  const sl = slots(formation);
  const attackers = xi.filter((pi, i) => sl[i].pos === 'FW' || (sl[i].pos === 'MF' && rnd() < 0.4));
  const hero = squad[pick(attackers.length ? attackers : xi.slice(1))];

  const roll = rnd();
  if (roll < pGoal) {
    m.score[byYou ? 0 : 1] += 1;
    feed(m.minute, `⚽ <b>ГОЛ! ${hero.n}</b> (${teamName}) отправляет мяч в сетку!`, byYou ? 'goal' : 'bad');
  } else if (roll < pGoal + 0.3) {
    feed(m.minute, `${hero.n} бьёт — ${pick(['вратарь тащит!', 'мимо цели.', 'штанга!', 'блок-шот защитника.'])}`, '');
  } else if (roll < pGoal + 0.42) {
    // Фол на атакующем → карточка защитнику
    const defSquad = byYou ? m.ai.squad : M.squad;
    const defXi = byYou ? m.ai.xi : M.xi;
    const defSl = slots(byYou ? m.ai.formation : M.formation);
    const defs = defXi.filter((pi, i) => defSl[i].pos !== 'GK');
    const sinner = defSquad[pick(defs)];
    if (rnd() < 0.3) {
      sinner.yellow += 1;
      if (sinner.yellow >= 2) {
        sinner.red = true;
        feed(m.minute, `🟥 Вторая жёлтая — <b>${sinner.n}</b> удалён!`, 'bad');
        removeSentOff(byYou ? false : true, sinner);
      } else {
        feed(m.minute, `🟨 ${sinner.n} получает жёлтую за фол на ${hero.n}.`, '');
      }
    }
  }
  // остальное — атака затухла, событие не пишем (не спамим ленту)
}

function removeSentOff(yours, player) {
  // Удалённый уходит; играем вдесятером (слот убираем)
  if (yours) {
    const idx = M.xi.findIndex((pi) => M.squad[pi] === player);
    if (idx >= 0) M.xi.splice(idx, 1);
    renderLiveLineup();
  } else {
    const ai = M.match.ai;
    const idx = ai.xi.findIndex((pi) => ai.squad[pi] === player);
    if (idx >= 0) ai.xi.splice(idx, 1);
  }
}

function injury() {
  const sl = slots(M.formation);
  const candidates = M.xi.map((pi, i) => i).filter((i) => sl[i].pos !== 'GK');
  const slotIdx = pick(candidates);
  const p = M.squad[M.xi[slotIdx]];
  if (p.injured) return;
  p.injured = true;
  feed(M.match.minute, `🚑 ${p.n} получил травму и не может продолжать! Нужна замена.`, 'bad');
  setPaused(true);
  openPausePanel('subs');
}

// ---------- Конец матча / овертайм / пенальти ----------

function endOfTime() {
  const m = M.match;
  if (m.score[0] !== m.score[1]) return finishMatch();
  if (!m.extra) {
    m.extra = true;
    m.maxMin = 120;
    feed(90, '⏱ Ничья! Впереди дополнительное время — 2×15 минут.', '');
    setPaused(true);
    return;
  }
  // Серия пенальти (автосимуляция с драматургией в ленте)
  clearInterval(m.timer);
  m.finished = true;
  feed(120, '🥅 Серия пенальти решит судьбу матча!', '');
  const you = lineStrength(M.squad, M.xi, M.formation, M.tactics);
  const ai = lineStrength(m.ai.squad, m.ai.xi, m.ai.formation, m.ai.tactics);
  let yG = 0, aG = 0;
  const lines = [];
  for (let i = 1; i <= 5; i += 1) {
    const ys = rnd() < 0.72 + (you.att - ai.def) * 0.004;
    const as = rnd() < 0.72 + (ai.att - you.def) * 0.004;
    if (ys) yG += 1;
    if (as) aG += 1;
    lines.push(`Удар ${i}: ${TEAMS[M.teamCode].name} ${ys ? '⚽' : '❌'} · ${TEAMS[m.ai.code].name} ${as ? '⚽' : '❌'}`);
  }
  while (yG === aG) {
    const ys = rnd() < 0.7, as = rnd() < 0.7;
    if (ys) yG += 1;
    if (as) aG += 1;
    lines.push(`Доп. удар: ${ys ? '⚽' : '❌'} · ${as ? '⚽' : '❌'}`);
  }
  lines.forEach((l, i) => setTimeout(() => feed(120, l, ''), i * 700));
  setTimeout(() => {
    m.penalty = [yG, aG];
    finishMatch();
  }, lines.length * 700 + 600);
}

function finishMatch() {
  const m = M.match;
  clearInterval(m.timer);
  m.finished = true;
  const pen = m.penalty;
  const won = pen ? pen[0] > pen[1] : m.score[0] > m.score[1];
  M.history.push({
    stage: STAGES[M.stageIdx],
    opp: m.ai.code,
    score: `${m.score[0]}:${m.score[1]}${pen ? ` (пен. ${pen[0]}:${pen[1]})` : ''}`,
    won,
  });
  showResult(won);
}

// Симуляция «чужих» матчей сетки: кто станет соперником дальше
function simOtherWinner() {
  // Полуфинал: победитель соседней пары 1/4; финал: победитель другой половины
  const idxOfPair = QF_PAIRS.findIndex((p) => p.includes(M.teamCode));
  let candidates;
  if (M.stageIdx === 1) {
    const buddy = idxOfPair % 2 === 0 ? idxOfPair + 1 : idxOfPair - 1;
    candidates = QF_PAIRS[buddy];
  } else {
    const otherHalf = idxOfPair < 2 ? [2, 3] : [0, 1];
    candidates = [pick(QF_PAIRS[otherHalf[0]]), pick(QF_PAIRS[otherHalf[1]])];
  }
  // Побеждает чуть чаще тот, у кого рейтинг выше
  const power = (c) => SQUADS[c].reduce((s, p) => s + p.r, 0);
  const [a, b] = candidates;
  return rnd() < power(a) / (power(a) + power(b)) ? a : b;
}

function showResult(won) {
  $('#mgr-match').hidden = true;
  const res = $('#mgr-result');
  res.hidden = false;
  const last = M.history[M.history.length - 1];
  const isFinal = M.stageIdx === 2;

  const historyHtml = M.history
    .map((h) => `<p>${h.stage}: ${TEAMS[M.teamCode].flag} ${h.score} ${TEAMS[h.opp].flag} ${TEAMS[h.opp].name} — ${h.won ? '✅' : '❌'}</p>`)
    .join('');

  if (won && isFinal) {
    confetti(220);
    res.innerHTML = `
      <h3 class="gold">🏆 ЧЕМПИОНЫ МИРА!</h3>
      <div class="big">${TEAMS[M.teamCode].flag}</div>
      <p>${TEAMS[M.teamCode].name} поднимает Кубок мира на «МетЛайф»! Вы — тренер-чемпион.</p>
      ${historyHtml}
      <button class="btn primary" id="mgr-again">Новая карьера</button>`;
  } else if (won) {
    res.innerHTML = `
      <h3>Победа! ${last.score}</h3>
      <div class="big">${TEAMS[M.teamCode].flag} ✅</div>
      <p>${TEAMS[M.teamCode].name} проходит дальше. Впереди — ${STAGES[M.stageIdx + 1].toLowerCase()}!</p>
      ${historyHtml}
      <button class="btn primary" id="mgr-next">К следующему матчу →</button>`;
  } else {
    res.innerHTML = `
      <h3>Поражение… ${last.score}</h3>
      <div class="big">😞</div>
      <p>${TEAMS[M.teamCode].name} покидает турнир на стадии «${STAGES[M.stageIdx].toLowerCase()}». Болельщики верили до конца.</p>
      ${historyHtml}
      <button class="btn primary" id="mgr-again">Попробовать снова</button>`;
  }

  const again = $('#mgr-again');
  if (again) again.addEventListener('click', () => {
    $('#mgr-result').hidden = true;
    $('#mgr-pick').hidden = false;
  });
  const next = $('#mgr-next');
  if (next) next.addEventListener('click', () => {
    M.stageIdx += 1;
    M.opponents.push(simOtherWinner());
    // Восстановление между матчами + снятие жёлтых после 1/4
    M.squad.forEach((p) => {
      p.stamina = Math.min(100, p.stamina + 70);
      p.injured = false;
      p.red = false;
      if (M.stageIdx === 1) p.yellow = 0;
    });
    M.xi = autoXI(M.squad, M.formation, M.teamCode);
    showPrep();
  });
}

// ---------- Панель паузы: тактика и замены ----------

function openPausePanel(kind) {
  const panel = $('#mgr-pausepanel');
  panel.hidden = false;

  if (kind === 'tactics') {
    panel.innerHTML = `
      <h4>Тактика на ходу</h4>
      <div class="mgr-tactics">
        <label>Настрой
          <select id="pp-mentality">
            <option value="def" ${M.tactics.mentality === 'def' ? 'selected' : ''}>Оборонительный</option>
            <option value="bal" ${M.tactics.mentality === 'bal' ? 'selected' : ''}>Сбалансированный</option>
            <option value="atk" ${M.tactics.mentality === 'atk' ? 'selected' : ''}>Атакующий</option>
          </select>
        </label>
        <label>Прессинг
          <select id="pp-pressing">
            <option value="low" ${M.tactics.pressing === 'low' ? 'selected' : ''}>Низкий блок</option>
            <option value="mid" ${M.tactics.pressing === 'mid' ? 'selected' : ''}>Средний</option>
            <option value="high" ${M.tactics.pressing === 'high' ? 'selected' : ''}>Высокий</option>
          </select>
        </label>
        <label>Стиль
          <select id="pp-style">
            <option value="pass" ${M.tactics.style === 'pass' ? 'selected' : ''}>Контроль мяча</option>
            <option value="counter" ${M.tactics.style === 'counter' ? 'selected' : ''}>Контратаки</option>
            <option value="wings" ${M.tactics.style === 'wings' ? 'selected' : ''}>Фланги и навесы</option>
          </select>
        </label>
      </div>
      <p class="muted small" style="margin:10px 0 0">Изменения применятся сразу после продолжения игры.</p>`;
    ['mentality', 'pressing', 'style'].forEach((key) => {
      panel.querySelector(`#pp-${key}`).addEventListener('change', (e) => {
        M.tactics[key] = e.target.value;
        feed(M.match.minute, `📋 Тактическая перестройка: ${e.target.selectedOptions[0].textContent.toLowerCase()}.`, '');
      });
    });
    return;
  }

  // Замены
  renderSubsPanel(panel);
}

function renderSubsPanel(panel) {
  const m = M.match;
  const sl = slots(M.formation);
  panel.innerHTML = `<h4>Замены · осталось ${m.subsLeft}</h4>
    <p class="muted small">Кликни игрока на поле, затем — кто выходит со скамейки.</p>
    <div class="subs-grid">
      <div class="subs-col"><h5>На поле</h5><div id="subs-on"></div></div>
      <div class="subs-col"><h5>Скамейка</h5><div id="subs-bench"></div></div>
    </div>`;

  let pickedSlot = null;
  const onBox = panel.querySelector('#subs-on');
  const benchBox = panel.querySelector('#subs-bench');

  const paint = () => {
    panel.querySelector('h4').textContent = `Замены · осталось ${m.subsLeft}`;
    onBox.innerHTML = '';
    benchBox.innerHTML = '';
    M.xi.forEach((pi, i) => {
      const p = M.squad[pi];
      const row = document.createElement('div');
      row.className = 'xi-row' + (pickedSlot === i ? ' sub-pick' : '') + (p.stamina < 55 ? ' tired' : '');
      row.innerHTML = `
        <span class="pos ${sl[i].pos}">${sl[i].pos}</span>
        <span>${p.n}${p.injured ? ' 🚑' : ''}${p.yellow ? ' 🟨' : ''}</span>
        <span class="rating">${Math.round(effRating(p, sl[i].pos))}</span>
        <span class="stamina">${Math.round(p.stamina)}%</span>`;
      row.addEventListener('click', () => { pickedSlot = pickedSlot === i ? null : i; paint(); });
      onBox.appendChild(row);
    });
    M.squad.forEach((p, i) => {
      if (M.xi.includes(i) || p.injured || p.red) return;
      const row = document.createElement('div');
      row.className = 'xi-row';
      row.innerHTML = `
        <span class="pos ${p.pos}">${p.pos}</span>
        <span>${p.n}</span>
        <span class="rating">${p.r}</span>
        <span class="stamina">${Math.round(p.stamina)}%</span>`;
      row.addEventListener('click', () => {
        if (pickedSlot === null) return;
        if (m.subsLeft <= 0) return;
        // Вратарь меняется только на вратаря, полевой — только на полевого
        if ((sl[pickedSlot].pos === 'GK') !== (p.pos === 'GK')) return;
        const out = M.squad[M.xi[pickedSlot]];
        M.xi[pickedSlot] = i;
        m.subsLeft -= 1;
        $('#mgr-subs-left').textContent = m.subsLeft;
        feed(m.minute, `🔁 Замена: ${p.n} вместо ${out.n}.`, '');
        pickedSlot = null;
        paint();
        renderLiveLineup();
      });
      benchBox.appendChild(row);
    });
  };
  paint();
}
