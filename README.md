# YTBrain

Превращает вашу историю просмотров YouTube в архив конспектов с поиском, фильтрами и статистикой. Обработка идёт автоматически через GitHub Actions, всё живёт в одном репозитории, дашборд публикуется на GitHub Pages.

## Как это работает

```
data/incoming/*.json  →  parse_history.py  →  data/watch_log.json
                          summarize.py     →  notes/*.md + data/notes.json
                          build_site.py    →  docs/data.json  →  дашборд (Pages)
```

Конспекты генерирует Claude (модель по умолчанию `claude-sonnet-4-6`, переопределяется env `SUMMARY_MODEL`) из субтитров видео, полученных через `youtube-transcript-api`.

## Почему не YouTube Data API

YouTube Data API **не отдаёт личную историю просмотров** — этот эндпоинт закрыт много лет назад. Поэтому история берётся из двух источников:

| Источник | Файл в `data/incoming/` | Что содержит |
|---|---|---|
| Google Takeout | `watch-history.json` | Полная история за всё время; выгружается вручную с [takeout.google.com](https://takeout.google.com) (раздел YouTube → история) |
| Браузерное расширение | `extension-YYYY-MM-DD.json` | Свежие просмотры; логируются автоматически, выгружаются кнопкой из попапа |

Takeout удобен для первоначальной загрузки архива, расширение — для регулярного пополнения.

## Быстрый старт

1. **Форкните** репозиторий.
2. Добавьте секрет **`ANTHROPIC_API_KEY`**: Settings → Secrets and variables → Actions → New repository secret.
3. Включите **GitHub Pages**: Settings → Pages → Source: Deploy from a branch → ветка `main`, папка `/docs`.
4. Дайте Actions **право на запись**: Settings → Actions → General → Workflow permissions → Read and write permissions.
5. Закиньте `watch-history.json` (из Takeout) и/или `extension-*.json` в `data/incoming/` и запушьте.

Workflow запустится по пушу (а дальше — ежедневно в 06:00 UTC или вручную через Run workflow) и закоммитит конспекты и данные дашборда обратно в репозиторий.

## Установка расширения (Chrome/Edge)

1. Откройте `chrome://extensions` (или `edge://extensions`).
2. Включите **режим разработчика**.
3. Нажмите **«Загрузить распакованное»** и укажите папку `extension/` этого репозитория.

Расширение фиксирует видео после 30 секунд на странице. В попапе — счётчик очереди, кнопка «Скачать лог» (экспортирует `extension-YYYY-MM-DD.json` — его и кладите в `data/incoming/`) и «Очистить очередь».

## Локальный запуск

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...

python scripts/parse_history.py   # incoming → watch_log.json
python scripts/summarize.py       # транскрипты + конспекты (лимит: MAX_PER_RUN=25)
python scripts/build_site.py      # docs/data.json

# посмотреть дашборд локально:
python -m http.server -d docs 8000   # → http://localhost:8000
```

## Честные ограничения

- **Видео без субтитров не конспектируются** — они помечаются `no_transcript` и в дашборде учитываются только счётчиком. Аудио не распознаётся.
- **Автосубтитры шумные**: у видео без ручных субтитров транскрипт бывает с ошибками, конспект может их наследовать.
- **Длинные видео обрезаются** до ~45 000 символов транскрипта — у многочасовых стримов конспект охватит только начало.
- `youtube-transcript-api` — неофициальная библиотека: YouTube иногда меняет внутренности, и получение субтитров может временно ломаться до обновления библиотеки.
- Дедупликация — по `video_id + день`: пересмотр в другой день считается отдельным просмотром (это сознательно).
