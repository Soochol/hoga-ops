"""ADR-0037 source-aware data slice 회귀 테스트 (5/27 버그)."""
import json
from pathlib import Path

import polars as pl
import pytest

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine


def _write_meta(path: Path, **kwargs) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    default = {
        "source": "kis_live",
        "code": "003490",
        "date": "20260527",
        "promoted_at": "2026-05-28T09:00:00+00:00",
        "row_counts": {"snapshots": 1, "trades": 0, "brokers": 0},
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }
    default.update(kwargs)
    path.write_text(json.dumps(default, indent=2))


def _write_snapshots(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _write_empty_candles(path: Path) -> None:
    """Write an empty candles.parquet with the required schema."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "ts_ms": pl.Series([], dtype=pl.Int64),
        "open": pl.Series([], dtype=pl.Int64),
        "close": pl.Series([], dtype=pl.Int64),
        "high": pl.Series([], dtype=pl.Int64),
        "low": pl.Series([], dtype=pl.Int64),
        "vol_a": pl.Series([], dtype=pl.Int64),
        "vol_b": pl.Series([], dtype=pl.Int64),
    }).write_parquet(path)


def _write_empty_trades(path: Path) -> None:
    """Write an empty trades.parquet with the required schema."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "ts_ms": pl.Series([], dtype=pl.Int64),
        "price": pl.Series([], dtype=pl.Int64),
        "qty": pl.Series([], dtype=pl.Int64),
        "side": pl.Series([], dtype=pl.Int8),
    }).write_parquet(path)


def _snap(t_hhmmssms: int, total_bid: int, total_ask: int) -> dict:
    """Build a snapshot row matching snapshots.parquet schema (ts_ms + 10-level orderbook)."""
    base: dict = {"ts_ms": t_hhmmssms, "seq": 0}
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            base[f"{prefix}{i}"] = 0
    # Inject non-zero bid_q / ask_q values so the query returns something useful
    base["bid_q1"] = total_bid
    base["ask_q1"] = total_ask
    base.update({"tot_ask": total_ask, "tot_ask_d": 0, "tot_bid": total_bid, "tot_bid_d": 0})
    return base


def test_dual_source_5_27_scenario(tmp_path: Path) -> None:
    """5/27 시나리오: 손상된 top-level hogaplay + 정상 kis_live/.

    Expected: source preference가 hogaplay여도 hogaplay/ 가 없으므로 kis_live
    fallback. 그리고 슬라이스가 kis_live/snapshots.parquet 만 읽음 (top-level
    snapshots.parquet은 안 읽힘 — 손상된 hogaplay 잔재).
    """
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # 손상된 top-level meta + parquet (실제 5/27 환경 재현)
    sd_dir.mkdir(parents=True)
    (sd_dir / "meta.json").write_text(json.dumps({
        "source": "hogaplay",
        "code": code, "date": date,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 0,  # 손상값 (invariant 위반)
    }))
    _write_snapshots(sd_dir / "snapshots.parquet", [
        _snap(90000000, 99999, 99999)  # 손상 데이터 — kis_live와 다른 값
    ])
    _write_empty_candles(sd_dir / "candles.parquet")
    _write_empty_trades(sd_dir / "trades.parquet")

    # 정상 kis_live/ 서브디렉터리
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 12345, 67890),  # 진짜 데이터
    ])
    _write_empty_candles(sd_dir / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir / "kis_live" / "trades.parquet")

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",
    )

    assert len(bundle.segments) == 1
    assert bundle.segments[0].source == "kis_live"  # fallback 발동
    points = bundle.quote_ratio.points
    assert len(points) >= 1
    # kis_live 데이터가 노출됨 (top-level 손상 데이터 99999 아니라 12345)
    assert any(p.bid_total == 12345 for p in points)
    assert not any(p.bid_total == 99999 for p in points)


def test_legacy_flat_layout_still_works(tmp_path: Path) -> None:
    """진짜 legacy flat-only layout (source 서브디렉터리 없음).

    resolve_source_dir의 legacy fallback이 정상 동작해야 함.
    """
    code = "003490"
    date = "20260501"
    sd_dir = tmp_path / "parquet" / date / code

    sd_dir.mkdir(parents=True)
    _write_meta(sd_dir / "meta.json", date=date, source="hogaplay")
    _write_snapshots(sd_dir / "snapshots.parquet", [_snap(100000000, 11111, 22222)])
    _write_empty_candles(sd_dir / "candles.parquet")
    _write_empty_trades(sd_dir / "trades.parquet")

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",
    )

    assert len(bundle.segments) == 1
    assert any(p.bid_total == 11111 for p in bundle.quote_ratio.points)


def test_source_pref_strict_when_pref_present_but_sparse(tmp_path: Path) -> None:
    """선호 source가 있으면 sparse여도 fallback 안 함."""
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # 정상 hogaplay/ (풍부)
    _write_meta(sd_dir / "hogaplay" / "meta.json", source="hogaplay")
    _write_snapshots(sd_dir / "hogaplay" / "snapshots.parquet", [
        _snap(100000000, 10000, 20000),
        _snap(100100000, 11000, 21000),
        _snap(100200000, 12000, 22000),
    ])
    _write_empty_candles(sd_dir / "hogaplay" / "candles.parquet")
    _write_empty_trades(sd_dir / "hogaplay" / "trades.parquet")

    # 정상 kis_live/ (sparse — 1건만)
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(165000000, 55555, 66666),
    ])
    _write_empty_candles(sd_dir / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir / "kis_live" / "trades.parquet")

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="kis_live",
    )

    # kis_live가 있으니 그것만 — sparse(1건)여도
    assert bundle.segments[0].source == "kis_live"
    bid_totals = [p.bid_total for p in bundle.quote_ratio.points]
    assert 55555 in bid_totals
    assert 10000 not in bid_totals  # hogaplay 데이터는 안 섞임


def test_source_pref_fallback_when_pref_missing(tmp_path: Path) -> None:
    """선호 source가 없으면 다른 source로 fallback."""
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # kis_live/ 만 존재 (hogaplay/ 없음)
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 33333, 44444),
    ])
    _write_empty_candles(sd_dir / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir / "kis_live" / "trades.parquet")

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",  # 없으니 kis_live fallback
    )

    assert bundle.segments[0].source == "kis_live"
    assert any(p.bid_total == 33333 for p in bundle.quote_ratio.points)
