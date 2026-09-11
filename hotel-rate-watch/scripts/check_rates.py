#!/usr/bin/env python3
"""Тянет тарифы отелей из Amadeus Self-Service API по списку из hotels.yml.

Результат:
  data/latest.json          — последний срез тарифов (по одному дешёвому офферу на отель);
  data/history.jsonl        — история срезов (по строке JSON на каждый запуск), для графиков.

Ключи берутся из окружения (в CI — из GitHub Secrets):
  AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET
  AMADEUS_ENV = test | production   (по умолчанию test)

Без ключей скрипт завершится с понятной ошибкой и НЕ тронет уже собранные данные.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "hotels.yml"
DATA = ROOT / "data"
LATEST = DATA / "latest.json"
HISTORY = DATA / "history.jsonl"

BASES = {
    "test": "https://test.api.amadeus.com",
    "production": "https://api.amadeus.com",
}

# hotelIds за один запрос к hotel-offers, чтобы не упереться в длину URL.
BATCH = 20
# Пауза между запросами — бережём rate limit Self-Service тира.
PAUSE = 0.4


def die(msg: str, code: int = 1) -> None:
    print(f"ОШИБКА: {msg}", file=sys.stderr)
    sys.exit(code)


def get_token(base: str, cid: str, secret: str) -> str:
    r = requests.post(
        f"{base}/v1/security/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": cid,
            "client_secret": secret,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    if r.status_code != 200:
        die(f"не удалось получить токен Amadeus ({r.status_code}): {r.text[:300]}")
    return r.json()["access_token"]


def api_get(base: str, path: str, token: str, params: dict) -> dict:
    """GET к Amadeus с одним ретраем на 429 (rate limit)."""
    url = f"{base}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(2):
        r = requests.get(url, headers=headers, params=params, timeout=40)
        if r.status_code == 429 and attempt == 0:
            time.sleep(2)
            continue
        if r.status_code >= 400:
            # 400/404 по конкретному городу не должны валить весь прогон
            print(
                f"  предупреждение: {path} -> {r.status_code}: {r.text[:200]}",
                file=sys.stderr,
            )
            return {}
        return r.json()
    return {}


def hotels_by_city(base: str, token: str, city_code: str, limit: int) -> list[str]:
    data = api_get(
        base,
        "/v1/reference-data/locations/hotels/by-city",
        token,
        {"cityCode": city_code, "radius": 20, "radiusUnit": "KM"},
    )
    ids = [h["hotelId"] for h in data.get("data", []) if h.get("hotelId")]
    return ids[:limit]


def cheapest_offer(hotel_entry: dict) -> dict | None:
    offers = hotel_entry.get("offers") or []
    if not offers:
        return None
    best = min(offers, key=lambda o: float(o.get("price", {}).get("total", "inf")))
    price = best.get("price", {})
    room = best.get("room", {})
    est = room.get("typeEstimated", {}) or {}
    policies = best.get("policies", {}) or {}
    cancellations = policies.get("cancellations") or []
    refundable = None
    if cancellations:
        # эвристика: есть дедлайн отмены без штрафа => возвратный
        refundable = any(
            c.get("amount", "0") in ("0", "0.00", 0) or c.get("deadline")
            for c in cancellations
        )
    return {
        "price": float(price.get("total")) if price.get("total") else None,
        "currency": price.get("currency"),
        "room_category": est.get("category"),
        "beds": est.get("beds"),
        "bed_type": est.get("bedType"),
        "board": best.get("boardType"),
        "refundable": refundable,
    }


def fetch_offers(
    base: str, token: str, hotel_ids: list[str], search: dict, check_in: str, check_out: str
) -> dict[str, dict]:
    """Возвращает {hotelId: {name, offer}} по батчам."""
    out: dict[str, dict] = {}
    for i in range(0, len(hotel_ids), BATCH):
        chunk = hotel_ids[i : i + BATCH]
        data = api_get(
            base,
            "/v3/shopping/hotel-offers",
            token,
            {
                "hotelIds": ",".join(chunk),
                "adults": search["adults"],
                "checkInDate": check_in,
                "checkOutDate": check_out,
                "roomQuantity": 1,
                "currency": search["currency"],
                "bestRateOnly": "true",
            },
        )
        for entry in data.get("data", []):
            hotel = entry.get("hotel", {})
            hid = hotel.get("hotelId")
            if not hid or not entry.get("available", True):
                continue
            offer = cheapest_offer(entry)
            if offer:
                out[hid] = {"name": hotel.get("name", hid), "offer": offer}
        time.sleep(PAUSE)
    return out


def main() -> None:
    cid = os.environ.get("AMADEUS_CLIENT_ID")
    secret = os.environ.get("AMADEUS_CLIENT_SECRET")
    if not cid or not secret:
        die(
            "не заданы AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET. "
            "Заведите ключ на developers.amadeus.com и положите в GitHub Secrets."
        )

    env = os.environ.get("AMADEUS_ENV", "test").lower()
    base = BASES.get(env)
    if not base:
        die(f"AMADEUS_ENV должно быть test или production, а не {env!r}")

    cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    search = cfg["search"]
    targets = cfg["targets"]

    now = datetime.now(timezone.utc)
    check_in = (now + timedelta(days=int(search["check_in_offset_days"]))).date()
    check_out = check_in + timedelta(days=int(search["nights"]))
    ci, co = check_in.isoformat(), check_out.isoformat()

    print(f"Amadeus [{env}] · заезд {ci} · выезд {co} · {search['adults']} гостя")
    token = get_token(base, cid, secret)

    DATA.mkdir(exist_ok=True)
    rows: list[dict] = []

    for t in targets:
        label = t.get("city") or t.get("name") or "?"
        if t.get("cityCode"):
            ids = hotels_by_city(base, token, t["cityCode"], int(search["max_hotels_per_city"]))
            print(f"· {label} ({t['cityCode']}): найдено {len(ids)} отелей")
        else:
            ids = list(t.get("hotelIds") or [])
            print(f"· {label}: {len(ids)} отелей из конфига")
        if not ids:
            continue

        found = fetch_offers(base, token, ids, search, ci, co)
        for hid, info in found.items():
            o = info["offer"]
            rows.append(
                {
                    "target": label,
                    "hotel_id": hid,
                    "hotel": info["name"],
                    "price": o["price"],
                    "currency": o["currency"],
                    "room": o["room_category"],
                    "board": o["board"],
                    "refundable": o["refundable"],
                }
            )
        print(f"    тарифов получено: {len(found)}")

    if not rows:
        die("ни одного тарифа не получено — данные не перезаписываю", code=2)

    rows.sort(key=lambda r: (r["target"], r["price"] if r["price"] is not None else 1e12))
    snapshot = {
        "collected_at": now.isoformat(),
        "check_in": ci,
        "check_out": co,
        "nights": int(search["nights"]),
        "adults": int(search["adults"]),
        "rows": rows,
    }

    LATEST.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    with HISTORY.open("a", encoding="utf-8") as f:
        f.write(json.dumps(snapshot, ensure_ascii=False) + "\n")

    print(f"Готово: {len(rows)} тарифов → {LATEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
