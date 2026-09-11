#!/usr/bin/env python3
"""Собирает docs/data.json для дашборда из data/latest.json и data/history.jsonl.

Дашборд статический (docs/index.html), поэтому здесь только готовим данные:
  - последний срез тарифов;
  - динамику минимальной цены по каждому отелю (по истории).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LATEST = DATA / "latest.json"
HISTORY = DATA / "history.jsonl"
OUT = ROOT / "docs" / "data.json"


def load_history() -> list[dict]:
    if not HISTORY.exists():
        return []
    snaps = []
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                snaps.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return snaps


def main() -> None:
    latest = json.loads(LATEST.read_text(encoding="utf-8")) if LATEST.exists() else None
    history = load_history()

    # Тренд цены по каждому отелю: [{ts, price}] из всех срезов.
    trends: dict[str, dict] = {}
    for snap in history:
        ts = snap.get("collected_at")
        for row in snap.get("rows", []):
            hid = row.get("hotel_id")
            if not hid or row.get("price") is None:
                continue
            entry = trends.setdefault(
                hid, {"hotel": row.get("hotel"), "currency": row.get("currency"), "points": []}
            )
            entry["points"].append({"ts": ts, "price": row["price"]})

    OUT.parent.mkdir(exist_ok=True)
    payload = {
        "generated_at": latest.get("collected_at") if latest else None,
        "latest": latest,
        "trends": trends,
        "snapshots": len(history),
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"docs/data.json собран: {len(trends)} отелей, {len(history)} срезов")


if __name__ == "__main__":
    main()
