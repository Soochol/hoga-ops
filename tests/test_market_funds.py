"""증시 주변 자금 파싱 — 실측(#1098)의 함정 셋을 고정한다.

값은 2026-08-05 실응답에서 가져왔다.
"""
from __future__ import annotations

import pytest

from hoga.live import market_funds as mf


def _envelope(items: list[dict]) -> dict:
    return {
        "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL SERVICE."},
            "body": {"items": {"item": items}, "totalCount": len(items)},
        }
    }


def test_encoding_key_is_normalized_and_idempotent():
    """Encoding 형을 params= 에 넘기면 이중 인코딩으로 인증이 깨진다 — decoded 로 돌린다."""
    encoded = "abc%2Bdef%3D%3D"
    decoded = mf.normalize_key(encoded)
    assert decoded == "abc+def=="
    # 이미 decoded 인 키에 걸어도 무해해야 한다(멱등)
    assert mf.normalize_key(decoded) == decoded


def test_deposit_series_from_real_row():
    body = _envelope([
        {"basDt": "20260803", "invrDpsgAmt": "102825552619394",
         "brkTrdUcolMny": "1566321843028"},
        {"basDt": "20260731", "invrDpsgAmt": "101000000000000"},
    ])
    got = mf.parse_single_value_series(body, field=mf.FIELD_DEPOSIT)
    assert got == {"20260803": 102825552619394, "20260731": 101000000000000}


def test_credit_reads_each_market_from_the_same_response():
    """코스피·코스닥 원본 필드를 사용하고 기존 합계도 보존한다."""
    body = _envelope([{
        "basDt": "20260803",
        "crdTrFingWhl": "27443853960691",
        "crdTrFingScrs": "21614091173422",
        "crdTrFingKosdaq": "5829762787269",
    }])
    assert mf.parse_single_value_series(body, field=mf.FIELD_CREDIT) == {
        "20260803": 27443853960691
    }
    assert mf.parse_single_value_series(body, field=mf.FIELD_CREDIT_KOSPI) == {
        "20260803": 21614091173422
    }
    assert mf.parse_single_value_series(body, field=mf.FIELD_CREDIT_KOSDAQ) == {
        "20260803": 5829762787269
    }


def test_cma_sums_only_the_total_rows():
    """⚠ 유형별 소계를 함께 더하면 합계 행과 **이중 계상**된다 (#1098)."""
    body = _envelope([
        {"basDt": "20260803", "mngInvTgt": "MMF형", "invrCtg": "개인", "actBal": "4237976374553"},
        {"basDt": "20260803", "mngInvTgt": "RP형", "invrCtg": "개인", "actBal": "1000000000000"},
        {"basDt": "20260803", "mngInvTgt": "합계", "invrCtg": "개인", "actBal": "60000000000000"},
        {"basDt": "20260803", "mngInvTgt": "합계", "invrCtg": "기관", "actBal": "28000000000000"},
    ])
    # 개인 합계 + 기관 합계만 — 소계(MMF·RP)는 무시
    assert mf.parse_cma_series(body) == {"20260803": 88000000000000}


def test_missing_value_is_none_not_zero():
    """세 오퍼레이션의 최신일이 어긋날 수 있다 — 0 으로 채우면 '그날 예탁금 0' 이라는 거짓말."""
    merged = mf.merge_series(
        deposit={"20260803": 100, "20260731": 90},
        credit={"20260731": 27},
        cma={},
        credit_kospi={"20260731": 21, "20260803": 22},
        credit_kosdaq={"20260731": 6},
    )
    assert merged == [
        {"date": "20260731", "deposit_won": 90, "credit_won": 27, "cma_won": None,
         "credit_kospi_won": 21, "credit_kosdaq_won": 6},
        {"date": "20260803", "deposit_won": 100, "credit_won": None, "cma_won": None,
         "credit_kospi_won": 22, "credit_kosdaq_won": None},
    ]


def test_merge_is_date_ascending():
    merged = mf.merge_series(
        {"20260805": 1, "20260731": 2}, {}, {},
        credit_kospi={"20260803": 3}, credit_kosdaq={},
    )
    assert [r["date"] for r in merged] == ["20260731", "20260803", "20260805"]


def test_single_item_envelope_is_not_a_list():
    """1건이면 리스트가 아니라 객체로 온다 — 그걸 0행으로 읽으면 조용히 빈다."""
    body = {
        "response": {
            "header": {"resultCode": "00"},
            "body": {"items": {"item": {"basDt": "20260803", "invrDpsgAmt": "5"}}},
        }
    }
    assert mf.parse_single_value_series(body, field=mf.FIELD_DEPOSIT) == {"20260803": 5}
    assert mf.result_code(body) == "00"


def test_empty_response_is_empty_not_error():
    body = {"response": {"header": {"resultCode": "00"}, "body": {"items": ""}}}
    assert mf.parse_single_value_series(body, field=mf.FIELD_DEPOSIT) == {}
    assert mf.parse_cma_series(body) == {}


@pytest.mark.asyncio
async def test_fetch_reuses_credit_response_and_preserves_missing_market(monkeypatch):
    from hoga.live import market_funds_runtime as runtime

    credit = _envelope([
        {"basDt": "20260803", "crdTrFingWhl": "27", "crdTrFingScrs": "21",
         "crdTrFingKosdaq": "6"},
        {"basDt": "20260804", "crdTrFingWhl": "28", "crdTrFingScrs": "22"},
    ])
    calls = []

    async def fake_get(client, op, *, key, rows):
        calls.append(op)
        return credit if op == mf.OP_CREDIT else _envelope([])

    monkeypatch.setattr(runtime, "_get", fake_get)
    rows = await runtime.fetch_series(key="test-key")
    assert calls.count(mf.OP_CREDIT) == 1
    assert rows[0]["credit_kospi_won"] == 21
    assert rows[0]["credit_kosdaq_won"] == 6
    assert rows[1]["credit_kospi_won"] == 22
    assert rows[1]["credit_kosdaq_won"] is None


@pytest.mark.parametrize("series", [
    [],
    [{"date": "20260803", "deposit_won": 100, "credit_kospi_won": 21, "credit_kosdaq_won": 6}],
    [{"date": "20260804", "credit_kospi_won": 22}],
])
def test_funds_http_response_preserves_market_balances(monkeypatch, tmp_path, series):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api.market_routes import build_router
    from hoga.live.market_funds_runtime import MarketFundsCache

    async def fake_get(self):
        return {"series": series, "as_of": series[-1]["date"] if series else None}

    monkeypatch.setattr(MarketFundsCache, "get", fake_get)
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    with TestClient(app) as client:
        response = client.get("/api/market/funds")
    assert response.status_code == 200
    rows = response.json()["series"]
    assert len(rows) == len(series)
    for source, row in zip(series, rows, strict=True):
        for field in ("deposit_won", "credit_kospi_won", "credit_kosdaq_won"):
            assert row[field] == source.get(field)


# ── 런타임 캐시 ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_missing_key_leaves_only_this_card_empty():
    """무자격이면 이 카드만 빈다 — 예외를 던지지 않는다(ADR-0134)."""
    from hoga.live.market_funds_runtime import MarketFundsCache

    cache = MarketFundsCache()
    got = await cache.get(key_fn=lambda: None)
    assert got["unavailable"] == "credentials_missing"
    assert got["series"] == []
    assert got["as_of"] is None


@pytest.mark.asyncio
async def test_as_of_comes_from_the_response_not_a_constant():
    """T+2 는 관측이지 계약이 아니다 — 기준일은 응답에서 온다(#1098)."""
    from hoga.live.market_funds_runtime import MarketFundsCache

    async def _fetch(*, key):  # noqa: ANN001, ARG001
        return [
            {"date": "20260731", "deposit_won": 1, "credit_won": 2, "cma_won": 3},
            {"date": "20260803", "deposit_won": 4, "credit_won": 5, "cma_won": 6},
        ]

    cache = MarketFundsCache()
    got = await cache.get(key_fn=lambda: "k", fetch=_fetch)
    assert got["as_of"] == "20260803"   # 마지막(최신) 행의 날짜
    assert got["unavailable"] is None
    assert len(got["series"]) == 2


@pytest.mark.asyncio
async def test_cache_is_single_flight_and_keeps_last_good():
    from hoga.live.market_funds_runtime import MarketFundsCache

    calls = {"n": 0}

    async def _fetch(*, key):  # noqa: ANN001, ARG001
        calls["n"] += 1
        if calls["n"] > 1:
            return []          # 이후 실패(빈 응답)
        return [{"date": "20260803", "deposit_won": 1, "credit_won": None, "cma_won": None}]

    cache = MarketFundsCache(ttl_s=0.0)  # 항상 만료
    first = await cache.get(key_fn=lambda: "k", fetch=_fetch)
    second = await cache.get(key_fn=lambda: "k", fetch=_fetch)
    assert first["as_of"] == "20260803"
    # 빈 응답이 last-good 을 지우면 안 된다
    assert second["as_of"] == "20260803"
    assert second["series"] == first["series"]


@pytest.mark.asyncio
async def test_cache_picks_up_next_day_publication_after_thirty_seconds(monkeypatch):
    from hoga.live import market_funds_runtime as runtime

    clock = {"now": 0.0}
    monkeypatch.setattr(runtime.time, "monotonic", lambda: clock["now"])
    published = {"date": "20261021"}
    calls = []

    async def fetch(*, key):
        calls.append(published["date"])
        return [{"date": published["date"], "deposit_won": 100,
                 "credit_kospi_won": 23, "credit_kosdaq_won": 6}]

    cache = runtime.MarketFundsCache()
    assert (await cache.get(key_fn=lambda: "k", fetch=fetch))["as_of"] == "20261021"
    published["date"] = "20261022"
    clock["now"] = 29.0
    assert (await cache.get(key_fn=lambda: "k", fetch=fetch))["as_of"] == "20261021"
    assert len(calls) == 1
    clock["now"] = 30.0
    updated = await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert updated["as_of"] == "20261022"
    assert updated["series"][-1]["credit_kospi_won"] == 23
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_empty_cold_cache_throttles_shared_requests_and_retries(monkeypatch):
    import asyncio

    from hoga.live import market_funds_runtime as runtime

    clock = {"now": 0.0}
    monkeypatch.setattr(runtime.time, "monotonic", lambda: clock["now"])
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def fetch(*, key):
        calls.append(key)
        entered.set()
        await release.wait()
        return []

    cache = runtime.MarketFundsCache()
    first = asyncio.create_task(cache.get(key_fn=lambda: "k", fetch=fetch))
    await entered.wait()
    others = [asyncio.create_task(cache.get(key_fn=lambda: "k", fetch=fetch)) for _ in range(5)]
    release.set()
    results = await asyncio.gather(first, *others)
    assert all(result["series"] == [] for result in results)
    assert len(calls) == 1
    clock["now"] = 29.0
    await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert len(calls) == 1
    clock["now"] = 30.0
    await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_partial_and_older_refreshes_preserve_observed_balances():
    from hoga.live.market_funds_runtime import MarketFundsCache

    responses = iter([
        [{"date": "20261021", "deposit_won": 100, "credit_kospi_won": 23, "credit_kosdaq_won": 6}],
        [{"date": "20261021", "deposit_won": 99, "credit_kospi_won": None, "credit_kosdaq_won": None},
         {"date": "20261022", "deposit_won": 98, "credit_kospi_won": None, "credit_kosdaq_won": None}],
        [{"date": "20261022", "deposit_won": None, "credit_kospi_won": 24, "credit_kosdaq_won": 0}],
        [{"date": "20261020", "deposit_won": 101, "credit_kospi_won": 22, "credit_kosdaq_won": 7}],
    ])

    async def fetch(*, key):
        return next(responses)

    cache = MarketFundsCache(ttl_s=0.0)
    await cache.get(key_fn=lambda: "k", fetch=fetch)
    partial = await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert partial["series"][0]["credit_kospi_won"] == 23
    assert partial["series"][-1]["credit_kospi_won"] is None
    updated = await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert updated["series"][-1] == {
        "date": "20261022", "deposit_won": 98, "credit_kospi_won": 24, "credit_kosdaq_won": 0,
    }
    older = await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert older["as_of"] == "20261022"
    assert older["series"][-1] == updated["series"][-1]


@pytest.mark.asyncio
async def test_refresh_history_stays_bounded():
    from datetime import date, timedelta

    from hoga.live import market_funds_runtime as runtime

    rows = [{"date": (date(2026, 1, 1) + timedelta(days=i)).strftime("%Y%m%d"),
             "deposit_won": i} for i in range(runtime.DEFAULT_ROWS + 1)]
    responses = iter([rows[:-1], rows[-1:]])

    async def fetch(*, key):
        return next(responses)

    cache = runtime.MarketFundsCache(ttl_s=0.0)
    await cache.get(key_fn=lambda: "k", fetch=fetch)
    updated = await cache.get(key_fn=lambda: "k", fetch=fetch)
    assert updated["series"] == rows[1:]
