"""promote_kiwoom_today 골든 — live_kiwoom JSONL → kiwoom_live parquet (ADR-0116)."""
import json

import polars as pl

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.promote import _today_kst_yyyymmdd, promote_kiwoom_today


async def test_promote_kiwoom_today_writes_kiwoom_live_parquet(tmp_path):
    today = _today_kst_yyyymmdd()  # promote_kiwoom_today가 오늘 KST를 읽으므로 동일 날짜로 시딩
    jsonl_path = tmp_path / "live_kiwoom" / today / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    base_t = hhmmssms_to_unix_ms(today, 90000000)  # 09:00:00.000 KST
    lines = []
    for tick in range(2):
        t = base_t + tick * 10_000
        lines.append(json.dumps({"t_ms": t, "kind": "ob", "payload": {
            "code": "005930", "t_ms": t,
            "asks": [{"price": 75000 + i, "qty": 100 + i} for i in range(10)],
            "bids": [{"price": 74990 - i, "qty": 200 + i} for i in range(10)],
            "total_ask_qty": 1500, "total_bid_qty": 2500, "phase": "regular",
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "trade", "payload": {
            "trades": [{"t_ms": t, "price": 75000, "qty": 5, "side": 1,
                        "side_source": "kiwoom_ws"}],
            "phase": "regular",
        }}))
    jsonl_path.write_text("\n".join(lines) + "\n")

    await promote_kiwoom_today(tmp_path, code="005930")

    target = tmp_path / "parquet" / today / "005930" / "kiwoom_live"
    assert (target / "snapshots.parquet").exists()
    assert (target / "trades.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    # 소스 태그가 kiwoom_live — 완결성 게이트/조회가 read-path에서 인식(PR-2).
    assert meta["source"] == "kiwoom_live"
    assert meta["code"] == "005930"
    assert meta["date"] == today
    # 실시간 WS라 sampling 메타 없음(_build_meta kis_api 분기 밖).
    assert "sampling_ms" not in meta
    assert meta["regular_session_open_ms"] == 90000000
    assert meta["regular_session_close_ms"] == 153000000

    snaps = pl.read_parquet(target / "snapshots.parquet")
    assert snaps.height == 2
    assert "ask_p1" in snaps.columns and "tot_ask" in snaps.columns


async def test_promote_kiwoom_today_noop_when_no_jsonl(tmp_path):
    # live_kiwoom JSONL 부재 → no-op(파일 안 만듦). KIS live_kiwoom 경로와 격리.
    await promote_kiwoom_today(tmp_path, code="005930")
    today = _today_kst_yyyymmdd()
    assert not (tmp_path / "parquet" / today / "005930" / "kiwoom_live").exists()


async def test_promote_pending_promotes_live_kiwoom_to_kiwoom_live(tmp_path):
    """리뷰 Major: promote_pending이 live_kiwoom 과거일 JSONL도 kiwoom_live parquet로
    승격+아카이브 — 크래시/이탈 후 미승격·디스크 무한증가 방지."""
    import json as _json

    from hoga.live.promote import promote_pending

    # 과거일(오늘 아님) live_kiwoom JSONL 시딩.
    jsonl = tmp_path / "live_kiwoom" / "20260527" / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(_json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"asks": [], "bids": [], "code": "005930", "t_ms": 1,
                    "total_ask_qty": 0, "total_bid_qty": 0, "phase": "regular"},
    }) + "\n")

    await promote_pending(tmp_path)

    target = tmp_path / "parquet" / "20260527" / "005930" / "kiwoom_live"
    assert (target / "meta.json").exists()
    assert _json.loads((target / "meta.json").read_text())["source"] == "kiwoom_live"
    # 아카이브 이동(live_kiwoom/_archive).
    assert (tmp_path / "live_kiwoom" / "_archive" / "20260527" / "005930.jsonl").exists()
    assert not jsonl.exists()
