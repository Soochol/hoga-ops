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


def fill_line(t_ms: int, buy: int, sell: int) -> str:
    return json.dumps({
        "kind": "fill", "t_ms": t_ms, "payload": {"buy_qty": buy, "sell_qty": sell},
    })


def assert_matches_full_parse(jsonl: Path) -> None:
    inc = _parse_jsonl_incremental(jsonl, code=CODE, date=DATE)
    full = _parse_jsonl_to_records(jsonl, code=CODE, date=DATE)
    # 레코드 4종 + meta.row_counts 전부 동일해야 한다.
    assert inc[0] == full[0], "snapshots 불일치"
    assert inc[1] == full[1], "trades 불일치"
    assert inc[2] == full[2], "broker_rows 불일치"
    assert inc[3] == full[3], "fills 불일치"
    assert inc[4]["row_counts"] == full[4]["row_counts"]
    assert sum(len(x) for x in full[:4]) > 0, "오라클이 공허 — 픽스처 시각 오류"


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
