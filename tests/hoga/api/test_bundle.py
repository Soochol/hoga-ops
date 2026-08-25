"""Tests for hoga.api.bundle module."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import duckdb
import pytest

from hoga.api.bundle import (
    _expand_distribution_bins,
    downsample_candles,
)
from hoga.api.models import ALLOWED_TIMEFRAME_MS
from hoga.tables.candles import ApiCandle


def _c(ts_ms: int, o: int, h: int, l: int, c: int, va: int = 0, vb: int = 0) -> ApiCandle:  # noqa: E741 — 도메인 관례 변수(OHLC 의 l = low 등)
    """KRX prices are integer-won (see hoga/tables/candles.py:ApiCandle)."""
    return ApiCandle(ts_ms=ts_ms, open=o, close=c, high=h, low=l, vol_a=va, vol_b=vb)


# epoch 0 == 1970-01-01 09:00 KST — 아래 픽스처의 ts_ms 가 그대로 정규장
# 개장 기준 오프셋이 된다. 클립 대상 tf(120·240m)도 이 날짜로 통과한다.
EPOCH_DATE = "19700101"
JUN24_0901 = 1_782_259_260_000
MINUTE = 60_000


def test_downsample_candles_identity_at_60000():
    inp = [_c(60_000, 100, 110, 95, 105), _c(120_000, 105, 108, 100, 102)]
    out = downsample_candles(inp, bucket_ms=60_000, date=EPOCH_DATE)
    assert out == inp


def test_downsample_candles_5min_groups_five_1min_bars():
    inp = [
        _c(0,        100, 110,  95, 105, 10, 20),
        _c(60_000,   105, 115, 102, 110, 15, 25),
        _c(120_000,  110, 120, 108, 118,  5, 30),
        _c(180_000,  118, 119, 110, 112, 20, 10),
        _c(240_000,  112, 125, 111, 122, 30, 15),
    ]
    out = downsample_candles(inp, bucket_ms=300_000, date=EPOCH_DATE)
    assert len(out) == 1
    bar = out[0]
    assert bar.ts_ms == 0
    assert bar.open == 100
    assert bar.close == 122
    assert bar.high == 125
    assert bar.low == 95
    assert bar.vol_a == 80
    assert bar.vol_b == 100


def test_downsample_candles_includes_last_partial_bucket():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(7)]
    out = downsample_candles(inp, bucket_ms=300_000, date=EPOCH_DATE)
    assert len(out) == 2
    assert out[0].ts_ms == 0
    assert out[1].ts_ms == 300_000
    assert out[1].vol_a == 2


def test_downsample_candles_empty_input_returns_empty():
    assert downsample_candles([], bucket_ms=300_000, date=EPOCH_DATE) == []


def test_downsample_candles_rejects_invalid_bucket():
    with pytest.raises(ValueError, match="bucket_ms"):
        downsample_candles([_c(0, 1, 1, 1, 1)], bucket_ms=42_000, date=EPOCH_DATE)


def test_downsample_clips_after_hours_only_for_120m_and_240m():
    """정규장 밖 봉은 120·240 에서만 사라진다.

    2026-08-07 `005930` 실측 재현: NXT·UN 은 08:00~19:59 를 통째로 싣는데, 240m
    `[13:00,17:00)` 이 애프터마켓을 정규장 봉에 끌어들여 close 가 +1.30% 어긋났다.
    클립이 그 유입을 막는지 — **그리고 60m 는 종전대로 두는지** — 를 함께 본다.
    """
    open_ms = 0                       # 1970-01-01 09:00 KST
    def at(h: int, m: int) -> int:
        return open_ms + ((h - 9) * 60 + m) * 60_000

    inp = [
        _c(at(9, 0),   100, 100, 100, 100, 1, 1),   # 정규장
        _c(at(15, 0),  100, 100, 100, 100, 1, 1),   # 정규장
        _c(at(16, 30), 900, 900, 900, 900, 1, 1),   # 애프터마켓 — 값이 크게 다르다
    ]

    for bucket_ms in (7_200_000, 14_400_000):
        out = downsample_candles(inp, bucket_ms=bucket_ms, date=EPOCH_DATE)
        assert all(c.high < 900 for c in out), f"{bucket_ms}: 애프터마켓이 새어 들어왔다"
        assert sum(c.vol_a for c in out) == 2

    # 60m 는 클립 대상이 아니다 — 애프터마켓 봉이 자기 버킷으로 그대로 남는다.
    out_60 = downsample_candles(inp, bucket_ms=3_600_000, date=EPOCH_DATE)
    assert sum(c.vol_a for c in out_60) == 3
    assert any(c.high == 900 for c in out_60)


def test_downsample_candles_handles_all_minute_timeframes():
    inp = [_c(i * 60_000, 100, 110, 90, 105, 1, 1) for i in range(60)]
    for bucket_ms in ALLOWED_TIMEFRAME_MS:
        out = downsample_candles(inp, bucket_ms=bucket_ms, date=EPOCH_DATE)
        assert sum(c.vol_a for c in out) == 60
        for c in out:
            assert c.ts_ms % bucket_ms == 0


# ---------------------------------------------------------------------------
# build_range_bundle (ADR-0013/0014): partial-inventory, segments
# ---------------------------------------------------------------------------

def _patch_slice_builders(
    bundle_mod,
    bucket_ms: int = 60_000,
    *,
    patch_ask_peak: bool = True,
    patch_bid_peak: bool = True,
):
    """Return a list of context managers that stub every per-slice builder.

    ``patch_ask_peak`` and ``patch_bid_peak`` (default True) also stub peak builders
    to ``None`` so the general bundle tests (MagicMock engine, no real parquet/conn)
    don't exercise them. Dedicated peak tests pass False or override the stub to run
    the relevant builder for real."""
    from unittest.mock import patch

    from hoga.api.models import (
        FillStrength,
        QuoteRatio,
    )
    qr = QuoteRatio(bucket_ms=bucket_ms, points=[])
    fs = FillStrength(bucket_ms=bucket_ms, points=[])
    patches = [
        patch.object(bundle_mod, "build_candles_slice", return_value=[]),
        patch.object(bundle_mod, "downsample_candles", return_value=[]),
        patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr),
        patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs),
    ]
    if patch_ask_peak and patch_bid_peak:
        patches.append(patch.object(bundle_mod, "build_ask_bid_peak_slices", return_value=(None, None)))
    else:
        if patch_ask_peak:
            patches.append(patch.object(bundle_mod, "build_ask_peak_slice", return_value=None))
        if patch_bid_peak:
            patches.append(patch.object(bundle_mod, "build_bid_peak_slice", return_value=None))
    patches.append(patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=None))
    return patches


def _engine_with_meta_for_dates(dates):
    """MagicMock engine with list_stock_dates_in_range + get_meta wired."""
    from unittest.mock import MagicMock
    eng = MagicMock()
    eng.list_stock_dates_in_range.return_value = dates
    eng.get_meta.return_value = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
    }
    # 새 wire 필드(디스크 좌팬 바닥)는 pydantic 이 str|None 을 요구한다 —
    # MagicMock 기본 반환이 그대로 들어가면 ValidationError 다.
    eng.earliest_stock_date.return_value = None
    eng.indicators_cache = None
    return eng


def test_build_range_bundle_single_day_yields_one_segment():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=60_000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

    assert len(rb.segments) == 1
    assert rb.segments[0].date == "20260512"
    assert rb.bucket_ms == 60_000
    # mode=full 퇴역 후 volume_profile_by_day는 와이어 shape 유지용 상시-빈 필드.
    assert rb.volume_profile_by_day == []


def test_build_range_bundle_multi_day_concatenates_per_segment_lists():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    mock_engine = _engine_with_meta_for_dates(["20260512", "20260513"])
    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260513", bucket_ms=60_000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

    assert len(rb.segments) == 2
    assert [s.date for s in rb.segments] == ["20260512", "20260513"]
    assert rb.volume_profile_by_day == []


def test_build_range_bundle_volume_distributions_are_opt_in():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import DayVolumeDistribution, VolumeDistributionBin

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    profile = DayVolumeDistribution(
        date="20260512",
        range_count=10,
        price_min=70_000,
        price_max=71_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        bins=[VolumeDistributionBin(price_low=70_000, price_high=71_000, qty=123)],
    )
    base_patches = _patch_slice_builders(bundle_mod)

    with contextlib.ExitStack() as stack:
        for pcm in base_patches:
            stack.enter_context(pcm)
        dist_builder = stack.enter_context(
            patch.object(bundle_mod, "build_volume_distribution_slice", return_value=profile)
        )
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
        )

    assert dist_builder.call_count == 0
    assert rb.volume_distributions == []

    with contextlib.ExitStack() as stack:
        for pcm in base_patches:
            stack.enter_context(pcm)
        dist_builder = stack.enter_context(
            patch.object(bundle_mod, "build_volume_distribution_slice", return_value=profile)
        )
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
            volume_distribution_bins=10,
        )

    assert dist_builder.call_count == 1
    assert rb.volume_distributions == [profile]


def test_build_range_bundle_sidecar_mode_includes_requested_volume_distributions():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import DayVolumeDistribution, VolumeDistributionBin

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    profile = DayVolumeDistribution(
        date="20260512",
        range_count=10,
        price_min=70_000,
        price_max=71_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        bins=[VolumeDistributionBin(price_low=70_000, price_high=71_000, qty=123)],
    )

    with contextlib.ExitStack() as stack:
        for pcm in _patch_slice_builders(bundle_mod):
            stack.enter_context(pcm)
        dist_builder = stack.enter_context(
            patch.object(bundle_mod, "build_volume_distribution_slice", return_value=profile)
        )

        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
            volume_distribution_bins=10,
        )

    assert dist_builder.call_count == 1
    assert rb.volume_distributions == [profile]
    assert rb.candles == []
    assert rb.quote_ratio.points == []
    assert rb.fill_strength.points == []


def test_build_range_bundle_candles_mode_skips_hoga_and_sidecar_builders():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    mock_engine = _engine_with_meta_for_dates(["20260625"])
    raw_candles = [_c(1_772_000_000_000, 100, 110, 90, 105, 1, 2)]
    downsampled = [_c(1_772_000_000_000, 100, 110, 90, 105, 1, 2)]

    with contextlib.ExitStack() as stack:
        candles = stack.enter_context(patch.object(bundle_mod, "build_candles_slice", return_value=raw_candles))
        downsample = stack.enter_context(patch.object(bundle_mod, "downsample_candles", return_value=downsampled))
        quote_ratio = stack.enter_context(patch.object(bundle_mod, "build_quote_ratio_slice"))
        fill_strength = stack.enter_context(patch.object(bundle_mod, "build_fill_strength_slice"))
        distribution = stack.enter_context(patch.object(bundle_mod, "build_volume_distribution_slice"))
        poc = stack.enter_context(patch.object(bundle_mod, "build_trade_volume_poc_slice"))
        ask_bid_peaks = stack.enter_context(patch.object(bundle_mod, "build_ask_bid_peak_slices"))
        program = stack.enter_context(patch.object(bundle_mod, "build_program_trade_series"))
        broker_late = stack.enter_context(patch.object(bundle_mod, "build_broker_late_entries_slice"))

        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260625",
            to_date="20260625",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
            mode="candles",
            broker_late_entries_enabled=True,
            volume_distribution_bins=10,
            trade_volume_poc_bins=10,
        )

    candles.assert_called_once()
    # `date` 는 정규장 클립의 기준이라 **날짜별 루프의 그 날짜**여야 한다 — 여기서
    # 값을 못박지 않으면 엉뚱한 날짜가 넘어가도 통과한다(클립 tf 에서만 증상).
    downsample.assert_called_once_with(raw_candles, bucket_ms=60_000, date="20260625")
    quote_ratio.assert_not_called()
    fill_strength.assert_not_called()
    distribution.assert_not_called()
    poc.assert_not_called()
    ask_bid_peaks.assert_not_called()
    program.assert_not_called()
    broker_late.assert_not_called()
    assert len(rb.segments) == 1
    assert rb.candles == downsampled
    assert rb.quote_ratio.points == []
    assert rb.fill_strength.points == []
    assert rb.volume_profile_by_day == []
    assert rb.volume_profile_range.bin_count == 0
    assert rb.volume_distributions == []
    assert rb.trade_volume_pocs == []
    assert rb.program_trade.points == []


def test_build_range_bundle_builds_trade_volume_poc_by_default_from_candle_range():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import TradeVolumePoc
    from hoga.tables.candles import ApiCandle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    raw_candles = [
        ApiCandle(ts_ms=1, open=70_000, close=70_100, high=70_200, low=69_900, vol_a=1, vol_b=0),
        ApiCandle(ts_ms=2, open=70_100, close=70_300, high=70_400, low=70_000, vol_a=1, vol_b=0),
    ]
    poc = TradeVolumePoc(
        date="20260512",
        center_price=70_150,
        low_price=69_900,
        high_price=70_400,
        qty=123,
        t_ms=1,
        band_pct=0.005,
    )
    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(bundle_mod, "build_candles_slice", return_value=raw_candles),
    ]

    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        poc_builder = stack.enter_context(
            patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=poc)
        )
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
        )

    assert rb.trade_volume_pocs == [poc]
    assert poc_builder.call_args.kwargs["range_count"] == 10
    assert poc_builder.call_args.kwargs["price_range"] == (69_900, 70_400)


def test_build_range_bundle_threads_explicit_trade_volume_poc_bins():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.candles import ApiCandle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    patches = _patch_slice_builders(bundle_mod) + [
        patch.object(
            bundle_mod,
            "build_candles_slice",
            return_value=[
                ApiCandle(ts_ms=1, open=100, close=101, high=102, low=99, vol_a=1, vol_b=0),
            ],
        ),
    ]

    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        poc_builder = stack.enter_context(
            patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=None)
        )
        build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
            trade_volume_poc_bins=12,
        )

    assert poc_builder.call_args.kwargs["range_count"] == 12


def test_build_range_bundle_attaches_program_trade_sidecar_from_disk(tmp_path):
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    store.merge_response(
        venue="KRX",
        code="005930",
        date="20260512",
        observed_at_ms=100,
        rows=[
            ProgramTradeByStockRow(
                code="005930",
                bsop_hour="090000",
                t_ms=1_747_006_200_000,
                price=70000,
                net_qty=1000,
                net_amount=70_000_000,
                buy_qty=None,
                sell_qty=None,
                buy_amount=None,
                sell_amount=None,
                delta_qty=1000,
                delta_amount=70_000_000,
            )
        ],
    )

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    mock_engine.data_dir = tmp_path
    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
        )

    assert rb.program_trade.source == "kis_program_trade"
    assert [(p.t, p.net_amount, p.delta_amount) for p in rb.program_trade.points] == [
        (1_747_006_200_000, 70_000_000, 70_000_000)
    ]


def test_build_program_trade_series_reads_the_requested_venue(tmp_path):
    """읽기가 venue 를 탄다 — 축이 없던 시절엔 NXT·통합 화면이 15:30 에 멎은 KRX
    시계열을 자기 시장 것으로 받았다."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_program_trade_series
    from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore

    def _row(hhmmss: str, net_qty: int) -> ProgramTradeByStockRow:
        return ProgramTradeByStockRow(
            code="005930", bsop_hour=hhmmss, t_ms=0, price=70_000,
            net_qty=net_qty, net_amount=net_qty * 1000,
            buy_qty=None, sell_qty=None, buy_amount=None, sell_amount=None,
            delta_qty=None, delta_amount=None,
        )

    store = ProgramTradeStore(tmp_path)
    store.merge_response(venue="KRX", code="005930", date="20260807",
                         rows=[_row("100000", 11)], observed_at_ms=1)
    # 애프터마켓 — KRX 창은 닫혔고 NXT 만 열려 있는 시간대.
    store.merge_response(venue="NXT", code="005930", date="20260807",
                         rows=[_row("170000", 77)], observed_at_ms=2)

    engine = MagicMock()
    engine.data_dir = tmp_path

    krx = build_program_trade_series(engine, code="005930", dates=["20260807"], venue="KRX")
    nxt = build_program_trade_series(engine, code="005930", dates=["20260807"], venue="NXT")
    un = build_program_trade_series(engine, code="005930", dates=["20260807"], venue="UN")

    assert [p.net_qty for p in krx.points] == [11]
    assert [p.net_qty for p in nxt.points] == [77]
    assert un.points == []  # 저장된 적 없는 venue 는 빈 시계열(KRX 로 새지 않는다)


def test_build_program_trade_series_filters_legacy_polluted_gap_events(tmp_path):
    """PR-F4 직후 0w drain 이 매 30초 배치마다 쌓은 오염 gap_events(임계 이하 점프)는
    읽기 경로에서 걸러 gap_risk 오탐을 만들지 않는다 — 실제 수집 공백(임계 초과)만 남긴다."""
    import json

    from hoga.api.bundle import build_program_trade_series
    from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    for i, hhmmss in enumerate(["090000", "090030", "090500"]):
        store.merge_response(
            venue="KRX",
            code="005930",
            date="20260721",
            rows=[
                ProgramTradeByStockRow(
                    code="005930",
                    bsop_hour=hhmmss,
                    t_ms=0,
                    price=70000,
                    net_qty=1000,
                    net_amount=(i + 1) * 1000,
                    buy_qty=None,
                    sell_qty=None,
                    buy_amount=None,
                    sell_amount=None,
                    delta_qty=None,
                    delta_amount=None,
                )
            ],
            observed_at_ms=i + 1,
        )

    # 수정 전 코드가 남긴 오염 이벤트를 주입 — 30초 점프(정상 드레인 주기)도 갭으로 기록됐었다.
    path = tmp_path / "kis-program-trade" / "005930" / "KRX" / "20260721.json"
    body = json.loads(path.read_text())
    body["gap_events"].insert(
        0,
        {"previous_latest": "090000", "new_oldest": "090030", "new_newest": "090030", "observed_at_ms": 2},
    )
    path.write_text(json.dumps(body))

    mock_engine = MagicMock()
    mock_engine.data_dir = tmp_path
    series = build_program_trade_series(mock_engine, code="005930", dates=["20260721"], venue="KRX")

    assert [p.gap_risk for p in series.points] == [False, False, True]


def test_build_range_bundle_hoga_mode_skips_full_sidecars_and_inventory_scan(tmp_path):
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    mock_engine.data_dir = tmp_path
    mock_engine.list_stock_dates.side_effect = AssertionError(
        "mode=hoga must not scan the full stock-date inventory"
    )

    with contextlib.ExitStack() as stack:
        for pcm in _patch_slice_builders(bundle_mod):
            stack.enter_context(pcm)
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="hoga",
        )

    assert rb.candles == []
    assert rb.volume_profile_by_day == []
    assert rb.volume_profile_range.bins == []
    assert rb.ask_peaks == []
    assert rb.bid_peaks == []
    assert rb.broker_late_entries == []
    assert rb.price_level_hits == []
    assert rb.trade_volume_pocs == []
    assert rb.volume_distributions == []
    assert rb.program_trade.points == []
    mock_engine.list_stock_dates.assert_not_called()


def test_build_range_bundle_sidecar_mode_builds_overlay_sidecars_only(tmp_path):
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import AskPeak, BidPeak, BrokerLateEntryEvent, TradeVolumePoc
    from hoga.tables.candles import ApiCandle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    mock_engine.data_dir = tmp_path
    raw_candles = [
        ApiCandle(ts_ms=1, open=70_000, close=70_100, high=70_200, low=69_900, vol_a=1, vol_b=0),
    ]
    ask = AskPeak(date="20260512", price=70_200, qty=5000, t_ms=1, max_price=70_200, max_qty=5000, max_t_ms=1)
    bid = BidPeak(date="20260512", price=69_900, qty=4000, t_ms=1, max_price=69_900, max_qty=4000, max_t_ms=1)
    broker = BrokerLateEntryEvent(t_ms=1_747_006_200_000, broker="NH투자증권", side="buy", net=42)
    poc = TradeVolumePoc(
        date="20260512",
        center_price=70_100,
        low_price=69_900,
        high_price=70_200,
        qty=123,
        t_ms=1,
        band_pct=0.005,
    )

    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(bundle_mod, "build_candles_slice", return_value=raw_candles))
        qr_builder = stack.enter_context(patch.object(bundle_mod, "build_quote_ratio_slice"))
        fs_builder = stack.enter_context(patch.object(bundle_mod, "build_fill_strength_slice"))
        program = bundle_mod.ProgramTradeSeries(points=[
            bundle_mod.ProgramTradePoint(
                t=1_747_006_200_000,
                net_qty=1000,
                net_amount=70_000_000,
                delta_qty=1000,
                delta_amount=70_000_000,
                gap_risk=False,
            )
        ])
        program_builder = stack.enter_context(patch.object(bundle_mod, "build_program_trade_series", return_value=program))  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
        stack.enter_context(patch.object(bundle_mod, "build_ask_bid_peak_slices", return_value=(ask, bid)))
        stack.enter_context(patch.object(bundle_mod, "build_broker_late_entries_slice", return_value=[broker]))
        stack.enter_context(patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=poc))

        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
            broker_late_entries_enabled=True,
            trade_volume_poc_bins=10,
        )

    assert rb.candles == []
    assert rb.quote_ratio.points == []
    assert rb.fill_strength.points == []
    assert rb.volume_profile_by_day == []
    assert rb.volume_profile_range.bins == []
    assert rb.program_trade == program
    assert rb.ask_peaks == [ask]
    assert rb.bid_peaks == [bid]
    assert rb.broker_late_entries == [broker]
    assert rb.trade_volume_pocs == [poc]
    qr_builder.assert_not_called()
    fs_builder.assert_not_called()
    # venue 가 읽기 경로까지 흐르는지 — 빠지면 NXT·통합 화면이 KRX 시계열을 자기
    # 시장 것으로 믿는다(사이드카에 venue 축이 없던 시절의 증상).
    #
    # **전체 시그니처 스냅샷으로 두지 않는다** — `today_kst` 가 실제 오늘 날짜라
    # 스냅샷이면 날짜가 바뀔 때마다 깨진다. kwargs 를 축별로 단언한다.
    assert program_builder.call_count == 1
    kwargs = program_builder.call_args.kwargs
    assert kwargs["code"] == "005930"
    assert kwargs["dates"] == ["20260512"]
    assert kwargs["venue"] == "KRX"
    # 접기 축(2026-08-21): 번들과 **같은** 해상도로 접히고, 격자 원점은 세그먼트에서
    # 온다. bucket_ms 를 안 넘기면 조용히 원해상도(47,313점/3개월)로 돌아간다.
    assert kwargs["bucket_ms"] == 60_000
    assert set(kwargs["session_open_by_date"]) == {"20260512"}
    assert kwargs["today_kst"] is not None


def test_build_range_bundle_cutoff_sidecar_skips_unneeded_overlay_sidecars(tmp_path):
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import DayVolumeDistribution, VolumeDistributionBin
    from hoga.tables.candles import ApiCandle

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    mock_engine.data_dir = tmp_path
    profile = DayVolumeDistribution(
        date="20260512",
        range_count=10,
        price_min=70_000,
        price_max=70_200,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        bins=[VolumeDistributionBin(price_low=70_000, price_high=70_200, qty=123)],
    )

    with contextlib.ExitStack() as stack:
        stack.enter_context(
            patch.object(
                bundle_mod,
                "build_candles_slice",
                return_value=[
                    ApiCandle(ts_ms=1, open=70_000, close=70_100, high=70_200, low=69_900, vol_a=1, vol_b=0),
                ],
            )
        )
        stack.enter_context(patch.object(bundle_mod, "build_volume_distribution_slice", return_value=profile))
        ask_bid_builder = stack.enter_context(patch.object(bundle_mod, "build_ask_bid_peak_slices", return_value=(None, None)))  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
        broker_builder = stack.enter_context(patch.object(bundle_mod, "build_broker_late_entries_slice", return_value=[]))  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
        poc_builder = stack.enter_context(patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=None))

        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
            broker_late_entries_enabled=True,
            trade_volume_poc_bins=10,
            volume_distribution_bins=10,
            volume_distribution_cutoff_ms=1_747_006_260_000,
        )

    assert rb.volume_distributions == [profile]
    assert rb.ask_peaks == []
    assert rb.bid_peaks == []
    assert rb.broker_late_entries == []
    assert rb.trade_volume_pocs == []
    ask_bid_builder.assert_not_called()
    broker_builder.assert_not_called()
    poc_builder.assert_not_called()


def test_build_range_bundle_uses_combined_ask_bid_peak_builder():
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import AskPeak, BidPeak

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    ask = AskPeak(date="20260512", price=100, qty=10, t_ms=1, max_price=100, max_qty=10, max_t_ms=1)
    bid = BidPeak(date="20260512", price=90, qty=9, t_ms=1, max_price=90, max_qty=9, max_t_ms=1)

    with contextlib.ExitStack() as stack:
        for pcm in _patch_slice_builders(bundle_mod, patch_ask_peak=False, patch_bid_peak=False):
            stack.enter_context(pcm)
        combined = stack.enter_context(patch.object(bundle_mod, "build_ask_bid_peak_slices", return_value=(ask, bid)))
        rb = build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260512",
            to_date="20260512",
            bucket_ms=60_000,
            mode="sidecar",
        )

    combined.assert_called_once()
    assert rb.ask_peaks == [ask]
    assert rb.bid_peaks == [bid]


def test_build_volume_distribution_slice_returns_unix_session_bounds(tmp_path):
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_volume_distribution_slice
    from hoga.tables.trades import VolumeProfileBinning
    from hoga.util.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms

    code_dir = tmp_path / "20260512" / "005930"
    code_dir.mkdir(parents=True)
    (code_dir / "candles.parquet").touch()
    (code_dir / "trades.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir

    with patch.object(bundle_mod.candles_tbl, "query_price_range", return_value=(70_000, 71_000)), \
         patch.object(
             bundle_mod.trades_tbl,
             "query_continuous_trade_volume_distribution",
             return_value=VolumeProfileBinning(
                 price_min=70_000,
                 price_max=71_000,
                 bin_width=100.0,
                 bins=[(0, 123)],
                 max_intra_ms=32_460_000,
             ),
         ) as dist_query:
        profile = build_volume_distribution_slice(
            engine,
            code="005930",
            date="20260512",
            source="hogaplay",
            session_open_ms=90_000_000,
            session_close_ms=153_000_000,
            range_count=10,
            # 순수 변환/쿼리 검증 — 캐시 명시 우회(MagicMock indicators_cache 조기반환 방지).
            cache=None,
            today_kst=None,
        )

    dist_query.assert_called_once_with(
        engine.conn,
        path=code_dir / "trades.parquet",
        price_lo=70_000,
        price_hi=71_000,
        bins=10,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        continuous_before_ms=None,
    )
    assert profile is not None
    assert profile.session_open_ms == hhmmssms_to_unix_ms("20260512", 90_000_000)
    assert profile.session_close_ms == hhmmssms_to_unix_ms("20260512", 153_000_000)
    assert profile.last_trade_ms == ms_from_midnight_to_unix_ms("20260512", 32_460_000)


def test_build_volume_distribution_slice_uses_supplied_price_range_without_candles_parquet(tmp_path):
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_volume_distribution_slice
    from hoga.tables.trades import VolumeProfileBinning

    code_dir = tmp_path / "20260512" / "005930"
    code_dir.mkdir(parents=True)
    (code_dir / "trades.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir

    with patch.object(bundle_mod.candles_tbl, "query_price_range") as price_range_query, \
         patch.object(
             bundle_mod.trades_tbl,
             "query_continuous_trade_volume_distribution",
             return_value=VolumeProfileBinning(
                 price_min=70_000,
                 price_max=71_000,
                 bin_width=100.0,
                 bins=[(1, 456)],
                 max_intra_ms=32_460_000,
             ),
         ) as dist_query:
        profile = build_volume_distribution_slice(
            engine,
            code="005930",
            date="20260512",
            source="kiwoom_live",
            session_open_ms=90_000_000,
            session_close_ms=153_000_000,
            range_count=10,
            price_min=70_000,
            price_max=71_000,
            cache=None,
            today_kst=None,
        )

    price_range_query.assert_not_called()
    dist_query.assert_called_once_with(
        engine.conn,
        path=code_dir / "trades.parquet",
        price_lo=70_000,
        price_hi=71_000,
        bins=10,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        continuous_before_ms=None,
    )
    assert profile is not None
    assert [bin.qty for bin in profile.bins][1] == 456


def test_build_range_bundle_trade_source_fallback_skips_kis_api(tmp_path):
    """kis_api는 캔들 전용(2026-07-17 정책) — trades.parquet가 kis_api에만 있어도
    체결 지표 소스 폴백이 kis_api로 내려가지 않고 선택 소스에 머문다."""
    import contextlib
    import json

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import DayVolumeDistribution, VolumeDistributionBin

    date = "20260512"
    code = "005930"
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 1,
        "total_unique_events": 1,
    }
    from hoga.api.sources import source_venue_dir

    for source in ("kiwoom_live", "kis_api"):
        # 정본 헬퍼 — venue 축이 있는 소스는 세그먼트가 붙는다.
        source_dir = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX")
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (tmp_path / "parquet" / date / code / "kis_api" / "trades.parquet").touch()

    engine = _engine_with_meta_for_dates([date])
    engine.data_dir = tmp_path
    engine.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path / "parquet" / d / c / src

    profile = DayVolumeDistribution(
        date=date,
        range_count=10,
        price_min=69_900,
        price_max=70_100,
        session_open_ms=1,
        session_close_ms=2,
        bins=[VolumeDistributionBin(price_low=69_900, price_high=70_100, qty=123)],
    )
    qr = bundle_mod.QuoteRatio(bucket_ms=60_000, points=[])
    fs = bundle_mod.FillStrength(bucket_ms=60_000, points=[])

    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(bundle_mod, "build_candles_slice", return_value=[]))
        stack.enter_context(patch.object(bundle_mod, "downsample_candles", return_value=[]))
        stack.enter_context(patch.object(bundle_mod, "build_quote_ratio_slice", return_value=qr))
        stack.enter_context(patch.object(bundle_mod, "build_fill_strength_slice", return_value=fs))
        stack.enter_context(patch.object(bundle_mod, "build_ask_peak_slice", return_value=None))
        stack.enter_context(patch.object(bundle_mod, "build_bid_peak_slice", return_value=None))
        stack.enter_context(patch.object(bundle_mod, "build_program_trade_series", return_value=bundle_mod.ProgramTradeSeries(points=[])))  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
        poc_builder = stack.enter_context(patch.object(bundle_mod, "build_trade_volume_poc_slice", return_value=None))
        dist_builder = stack.enter_context(patch.object(bundle_mod, "build_volume_distribution_slice", return_value=profile))  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

        rb = build_range_bundle(
            engine,
            code=code,
            from_date=date,
            to_date=date,
            bucket_ms=60_000,
            mode="sidecar",
            source_pref="kis_ws_first",
            volume_distribution_bins=10,
            volume_distribution_price_min=69_900,
            volume_distribution_price_max=70_100,
        )

    assert rb.segments[0].source == "kiwoom_live"
    assert rb.volume_distributions == [profile]
    assert dist_builder.call_args.kwargs["source"] == "kiwoom_live"
    assert dist_builder.call_args.kwargs["price_min"] == 69_900
    assert dist_builder.call_args.kwargs["price_max"] == 70_100
    assert poc_builder.call_args.kwargs["source"] == "kiwoom_live"


def test_range_volume_distribution_uses_first_single_price_book_cutoff(tmp_path):
    import json

    from hoga.api.bundle import build_range_bundle
    from hoga.api.queries import QueryEngine
    from hoga.tables.candles import Candle, write_parquet as candles_write_parquet
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    date = "20260625"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(json.dumps(_meta()), encoding="utf-8")

    z = tuple([0] * 10)
    ask_p = tuple(101 + i for i in range(10))
    bid_p = tuple(100 - i for i in range(10))
    normal_q = tuple([10] * 10)
    shallow_q = (10, 10, 10, 0, 0, 0, 0, 0, 0, 0)
    snapshots_write_parquet([
        Orderbook(
            ts_ms=151_959_000,
            seq=1,
            ask_p=ask_p,
            ask_q=normal_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=normal_q,
            bid_d=z,
            tot_ask=sum(normal_q),
            tot_ask_d=0,
            tot_bid=sum(normal_q),
            tot_bid_d=0,
        ),
        Orderbook(
            ts_ms=152_001_000,
            seq=2,
            ask_p=ask_p,
            ask_q=shallow_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=shallow_q,
            bid_d=z,
            tot_ask=sum(shallow_q),
            tot_ask_d=0,
            tot_bid=sum(shallow_q),
            tot_bid_d=0,
        ),
    ], source_dir / "snapshots.parquet")
    candles_write_parquet([
        Candle(ts_ms=90_000_000, open_=110, close_=110, high=120, low=100, vol_a=1, vol_b=1),
    ], source_dir / "candles.parquet")
    trades_write_parquet([
        Trade(ts_ms=151_959_000, seq=1, price=110, change_pct=0, qty=20, side=1,
              cum_vol=20, cum_trades=1, low_so_far=110, high_so_far=110,
              net_pressure=20, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=152_001_000, seq=2, price=100, change_pct=0, qty=999, side=1,
              cum_vol=1019, cum_trades=2, low_so_far=100, high_so_far=110,
              net_pressure=1019, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], source_dir / "trades.parquet")

    engine = QueryEngine(tmp_path)
    try:
        bundle = build_range_bundle(
            engine,
            code=code,
            from_date=date,
            to_date=date,
            bucket_ms=60_000,
            mode="sidecar",
            volume_distribution_bins=5,
            trade_volume_poc_bins=5,
        )
    finally:
        engine.close()

    assert len(bundle.volume_distributions) == 1
    assert [bin.qty for bin in bundle.volume_distributions[0].bins] == [0, 0, 20, 0, 0]
    assert len(bundle.trade_volume_pocs) == 1
    assert bundle.trade_volume_pocs[0].qty == 20
    assert bundle.trade_volume_pocs[0].low_price == 108


def test_range_volume_distribution_ignores_false_early_single_price_cutoff(tmp_path):
    import json

    from hoga.api.bundle import build_range_bundle
    from hoga.api.queries import QueryEngine
    from hoga.tables.candles import Candle, write_parquet as candles_write_parquet
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    date = "20260625"
    code = "005930"
    source_dir = tmp_path / "parquet" / date / code / "hogaplay"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(json.dumps(_meta()), encoding="utf-8")

    z = tuple([0] * 10)
    ask_p = tuple(101 + i for i in range(10))
    bid_p = tuple(100 - i for i in range(10))
    normal_q = tuple([10] * 10)
    shallow_q = (10, 10, 10, 0, 0, 0, 0, 0, 0, 0)
    snapshots_write_parquet([
        Orderbook(
            ts_ms=110_000_000,
            seq=1,
            ask_p=ask_p,
            ask_q=normal_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=normal_q,
            bid_d=z,
            tot_ask=sum(normal_q),
            tot_ask_d=0,
            tot_bid=sum(normal_q),
            tot_bid_d=0,
        ),
        Orderbook(
            ts_ms=111_000_000,
            seq=2,
            ask_p=ask_p,
            ask_q=shallow_q,
            ask_d=z,
            bid_p=bid_p,
            bid_q=shallow_q,
            bid_d=z,
            tot_ask=sum(shallow_q),
            tot_ask_d=0,
            tot_bid=sum(shallow_q),
            tot_bid_d=0,
        ),
    ], source_dir / "snapshots.parquet")
    candles_write_parquet([
        Candle(ts_ms=90_000_000, open_=110, close_=110, high=120, low=100, vol_a=1, vol_b=1),
    ], source_dir / "candles.parquet")
    trades_write_parquet([
        Trade(ts_ms=110_500_000, seq=1, price=100, change_pct=0, qty=10, side=1,
              cum_vol=10, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=10, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=120_000_000, seq=2, price=110, change_pct=0, qty=20, side=1,
              cum_vol=30, cum_trades=2, low_so_far=100, high_so_far=110,
              net_pressure=30, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], source_dir / "trades.parquet")

    engine = QueryEngine(tmp_path)
    try:
        bundle = build_range_bundle(
            engine,
            code=code,
            from_date=date,
            to_date=date,
            bucket_ms=60_000,
            mode="sidecar",
            volume_distribution_bins=5,
            trade_volume_poc_bins=5,
        )
    finally:
        engine.close()

    assert len(bundle.volume_distributions) == 1
    assert [bin.qty for bin in bundle.volume_distributions[0].bins] == [10, 0, 20, 0, 0]
    assert len(bundle.trade_volume_pocs) == 1
    assert bundle.trade_volume_pocs[0].qty == 20


def test_expand_distribution_bins_single_price_day_stays_on_candle_range():
    bins = _expand_distribution_bins(
        price_min=70_000,
        price_max=70_000,
        bin_width=1.0,
        sparse_bins=[(0, 120)],
        range_count=5,
    )

    assert len(bins) == 5
    assert [(b.price_low, b.price_high) for b in bins] == [
        (70_000, 70_000),
        (70_000, 70_000),
        (70_000, 70_000),
        (70_000, 70_000),
        (70_000, 70_000),
    ]
    assert [b.qty for b in bins] == [120, 0, 0, 0, 0]


def test_build_range_bundle_rejects_from_gt_to():
    from fastapi import HTTPException

    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(HTTPException) as exc:
        build_range_bundle(mock_engine, code="005930", from_date="20260520", to_date="20260512", bucket_ms=60_000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
    assert exc.value.status_code == 400


def test_build_range_bundle_returns_empty_on_empty_inventory():
    """Spec 2026-05-27 §4.3: no captured Stock-Date → empty bundle (not 404)."""
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = []
    rb = build_range_bundle(
        mock_engine, code="005930", from_date="20260512", to_date="20260520", bucket_ms=60_000, mode="sidecar"
    )
    assert rb.segments == []
    assert rb.candles == []
    assert rb.quote_ratio.points == []
    assert rb.fill_strength.points == []
    assert rb.excluded_dates == []
    assert rb.code == "005930"
    assert rb.from_date == "20260512"
    assert rb.to_date == "20260520"
    assert rb.bucket_ms == 60_000


def test_build_range_bundle_rejects_invalid_bucket_ms():
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    with pytest.raises(ValueError, match="bucket_ms"):
        build_range_bundle(mock_engine, code="005930", from_date="20260512", to_date="20260512", bucket_ms=42_000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)


# --- ADR-0020 / Invariants ---


def _meta(
    *,
    open_ms: int = 90_000_000,
    close_ms: int = 153_000_000,
    complete: bool = True,
    partial: bool = False,
    pages: int = 100,
    events: int = 80,
) -> dict:
    """Healthy default meta dict; override fields per test."""
    return {
        "regular_session_open_ms": open_ms,
        "regular_session_close_ms": close_ms,
        "collection_complete": complete,
        "is_partial": partial,
        "pages_collected": pages,
        "total_unique_events": events,
    }


def test_build_range_bundle_skips_invalid_and_surfaces_in_excluded():
    """Bad Stock-Date (close=0 → INVALID) is dropped from segments
    and appears under excluded_dates with its violations."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    eng = _engine_with_meta_for_dates(["20260520", "20260518", "20260521"])
    # Per-date meta: 5/18 is broken (close_ms=0), others healthy.
    metas = {
        "20260520": _meta(),
        "20260518": _meta(close_ms=0),
        "20260521": _meta(),
    }
    eng.get_meta.side_effect = lambda date, _code, _source="hogaplay", *, venue="KRX": metas[date]

    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date="20260520", to_date="20260521",
                                bucket_ms=60_000, mode="sidecar")

    # Only the 2 healthy dates are in segments.
    assert [s.date for s in rb.segments] == ["20260520", "20260521"]
    # The bad date is surfaced.
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"
    fired_ids = {v.invariant_id for v in rb.excluded_dates[0].violations}
    assert "meta.close_after_open" in fired_ids
    # No warn-severity violations in this fixture.
    assert rb.data_warnings == []


def test_build_range_bundle_surfaces_warn_without_excluding():
    """Healthy shape but low unique-event ratio → warn only, segment included."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    eng = _engine_with_meta_for_dates(["20260520"])
    # Healthy bounds, but pages=4132 events=1553 → ratio invariant fires (warn).
    eng.get_meta.return_value = _meta(pages=4132, events=1553)

    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date="20260520", to_date="20260520",
                                bucket_ms=60_000, mode="sidecar")

    assert len(rb.segments) == 1
    assert rb.excluded_dates == []
    assert len(rb.data_warnings) == 1
    assert rb.data_warnings[0].date == "20260520"
    fired_ids = {v.invariant_id for v in rb.data_warnings[0].warnings}
    assert "collection.unique_events_ratio" in fired_ids


def test_bundle_open_ms_zero_served_and_normalized():
    """open_ms=0 upstream sentinel: segment must be served (not excluded),
    session_open_ms must be KRX 09:00 (not midnight), and the
    meta.open_ms_normalized warn must appear exactly once (ADR-0063)."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.util.timeenc import hhmmssms_to_unix_ms

    DATE = "20260520"
    eng = _engine_with_meta_for_dates([DATE])
    # open=0 is the upstream sentinel; close and completeness are healthy.
    eng.get_meta.return_value = _meta(open_ms=0)

    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="005930",
                                from_date=DATE, to_date=DATE,
                                bucket_ms=60_000, mode="sidecar")

    # 1) Not excluded; present in segments.
    assert [s.date for s in rb.segments] == [DATE]
    assert DATE not in [e.date for e in rb.excluded_dates]

    # 2) session_open_ms == KRX 09:00 unix (NOT midnight).
    seg = rb.segments[0]
    assert seg.session_open_ms == hhmmssms_to_unix_ms(DATE, 90_000_000)
    assert seg.session_open_ms != hhmmssms_to_unix_ms(DATE, 0)

    # 3) The warn tag appears exactly once — guards against double-emit.
    warns = [w for w in rb.data_warnings if w.date == DATE]
    assert sum(
        1 for w in warns for v in w.warnings
        if v.invariant_id == "meta.open_ms_normalized"
    ) == 1


def test_build_range_bundle_empty_when_all_dates_excluded():
    """Spec 2026-05-27 §4.3: every Stock-Date INVALID → return empty bundle
    with excluded_dates populated (not 404)."""
    from hoga.api.bundle import build_range_bundle

    eng = _engine_with_meta_for_dates(["20260518"])
    eng.get_meta.return_value = _meta(close_ms=0)

    rb = build_range_bundle(
        eng, code="003490", from_date="20260518", to_date="20260518", bucket_ms=60_000, mode="sidecar"
    )
    assert rb.segments == []
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"


def test_build_range_bundle_excludes_real_5_18_003490_case():
    """Regression: the literal production payload that motivated ADR-0020 must
    not appear in segments. Both signals fire together — collection_complete=False
    AND close_ms=0 — and an earlier priority-ordering bug let this pass through
    as CLIENT_INCOMPLETE (which build_range_bundle does NOT skip). After the
    INVALID > CLIENT_INCOMPLETE flip, the date must be excluded."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    eng = _engine_with_meta_for_dates(["20260520", "20260518"])
    # Healthy 5/20 + the exact 5/18/003490 production shape (close=0 AND
    # collection_complete=False, stagnation_abort).
    metas = {
        "20260520": _meta(),
        "20260518": _meta(close_ms=0, complete=False),
    }
    eng.get_meta.side_effect = lambda date, _code, _source="hogaplay", *, venue="KRX": metas[date]

    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        rb = build_range_bundle(eng, code="003490",
                                from_date="20260518", to_date="20260520",
                                bucket_ms=60_000, mode="sidecar")

    # 5/18 must be excluded — virtual axis bug repeats otherwise.
    assert [s.date for s in rb.segments] == ["20260520"]
    assert len(rb.excluded_dates) == 1
    assert rb.excluded_dates[0].date == "20260518"


def test_build_range_bundle_includes_ask_peak_for_today(monkeypatch, tmp_path) -> None:
    """오늘(today_kst) 날짜에 snapshots.parquet(연속거래 + 단일 큰 매도단계)를 깔고
    build_range_bundle 호출. ask_peak가 그 최대단계 price/qty로 채워지는지."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260613"
    EXPECTED_QTY = 5000
    EXPECTED_PRICE = 25100

    # today-pin no longer gates ask_peak (computed from the most-recent segment);
    # kept harmless (still used by the indicator cache, which is patched out here).
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)

    # Build a real snapshots.parquet with continuous-trading rows.
    # Bids filled [100]*10 satisfies _BID_DEEP_SUM > 0 (continuous trading predicate).
    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    # Also create a candles.parquet stub (needed by some guards).
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE, bucket_ms=60000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

    assert len(bundle.ask_peaks) == 1
    p = bundle.ask_peaks[0]
    assert p.date == FIXTURE_DATE
    assert p.qty == EXPECTED_QTY
    assert p.price == EXPECTED_PRICE
    # t_ms is unix ms — must be positive and in a sane range
    assert p.t_ms > 0


def test_range_bundle_includes_depth_heatmap_when_enabled(monkeypatch, tmp_path) -> None:
    """depth_heatmap_enabled=True(기본) + 캡처된 단일 거래일 → depth_heatmap이 채워진다.
    (build_depth_heatmap_slice는 디스크 snapshots.parquet에서 실제 계산 — 패치 안 함.)"""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260613"
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)

    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(
            eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE,
            bucket_ms=60000, mode="sidecar", depth_heatmap_enabled=True,
        )

    assert len(bundle.depth_heatmap) > 0
    assert all(len(p.asks) <= 10 for p in bundle.depth_heatmap)


def test_range_bundle_omits_depth_heatmap_when_disabled(monkeypatch, tmp_path) -> None:
    """depth_heatmap_enabled=False → 디스크에 캡처가 있어도 depth_heatmap은 빈 리스트."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260613"
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)

    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(
            eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE,
            bucket_ms=60000, mode="sidecar", depth_heatmap_enabled=False,
        )

    assert bundle.depth_heatmap == []


def test_build_range_bundle_keeps_capped_all_peak_rankings() -> None:
    """range 응답이 all_peaks/all_max_peaks 를 **그대로 싣는다**(2026-08-25).

    종전엔 벗겼다 — 배열이 하루당 수천 후보라 sidecar 페이로드의 99%였고 소비처가
    없었기 때문이다. 이제 소스에서 top-3 로 캡하므로(snapshots `_side_row`) 크기
    문제가 사라졌고, 프론트의 「전체 최대벽 표시 개수」가 그 3개를 읽는다.

    **막는 방향**: 스트립이 되살아나 표시 개수 2·3 이 조용히 rank-1 로 떨어지는 것.
    못 보는 것: 캡 자체(소스 계약이라 `test_peak_sweep_oracle` 이 본다)."""
    import contextlib
    from unittest.mock import patch

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import AskPeak, BidPeak

    candidate = {"price": 70_200, "qty": 5000, "t_ms": 1}
    fat = dict(
        date="20260512", price=70_200, qty=5000, t_ms=1,
        max_price=70_200, max_qty=5000, max_t_ms=1,
        all_price=70_300, all_qty=6000, all_t_ms=2,
        traded_peaks=[candidate], traded_max_peaks=[candidate],
        all_peaks=[candidate] * 4, all_max_peaks=[candidate] * 4,
    )
    ask = AskPeak(**fat)
    bid = BidPeak(**fat)

    mock_engine = _engine_with_meta_for_dates(["20260512"])
    patches = _patch_slice_builders(bundle_mod)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        stack.enter_context(patch.object(bundle_mod, "build_ask_bid_peak_slices", return_value=(ask, bid)))
        rb = build_range_bundle(
            mock_engine, code="005930", from_date="20260512", to_date="20260512",
            bucket_ms=60_000, mode="sidecar",
        )

    for peak in (rb.ask_peaks[0], rb.bid_peaks[0]):
        assert [c.model_dump() for c in peak.all_peaks] == [candidate] * 4
        assert [c.model_dump() for c in peak.all_max_peaks] == [candidate] * 4
        assert [c.model_dump() for c in peak.traded_peaks] == [candidate]
        assert (peak.all_price, peak.all_qty, peak.all_t_ms) == (70_300, 6000, 2)
    # 픽스처가 4개인 것은 의도다 — 이 자리는 **통과 여부**를 재고, 3개 캡은 소스
    # 계약이라 오라클이 잰다. 여기서 캡을 재면 두 곳이 같은 것을 다르게 말한다.


def test_build_range_bundle_ask_peaks_includes_past_day_even_when_not_today(monkeypatch, tmp_path) -> None:
    """범위가 과거일만(오늘 미포함)이어도 그날 항목이 ask_peaks에 들어간다(per-day).
    (이전엔 '달력상 오늘'에만 계산해 휴장·과거일 조회 시 항상 비어 선이 안 보였다 — 회귀 가드.)"""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    FIXTURE_DATE = "20260612"  # a past date (NOT today)

    # Pin today to a DIFFERENT date — the new logic computes ask_peak from the
    # most-recent SEGMENT, not from "today", so this no longer suppresses it.
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: "20260613")

    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1),
        ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_path = tmp_path / "snapshots.parquet"
    snapshots_write_parquet([ob], snapshots_path)
    (tmp_path / "candles.parquet").touch()

    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date=FIXTURE_DATE, to_date=FIXTURE_DATE, bucket_ms=60000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

    # 과거일도 그날 항목이 ask_peaks에 들어간다(거래일별).
    assert len(bundle.ask_peaks) == 1
    assert bundle.ask_peaks[0].date == FIXTURE_DATE
    assert bundle.ask_peaks[0].qty == 5000
    assert bundle.ask_peaks[0].price == 25100


def test_build_range_bundle_ask_peaks_per_day(monkeypatch, tmp_path) -> None:
    """다일 범위: 각 거래일이 자기 최대벽을 ask_peaks에 가진다(per-day) — 날짜별 독립."""
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: "20260613")
    z = tuple([0] * 10)
    bp = tuple([24950 - 50 * i for i in range(10)])

    def mk_ob(price_at_max: int, qty_at_max: int) -> Orderbook:
        ask_p = (price_at_max, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450)
        ask_q = (qty_at_max, 200, 30, 40, 5, 6, 7, 8, 9, 1)
        return Orderbook(ts_ms=90100000, seq=1, ask_p=ask_p, ask_q=ask_q, ask_d=z,
                         bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
                         tot_ask=sum(ask_q), tot_ask_d=0, tot_bid=1000, tot_bid_d=0)

    dirs = {}
    for d, price, qty in (("20260610", 30000, 9000), ("20260611", 28000, 3000)):
        dd = tmp_path / d
        dd.mkdir()
        snapshots_write_parquet([mk_ob(price, qty)], dd / "snapshots.parquet")
        (dd / "candles.parquet").touch()
        dirs[d] = dd

    eng = _engine_with_meta_for_dates(["20260610", "20260611"])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": dirs[d]
    eng.conn = duckdb.connect()
    eng.indicators_cache = None  # ask_peak 캐시 미사용(MagicMock 회피); per-day 계산만 검증

    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False)
    with contextlib.ExitStack() as stack:
        for pcm in patches:
            stack.enter_context(pcm)
        bundle = build_range_bundle(eng, code="005930", from_date="20260610", to_date="20260611", bucket_ms=60000, mode="sidecar")  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)

    # 거래일별: 두 날 모두 각자의 최대벽이 ask_peaks에 — 06-10=9000@30000, 06-11=3000@28000.
    by_date = {p.date: p for p in bundle.ask_peaks}
    assert set(by_date) == {"20260610", "20260611"}
    assert by_date["20260610"].price == 30000 and by_date["20260610"].qty == 9000
    assert by_date["20260611"].price == 28000 and by_date["20260611"].qty == 3000


def test_build_ask_peak_slice_caches_past_days(tmp_path) -> None:
    """과거일은 indicators_cache로 1회만 계산(불변) — 두번째 호출은 재스캔 안 함. 오늘은 미캐시."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_ask_peak_slice
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple([24950 - 50 * i for i in range(10)]), bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    cache = PastIndicatorsCache(tmp_path / "cachedir")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p1 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                              source="hogaplay", cache=cache, today_kst="20260613")
    assert p1 is not None and p1.qty == 5000 and p1.date == "20260610"
    assert p1.max_qty == 5000 and p1.max_price == 25100
    assert p1.max_t_ms == p1.t_ms
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 60_000)

    # 두번째 호출: parquet_dir이 깨져도 캐시에서 반환(재스캔 안 함).
    eng.parquet_dir.side_effect = AssertionError("should not recompute a cached past day")
    p2 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                              source="hogaplay", cache=cache, today_kst="20260613")
    assert p2 == p1

    # 오늘 날짜는 cacheable 아님 → 캐시에 저장하지 않는다(매번 재계산해 ratchet seed 갱신).
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    build_ask_peak_slice(eng, code="005930", date="20260613", bucket_ms=60_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert not cache.has_ask_peak("005930", "20260613", "hogaplay", 60_000)


def test_build_ask_peak_slice_cache_key_is_bucket_ms_aware(tmp_path) -> None:
    """버킷 대표 위에서 집계하므로 분봉(bucket_ms)이 다르면 결과도 다를 수 있다 — 캐시 키에
    bucket_ms가 포함돼야 60s 결과가 180s 조회에 잘못 재사용되지 않는다(회귀 가드)."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_ask_peak_slice
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=(25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450),
        ask_q=(100, 200, 5000, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=tuple([24950 - 50 * i for i in range(10)]), bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=5376, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    cache = PastIndicatorsCache(tmp_path / "cachedir")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 60_000)
    # 다른 bucket_ms는 별개 키 — 캐시 미스라 재계산해야 한다(parquet_dir 다시 호출됨).
    assert not cache.has_ask_peak("005930", "20260610", "hogaplay", 180_000)
    build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=180_000,
                         source="hogaplay", cache=cache, today_kst="20260613")
    assert cache.has_ask_peak("005930", "20260610", "hogaplay", 180_000)


def test_build_ask_peak_slice_wires_intra_max(tmp_path) -> None:
    """build_ask_peak_slice가 close 변종과 틱-max 변종(max_*)을 모두 배선한다."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_ask_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

    z = tuple([0] * 10)
    ap = tuple(25000 + 50 * i for i in range(10))
    bp = tuple(24950 - 50 * i for i in range(10))
    bq = tuple([100] * 10)
    spike = Orderbook(ts_ms=90010000, seq=1, ask_p=ap, ask_q=(5000,) + (1,) * 9, ask_d=z,
                      bid_p=bp, bid_q=bq, bid_d=z, tot_ask=5009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
    rep = Orderbook(ts_ms=90055000, seq=2, ask_p=ap, ask_q=(1000,) + (1,) * 9, ask_d=z,
                    bid_p=bp, bid_q=bq, bid_d=z, tot_ask=1009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
    snapshots_write_parquet([spike, rep], tmp_path / "snapshots.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p = build_ask_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )
    assert p is not None
    assert p.qty == 1000 and p.price == 25000
    assert p.max_qty == 5000 and p.max_price == 25000
    assert p.max_t_ms < p.t_ms


def test_build_ask_peak_slice_wires_all_price_peak(tmp_path) -> None:
    """동일분 터치 벽이 없더라도 `all_*` ask peak payload 는 유지된다."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_ask_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = (25000, 26000, 27000, 27100, 27200, 27300, 27400, 27500, 27600, 27700)
    bp = tuple(24950 - 50 * i for i in range(10))
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=(1000, 9000, 100, 40, 5, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=bp, bid_q=tuple([100] * 10), bid_d=z,
        tot_ask=10170, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    tr = Trade(
        ts_ms=90050000, seq=1, price=25000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=25000, high_so_far=25000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    trades_write_parquet([tr], tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p = build_ask_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )

    assert p is not None
    assert p.price is None and p.qty is None and p.t_ms is None
    assert p.max_price is None and p.max_qty is None and p.max_t_ms is None
    assert p.all_price == 26000 and p.all_qty == 9000


def test_build_ask_peak_slice_wires_traded_peak_candidates(tmp_path) -> None:
    """동일분 터치 후보가 없으면 ranked arrays 는 `all_*` 쪽으로만 남는다."""
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_ask_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = (25000, 26000, 27000, 28000, 29000, 29100, 29200, 29300, 29400, 29500)
    bp = tuple(24950 - 50 * i for i in range(10))
    bq = tuple([100] * 10)
    ob1 = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=(1000, 9000, 7000, 6000, 500, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=bp, bid_q=bq, bid_d=z,
        tot_ask=23531, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    ob2 = Orderbook(
        ts_ms=90200000, seq=2,
        ask_p=ap, ask_q=(3000, 8000, 7100, 100, 500, 6, 7, 8, 9, 1), ask_d=z,
        bid_p=bp, bid_q=bq, bid_d=z,
        tot_ask=18731, tot_ask_d=0, tot_bid=1000, tot_bid_d=0,
    )
    # 체결은 전부 **분 540**(09:00:50~56), 벽은 분 541·542 — ADR-0156 에서 분이 다르면
    # 가격을 쳤어도 터치가 아니다. 이 테스트가 재는 것은 `all_*` 전체 랭킹이다.
    trades = [
        Trade(ts_ms=90050000, seq=1, price=25000, change_pct=0, qty=1, side=1,
              cum_vol=1, cum_trades=1, low_so_far=25000, high_so_far=25000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90052000, seq=2, price=26000, change_pct=0, qty=1, side=1,
              cum_vol=2, cum_trades=2, low_so_far=25000, high_so_far=26000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90054000, seq=3, price=27000, change_pct=0, qty=1, side=1,
              cum_vol=3, cum_trades=3, low_so_far=25000, high_so_far=27000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90056000, seq=4, price=28000, change_pct=0, qty=1, side=1,
              cum_vol=4, cum_trades=4, low_so_far=25000, high_so_far=28000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ]
    snapshots_write_parquet([ob1, ob2], tmp_path / "snapshots.parquet")
    trades_write_parquet(trades, tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p = build_ask_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )

    assert p is not None
    assert p.price is None and p.qty is None and p.t_ms is None
    assert p.max_price is None and p.max_qty is None and p.max_t_ms is None
    assert [c.model_dump() for c in p.traded_peaks] == []
    assert [c.model_dump() for c in p.traded_max_peaks] == []
    # **top-3 캡**(2026-08-25) — 종전엔 전량이라 `[:8]` 로 잘라 봤다. 이제 소스가
    # 3개만 만든다(프론트 「표시 개수」 상한과 같은 수).
    assert [c.model_dump() for c in p.all_peaks] == [
        {"price": 26000, "qty": 9000, "t_ms": 1781049660000},
        {"price": 26000, "qty": 8000, "t_ms": 1781049720000},
        {"price": 27000, "qty": 7100, "t_ms": 1781049720000},
    ]


def test_ask_peak_from_dual_row_keeps_post_touch_scalars_nullable_without_dropping_other_views() -> None:
    from hoga.api.bundle import _ask_peak_from_dual_row
    from hoga.tables.snapshots import AskPeakCandidateRow, AskPeakDualRow

    row = AskPeakDualRow(
        price=None,
        qty=None,
        intra_ms=None,
        max_price=None,
        max_qty=None,
        max_intra_ms=None,
        traded_peaks=(),
        traded_max_peaks=(),
        all_price=26000,
        all_qty=9000,
        all_intra_ms=9 * 3_600_000 + 3 * 60_000,
        all_max_price=26100,
        all_max_qty=9100,
        all_max_intra_ms=9 * 3_600_000 + 4 * 60_000,
        all_peaks=(
            AskPeakCandidateRow(price=26000, qty=9000, intra_ms=9 * 3_600_000 + 3 * 60_000),
            AskPeakCandidateRow(price=27000, qty=7100, intra_ms=9 * 3_600_000 + 4 * 60_000),
        ),
        all_max_peaks=(
            AskPeakCandidateRow(price=26100, qty=9100, intra_ms=9 * 3_600_000 + 4 * 60_000),
            AskPeakCandidateRow(price=27200, qty=7200, intra_ms=9 * 3_600_000 + 5 * 60_000),
        ),
    )

    peak = _ask_peak_from_dual_row("20260617", row)

    assert peak.price is None
    assert peak.qty is None
    assert peak.t_ms is None
    assert peak.max_price is None
    assert peak.max_qty is None
    assert peak.max_t_ms is None
    assert [candidate.model_dump() for candidate in peak.all_peaks] == [
        {"price": 26000, "qty": 9000, "t_ms": 1781654580000},
        {"price": 27000, "qty": 7100, "t_ms": 1781654640000},
    ]
    assert [candidate.model_dump() for candidate in peak.all_max_peaks] == [
        {"price": 26100, "qty": 9100, "t_ms": 1781654640000},
        {"price": 27200, "qty": 7200, "t_ms": 1781654700000},
    ]
    assert peak.all_price == 26000
    assert peak.all_qty == 9000
    assert peak.all_t_ms == 1781654580000
    assert peak.all_max_price == 26100
    assert peak.all_max_qty == 9100
    assert peak.all_max_t_ms == 1781654640000


def test_build_bid_peak_slice_wires_all_price_peak(tmp_path) -> None:
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_bid_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = tuple(70100 + 50 * i for i in range(10))
    aq = tuple([100] * 10)
    bp = (70000, 69000, 68900, 68800, 68700, 68600, 68500, 68400, 68300, 68200)
    ob = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(5000, 9000, 12000, 40, 5, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=26076, tot_bid_d=0,
    )
    tr = Trade(
        ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
        cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
        net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
    )
    snapshots_write_parquet([ob], tmp_path / "snapshots.parquet")
    trades_write_parquet([tr], tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p = build_bid_peak_slice(
        eng,
        code="005930",
        date="20260619",
        bucket_ms=60_000,
        source="hogaplay",
        session_open_ms=90000000,
        session_close_ms=153000000,
        cache=None,
        today_kst="20260620",
    )

    assert p is not None
    assert p.price is None
    assert p.qty is None
    assert p.t_ms is None
    assert p.max_price is None
    assert p.max_qty is None
    assert p.max_t_ms is None


def test_bid_peak_from_dual_row_keeps_post_touch_scalars_nullable_without_dropping_other_views() -> None:
    from hoga.api.bundle import _bid_peak_from_dual_row
    from hoga.tables.snapshots import AskPeakCandidateRow, BidPeakDualRow

    row = BidPeakDualRow(
        price=None,
        qty=None,
        intra_ms=None,
        max_price=None,
        max_qty=None,
        max_intra_ms=None,
        traded_peaks=(),
        traded_max_peaks=(),
        all_price=69800,
        all_qty=9000,
        all_intra_ms=9 * 3_600_000 + 3 * 60_000,
        all_max_price=69700,
        all_max_qty=9100,
        all_max_intra_ms=9 * 3_600_000 + 4 * 60_000,
        all_peaks=(
            AskPeakCandidateRow(price=69800, qty=9000, intra_ms=9 * 3_600_000 + 3 * 60_000),
            AskPeakCandidateRow(price=69700, qty=7100, intra_ms=9 * 3_600_000 + 4 * 60_000),
        ),
        all_max_peaks=(
            AskPeakCandidateRow(price=69700, qty=9100, intra_ms=9 * 3_600_000 + 4 * 60_000),
            AskPeakCandidateRow(price=69600, qty=7200, intra_ms=9 * 3_600_000 + 5 * 60_000),
        ),
    )

    peak = _bid_peak_from_dual_row("20260619", row)

    assert peak.price is None
    assert peak.qty is None
    assert peak.t_ms is None
    assert peak.max_price is None
    assert peak.max_qty is None
    assert peak.max_t_ms is None
    assert [candidate.model_dump() for candidate in peak.all_peaks] == [
        {"price": 69800, "qty": 9000, "t_ms": 1781827380000},
        {"price": 69700, "qty": 7100, "t_ms": 1781827440000},
    ]
    assert [candidate.model_dump() for candidate in peak.all_max_peaks] == [
        {"price": 69700, "qty": 9100, "t_ms": 1781827440000},
        {"price": 69600, "qty": 7200, "t_ms": 1781827500000},
    ]
    assert peak.all_price == 69800
    assert peak.all_qty == 9000
    assert peak.all_t_ms == 1781827380000
    assert peak.all_max_price == 69700
    assert peak.all_max_qty == 9100
    assert peak.all_max_t_ms == 1781827440000


def test_build_bid_peak_slice_wires_ranked_candidates(tmp_path) -> None:
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_bid_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = tuple(70100 + 50 * i for i in range(10))
    aq = tuple([100] * 10)
    bp = (70000, 69900, 69800, 69700, 69600, 69500, 69400, 69300, 69200, 69100)
    ob1 = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(1000, 9000, 7000, 6000, 500, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=23531, tot_bid_d=0,
    )
    ob2 = Orderbook(
        ts_ms=90200000, seq=2,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(3000, 8000, 7100, 100, 500, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=18731, tot_bid_d=0,
    )
    # 체결은 전부 **분 540**(09:00:50~56), 벽은 분 541·542 — ADR-0156 에서 분이 다르면
    # 가격을 쳤어도 터치가 아니다. 이 테스트가 재는 것은 `all_*` 전체 랭킹이다.
    trades = [
        Trade(ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
              cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90052000, seq=2, price=69900, change_pct=0, qty=1, side=1,
              cum_vol=2, cum_trades=2, low_so_far=69900, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90054000, seq=3, price=69800, change_pct=0, qty=1, side=1,
              cum_vol=3, cum_trades=3, low_so_far=69800, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90056000, seq=4, price=69700, change_pct=0, qty=1, side=1,
              cum_vol=4, cum_trades=4, low_so_far=69700, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ]
    snapshots_write_parquet([ob1, ob2], tmp_path / "snapshots.parquet")
    trades_write_parquet(trades, tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()

    p = build_bid_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )

    assert p is not None
    assert p.price is None and p.qty is None and p.t_ms is None
    assert p.max_price is None and p.max_qty is None and p.max_t_ms is None
    assert [c.model_dump() for c in p.traded_peaks] == []
    assert [c.model_dump() for c in p.traded_max_peaks] == []
    # **top-3 캡**(2026-08-25) — 종전엔 전량이라 `[:8]` 로 잘라 봤다. 이제 소스가
    # 3개만 만든다(프론트 「표시 개수」 상한과 같은 수).
    assert [c.model_dump() for c in p.all_peaks] == [
        {"price": 69900, "qty": 9000, "t_ms": 1781049660000},
        {"price": 69900, "qty": 8000, "t_ms": 1781049720000},
        {"price": 69800, "qty": 7100, "t_ms": 1781049720000},
    ]


def test_range_bundle_ask_peak_field_defaults_none() -> None:
    from hoga.api.models import AskPeak, FillStrength, QuoteRatio, RangeBundle, VolumeProfile
    b = RangeBundle(
        code="005930", from_date="20260613", to_date="20260613", bucket_ms=60000,
        segments=[], candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60000, points=[]),
        fill_strength=FillStrength(bucket_ms=60000, points=[]),
        volume_profile_range=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        volume_profile_by_day=[],
    )
    assert b.ask_peaks == []  # 기본 빈 리스트 — 기존 클라 무영향
    b2 = b.model_copy(update={"ask_peaks": [
        AskPeak(date="20260613", price=25100, qty=5000, t_ms=1,
                max_price=25100, max_qty=5000, max_t_ms=1)
    ]})
    assert b2.ask_peaks[0].price == 25100 and b2.ask_peaks[0].date == "20260613"


def test_range_bundle_bid_peak_field_defaults_empty() -> None:
    from hoga.api.models import BidPeak, FillStrength, QuoteRatio, RangeBundle, VolumeProfile

    b = RangeBundle(
        code="005930",
        from_date="20260619",
        to_date="20260619",
        bucket_ms=60_000,
        segments=[],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]
        ),
        volume_profile_by_day=[],
    )

    assert b.bid_peaks == []

    b2 = b.model_copy(update={"bid_peaks": [
        BidPeak(
            date="20260619",
            price=70000,
            qty=5000,
            t_ms=1,
            max_price=70000,
            max_qty=5000,
            max_t_ms=1,
        )
    ]})
    assert b2.bid_peaks[0].price == 70000


def test_build_range_bundle_includes_bid_peaks(monkeypatch, tmp_path) -> None:
    import contextlib

    import hoga.api.bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle
    from hoga.api.models import BidPeak

    FIXTURE_DATE = "20260613"
    monkeypatch.setattr(bundle_mod, "_today_kst_yyyymmdd", lambda: FIXTURE_DATE)
    eng = _engine_with_meta_for_dates([FIXTURE_DATE])
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay", *, venue="KRX": tmp_path
    eng.conn = duckdb.connect()
    eng.indicators_cache = None
    bid = BidPeak(
        date=FIXTURE_DATE,
        price=70000,
        qty=5000,
        t_ms=1,
        max_price=70000,
        max_qty=5000,
        max_t_ms=1,
    )
    patches = _patch_slice_builders(bundle_mod, patch_ask_peak=False, patch_bid_peak=False) + [
        patch.object(
            bundle_mod,
            "build_ask_bid_peak_slices",
            return_value=(None, bid),
        ),
    ]
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        bundle = build_range_bundle(
            eng,
            code="005930",
            from_date=FIXTURE_DATE,
            to_date=FIXTURE_DATE,
            bucket_ms=60_000,
            mode="sidecar",
        )
    assert len(bundle.bid_peaks) == 1
    assert bundle.bid_peaks[0].price == 70000
    assert bundle.bid_peaks[0].qty == 5000


def test_build_depth_heatmap_slice_converts_rows_to_points(tmp_path):
    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_depth_heatmap_slice
    from hoga.tables.snapshots import DepthHeatmapRow
    from hoga.util.timeenc import ms_from_midnight_to_unix_ms

    code_dir = tmp_path / "20260102" / "005930"
    code_dir.mkdir(parents=True)
    (code_dir / "snapshots.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir

    row = DepthHeatmapRow(
        bucket_intra_ms=34_200_000,
        ask_prices=tuple(1000 + 10 * i for i in range(10)),
        ask_qtys=tuple(500 - 10 * i for i in range(10)),
        bid_prices=tuple(990 - 10 * i for i in range(10)),
        bid_qtys=tuple(400 - 10 * i for i in range(10)),
        ask_prices_max=tuple(1000 + 10 * i for i in range(10)),
        ask_qtys_max=tuple(900 - 10 * i for i in range(10)),
        bid_prices_max=tuple(990 - 10 * i for i in range(10)),
        bid_qtys_max=tuple(800 - 10 * i for i in range(10)),
    )
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_bucketed_depth_heatmap",
        return_value=[row],
    ) as query:
        points = build_depth_heatmap_slice(
            engine,
            code="005930",
            date="20260102",
            bucket_ms=60_000,
            source="hogaplay",
            session_open_ms=90_000_000,
            session_close_ms=153_000_000,
            # 순수 변환/쿼리 검증 — 캐시를 명시 우회해 MagicMock engine의
            # indicators_cache 가 조기 반환하지 않도록 한다(형제 빌더 테스트 관용구).
            cache=None,
            today_kst=None,
        )

    query.assert_called_once_with(
        engine.conn,
        path=code_dir / "snapshots.parquet",
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    assert len(points) == 1
    assert points[0].asks[0] == [1000, 500]
    assert points[0].bids[0] == [990, 400]
    assert len(points[0].asks) == 10
    assert len(points[0].bids) == 10
    assert points[0].asks_max[0] == [1000, 900]
    assert points[0].bids_max[0] == [990, 800]
    assert len(points[0].asks_max) == 10
    assert len(points[0].bids_max) == 10
    assert points[0].t_ms == ms_from_midnight_to_unix_ms("20260102", 34_200_000)
    assert points[0].t_ms > 1_000_000_000_000


def test_build_depth_heatmap_slice_missing_parquet_returns_empty(tmp_path):
    from hoga.api.bundle import build_depth_heatmap_slice

    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = tmp_path / "20260102" / "005930"  # no file

    points = build_depth_heatmap_slice(
        engine,
        code="005930",
        date="20260102",
        bucket_ms=60_000,
        source="hogaplay",
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    assert points == []


def _pt(t: int, *, net=None, delta=None, gap=False):
    from hoga.api.models import ProgramTradePoint
    return ProgramTradePoint(
        t=t, net_qty=net, net_amount=net, delta_qty=delta, delta_amount=delta, gap_risk=gap,
    )


def test_bucket_program_trade_points_aggregation_rules():
    """필드마다 규칙이 다르다 — **누적은 마지막, 증분은 합, 위험은 any**.

    막는 방향: 전 필드를 같은 규칙으로 접는 회귀. 특히 `net_*` 를 더하면(누적인데)
    값이 폭주하고, `delta_*` 를 마지막만 취하면 버킷 안 증분이 사라진다. 둘 다
    **화면에는 그럴듯한 숫자로 나와서** 눈으로 못 잡는다.
    """
    from hoga.api.bundle import _bucket_program_trade_points

    open_ms = 1_000_000
    out = _bucket_program_trade_points(
        [
            _pt(open_ms + 0, net=100, delta=10),
            _pt(open_ms + 30_000, net=130, delta=30, gap=True),
            _pt(open_ms + 59_000, net=175, delta=45),
            _pt(open_ms + 60_000, net=200, delta=25),   # 다음 버킷
        ],
        open_ms=open_ms,
        bucket_ms=60_000,
    )

    assert [p.t for p in out] == [open_ms, open_ms + 60_000]
    assert [p.net_amount for p in out] == [175, 200]        # 누적 → 마지막
    assert [p.delta_amount for p in out] == [85, 25]        # 증분 → 합(10+30+45)
    assert [p.gap_risk for p in out] == [True, False]       # any


def test_bucket_program_trade_points_all_null_delta_stays_null():
    """delta 가 전부 null 인 버킷은 **null 이지 0 이 아니다**.

    거래일 첫 행은 delta 가 null 이다(수집기가 새 거래일에 `_last_net` 을 리셋한다).
    0 으로 접으면 "증분이 없었다" 와 "모른다" 가 뭉개진다 — 이 리포가 `days_behind`
    에서 같은 구분을 지킨 것과 같은 이유다.
    """
    from hoga.api.bundle import _bucket_program_trade_points

    out = _bucket_program_trade_points(
        [_pt(0, net=100, delta=None), _pt(1_000, net=110, delta=None)],
        open_ms=0, bucket_ms=60_000,
    )
    assert len(out) == 1
    assert out[0].delta_amount is None and out[0].delta_qty is None
    # 섞여 있으면 non-null 만 더한다(전부 null 일 때만 null).
    mixed = _bucket_program_trade_points(
        [_pt(0, delta=None), _pt(1_000, delta=7)], open_ms=0, bucket_ms=60_000,
    )
    assert mixed[0].delta_amount == 7


def test_bucket_program_trade_anchors_on_session_open_not_epoch():
    """격자 원점이 **세션 오픈**이다 — epoch 가 아니다.

    프론트 프로젝터가 `meta.openMs + floor((t-openMs)/bucketMs)*bucketMs` 로 재버킷하므로
    (`chart/projectors/programTrade.ts`), 원점이 다르면 버킷 경계가 어긋나 "프론트
    버킷의 마지막 점" 이 아닌 값이 남는다. epoch 원점이면 아래가 두 버킷으로 갈린다.
    """
    from hoga.api.bundle import _bucket_program_trade_points

    open_ms = 1_000_000 + 30_000          # epoch 60s 격자와 어긋난 원점
    out = _bucket_program_trade_points(
        [_pt(open_ms + 0, net=1), _pt(open_ms + 59_000, net=2)],
        open_ms=open_ms, bucket_ms=60_000,
    )
    assert [p.t for p in out] == [open_ms]      # 한 버킷 — 원점을 세션 오픈으로 잡았다
    assert out[0].net_amount == 2


def test_build_program_trade_series_buckets_past_but_keeps_today_raw(tmp_path):
    """과거일은 접고 **오늘분은 원해상도**로 둔다.

    막는 방향: 오늘분까지 접는 회귀. 오늘분은 프론트에서 WS 실시간 꼬리와
    `max(persisted.t)` 이음매로 이어지므로(`programTradeLiveTail.ts`), 접으면 이음매가
    마지막 버킷 시작으로 당겨져 라이브 점들이 이미 덮인 구간에 겹쳐 들어온다 —
    캔들이 ADR-0125 에서 "오늘분은 언제나 1분" 을 못박은 것과 같은 함정.

    못 보는 것: 프론트 병합 결과 자체(그건 `programTradeLiveTail.test.ts` 몫).
    """
    from datetime import datetime
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_program_trade_series
    from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore
    from hoga.util.timeenc import KST

    def _row(hhmmss: str, net_qty: int) -> ProgramTradeByStockRow:
        return ProgramTradeByStockRow(
            code="005930", bsop_hour=hhmmss, t_ms=0, price=70_000,
            net_qty=net_qty, net_amount=net_qty * 1000,
            buy_qty=None, sell_qty=None, buy_amount=None, sell_amount=None,
            delta_qty=None, delta_amount=None,
        )

    def _open_ms(date: str) -> int:
        d = datetime.strptime(date, "%Y%m%d").replace(hour=9, tzinfo=KST)
        return int(d.timestamp() * 1000)

    past, today = "20260806", "20260807"
    store = ProgramTradeStore(tmp_path)
    for date in (past, today):
        # 같은 1분 버킷 안 30초 간격 2행 + 다음 버킷 1행.
        store.merge_response(
            venue="KRX", code="005930", date=date,
            rows=[_row("100000", 1), _row("100030", 2), _row("100100", 3)],
            observed_at_ms=1,
        )

    engine = MagicMock()
    engine.data_dir = tmp_path
    series = build_program_trade_series(
        engine, code="005930", dates=[past, today], venue="KRX",
        bucket_ms=60_000,
        session_open_by_date={past: _open_ms(past), today: _open_ms(today)},
        today_kst=today,
    )

    def _for(date: str) -> list[int]:
        lo, hi = _open_ms(date), _open_ms(date) + 86_400_000
        return [p.net_qty for p in series.points if lo <= p.t < hi]

    assert _for(past) == [2, 3]           # 접힘: 1분 버킷 2개(첫 버킷은 마지막 값 2)
    assert _for(today) == [1, 2, 3]       # 원해상도 유지
    assert series.points == sorted(series.points, key=lambda p: p.t)


def test_build_program_trade_series_skips_bucketing_without_session_open(tmp_path):
    """세션 오픈을 모르면 **접지 않는다** — 격자 원점을 추측하지 않는다.

    원점이 프론트와 어긋나면 값이 조용히 달라진다. 모를 때는 원해상도가 안전한 쪽이다.
    """
    from unittest.mock import MagicMock

    from hoga.api.bundle import build_program_trade_series
    from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore

    store = ProgramTradeStore(tmp_path)
    store.merge_response(
        venue="KRX", code="005930", date="20260806",
        rows=[
            ProgramTradeByStockRow(
                code="005930", bsop_hour=h, t_ms=0, price=1, net_qty=i,
                net_amount=i, buy_qty=None, sell_qty=None, buy_amount=None,
                sell_amount=None, delta_qty=None, delta_amount=None,
            )
            for i, h in enumerate(("100000", "100030"))
        ],
        observed_at_ms=1,
    )
    engine = MagicMock()
    engine.data_dir = tmp_path

    series = build_program_trade_series(
        engine, code="005930", dates=["20260806"], venue="KRX",
        bucket_ms=60_000, session_open_by_date={}, today_kst="20260807",
    )
    assert len(series.points) == 2


def test_gil_breathe_respects_the_interval(monkeypatch):
    """`_gil_breathe` 는 **임계에 걸릴 때만** sleep 한다 — 무조건이 아니다.

    막는 방향 둘:
    - 임계 검사를 지워 일자마다 sleep → 짧은 창(1~2일)에도 불필요한 1ms×N 지연.
    - sleep 을 지워 검사만 남김 → GIL 을 놓지 않아 이 장치가 무동작이 된다.

    시계·sleep 을 함께 fake 로 갈아 결정적으로 만든다(벽시계 단언은 이 리포에서
    flaky 로 기각 — `reference_wallclock_ratio_assertions_replace_with_call_counts`).
    """
    from hoga.api import bundle as bundle_mod

    clock = {"now": 1000.0}
    slept: list[float] = []

    class FakeTime:
        @staticmethod
        def monotonic() -> float:
            return clock["now"]

        @staticmethod
        def sleep(s: float) -> None:
            slept.append(s)

    monkeypatch.setattr(bundle_mod, "time", FakeTime)

    anchor = bundle_mod._gil_breathe(clock["now"])   # 방금 양보한 상태 → no-op
    assert slept == [] and anchor == 1000.0

    clock["now"] += bundle_mod._GIL_BREATHE_INTERVAL_S / 2   # 임계 미달 → no-op
    assert bundle_mod._gil_breathe(anchor) == anchor
    assert slept == []

    clock["now"] += bundle_mod._GIL_BREATHE_INTERVAL_S       # 임계 초과 → sleep + 갱신
    new_anchor = bundle_mod._gil_breathe(anchor)
    assert slept == [bundle_mod._GIL_BREATHE_SLEEP_S]
    assert new_anchor == clock["now"]


def test_build_range_bundle_breathes_once_per_date():
    """일자 루프가 **일자마다 + 빌더 사이마다** `_gil_breathe` 를 지난다 (배선).

    막는 방향: 루프의 호출을 지우는 회귀. 헬퍼 단위 테스트(위)는 그 회귀에 전부
    초록이다 — 이 세션에서 두 번 반복된 "무동작이 초록으로 위장" 패턴이라 배선을
    따로 못박는다. 이 장치가 없으면 3개월 sidecar 1발이 이벤트 루프를 9.8초
    굶긴다(2026-08-21 /health 프로브 실측).
    """
    import contextlib

    from hoga.api import bundle as bundle_mod
    from hoga.api.bundle import build_range_bundle

    dates = ["20260601", "20260602", "20260603"]
    mock_engine = _engine_with_meta_for_dates(dates)

    with contextlib.ExitStack() as stack:
        for name in (
            "build_candles_slice", "downsample_candles", "build_quote_ratio_slice",
            "build_fill_strength_slice", "build_volume_distribution_slice",
            "build_trade_volume_poc_slice", "build_ask_bid_peak_slices",
            "build_program_trade_series", "build_broker_late_entries_slice",
        ):
            stack.enter_context(patch.object(bundle_mod, name))
        breathe = stack.enter_context(
            patch.object(bundle_mod, "_gil_breathe", side_effect=lambda last: last)
        )
        build_range_bundle(
            mock_engine,
            code="005930",
            from_date="20260601",
            to_date="20260603",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
            mode="candles",
        )

    # **일자당 정확히 8회** = 루프 상단 1 + 빌더 블록 앞 7 (quote_ratio · peaks ·
    # poc · broker_late · vdist · heatmap · wall_surge). 지점 하나를 지우면
    # 여기서 떨어진다 — 오늘 재계산(과거 36ms vs 오늘 1,379ms, 그중 peaks 577ms)이
    # 한 덩어리로 돌아가는 회귀다. **빌더를 추가하면 그 앞에 지점을 넣고 이 수를
    # 올릴 것** — mergeRangeBundles 가 필드를 전수 나열하는 것과 같은 규율이다.
    assert breathe.call_count == 8 * len(dates)

