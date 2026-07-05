#!/usr/bin/env python3
"""Собирает docs/data.json для дашборда из data/watch_log.json и data/notes.json."""

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_LOG = ROOT / "data" / "watch_log.json"
NOTES_JSON = ROOT / "data" / "notes.json"
OUT = ROOT / "docs" / "data.json"


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"ВНИМАНИЕ: {path} повреждён, использую пустое значение", file=sys.stderr)
        return default


def main() -> int:
    watch_log = load_json(WATCH_LOG, [])
    notes = load_json(NOTES_JSON, {})

    items = []
    for vid, note in notes.items():
        if note.get("status") != "ok":
            continue
        items.append({
            "id": vid,
            "title": note.get("title", ""),
            "channel": note.get("channel", ""),
            "url": note.get("url", f"https://www.youtube.com/watch?v={vid}"),
            "watched_at": (note.get("watched_at") or "")[:10],
            "one_liner": note.get("one_liner", ""),
            "theses": note.get("theses", []),
            "key_points": note.get("key_points", []),
            "topics": note.get("topics", []),
            "tags": note.get("tags", []),
        })
    items.sort(key=lambda x: x["watched_at"], reverse=True)

    channels = Counter(r.get("channel") for r in watch_log if r.get("channel"))
    topics = Counter(t for i in items for t in i["topics"])
    tags = Counter(t for i in items for t in i["tags"])
    by_month = Counter(
        r["watched_at"][:7] for r in watch_log
        if r.get("watched_at") and len(r["watched_at"]) >= 7
    )

    data = {
        "items": items,
        "stats": {
            "total_watched": len(watch_log),
            "total_notes": len(items),
            "no_transcript": sum(
                1 for n in notes.values() if n.get("status") == "no_transcript"
            ),
            "top_channels": channels.most_common(15),
            "top_topics": topics.most_common(20),
            "top_tags": tags.most_common(30),
            "by_month": sorted(by_month.items()),
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"docs/data.json: {len(items)} конспектов, {len(watch_log)} просмотров.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
