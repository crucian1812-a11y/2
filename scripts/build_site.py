#!/usr/bin/env python3
"""Build docs/data.json for the dashboard from data/watch_log.json + notes."""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_LOG = ROOT / "data" / "watch_log.json"
NOTES_JSON = ROOT / "data" / "notes.json"
OUTPUT = ROOT / "docs" / "data.json"


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return default


def main() -> None:
    watch_log: list = load_json(WATCH_LOG, [])
    notes: dict = load_json(NOTES_JSON, {})

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
    items.sort(key=lambda it: it["watched_at"], reverse=True)

    channels = Counter(
        r.get("channel") for r in watch_log if r.get("channel")
    )
    topics = Counter(t for it in items for t in it["topics"] if t)
    tags = Counter(t for it in items for t in it["tags"] if t)
    months = Counter(
        r["watched_at"][:7] for r in watch_log
        if r.get("watched_at") and len(r["watched_at"]) >= 7
    )

    stats = {
        "total_watched": len(watch_log),
        "total_notes": len(items),
        "no_transcript": sum(
            1 for n in notes.values() if n.get("status") == "no_transcript"
        ),
        "top_channels": channels.most_common(15),
        "top_topics": topics.most_common(20),
        "top_tags": tags.most_common(30),
        "by_month": sorted(months.items()),
    }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "items": items,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"data.json: {len(items)} notes, "
          f"{stats['total_watched']} watched, "
          f"{stats['no_transcript']} without transcript")


if __name__ == "__main__":
    main()
