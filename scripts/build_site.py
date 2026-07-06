#!/usr/bin/env python3
"""Build docs/data.json for the dashboard.

Besides the notes list and headline stats, exports the full watch log as
compact records ([id, title, channel, watched_at, kind]) and the search
log ([query, searched_at]) so the dashboard can compute detailed
statistics client-side — the same engine also powers files uploaded
directly in the browser.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_LOG = ROOT / "data" / "watch_log.json"
SEARCH_LOG = ROOT / "data" / "search_log.json"
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
    search_log: list = load_json(SEARCH_LOG, [])
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

    def short_title(t: str) -> str:
        # Post "titles" are whole post bodies — keep the payload lean.
        t = " ".join(t.split())
        return t[:157] + "…" if len(t) > 160 else t

    records = [
        [
            r.get("video_id", ""),
            short_title(r.get("title", "")),
            r.get("channel", ""),
            r.get("watched_at", ""),
            r.get("kind", "video"),
        ]
        for r in watch_log
    ]
    searches = [
        [s.get("query", ""), s.get("searched_at", "")] for s in search_log
    ]

    topics = Counter(t for it in items for t in it["topics"] if t)
    tags = Counter(t for it in items for t in it["tags"] if t)

    stats = {
        "total_watched": len(watch_log),
        "total_notes": len(items),
        "no_transcript": sum(
            1 for n in notes.values() if n.get("status") == "no_transcript"
        ),
        "top_topics": topics.most_common(20),
        "top_tags": tags.most_common(30),
    }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "items": items,
        "records": records,
        "searches": searches,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    size_mb = OUTPUT.stat().st_size / 1e6
    print(f"data.json: {len(items)} notes, {len(records)} records, "
          f"{len(searches)} searches, {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
