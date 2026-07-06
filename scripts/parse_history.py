#!/usr/bin/env python3
"""Merge watch-history sources from data/incoming/ into data/watch_log.json
and search queries into data/search_log.json.

Supported sources (mixed files are handled per-item):
  * Google Takeout watch history (RU/EN locales) — videos, community
    posts, ads, deleted videos;
  * Google Takeout search history;
  * browser extension logs — extension-*.json.

Record kinds: video | short | post | ad | deleted.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote_plus, urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
INCOMING = ROOT / "data" / "incoming"
WATCH_LOG = ROOT / "data" / "watch_log.json"
SEARCH_LOG = ROOT / "data" / "search_log.json"

VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/live/)([A-Za-z0-9_-]{11})")
POST_ID_RE = re.compile(r"/post/([A-Za-z0-9_-]+)")

# Takeout title prefixes per locale: "<action> <title>"
WATCH_PREFIXES = (
    "Watched ", "Просмотрено видео ", "Вы посмотрели ",
)
POST_PREFIXES = (
    "Viewed ", "Просмотрена запись ",
)
SEARCH_PREFIXES = (
    "Searched for ", "Выполнен поиск ",
)
AD_DETAILS = {"From Google Ads", "Из рекламы Google"}


def strip_prefix(title: str, prefixes) -> str:
    for p in prefixes:
        if title.startswith(p):
            return title[len(p):]
    return title


def extract_video_id(url: str) -> str | None:
    if not url:
        return None
    m = VIDEO_ID_RE.search(url)
    return m.group(1) if m else None


def is_ad(item: dict) -> bool:
    return any(d.get("name") in AD_DETAILS for d in item.get("details", []))


def parse_takeout_item(item: dict) -> tuple[str, dict] | None:
    """Return ("watch"|"search", record) or None for unrecognized items."""
    title = item.get("title", "")
    url = item.get("titleUrl", "")
    time_ = item.get("time", "")

    # --- search query ---
    for p in SEARCH_PREFIXES:
        if title.startswith(p):
            query = title[len(p):].strip()
            if not query and url:
                qs = parse_qs(urlparse(url).query)
                query = unquote_plus(qs.get("search_query", [""])[0])
            if not query:
                return None
            return "search", {"query": query, "searched_at": time_}

    subtitles = item.get("subtitles") or []
    channel = subtitles[0].get("name", "") if subtitles else ""
    ad = is_ad(item)

    # --- community post ---
    post_m = POST_ID_RE.search(url)
    if post_m or any(title.startswith(p) for p in POST_PREFIXES):
        pid = post_m.group(1) if post_m else ""
        clean = strip_prefix(title, POST_PREFIXES)
        return "watch", {
            "video_id": f"post:{pid}" if pid else "",
            "title": clean,
            "channel": channel,
            "url": url,
            "watched_at": time_,
            "source": "takeout",
            "kind": "ad" if ad else "post",
        }

    # --- video (possibly an ad or deleted) ---
    video_id = extract_video_id(url)
    clean = strip_prefix(title, WATCH_PREFIXES)
    if ad:
        return "watch", {
            "video_id": video_id or "",
            "title": "" if clean.startswith("http") else clean,
            "channel": channel,
            "url": url,
            "watched_at": time_,
            "source": "takeout",
            "kind": "ad",
        }
    if not video_id:
        # Watched entry with no recognizable URL and not an ad/post — skip.
        return None
    if clean.startswith("http") or not clean:
        # Title degraded to a bare URL — the video was deleted/unavailable.
        return "watch", {
            "video_id": video_id,
            "title": "",
            "channel": channel,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "watched_at": time_,
            "source": "takeout",
            "kind": "deleted",
        }
    kind = "short" if "/shorts/" in url else "video"
    return "watch", {
        "video_id": video_id,
        "title": clean,
        "channel": channel,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "watched_at": time_,
        "source": "takeout",
        "kind": kind,
    }


def parse_extension_item(item: dict) -> tuple[str, dict] | None:
    video_id = item.get("videoId") or extract_video_id(item.get("url", ""))
    if not video_id:
        return None
    kind = "short" if "/shorts/" in (item.get("url") or "") else "video"
    return "watch", {
        "video_id": video_id,
        "title": item.get("title", ""),
        "channel": item.get("channel", ""),
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "watched_at": item.get("watchedAt", ""),
        "source": "extension",
        "kind": kind,
    }


def parse_file(path: Path) -> tuple[list[dict], list[dict]]:
    """Return (watch_records, search_records)."""
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"  ! skipping {path.name}: {exc}", file=sys.stderr)
        return [], []
    if not isinstance(items, list) or not items:
        return [], []

    first = items[0] if isinstance(items[0], dict) else {}
    takeout = "titleUrl" in first or "time" in first or "header" in first
    if path.name.lower().startswith("extension-") and "videoId" in first:
        takeout = False

    watches, searches = [], []
    for item in items:
        if not isinstance(item, dict):
            continue
        parsed = (parse_takeout_item(item) if takeout
                  else parse_extension_item(item))
        if not parsed:
            continue
        bucket, record = parsed
        (searches if bucket == "search" else watches).append(record)
    return watches, searches


def watch_key(record: dict) -> str:
    day = (record.get("watched_at") or "")[:10]
    vid = record.get("video_id") or ""
    if record.get("kind") == "ad" and not vid:
        # Ads without a URL can only be keyed by exact timestamp.
        return f"ad|{record.get('watched_at', '')}"
    return f"{record.get('kind', 'video')}|{vid}|{day}"


def migrate(record: dict) -> dict:
    """Upgrade records written by earlier versions of this script."""
    if "kind" not in record:
        title = strip_prefix(record.get("title", ""), WATCH_PREFIXES)
        title = strip_prefix(title, POST_PREFIXES)
        if title.startswith("http"):
            record["kind"], record["title"] = "deleted", ""
        else:
            record["kind"], record["title"] = "video", title
    return record


def load_list(path: Path) -> list:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"  ! {path.name} is corrupt, starting fresh",
                  file=sys.stderr)
    return []


def main() -> None:
    existing = [migrate(r) for r in load_list(WATCH_LOG)]
    existing_searches = load_list(SEARCH_LOG)

    seen = {watch_key(r) for r in existing}
    seen_q = {(s["query"], s["searched_at"]) for s in existing_searches}

    new_w, new_s = [], []
    files = sorted(INCOMING.glob("*.json")) if INCOMING.exists() else []
    for path in files:
        watches, searches = parse_file(path)
        aw = as_ = 0
        for r in watches:
            k = watch_key(r)
            if k not in seen:
                seen.add(k)
                new_w.append(r)
                aw += 1
        for s in searches:
            k = (s["query"], s["searched_at"])
            if k not in seen_q:
                seen_q.add(k)
                new_s.append(s)
                as_ += 1
        print(f"  {path.name}: {len(watches)} watches ({aw} new), "
              f"{len(searches)} searches ({as_} new)")

    merged = existing + new_w
    merged.sort(key=lambda r: r.get("watched_at") or "", reverse=True)
    WATCH_LOG.parent.mkdir(parents=True, exist_ok=True)
    WATCH_LOG.write_text(
        json.dumps(merged, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8")

    all_s = existing_searches + new_s
    all_s.sort(key=lambda s: s.get("searched_at") or "", reverse=True)
    SEARCH_LOG.write_text(
        json.dumps(all_s, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8")

    print(f"watch_log.json: {len(merged)} total, {len(new_w)} new")
    print(f"search_log.json: {len(all_s)} total, {len(new_s)} new")


if __name__ == "__main__":
    main()
