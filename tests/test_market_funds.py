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


def test_credit_uses_the_whole_market_field():
    """코스피·코스닥이 갈려 있지만 카드는 전체를 쓴다 — 분리는 같은 응답에서 공짜."""
    body = _envelope([{
        "basDt": "20260803",
        "crdTrFingWhl": "27443853960691",
        "crdTrFingScrs": "21614091173422",
        "crdTrFingKosdaq": "5829762787269",
    }])
    assert mf.parse_single_value_series(body, field=mf.FIELD_CREDIT) == {
        "20260803": 27443853960691
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
    )
    assert merged == [
        {"date": "20260731", "deposit_won": 90, "credit_won": 27, "cma_won": None},
        {"date": "20260803", "deposit_won": 100, "credit_won": None, "cma_won": None},
    ]


def test_merge_is_date_ascending():
    merged = mf.merge_series({"20260805": 1, "20260731": 2}, {}, {})
    assert [r["date"] for r in merged] == ["20260731", "20260805"]


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
