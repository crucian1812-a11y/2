# Hotel Rate Watch

Проверка тарифов отелей **по списку** и слежение за их динамикой. GitHub Actions
по расписанию тянет цены из [Amadeus Self-Service API](https://developers.amadeus.com),
копит историю срезов в `data/` и показывает дашборд на GitHub Pages.

Никакого парсинга сайтов — только официальный API, поэтому IP GitHub Actions
не банится (в отличие от прямого скрапинга Booking/Expedia).

## Как это работает

```
hotels.yml ──► check_rates.py ──► data/latest.json + data/history.jsonl
                                          │
                                   build_site.py ──► docs/data.json ──► docs/index.html
```

- `hotels.yml` — список целей: города (IATA `cityCode`) или конкретные отели (`hotelIds`).
- `scripts/check_rates.py` — получает токен Amadeus, резолвит отели по городу,
  запрашивает офферы на заданные даты, берёт самый дешёвый тариф по каждому отелю.
- `scripts/build_site.py` — готовит `docs/data.json` (последний срез + тренды цен).
- `docs/index.html` — статический дашборд: таблица тарифов по городам + спарклайны динамики.
- `.github/workflows/rates.yml` — cron (ежедневно 06:00 UTC), ручной запуск и запуск при
  изменении `hotels.yml`; коммитит собранные данные обратно в репозиторий.

## Настройка

1. **Ключ Amadeus.** Зарегистрируйтесь на [developers.amadeus.com](https://developers.amadeus.com),
   создайте app → получите `API Key` и `API Secret`.
2. **Секреты GitHub** (*Settings → Secrets and variables → Actions*):
   - *Secrets*: `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`;
   - *Variables* (опц.): `AMADEUS_ENV=test` (по умолчанию) или `production`.
3. **GitHub Pages**: *Settings → Pages* → Source: `Deploy from a branch`, ветка `main`,
   папка `/docs`.
4. **Права workflow**: *Settings → Actions → General → Workflow permissions* →
   `Read and write permissions` (нужно, чтобы бот коммитил данные).
5. Отредактируйте `hotels.yml` под свой список и запустите workflow
   **Check hotel rates** вручную (вкладка *Actions*) — после первого прогона появится дашборд.

## Локальный запуск

```bash
pip install -r requirements.txt

export AMADEUS_CLIENT_ID=xxx
export AMADEUS_CLIENT_SECRET=yyy
export AMADEUS_ENV=test          # test — бесплатная песочница

python scripts/check_rates.py    # соберёт data/latest.json + history.jsonl
python scripts/build_site.py     # соберёт docs/data.json
python -m http.server -d docs 8000   # http://localhost:8000
```

## Настройка списка (`hotels.yml`)

```yaml
search:
  check_in_offset_days: 14   # заезд через N дней от даты запуска
  nights: 1
  adults: 2
  currency: EUR
  max_hotels_per_city: 8

targets:
  - city: "Париж"
    cityCode: PAR
  - name: "Избранные отели"
    hotelIds: [MCLONGHM]
```

## Ограничения

- **Test-среда Amadeus** отдаёт ограниченный демо-набор отелей и цен — для реальных
  тарифов нужен `production`-ключ (бесплатный тир с квотой запросов).
- `cityCode` — это **IATA-код города** (PAR, BCN, TBS…), не название.
- Условие возвратности (`refundable`) выводится эвристически из политики отмены оффера.
- Rate limit Self-Service тира невысокий — не ставьте слишком большой
  `max_hotels_per_city` и много городов сразу.
