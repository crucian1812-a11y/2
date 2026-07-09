-- ============================================================
-- Семейный календарь — схема БД для Supabase.
-- Скопируйте весь файл в Supabase → SQL Editor → Run.
--
-- Модель безопасности: anon key публичный, данные защищает RLS.
-- Читать события могут все (включая гостей без входа),
-- писать — только залогиненные члены семьи.
-- ============================================================

-- ---------- Таблицы ----------

create table family_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null,        -- hex-акцент члена семьи, например '#c2571b'
  emoji text
);

create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  event_date date not null,
  event_time time,
  member_id uuid references family_members(id) on delete set null,
  note text,
  recurring text check (recurring in ('none','weekly','monthly','yearly')) default 'none',
  created_at timestamptz default now()
);

-- ---------- Row Level Security ----------

alter table family_members enable row level security;
alter table events enable row level security;

-- Читают все (включая анонимов)
create policy "read members for all" on family_members
  for select using (true);
create policy "read events for all" on events
  for select using (true);

-- Пишут только залогиненные
create policy "write members for authed" on family_members
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
create policy "write events for authed" on events
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Явные гранты для авто-REST API (обязательно для проектов, созданных
-- после 30.05.2026, иначе PostgREST не увидит таблицы)
grant select on family_members, events to anon;
grant all on family_members, events to authenticated;

-- ---------- Realtime ----------
-- Публикуем изменения таблиц, чтобы открытые вкладки обновлялись сами.

alter publication supabase_realtime add table events;
alter publication supabase_realtime add table family_members;

-- ---------- Демо-данные ----------
-- Удалите или замените на свою семью.

insert into family_members (id, name, color, emoji) values
  ('11111111-1111-1111-1111-111111111111', 'Мама',  '#c2571b', '🌷'),
  ('22222222-2222-2222-2222-222222222222', 'Папа',  '#2f6f8f', '🎸'),
  ('33333333-3333-3333-3333-333333333333', 'Мия',   '#7a9a3d', '🦄');

insert into events (title, event_date, event_time, member_id, note, recurring) values
  ('Ужин у бабушки', current_date + 2, '18:30',
   '11111111-1111-1111-1111-111111111111', 'Захватить пирог', 'none'),
  ('Футбол', current_date + 4, '17:00',
   '33333333-3333-3333-3333-333333333333', 'Форма постирана', 'weekly'),
  ('Оплата квартиры', current_date + 7, null,
   '22222222-2222-2222-2222-222222222222', null, 'monthly'),
  ('Семейный киновечер', current_date + 1, '20:00',
   null, 'Выбирает Мия', 'weekly'),
  ('День рождения Мии', current_date + 30, null,
   '33333333-3333-3333-3333-333333333333', 'Торт и шарики!', 'yearly');
