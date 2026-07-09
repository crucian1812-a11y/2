// ============================================================
// ЧМ-2026 · оболочка: переключение вкладок + рендер сетки.
// Квиз, пенальти и менеджер живут в своих модулях.
// ============================================================

import { TEAMS, BRACKET, UPDATED_AT } from './data.js';
import { initQuiz } from './quiz.js';
import { initPenalty } from './penalty.js';
import { initManager } from './manager.js';

// ---------- Вкладки ----------

const tabs = document.querySelectorAll('.tab');
tabs.forEach((tab) => tab.addEventListener('click', () => {
  tabs.forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`);
  });
}));

// ---------- Сетка плей-офф ----------

function teamRow(code, score, isWinner, decided) {
  const row = document.createElement('div');
  row.className = 'match-row';
  if (!code) {
    row.classList.add('tbd');
    row.innerHTML = '<span class="flag">•</span><span class="name">Победитель пары</span>';
    return row;
  }
  const t = TEAMS[code];
  if (decided) row.classList.add(isWinner ? 'winner' : 'loser');
  row.innerHTML = `
    <span class="flag">${t.flag}</span>
    <span class="name">${t.name}</span>
    <span class="score">${score ?? '–'}</span>`;
  return row;
}

function matchCard(m) {
  const card = document.createElement('div');
  card.className = 'match-card';
  const decided = Boolean(m.win);
  if (!decided) card.classList.add('pending');
  card.appendChild(teamRow(m.t1, m.s1, m.win === m.t1, decided));
  card.appendChild(teamRow(m.t2, m.s2, m.win === m.t2, decided));
  if (m.note) {
    const note = document.createElement('div');
    note.className = 'match-note';
    note.textContent = m.note;
    card.appendChild(note);
  }
  if (m.info) {
    const info = document.createElement('div');
    info.className = 'match-info';
    info.textContent = m.info;
    card.appendChild(info);
  }
  return card;
}

function renderBracket() {
  const box = document.getElementById('bracket');
  const rounds = [BRACKET.r32, BRACKET.r16, BRACKET.qf, BRACKET.sf, BRACKET.final];
  for (const round of rounds) {
    const col = document.createElement('div');
    col.className = 'round-col';
    col.innerHTML = `<div class="round-title">${round.title}</div>
                     <div class="round-dates">${round.dates}</div>`;
    const list = document.createElement('div');
    list.className = 'round-matches';
    round.matches.forEach((m) => list.appendChild(matchCard(m)));
    // Матч за 3-е место — под финалом
    if (round === BRACKET.final) {
      const t = document.createElement('div');
      t.className = 'round-title';
      t.style.marginTop = '18px';
      t.textContent = BRACKET.third.title;
      list.appendChild(t);
      const d = document.createElement('div');
      d.className = 'round-dates';
      d.textContent = BRACKET.third.dates;
      list.appendChild(d);
      BRACKET.third.matches.forEach((m) => list.appendChild(matchCard(m)));
    }
    col.appendChild(list);
    box.appendChild(col);
  }
}

function renderSchedule() {
  const box = document.getElementById('schedule-cards');
  const title = document.createElement('h3');
  title.style.gridColumn = '1 / -1';
  title.textContent = 'Ближайшие матчи · 1/4 финала';
  box.appendChild(title);
  for (const m of BRACKET.qf.matches) {
    if (m.win) continue;
    const c = document.createElement('div');
    c.className = 'sched-card';
    c.innerHTML = `
      <div class="flags">${TEAMS[m.t1].flag} ${TEAMS[m.t2].flag}</div>
      <div class="vs">${TEAMS[m.t1].name} — ${TEAMS[m.t2].name}</div>
      <div class="when">${m.info}</div>`;
    box.appendChild(c);
  }
}

// ---------- Запуск ----------

document.getElementById('updated-at').textContent = UPDATED_AT;
document.getElementById('updated-at2').textContent = UPDATED_AT;
renderBracket();
renderSchedule();
initQuiz();
initPenalty();
initManager();
