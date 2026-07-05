#!/usr/bin/env python3
"""Генерирует конспекты для видео из data/watch_log.json.

Для каждого нового видео: тянет транскрипт (youtube-transcript-api),
отправляет в Claude, сохраняет notes/<video_id>.md и data/notes.json.
Идемпотентен: видео со статусом ok или no_transcript повторно не обрабатываются.

Env:
  ANTHROPIC_API_KEY — обязателен
  SUMMARY_MODEL     — модель (по умолчанию claude-sonnet-4-6)
  MAX_PER_RUN       — лимит видео за прогон (по умолчанию 25)
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import anthropic
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

ROOT = Path(__file__).resolve().parent.parent
WATCH_LOG = ROOT / "data" / "watch_log.json"
NOTES_JSON = ROOT / "data" / "notes.json"
NOTES_DIR = ROOT / "notes"

MODEL = os.environ.get("SUMMARY_MODEL", "claude-sonnet-4-6")
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN", "25"))
TRANSCRIPT_CHAR_LIMIT = 45_000
PAUSE_SECONDS = 1.5

PROMPT_TEMPLATE = """Ниже транскрипт видео с YouTube.
Название: {title}
Канал: {channel}

Составь конспект и верни СТРОГО JSON без markdown-обёртки, без пояснений, по схеме:
{{
  "one_liner": "суть видео одним предложением",
  "theses": ["3-7 главных тезисов"],
  "key_points": ["конкретные факты, цифры, выводы, рекомендации"],
  "topics": ["2-5 тем широкими мазками"],
  "tags": ["5-10 тегов в нижнем регистре"]
}}
Всё на русском. Пиши конкретно, без воды. Если в транскрипте есть цифры и названия — сохраняй их.

ТРАНСКРИПТ:
{transcript}"""


def fetch_transcript(video_id: str) -> str | None:
    """Транскрипт: приоритет ru/en, фолбэк — любой доступный. None если нет."""
    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=["ru", "en"])
    except NoTranscriptFound:
        try:
            transcript_list = api.list(video_id)
            first = next(iter(transcript_list), None)
            if first is None:
                return None
            fetched = first.fetch()
        except Exception:
            return None
    except (TranscriptsDisabled, VideoUnavailable):
        return None
    except Exception as e:
        # Сетевые и прочие временные ошибки — не помечаем как no_transcript
        raise RuntimeError(f"временная ошибка получения транскрипта: {e}") from e

    return " ".join(snippet.text for snippet in fetched)


def parse_model_json(text: str) -> dict:
    """Устойчиво парсит JSON: снимает ```json-ограждения, ищет фигурные скобки."""
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def summarize(client: anthropic.Anthropic, record: dict, transcript: str) -> dict:
    prompt = PROMPT_TEMPLATE.format(
        title=record.get("title", ""),
        channel=record.get("channel", ""),
        transcript=transcript[:TRANSCRIPT_CHAR_LIMIT],
    )
    response = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    text = next(b.text for b in response.content if b.type == "text")
    return parse_model_json(text)


def write_note_md(record: dict, summary: dict) -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    watched = (record.get("watched_at") or "")[:10]
    lines = [
        f"# {record.get('title', record['video_id'])}",
        "",
        f"- **Канал:** {record.get('channel', '—')}",
        f"- **Ссылка:** {record.get('url', '')}",
        f"- **Просмотрено:** {watched or '—'}",
        f"- **Темы:** {', '.join(summary.get('topics', []))}",
        "",
        f"> {summary.get('one_liner', '')}",
        "",
        "## Тезисы",
        "",
    ]
    lines += [f"- {t}" for t in summary.get("theses", [])]
    lines += ["", "## Ключевое", ""]
    lines += [f"- {p}" for p in summary.get("key_points", [])]
    lines += ["", "## Теги", ""]
    lines.append(" ".join(f"`{t}`" for t in summary.get("tags", [])))
    lines.append("")
    (NOTES_DIR / f"{record['video_id']}.md").write_text(
        "\n".join(lines), encoding="utf-8"
    )


def main() -> int:
    if not WATCH_LOG.exists():
        print("data/watch_log.json не найден — сначала запустите parse_history.py")
        return 0

    watch_log = json.loads(WATCH_LOG.read_text(encoding="utf-8"))

    notes: dict = {}
    if NOTES_JSON.exists():
        try:
            notes = json.loads(NOTES_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"ВНИМАНИЕ: {NOTES_JSON} повреждён, начинаю заново", file=sys.stderr)

    pending = [r for r in watch_log if r["video_id"] not in notes]
    if not pending:
        print("Новых видео нет — всё уже обработано.")
        return 0

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY не задан — конспекты не будут созданы.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()

    def save_notes():
        NOTES_JSON.parent.mkdir(parents=True, exist_ok=True)
        NOTES_JSON.write_text(
            json.dumps(notes, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    processed = 0
    for record in pending:
        if processed >= MAX_PER_RUN:
            print(f"Достигнут лимит MAX_PER_RUN={MAX_PER_RUN}, остальное — в следующий прогон.")
            break
        vid = record["video_id"]
        print(f"[{processed + 1}/{min(MAX_PER_RUN, len(pending))}] {vid}: {record.get('title', '')[:60]}")

        try:
            transcript = fetch_transcript(vid)
        except RuntimeError as e:
            print(f"  {e} — пропускаю, попробую в следующий раз", file=sys.stderr)
            continue

        if not transcript:
            print("  субтитров нет — помечаю no_transcript")
            notes[vid] = {**record, "status": "no_transcript"}
            save_notes()
            processed += 1
            continue

        try:
            summary = summarize(client, record, transcript)
        except (anthropic.APIError, json.JSONDecodeError, StopIteration) as e:
            print(f"  ошибка конспектирования: {e} — пропускаю", file=sys.stderr)
            time.sleep(PAUSE_SECONDS)
            continue

        notes[vid] = {**record, **summary, "status": "ok"}
        write_note_md(record, summary)
        save_notes()
        processed += 1
        print("  готово")
        time.sleep(PAUSE_SECONDS)

    ok = sum(1 for n in notes.values() if n.get("status") == "ok")
    nt = sum(1 for n in notes.values() if n.get("status") == "no_transcript")
    print(f"Обработано за прогон: {processed}. Всего конспектов: {ok}, без субтитров: {nt}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
