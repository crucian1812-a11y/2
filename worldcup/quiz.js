// ============================================================
// ЧМ-2026 · квиз. Лёгкий/средний — 4 варианта.
// Сложный — «Что? Где? Когда?»: открытый ответ, минута на раздумье.
// ============================================================

import { QUIZ } from './data.js';

const $ = (s) => document.querySelector(s);

const state = {
  level: null,
  questions: [],
  index: 0,
  score: 0,
  timer: null,
  timeLeft: 0,
  answered: false,
};

// Перемешивание (Фишер–Йетс) — вопросы и варианты каждый раз в новом порядке
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Нормализация открытого ответа: регистр, ё→е, пунктуация, лишние пробелы
function normalize(s) {
  return s.toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCorrectOpen(input, answers) {
  const norm = normalize(input);
  if (!norm) return false;
  return answers.some((a) => {
    const na = normalize(a);
    return norm === na || norm.includes(na) || na.includes(norm) && norm.length >= 4;
  });
}

export function initQuiz() {
  document.querySelectorAll('.quiz-card').forEach((card) => {
    card.addEventListener('click', () => startQuiz(card.dataset.level));
  });
  $('#quiz-next').addEventListener('click', nextQuestion);
  $('#quiz-answer-btn').addEventListener('click', submitOpen);
  $('#quiz-giveup-btn').addEventListener('click', () => resolveOpen(false, true));
  $('#quiz-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitOpen();
  });
}

function startQuiz(level) {
  state.level = level;
  state.questions = shuffle(QUIZ[level]);
  state.index = 0;
  state.score = 0;
  $('#quiz-select').hidden = true;
  $('#quiz-result').hidden = true;
  $('#quiz-game').hidden = false;
  showQuestion();
}

function showQuestion() {
  const q = state.questions[state.index];
  state.answered = false;
  $('#quiz-progress').textContent = `Вопрос ${state.index + 1} / ${state.questions.length}`;
  $('#quiz-score').textContent = `Очки: ${state.score}`;
  $('#quiz-question').textContent = q.q;
  $('#quiz-feedback').hidden = true;
  $('#quiz-next').hidden = true;

  const opts = $('#quiz-options');
  const open = $('#quiz-open');
  opts.innerHTML = '';

  if (state.level === 'hard') {
    // ЧГК: открытый ответ + таймер 60 секунд
    opts.hidden = true;
    open.hidden = false;
    $('#quiz-input').value = '';
    $('#quiz-input').disabled = false;
    $('#quiz-answer-btn').disabled = false;
    $('#quiz-giveup-btn').disabled = false;
    $('#quiz-input').focus();
    startTimer(60);
  } else {
    opts.hidden = false;
    open.hidden = true;
    $('#quiz-timer').hidden = true;
    // Варианты перемешиваются, правильный отслеживаем по тексту
    const correctText = q.a[q.correct];
    shuffle(q.a).forEach((text) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-option';
      btn.textContent = text;
      btn.addEventListener('click', () => pickOption(btn, text === correctText, correctText));
      opts.appendChild(btn);
    });
  }
}

// ---------- Вопросы с вариантами ----------

function pickOption(btn, correct, correctText) {
  if (state.answered) return;
  state.answered = true;
  document.querySelectorAll('.quiz-option').forEach((b) => {
    b.disabled = true;
    if (b.textContent === correctText) b.classList.add('correct');
  });
  if (!correct) btn.classList.add('wrong');
  if (correct) state.score += 1;

  const q = state.questions[state.index];
  const fb = $('#quiz-feedback');
  fb.hidden = false;
  fb.classList.toggle('bad', !correct);
  fb.textContent = (correct ? '✅ Верно! ' : '❌ Не то. ') + (q.note || '');
  $('#quiz-score').textContent = `Очки: ${state.score}`;
  $('#quiz-next').hidden = false;
}

// ---------- ЧГК: открытые вопросы ----------

function startTimer(seconds) {
  clearInterval(state.timer);
  state.timeLeft = seconds;
  const el = $('#quiz-timer');
  el.hidden = false;
  el.classList.remove('hurry');
  el.textContent = `⏱ ${seconds}`;
  state.timer = setInterval(() => {
    state.timeLeft -= 1;
    el.textContent = `⏱ ${state.timeLeft}`;
    if (state.timeLeft <= 10) el.classList.add('hurry');
    if (state.timeLeft <= 0) {
      clearInterval(state.timer);
      resolveOpen(false, false, true);
    }
  }, 1000);
}

function submitOpen() {
  if (state.answered) return;
  const input = $('#quiz-input').value;
  const q = state.questions[state.index];
  resolveOpen(isCorrectOpen(input, q.answers), false);
}

function resolveOpen(correct, gaveUp, timeout = false) {
  if (state.answered) return;
  state.answered = true;
  clearInterval(state.timer);
  $('#quiz-input').disabled = true;
  $('#quiz-answer-btn').disabled = true;
  $('#quiz-giveup-btn').disabled = true;

  if (correct) state.score += 1;
  const q = state.questions[state.index];
  const fb = $('#quiz-feedback');
  fb.hidden = false;
  fb.classList.toggle('bad', !correct);
  const prefix = correct ? '✅ Правильно! '
    : timeout ? '⏱ Время вышло. '
    : gaveUp ? '🏳️ Бывает. '
    : '❌ Увы. ';
  fb.textContent = prefix + q.comment;
  $('#quiz-score').textContent = `Очки: ${state.score}`;
  $('#quiz-next').hidden = false;
}

// ---------- Дальше / результат ----------

function nextQuestion() {
  state.index += 1;
  if (state.index >= state.questions.length) showResult();
  else showQuestion();
}

function verdict(score, level) {
  const hard = level === 'hard';
  if (score >= 9) return hard ? '🦉 Магистр! Ворошилов бы гордился.' : '🏆 Чемпионский уровень!';
  if (score >= 7) return hard ? '🎓 Сильная игра — знатоки берут вас в команду.' : '🥈 Отлично! Почти без осечек.';
  if (score >= 5) return '⚽ Крепкий середняк — как сборная Швейцарии.';
  if (score >= 3) return '📖 Групповой этап пройден, но плей-офф не покорился.';
  return '🙈 Кажется, вы болеете за красоту игры, а не за статистику!';
}

function showResult() {
  clearInterval(state.timer);
  $('#quiz-game').hidden = true;
  const res = $('#quiz-result');
  res.hidden = false;
  res.innerHTML = `
    <h3>Результат</h3>
    <div class="big-score">${state.score} / ${state.questions.length}</div>
    <p>${verdict(state.score, state.level)}</p>
    <button class="btn primary" id="quiz-again">Сыграть ещё раз</button>
    <button class="btn ghost" id="quiz-other">Другая сложность</button>`;
  $('#quiz-again').addEventListener('click', () => startQuiz(state.level));
  $('#quiz-other').addEventListener('click', () => {
    res.hidden = true;
    $('#quiz-select').hidden = false;
  });
}
