"""Today Promotion 증분 파싱(_parse_jsonl_incremental)의 패리티·경계 계약.

핵심 불변식: 어떤 append 시퀀스에서도 증분 결과는 "그 시점 파일 전체를
전량 파싱(_parse_jsonl_to_records)"한 것과 동일해야 한다 — 전량 파서가
프로덕션에 상존하므로 오라클로 쓴다(캡처 파서 차등 오라클과 같은 수법).
"""
from __future__ import annotations

import json
from pathlib import Path

from hoga.live.promote import (
    _TODAY_PARSE_STATES,
    _parse_jsonl_incremental,
    _parse_jsonl_to_records,
)

DATE = "20260711"
CODE = "005930"
# 2026-07-11 10:00:00 KST — unix_ms_to_hhmmssms가 date 일치를 요구한다.
T0 = 1_783_731_600_000


def ob_line(t_ms: int, price: int) -> str:
    return json.dumps({
        "kind": "ob", "t_ms": t_ms,
        "payload": {
            "asks": [{"price": price + 50 * i, "qty": 10 + i} for i in range(10)],
            "bids": [{"price": price - 50 * (i + 1), "qty": 20 + i} for i in range(10)],
            "total_ask_qty": 145, "total_bid_qty": 245,
        },
    })


def trade_line(t_ms: int, price: int, qty: int, side: int) -> str:
    return json.dumps({
        "kind": "trade", "t_ms": t_ms,
        "payload": {"trades": [{"price": price, "qty": qty, "side": side}]},
    })


def broker_line(t_ms: int) -> str:
    return json.dumps({
        "kind": "broker", "t_ms": t_ms,
        "payload": {
            "sell_top": [{"name": f"셀{i}", "qty": 100 + i} for i in range(5)],
            "buy_top": [{"name": f"바이{i}", "qty": 200 + i} for i in range(5)],
        },
    })


def candle_line(t_ms: int, o: int, h: int, low: int, c: int, vol: int) -> str:
    """`MinuteCandleAggregator.flush` 가 내보내는 봉 한 줄(ADR-0125)."""
    return json.dumps({
        "kind": "candle", "t_ms": t_ms,
        "payload": {"open": o, "high": h, "low": low, "close": c, "volume": vol},
    })


def fill_line(t_ms: int, buy: int, sell: int) -> str:
    return json.dumps({
        "kind": "fill", "t_ms": t_ms, "payload": {"buy_qty": buy, "sell_qty": sell},
    })


def assert_matches_full_parse(jsonl: Path) -> None:
    inc = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)
    full = _parse_jsonl_to_records(jsonl, code=CODE, date=DATE)
    # 레코드 5종 + meta.row_counts 전부 동일해야 한다.
    assert inc[0] == full[0], "snapshots 불일치"
    assert inc[1] == full[1], "trades 불일치"
    assert inc[2] == full[2], "broker_rows 불일치"
    assert inc[3] == full[3], "fills 불일치"
    assert inc[4] == full[4], "candles 불일치"
    assert inc[5]["row_counts"] == full[5]["row_counts"]
    assert sum(len(x) for x in full[:5]) > 0, "오라클이 공허 — 픽스처 시각 오류"


def test_incremental_appends_match_full_parse(tmp_path: Path) -> None:
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"
    batches = [
        [ob_line(T0, 25000), trade_line(T0 + 500, 25000, 5, 1)],
        [broker_line(T0 + 1000), fill_line(T0 + 1500, 30, 20)],
        [ob_line(T0 + 2000, 25050), trade_line(T0 + 2500, 25050, 3, -1),
         trade_line(T0 + 3000, 25100, 7, 1)],
    ]
    written = ""
    for batch in batches:
        written += "".join(line + "\n" for line in batch)
        jsonl.write_text(written, encoding="utf-8")
        assert_matches_full_parse(jsonl)


def test_partial_trailing_line_deferred_not_lost(tmp_path: Path) -> None:
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"
    complete = ob_line(T0, 25000) + "\n"
    partial = trade_line(T0 + 500, 25000, 5, 1)  # 개행 없음 = 쓰기 도중
    jsonl.write_text(complete + partial[:20], encoding="utf-8")

    snaps, trades, *_ = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)
    assert len(snaps) == 1
    assert len(trades) == 0  # 부분 라인은 소비하지 않음 (스킵도 아님)

    # 라인 완성 → 다음 사이클에 정확히 1회 집계.
    jsonl.write_text(complete + partial + "\n", encoding="utf-8")
    snaps, trades, *_ = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)
    assert len(snaps) == 1
    assert len(trades) == 1
    assert_matches_full_parse(jsonl)


def test_truncation_resets_to_full_reparse(tmp_path: Path) -> None:
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"
    jsonl.write_text(ob_line(T0, 25000) + "\n" + ob_line(T0 + 1000, 25050) + "\n")
    _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)

    # 파일 축소(회전) 후 새 내용 — 오프셋이 남의 바이트를 가리키면 안 된다.
    jsonl.write_text(trade_line(T0 + 2000, 25100, 9, 1) + "\n")
    snaps, trades, *_ = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)
    assert len(snaps) == 0
    assert len(trades) == 1
    assert_matches_full_parse(jsonl)


def test_state_keyed_by_path_and_pruned_on_date_change(tmp_path: Path) -> None:
    _TODAY_PARSE_STATES.clear()
    a = tmp_path / "a" / f"{CODE}.jsonl"
    b = tmp_path / "b" / f"{CODE}.jsonl"
    a.parent.mkdir(); b.parent.mkdir()
    a.write_text(ob_line(T0, 25000) + "\n")
    b.write_text(trade_line(T0 + 500, 25000, 5, 1) + "\n")

    # 같은 (code, date)라도 경로가 다르면 상태를 공유하지 않는다 — 단
    # 프루닝 규칙상 최신 키 하나만 유지되므로 각 호출은 독립적으로 정확하다.
    snaps_a, trades_a, *_ = _parse_jsonl_incremental(a, code=CODE, date=DATE)
    assert (len(snaps_a), len(trades_a)) == (1, 0)
    snaps_b, trades_b, *_ = _parse_jsonl_incremental(b, code=CODE, date=DATE)
    assert (len(snaps_b), len(trades_b)) == (0, 1)
    assert len(_TODAY_PARSE_STATES) == 1  # 프루닝: (source, code)당 1키


def test_malformed_lines_skip_identically(tmp_path: Path) -> None:
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"
    jsonl.write_text(
        "not-json\n"
        + json.dumps({"kind": "ob", "t_ms": "NaN", "payload": {}}) + "\n"
        + ob_line(T0, 25000) + "\n",
    )
    assert_matches_full_parse(jsonl)


# === 쪼개진 분봉의 승격 (2026-08-22) ===
#
# 생산자(`MinuteCandleAggregator`)는 봉을 거래소 체결시간으로 버킷팅하면서 봉인은
# 로컬 벽시계로 하고 허용 지연이 0이라, 봉인 뒤 도착한 틱이 **같은 분의 두 번째 봉**을
# 만든다. 실측 지연: 추가 조각은 분 종료 후 10~120초. 승격이 그 조각을 접지 않으면
# 파케이가 ``series.candles_ts_monotonic``(Severity.error)을 위반한 채 쓰인다.

MINUTE_MS = 60_000


def test_full_parse_folds_a_minute_split_across_flushes(tmp_path: Path) -> None:
    """한 분이 두 줄로 나뉘어 들어와도 파케이 행은 하나다.

    값은 실측 파일에서 가져왔다(005930/20260820 09:08: 107,264 → 39,722).
    """
    jsonl = tmp_path / f"{CODE}.jsonl"
    jsonl.write_text("".join(line + "\n" for line in [
        candle_line(T0, 252750, 253500, 252500, 253000, 107264),          # 조각 1
        candle_line(T0, 253250, 254000, 253000, 253500, 39722),           # 조각 2(늦음)
        candle_line(T0 + MINUTE_MS, 253500, 254500, 253500, 254000, 90000),
    ]), encoding="utf-8")

    candles = _parse_jsonl_to_records(jsonl, code=CODE, date=DATE)[4]

    assert len(candles) == 2
    assert [c.ts_ms for c in candles] == [36_000_000, 36_060_000]  # 10:00 · 10:01
    assert candles[0].open_ == 252750    # 첫 조각
    assert candles[0].close_ == 253500   # 마지막 조각
    assert candles[0].high == 254000
    assert candles[0].low == 252500
    assert candles[0].vol_a == 146986    # 합


def test_incremental_folds_a_fragment_that_arrives_in_a_later_pass(tmp_path: Path) -> None:
    """조각 2가 **다음 승격 주기**에 도착해도 행은 하나이고 거래량은 정확히 한 번 더해진다.

    **막는 방향**: 증분 파서의 누적 상태(`_JsonlParseState.candles`)를 병합이 변이하는
    것. 변이하면 이 2회차가 **이미 접힌 행에 조각 2를 또 더해** 거래량이 부푼다 —
    1회차만 보는 테스트로는 원리적으로 못 잡는 방향이다.

    **못 보는 것**: 조각을 만드는 생산자는 그대로다. 이것은 파생 테이블을 만들 때의
    정규화이지, JSONL 이 도착 로그라는 사실을 바꾸지 않는다.
    """
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"

    first = candle_line(T0, 252750, 253500, 252500, 253000, 107264) + "\n"
    jsonl.write_text(first, encoding="utf-8")
    candles = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)[4]
    assert [(c.ts_ms, c.vol_a) for c in candles] == [(36_000_000, 107264)]

    # 2회차: 같은 분의 늦은 조각이 붙는다.
    jsonl.write_text(
        first + candle_line(T0, 253250, 254000, 253000, 253500, 39722) + "\n",
        encoding="utf-8",
    )
    candles = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)[4]
    assert [(c.ts_ms, c.vol_a) for c in candles] == [(36_000_000, 146986)]
    assert (candles[0].open_, candles[0].close_) == (252750, 253500)

    # 3회차: 새 줄이 없으면 값이 더 움직이지 않는다(멱등 — 변이 감지의 두 번째 각도).
    candles = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)[4]
    assert [(c.ts_ms, c.vol_a) for c in candles] == [(36_000_000, 146986)]
    assert_matches_full_parse(jsonl)


def test_incremental_and_full_agree_on_a_non_adjacent_fragment(tmp_path: Path) -> None:
    """``M 조각1, M+1, M 조각2`` 배치에서도 두 파서가 같은 답을 낸다."""
    _TODAY_PARSE_STATES.clear()
    jsonl = tmp_path / f"{CODE}.jsonl"
    jsonl.write_text("".join(line + "\n" for line in [
        candle_line(T0, 252750, 253500, 252500, 253000, 107264),
        candle_line(T0 + MINUTE_MS, 253500, 254500, 253500, 254000, 90000),
        candle_line(T0, 253250, 254000, 253000, 253500, 39722),  # 60초 넘게 늦음
    ]), encoding="utf-8")

    candles = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)[4]
    assert [(c.ts_ms, c.vol_a) for c in candles] == [
        (36_000_000, 146986), (36_060_000, 90000),
    ]
    assert_matches_full_parse(jsonl)
