import json
from datetime import datetime

from hoga.live.kis_client import KIS_KST


def row(bsop_hour: str, net_amount: int):
    from hoga.live.program_trade_store import ProgramTradeByStockRow

    return ProgramTradeByStockRow(
        code="005930",
        bsop_hour=bsop_hour,
        t_ms=0,
        price=70000,
        net_qty=net_amount // 1000,
        net_amount=net_amount,
        buy_qty=None,
        sell_qty=None,
        buy_amount=None,
        sell_amount=None,
        delta_qty=None,
        delta_amount=None,
    )


def test_program_trade_store_merges_rows_idempotently_and_sorts(tmp_path):
    from hoga.live.program_trade_store import ProgramTradeStore
    from hoga.api.timeenc import hhmmssms_to_unix_ms

    store = ProgramTradeStore(tmp_path)

    first = store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090030", 3000), row("090000", 1000)],
        observed_at_ms=1,
    )
    second = store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090030", 3333), row("090100", 5000)],
        observed_at_ms=2,
    )

    assert [p.bsop_hour for p in first.rows] == ["090000", "090030"]
    assert [p.bsop_hour for p in second.rows] == ["090000", "090030", "090100"]
    assert [p.net_amount for p in second.rows] == [1000, 3333, 5000]
    assert [p.t_ms for p in second.rows] == [
        hhmmssms_to_unix_ms("20260625", 90000000),
        hhmmssms_to_unix_ms("20260625", 90030000),
        hhmmssms_to_unix_ms("20260625", 90100000),
    ]
    body = json.loads((tmp_path / "kis-program-trade" / "005930" / "20260625.json").read_text())
    assert body["schema_version"] == 1
    assert body["source"] == "kis_program_trade"
    assert body["rows"][1]["observed_at_ms"] == 2


def test_program_trade_store_marks_gap_only_when_rolling_window_has_no_overlap(tmp_path):
    from hoga.live.program_trade_store import ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090000", 1000), row("090030", 2000)],
        observed_at_ms=1,
    )

    overlapped = store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090030", 2000), row("090100", 3000)],
        observed_at_ms=2,
    )
    gapped = store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090300", 4000), row("090330", 5000)],
        observed_at_ms=3,
    )

    assert overlapped.gap_events == []
    assert gapped.gap_events == [
        {
            "previous_latest": "090100",
            "new_oldest": "090300",
            "new_newest": "090330",
            "observed_at_ms": 3,
        }
    ]


def test_program_trade_store_ignores_stale_response(tmp_path):
    from hoga.live.program_trade_store import ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090300", 3000), row("090330", 3300)],
        observed_at_ms=1,
    )

    result = store.merge_response(
        code="005930",
        date="20260625",
        rows=[row("090000", 1000), row("090030", 2000)],
        observed_at_ms=2,
    )

    assert [p.bsop_hour for p in result.rows] == ["090300", "090330"]
    assert result.anomaly_events == [
        {
            "kind": "stale_or_out_of_order",
            "previous_latest": "090330",
            "new_oldest": "090000",
            "new_newest": "090030",
            "observed_at_ms": 2,
        }
    ]


def test_program_trade_store_quarantines_future_sidecar_and_accepts_current_rows(tmp_path):
    from hoga.live.program_trade_store import ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    store.merge_response(
        code="005930",
        date="20260626",
        rows=[row("152801", 15_280_100), row("180242", 18_024_200)],
        observed_at_ms=int(datetime(2026, 6, 26, 0, 37, 15, tzinfo=KIS_KST).timestamp() * 1000),
    )

    result = store.merge_response(
        code="005930",
        date="20260626",
        rows=[row("131155", 13_115_500), row("131544", 13_154_400)],
        observed_at_ms=int(datetime(2026, 6, 26, 13, 15, 50, tzinfo=KIS_KST).timestamp() * 1000),
    )

    assert [p.bsop_hour for p in result.rows] == ["131155", "131544"]
    assert result.anomaly_events == []
    backups = list((tmp_path / "kis-program-trade" / "005930").glob("20260626.json.poisoned-*"))
    assert len(backups) == 1
    backed_up = json.loads(backups[0].read_text())
    assert [p["bsop_hour"] for p in backed_up["rows"]] == ["152801", "180242"]


def test_load_cached_hits_unchanged_and_reloads_after_write(tmp_path):
    from datetime import datetime

    from hoga.live.program_trade_store import ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    obs = int(datetime(2026, 6, 26, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    store.merge_response(code="005930", date="20260626", rows=[row("100000", 1_000)], observed_at_ms=obs)

    a = store.load_cached("005930", "20260626")
    b = store.load_cached("005930", "20260626")
    assert a is b, "미변경 파일 2회째는 캐시 히트(동일 객체)"
    assert [p.bsop_hour for p in a.rows] == ["100000"]

    # merge_response 가 파일을 갱신(mtime 변경) → load_cached 는 새 데이터 반영.
    store.merge_response(code="005930", date="20260626", rows=[row("110000", 2_000)], observed_at_ms=obs + 1)
    c = store.load_cached("005930", "20260626")
    assert [p.bsop_hour for p in c.rows] == ["100000", "110000"]


def test_load_cached_does_not_poison_writer_path(tmp_path):
    """load_cached 로 캐시를 데운 뒤에도 writer(merge_response, uncached load)는 실제
    현재 파일에 병합해야 한다 — 캐시가 read-modify-write 를 오염시키면 안 된다."""
    from datetime import datetime

    from hoga.live.program_trade_store import ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    obs = int(datetime(2026, 6, 26, 10, 0, 0, tzinfo=KIS_KST).timestamp() * 1000)
    store.merge_response(code="005930", date="20260626", rows=[row("100000", 1_000)], observed_at_ms=obs)
    store.load_cached("005930", "20260626")  # 캐시 예열

    result = store.merge_response(
        code="005930", date="20260626", rows=[row("110000", 2_000)], observed_at_ms=obs + 1
    )
    assert [p.bsop_hour for p in result.rows] == ["100000", "110000"], "writer 는 기존 행 위에 병합"
