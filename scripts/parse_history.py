#!/usr/bin/env python3
"""Merge watch-history sources from data/incoming/ into data/watch_log.json.

Supported sources:
  * Google Takeout  -> watch-history*.json
  * Browser extension logs -> extension-*.json
Format is guessed from the filename first; if that fails, from the
presence of the "titleUrl" field in the first element.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCOMING = ROOT / "data" / "incoming"
WATCH_LOG = ROOT / "data" / "watch_log.json"

VIDEO_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})"
)


def extract_video_id(url: str) -> str | None:
    if not url:
        return None
    m = VIDEO_ID_RE.search(url)
    return m.group(1) if m else None


def parse_takeout(items: list) -> list[dict]:
    records = []
    for item in items:
        if not isinstance(item, dict):
            continue
        video_id = extract_video_id(item.get("titleUrl", ""))
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


def parse_extension(items: list) -> list[dict]:
    records = []
    for item in items:
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


def detect_and_parse(path: Path) -> list[dict]:
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"  ! skipping {path.name}: {exc}", file=sys.stderr)
        return []
    if not isinstance(items, list) or not items:
        return []

    name = path.name.lower()
    if name.startswith("watch-history"):
        return parse_takeout(items)
    if name.startswith("extension-"):
        return parse_extension(items)
    # Fallback: sniff the first element.
    first = items[0]
    if isinstance(first, dict) and "titleUrl" in first:
        return parse_takeout(items)
    return parse_extension(items)


def dedup_key(record: dict) -> str:
    # A rewatch on a different calendar day counts as a separate entry.
    day = (record.get("watched_at") or "")[:10]
    return f"{record['video_id']}|{day}"


def main() -> None:
    existing: list[dict] = []
    if WATCH_LOG.exists():
        try:
            existing = json.loads(WATCH_LOG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("  ! existing watch_log.json is corrupt, starting fresh",
                  file=sys.stderr)
    seen = {dedup_key(r) for r in existing}

    new_records: list[dict] = []
    files = sorted(INCOMING.glob("*.json")) if INCOMING.exists() else []
    for path in files:
        parsed = detect_and_parse(path)
        added = 0
        for record in parsed:
            key = dedup_key(record)
            if key in seen:
                continue
            seen.add(key)
            new_records.append(record)
            added += 1
        print(f"  {path.name}: {len(parsed)} parsed, {added} new")

    merged = existing + new_records
    merged.sort(key=lambda r: r.get("watched_at") or "", reverse=True)

    WATCH_LOG.parent.mkdir(parents=True, exist_ok=True)
    WATCH_LOG.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"watch_log.json: {len(merged)} total, {len(new_records)} new")


if __name__ == "__main__":
    main()
