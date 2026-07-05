#!/usr/bin/env python3
"""Объединяет историю просмотров из data/incoming/ в data/watch_log.json.

Источники:
  * Google Takeout  — watch-history*.json
  * Браузерное расширение — extension-*.json

Дедупликация: video_id + дата просмотра (YYYY-MM-DD).
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCOMING_DIR = ROOT / "data" / "incoming"
WATCH_LOG = ROOT / "data" / "watch_log.json"

VIDEO_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})"
)


def extract_video_id(url: str) -> str | None:
    if not url:
        return None
    m = VIDEO_ID_RE.search(url)
    return m.group(1) if m else None


def detect_format(path: Path, data) -> str | None:
    """Takeout или расширение — по имени файла, иначе по структуре."""
    name = path.name.lower()
    if name.startswith("watch-history"):
        return "takeout"
    if name.startswith("extension-"):
        return "extension"
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            if "titleUrl" in first:
                return "takeout"
            if "videoId" in first:
                return "extension"
    return None


def parse_takeout(data: list) -> list[dict]:
    records = []
    for item in data:
        if not isinstance(item, dict):
            continue
        url = item.get("titleUrl", "")
        video_id = extract_video_id(url)
        if not video_id:
            continue
        title = item.get("title", "")
        if title.startswith("Watched "):
            title = title[len("Watched "):]
        subtitles = item.get("subtitles") or []
        channel = subtitles[0].get("name", "") if subtitles else ""
        records.append({
            "video_id": video_id,
            "title": title,
            "channel": channel,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "watched_at": item.get("time", ""),
            "source": "takeout",
        })
    return records


def parse_extension(data: list) -> list[dict]:
    records = []
    for item in data:
        if not isinstance(item, dict):
            continue
        video_id = item.get("videoId") or extract_video_id(item.get("url", ""))
        if not video_id:
            continue
        records.append({
            "video_id": video_id,
            "title": item.get("title", ""),
            "channel": item.get("channel", ""),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "watched_at": item.get("watchedAt", ""),
            "source": "extension",
        })
    return records


def dedup_key(record: dict) -> str:
    watched = record.get("watched_at", "")
    day = watched[:10] if watched else ""
    return f"{record['video_id']}|{day}"


def sort_key(record: dict) -> str:
    return record.get("watched_at") or ""


def main() -> int:
    existing: list[dict] = []
    if WATCH_LOG.exists():
        try:
            existing = json.loads(WATCH_LOG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"ВНИМАНИЕ: {WATCH_LOG} повреждён, начинаю с пустого лога", file=sys.stderr)

    seen = {dedup_key(r) for r in existing}
    merged = list(existing)
    new_count = 0

    files = sorted(INCOMING_DIR.glob("*.json")) if INCOMING_DIR.exists() else []
    if not files:
        print("В data/incoming/ нет JSON-файлов — нечего обрабатывать.")

    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"Пропускаю {path.name}: не удалось разобрать ({e})", file=sys.stderr)
            continue

        fmt = detect_format(path, data)
        if fmt == "takeout":
            records = parse_takeout(data)
        elif fmt == "extension":
            records = parse_extension(data)
        else:
            print(f"Пропускаю {path.name}: неизвестный формат", file=sys.stderr)
            continue

        for record in records:
            key = dedup_key(record)
            if key in seen:
                continue
            seen.add(key)
            merged.append(record)
            new_count += 1
        print(f"{path.name}: формат {fmt}, записей {len(records)}")

    merged.sort(key=sort_key, reverse=True)

    WATCH_LOG.parent.mkdir(parents=True, exist_ok=True)
    WATCH_LOG.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Итого записей: {len(merged)} (новых: {new_count})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
