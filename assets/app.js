// ============================================================
// Семейный календарь — логика приложения.
//
// Модуль отвечает за:
//   · загрузку членов семьи и событий из Supabase;
//   · месячную сетку с разворачиванием повторяющихся событий;
//   · авторизацию по magic link и переключение UI гость/свой;
//   · realtime-подписку на изменения событий;
//   · модалки (вход, день, форма события), фильтры, тосты, тему.
// ============================================================

import { supabase, isConfigured } from './supabase.js';

// ---------- Состояние ----------

const state = {
  session: null,        // текущая сессия Supabase Auth (null = гость)
  members: [],          // члены семьи из БД
  events: [],           // «сырые» события из БД (по одной строке на повтор)
  viewYear: 0,          // отображаемый месяц
  viewMonth: 0,         // 0–11
  activeFilters: new Set(), // id членов семьи; пусто = показывать всех
  editingId: null,      // id редактируемого события (null = создание)
};

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const REPEAT_LABELS = { weekly: 'каждую неделю', monthly: 'каждый месяц', yearly: 'каждый год' };

const $ = (sel) => document.querySelector(sel);

// ---------- Работа с датами ----------
// Всюду используются локальные даты и строки 'YYYY-MM-DD':
// строки корректно сравниваются лексикографически и не зависят от таймзоны.

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayKey() {
  return toKey(new Date());
}

function humanDate(key) {
  const d = parseKey(key);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

/** 'HH:MM:SS' из Postgres → 'HH:MM' для показа */
const shortTime = (t) => (t ? t.slice(0, 5) : '');

// ---------- Разворачивание повторяющихся событий ----------
// В БД хранится одна строка; вхождения в интервал [fromKey, toKey]
// вычисляются на лету при рендере.

function occurrences(ev, fromKey, toKeyStr) {
  const result = [];
  const startKey = ev.event_date;

  if (!ev.recurring || ev.recurring === 'none') {
    if (startKey >= fromKey && startKey <= toKeyStr) result.push(startKey);
    return result;
  }

  const start = parseKey(startKey);
  const from = parseKey(fromKey);
  const to = parseKey(toKeyStr);

  if (ev.recurring === 'weekly') {
    // Первое вхождение не раньше начала события и начала интервала,
    // выровненное на день недели исходной даты.
    const cursor = start > from ? new Date(start) : new Date(from);
    const shift = (start.getDay() - cursor.getDay() + 7) % 7;
    cursor.setDate(cursor.getDate() + shift);
    while (cursor <= to) {
      result.push(toKey(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
    return result;
  }

  if (ev.recurring === 'monthly') {
    const day = start.getDate();
    for (let y = from.getFullYear(), m = from.getMonth(); ; ) {
      const candidate = new Date(y, m, day);
      if (candidate > to) break;
      // getMonth() !== m — в этом месяце нет такого числа (например, 31-го)
      if (candidate.getMonth() === m && candidate >= start && candidate >= from) {
        result.push(toKey(candidate));
      }
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return result;
  }

  if (ev.recurring === 'yearly') {
    const month = start.getMonth();
    const day = start.getDate();
    for (let y = from.getFullYear(); y <= to.getFullYear(); y += 1) {
      const candidate = new Date(y, month, day);
      // проверка месяца отсеивает 29 февраля в невисокосные годы
      if (candidate.getMonth() !== month) continue;
      if (candidate >= start && candidate >= from && candidate <= to) {
        result.push(toKey(candidate));
      }
    }
    return result;
  }

  return result;
}

/** События, прошедшие фильтр по членам семьи */
function filteredEvents() {
  if (state.activeFilters.size === 0) return state.events;
  return state.events.filter((ev) => ev.member_id && state.activeFilters.has(ev.member_id));
}

/** Map 'YYYY-MM-DD' → массив событий на этот день (отсортированный) */
function eventsByDate(fromKey, toKeyStr) {
  const map = new Map();
  for (const ev of filteredEvents()) {
    for (const key of occurrences(ev, fromKey, toKeyStr)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) =>
      (a.event_time || '99') < (b.event_time || '99') ? -1 :
      (a.event_time || '99') > (b.event_time || '99') ? 1 :
      a.title.localeCompare(b.title, 'ru'));
  }
  return map;
}

const memberById = (id) => state.members.find((m) => m.id === id) || null;
const memberColor = (id) => memberById(id)?.color || 'var(--accent)';

// ---------- Загрузка данных ----------

async function loadData({ silent = false } = {}) {
  if (!silent) setLoading(true);
  try {
    const [membersRes, eventsRes] = await Promise.all([
      supabase.from('family_members').select('*').order('name'),
      supabase.from('events').select('*').order('event_date'),
    ]);
    if (membersRes.error) throw membersRes.error;
    if (eventsRes.error) throw eventsRes.error;
    state.members = membersRes.data ?? [];
    state.events = eventsRes.data ?? [];
    renderAll();
  } catch (err) {
    console.error(err);
    toast(`Не удалось загрузить данные: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  $('#loader').classList.toggle('visible', on);
}

// ---------- Рендер ----------

function renderAll() {
  renderFilters();
  renderCalendar();
  renderUpcoming();
}

function renderCalendar() {
  const { viewYear: y, viewMonth: m } = state;
  $('#month-title').textContent = `${MONTHS[m]} ${y}`;

  // Сетка 6×7 с понедельника — стабильная высота из месяца в месяц
  const first = new Date(y, m, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7));
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 41);

  const byDate = eventsByDate(toKey(gridStart), toKey(gridEnd));
  const today = todayKey();

  const grid = $('#calendar-grid');
  grid.innerHTML = '';
  const cursor = new Date(gridStart);

  for (let i = 0; i < 42; i += 1) {
    const key = toKey(cursor);
    const dayEvents = byDate.get(key) || [];

    const cell = document.createElement('div');
    cell.className = 'day-cell';
    cell.dataset.date = key;
    if (cursor.getMonth() !== m) cell.classList.add('other-month');
    if (key === today) cell.classList.add('today');
    if (dayEvents.length) cell.classList.add('has-events');
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `${humanDate(key)}, событий: ${dayEvents.length}`);
    cell.tabIndex = 0;

    const num = document.createElement('span');
    num.className = 'day-num';
    num.textContent = cursor.getDate();
    cell.appendChild(num);

    // Десктоп: до 3 пилюль + счётчик остальных
    const MAX_PILLS = 3;
    dayEvents.slice(0, MAX_PILLS).forEach((ev) => {
      const pill = document.createElement('div');
      pill.className = 'event-pill';
      pill.style.setProperty('--member-color', memberColor(ev.member_id));
      if (ev.event_time) {
        const t = document.createElement('b');
        t.className = 'pill-time';
        t.textContent = shortTime(ev.event_time);
        pill.appendChild(t);
      }
      const title = document.createElement('span');
      title.textContent = ev.title;
      pill.appendChild(title);
      cell.appendChild(pill);
    });
    if (dayEvents.length > MAX_PILLS) {
      const more = document.createElement('div');
      more.className = 'more-events';
      more.textContent = `+ ещё ${dayEvents.length - MAX_PILLS}`;
      cell.appendChild(more);
    }

    // Мобильный: цветные точки вместо пилюль
    if (dayEvents.length) {
      const dots = document.createElement('div');
      dots.className = 'day-dots';
      dayEvents.slice(0, 4).forEach((ev) => {
        const dot = document.createElement('i');
        dot.style.setProperty('--member-color', memberColor(ev.member_id));
        dots.appendChild(dot);
      });
      cell.appendChild(dots);
    }

    grid.appendChild(cell);
    cursor.setDate(cursor.getDate() + 1);
  }
}

function renderUpcoming() {
  const list = $('#upcoming-list');
  list.innerHTML = '';

  // Разворачиваем повторы на ближайшие 90 дней и берём первые 7
  const from = todayKey();
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 90);

  const items = [];
  for (const ev of filteredEvents()) {
    for (const key of occurrences(ev, from, toKey(horizon))) {
      items.push({ key, ev });
    }
  }
  items.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 :
    (a.ev.event_time || '99') < (b.ev.event_time || '99') ? -1 : 1);

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'upcoming-empty';
    li.textContent = 'Пока ничего не запланировано — самое время добавить!';
    list.appendChild(li);
    return;
  }

  for (const { key, ev } of items.slice(0, 7)) {
    const member = memberById(ev.member_id);
    const li = document.createElement('li');
    li.className = 'upcoming-item';
    li.style.setProperty('--member-color', memberColor(ev.member_id));

    const date = document.createElement('span');
    date.className = 'upcoming-date';
    date.textContent = key === todayKey()
      ? 'Сегодня'
      : `${parseKey(key).getDate()} ${MONTHS_GEN[parseKey(key).getMonth()]}`;

    const body = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'upcoming-title';
    title.textContent = ev.title;
    body.appendChild(title);

    const metaParts = [];
    if (ev.event_time) metaParts.push(shortTime(ev.event_time));
    if (member) metaParts.push(`${member.emoji || ''} ${member.name}`.trim());
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'upcoming-meta';
      meta.textContent = ` · ${metaParts.join(' · ')}`;
      body.appendChild(meta);
    }

    li.append(date, body);
    li.addEventListener('click', () => openDayModal(key));
    list.appendChild(li);
  }
}

function renderFilters() {
  const box = $('#member-filters');
  box.innerHTML = '';
  for (const member of state.members) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.style.setProperty('--chip', member.color);
    chip.classList.toggle('active', state.activeFilters.has(member.id));
    chip.setAttribute('aria-pressed', state.activeFilters.has(member.id));

    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    const label = document.createElement('span');
    label.textContent = `${member.emoji || ''} ${member.name}`.trim();
    chip.append(dot, label);

    chip.addEventListener('click', () => {
      if (state.activeFilters.has(member.id)) state.activeFilters.delete(member.id);
      else state.activeFilters.add(member.id);
      renderAll();
    });
    box.appendChild(chip);
  }
}

// ---------- Авторизация ----------

const isAuthed = () => Boolean(state.session);

function renderAuth() {
  const area = $('#auth-area');
  area.innerHTML = '';

  if (isAuthed()) {
    const email = document.createElement('span');
    email.className = 'auth-email';
    email.title = state.session.user.email;
    email.textContent = state.session.user.email;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Выйти';
    btn.addEventListener('click', async () => {
      const { error } = await supabase.auth.signOut();
      if (error) toast(error.message, 'error');
    });
    area.append(email, btn);
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = 'Войти';
    btn.addEventListener('click', () => openModal('#login-modal'));
    area.appendChild(btn);
  }

  // Кнопки записи видны только своим
  $('#add-event-btn').hidden = !isAuthed();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const submitBtn = e.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
    $('#login-sent').hidden = false;
  } catch (err) {
    toast(`Не получилось отправить ссылку: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------- Модалки ----------

function openModal(sel) {
  $(sel).hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach((el) => { el.hidden = true; });
  document.body.style.overflow = '';
}

function openDayModal(dateKey) {
  const byDate = eventsByDate(dateKey, dateKey);
  const events = byDate.get(dateKey) || [];

  $('#day-title').textContent = humanDate(dateKey);
  const list = $('#day-events');
  list.innerHTML = '';

  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'day-empty';
    empty.textContent = 'В этот день пока ничего не запланировано.';
    list.appendChild(empty);
  }

  for (const ev of events) {
    const member = memberById(ev.member_id);
    const li = document.createElement('li');
    li.className = 'day-event';
    li.style.setProperty('--member-color', memberColor(ev.member_id));

    const head = document.createElement('div');
    head.className = 'day-event-head';
    if (ev.event_time) {
      const t = document.createElement('span');
      t.className = 'day-event-time';
      t.textContent = shortTime(ev.event_time);
      head.appendChild(t);
    }
    const title = document.createElement('span');
    title.className = 'day-event-title';
    title.textContent = ev.title;
    head.appendChild(title);
    if (member) {
      const who = document.createElement('span');
      who.className = 'day-event-member';
      who.textContent = `${member.emoji || ''} ${member.name}`.trim();
      head.appendChild(who);
    }
    if (ev.recurring && ev.recurring !== 'none') {
      const rep = document.createElement('span');
      rep.className = 'day-event-repeat';
      rep.textContent = `🔁 ${REPEAT_LABELS[ev.recurring]}`;
      head.appendChild(rep);
    }
    li.appendChild(head);

    if (ev.note) {
      const note = document.createElement('p');
      note.className = 'day-event-note';
      note.textContent = ev.note;
      li.appendChild(note);
    }

    if (isAuthed()) {
      const actions = document.createElement('div');
      actions.className = 'day-event-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'mini-btn';
      editBtn.textContent = '✏️ Редактировать';
      editBtn.addEventListener('click', () => openEventForm({ event: ev }));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '🗑 Удалить';
      delBtn.addEventListener('click', () => deleteEvent(ev));

      actions.append(editBtn, delBtn);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }

  const addBtn = $('#day-add-btn');
  addBtn.hidden = !isAuthed();
  addBtn.onclick = () => openEventForm({ dateKey });

  closeModals();
  openModal('#day-modal');
}

// ---------- Форма события ----------

function fillMemberSelect(selectedId) {
  const select = $('#ev-member');
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— вся семья —';
  select.appendChild(none);
  for (const m of state.members) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.emoji || ''} ${m.name}`.trim();
    if (m.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}

/** Открыть форму: event — редактирование, dateKey — создание на дату */
function openEventForm({ event = null, dateKey = null } = {}) {
  state.editingId = event?.id ?? null;

  $('#event-form-title').textContent = event ? 'Изменить событие' : 'Новое событие';
  $('#ev-title').value = event?.title ?? '';
  $('#ev-date').value = event?.event_date ?? dateKey ?? todayKey();
  $('#ev-time').value = event?.event_time ? shortTime(event.event_time) : '';
  $('#ev-note').value = event?.note ?? '';
  $('#ev-recurring').value = event?.recurring ?? 'none';
  fillMemberSelect(event?.member_id ?? '');
  $('#ev-delete-btn').hidden = !event;

  closeModals();
  openModal('#event-modal');
  $('#ev-title').focus();
}

async function handleEventSubmit(e) {
  e.preventDefault();
  const payload = {
    title: $('#ev-title').value.trim(),
    event_date: $('#ev-date').value,
    event_time: $('#ev-time').value || null,
    member_id: $('#ev-member').value || null,
    note: $('#ev-note').value.trim() || null,
    recurring: $('#ev-recurring').value,
  };
  if (!payload.title || !payload.event_date) return;

  const submitBtn = e.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try {
    const query = state.editingId
      ? supabase.from('events').update(payload).eq('id', state.editingId)
      : supabase.from('events').insert(payload);
    const { error } = await query;
    if (error) throw error;
    toast(state.editingId ? 'Событие обновлено' : 'Событие добавлено', 'success');
    closeModals();
    await loadData({ silent: true });
  } catch (err) {
    toast(`Не удалось сохранить: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteEvent(ev) {
  const suffix = ev.recurring && ev.recurring !== 'none' ? ' (все его повторы)' : '';
  if (!confirm(`Удалить «${ev.title}»${suffix}?`)) return;
  try {
    const { error } = await supabase.from('events').delete().eq('id', ev.id);
    if (error) throw error;
    toast('Событие удалено', 'success');
    closeModals();
    await loadData({ silent: true });
  } catch (err) {
    toast(`Не удалось удалить: ${err.message}`, 'error');
  }
}

// ---------- Realtime ----------
// Любое изменение таблицы events в любой вкладке/у любого члена семьи
// прилетает сюда — данные перезагружаются без обновления страницы.

function subscribeRealtime() {
  supabase
    .channel('events-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => {
      loadData({ silent: true });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_members' }, () => {
      loadData({ silent: true });
    })
    .subscribe();
}

// ---------- Тосты ----------

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 350);
  }, 4000);
}

// ---------- Тема ----------

function initTheme() {
  const btn = $('#theme-toggle');
  const apply = () => {
    btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
  };
  apply();
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fc-theme', next);
    apply();
  });
}

// ---------- Навигация по месяцам ----------

function shiftMonth(delta) {
  const d = new Date(state.viewYear, state.viewMonth + delta, 1);
  state.viewYear = d.getFullYear();
  state.viewMonth = d.getMonth();
  renderCalendar();
}

// ---------- Инициализация ----------

function bindUI() {
  $('#prev-month').addEventListener('click', () => shiftMonth(-1));
  $('#next-month').addEventListener('click', () => shiftMonth(1));
  $('#today-btn').addEventListener('click', () => {
    const now = new Date();
    state.viewYear = now.getFullYear();
    state.viewMonth = now.getMonth();
    renderCalendar();
  });

  $('#add-event-btn').addEventListener('click', () => openEventForm({}));
  $('#login-form').addEventListener('submit', handleLogin);
  $('#event-form').addEventListener('submit', handleEventSubmit);
  $('#ev-delete-btn').addEventListener('click', () => {
    const ev = state.events.find((x) => x.id === state.editingId);
    if (ev) deleteEvent(ev);
  });

  // Клик по дню календаря (делегирование)
  $('#calendar-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.day-cell');
    if (cell) openDayModal(cell.dataset.date);
  });
  $('#calendar-grid').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('.day-cell');
    if (cell) { e.preventDefault(); openDayModal(cell.dataset.date); }
  });

  // Закрытие модалок: крестик, клик по фону, Escape
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModals();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });
}

function init() {
  const now = new Date();
  state.viewYear = now.getFullYear();
  state.viewMonth = now.getMonth();

  initTheme();
  bindUI();
  renderAuth();
  renderCalendar(); // пустая сетка сразу, данные подтянутся следом

  if (!isConfigured) {
    $('#setup-banner').hidden = false;
    toast('Supabase не настроен — календарь работает без данных', 'error');
    return;
  }

  // Срабатывает и при первичной загрузке (INITIAL_SESSION),
  // и при входе по magic link, и при выходе.
  supabase.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    renderAuth();
    renderAll();
  });

  loadData();
  subscribeRealtime();
}

init();
