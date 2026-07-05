# YTBrain

Превращает историю просмотров YouTube в архив конспектов с поиском,
фильтрами и статистикой. Всё живёт в одном репозитории: GitHub Actions
обрабатывает данные по расписанию, GitHub Pages показывает дашборд.

## Почему не YouTube API

YouTube Data API **не отдаёт личную историю просмотров** — этот эндпоинт
закрыт много лет назад. Поэтому история берётся из двух источников,
оба кладутся в `data/incoming/`:

| Источник | Файл | Что даёт |
|---|---|---|
| [Google Takeout](https://takeout.google.com) → YouTube → «история» → JSON | `watch-history.json` | вся накопленная история разом |
| Браузерное расширение из `extension/` | `extension-YYYY-MM-DD.json` | новые просмотры день за днём |

## Как это работает

```
data/incoming/*.json ──► parse_history.py ──► data/watch_log.json
                                                    │
                    youtube-transcript-api ◄────────┘
                              │
                       summarize.py ──► notes/<id>.md + data/notes.json
                              │
                       build_site.py ──► docs/data.json ──► docs/index.html
```

Workflow `.github/workflows/process.yml` запускается ежедневно в 06:00 UTC,
вручную (workflow_dispatch) и при пуше файлов в `data/incoming/`.

## Провайдер конспектов

Выбирается переменной `SUMMARY_PROVIDER`. **По умолчанию `local` — работает
полностью офлайн, без единого ключа и бесплатно.**

| Провайдер | Что делает | Что нужно |
|---|---|---|
| `local` (дефолт) | извлекающий конспект: TextRank (sumy) + ключевые слова (yake) | ничего |
| `openai` | абстрактный конспект через любой OpenAI-совместимый эндпоинт | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` |

Примеры для `openai` (все варианты бесплатны или локальны):

| Эндпоинт | `LLM_BASE_URL` | `LLM_MODEL` (пример) |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-1.5-flash` |
| Ollama (локально) | `http://localhost:11434/v1` | `llama3.1` |

Настройка в GitHub: **Settings → Secrets and variables → Actions**:

- *Variables*: `SUMMARY_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_MODEL`;
- *Secrets*: `LLM_API_KEY`.

Ничего не задано → работает `local`.

## Быстрый старт

1. **Форкните** репозиторий.
2. **Settings → Pages** → Source: `Deploy from a branch`, ветка `main`,
   папка `/docs`.
3. **Settings → Actions → General → Workflow permissions** →
   `Read and write permissions`.
4. Закиньте `watch-history.json` из Takeout (и/или логи расширения)
   в `data/incoming/` — workflow запустится сам.

Платного ничего не требуется.

## Расширение

1. `chrome://extensions` → включить «Режим разработчика» →
   «Загрузить распакованное расширение» → папка `extension/`.
2. Смотрите YouTube как обычно: видео фиксируется после 30 секунд
   на странице.
3. В попапе расширения — «Скачать лог» → файл `extension-YYYY-MM-DD.json`
   → положить в `data/incoming/` (можно прямо через веб-интерфейс GitHub).
4. «Очистить очередь» — после успешной выгрузки.

## Локальный запуск

```bash
pip install -r requirements.txt

# офлайн-провайдер (дефолт)
python scripts/parse_history.py
python scripts/summarize.py
python scripts/build_site.py

# openai-провайдер, пример с Groq
SUMMARY_PROVIDER=openai \
LLM_BASE_URL=https://api.groq.com/openai/v1 \
LLM_MODEL=llama-3.1-8b-instant \
LLM_API_KEY=gsk_... \
python scripts/summarize.py

# посмотреть дашборд
python -m http.server -d docs 8000   # http://localhost:8000
```

Полезные переменные: `MAX_PER_RUN` — лимит видео за прогон (дефолт 25
локально, 40 в CI).

## Честные ограничения

- **Видео без субтитров не конспектируются** — они помечаются
  `no_transcript` и попадают только в статистику.
- **`local` — извлекающий конспект**: он выбирает предложения из
  субтитров, а не пересказывает. На авто-субтитрах без пунктуации
  формулировки получаются рваными.
- **Авто-субтитры шумные**: оговорки, «[музыка]», ошибки распознавания —
  всё это может протечь в тезисы.
- **Длинные транскрипты обрезаются** (~24 тыс. символов), конец
  многочасовых видео в конспект не попадает.
- YouTube иногда рейт-лимитит выкачивание субтитров с IP GitHub Actions;
  такие видео будут подхвачены следующим прогоном.
