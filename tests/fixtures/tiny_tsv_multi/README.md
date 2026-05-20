# tiny_tsv_multi — multi-stock dummy fixtures (E2E only)

## Purpose

Per-code copies of `tests/fixtures/tiny_tsv/` for E2E specs that need more
than one stock (smoke test + multi-tab specs that reference 005930 삼성전자
and 000660 SK하이닉스).

These fixtures exist **only** for E2E (`tests/e2e/` setup scripts and
Playwright specs). No unit tests consume them — `tests/fixtures/tiny_tsv/`
remains the single source for the existing `tests/test_api.py` suite
(code=003490, date=20260519).

## Contents

```
tiny_tsv_multi/
├── 005930/         # 삼성전자
│   ├── info.tsv         # code/name swapped to 005930 / 삼성전자
│   ├── first_001.tsv    # copied verbatim from tiny_tsv/
│   └── chart.tsv        # copied verbatim from tiny_tsv/
└── 000660/         # SK하이닉스
    ├── info.tsv         # code/name swapped to 000660 / SK하이닉스
    ├── first_001.tsv    # copied verbatim from tiny_tsv/
    └── chart.tsv        # copied verbatim from tiny_tsv/
```

## Why "copy verbatim" rather than realistic data

The parser (`hoga/parser/__init__.py::parse_stock_date`) does not cross-check
that `first_001.tsv` / `chart.tsv` row contents reference the directory's
stock code — it just trusts the layout `data/raw/{date}/{code}/`. So
reusing the 003490 event/candle stream under a different code parses cleanly
and produces a non-empty bundle (orderbook + trades + brokers + candles).

The values inside (prices, broker names, etc.) are obviously not real
삼성전자 / SK하이닉스 data. That is intentional and acceptable: E2E specs
only need the API routes to return ≥1 row per slice so the replay viewer
can render.

If a future spec needs realistic per-code prices, replace the verbatim
copies with hand-crafted TSVs — the directory layout stays the same.

## How E2E setup consumes them

The E2E seed script (planned for Task W5.4) copies these into the runtime
`data/raw/<date>/<code>/` layout:

```bash
for code in 005930 000660; do
  mkdir -p "data/raw/$DATE/$code"
  cp tests/fixtures/tiny_tsv_multi/$code/*.tsv "data/raw/$DATE/$code/"
done
# then: uv run hoga parse --date $DATE  (or however the E2E harness invokes parse)
```

The seed picks whichever `$DATE` the spec needs — fixtures are
date-agnostic.

## What NOT to do

- Do not add unit tests that depend on these fixtures. Keep
  `tests/test_api.py` and friends bound to `tests/fixtures/tiny_tsv/`.
- Do not modify `tests/fixtures/tiny_tsv/` to add more stocks; the
  single-stock fixture is load-bearing for the existing 119-test suite.
