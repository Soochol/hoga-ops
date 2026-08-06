"""야간 WS 틱과 주간 REST 값의 병합 (ADR-0141).

**주 회귀 가드는 "무음은 정상" 이다.** 야간 유동성은 상품마다 크게 다르다 —
2026-08-07 00:36 실측 40초에 KOSPI200 48틱 / 코스닥150 0틱 / VKOSPI 0틱.
틱이 없다고 값을 비우면 유동성 낮은 카드가 야간 내내 빈다. 그때 옳은 값은
**주간 마감본**이고, 화면은 그 카드에만 낡음 배지를 달아야 한다.

두 번째 가드는 주간에 WS 를 쥐지 않는 것이다. REST 가 이미 실시간이라 틱을 써도
얻는 게 없고, WS 슬롯만 붙잡는다.
"""
from dataclasses import replace

import pytest

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live import futures_runtime as fr
from hoga.live.kis_futures_endpoints import FuturesQuote
from hoga.live.kis_futures_ws import NightTick

MASTER = [
    FuturesMasterRow("A01609", "F 202609", "kospi200", "202609", "2001", "KOSPI200"),
    FuturesMasterRow("A06609", "코스닥150F 202609", "kosdaq150", "202609", "3003", "KSQ150"),
    FuturesMasterRow("A04608", "변동성F 202608", "vkospi", "202608", "0503", "VKOSPI"),
]


def _quote(code: str, value: float) -> FuturesQuote:
    return FuturesQuote(
        code=code, product="x", label="l", expiry="202609", value=value,
        change=-60.9, change_rate=-5.84, prev_close=1042.05, volume=123714,
        open_interest=159288, oi_change=-1469, market_basis=-1.77, disparity=-0.4,
        days_left=36, last_trade_date="20260910", t_ms=1,
    )


class _FakeClient:
    """REST 는 언제나 주간 마감본을 준다 — 실제 벤더 동작 그대로."""

    async def fetch_futures_quotes(self, rows, *, foreground=False):
        return [_quote(r.code, 100.0 + i) for i, r in enumerate(rows)]


class _FakeWs:
    def __init__(self, ticks: dict[str, NightTick]) -> None:
        self._ticks = ticks
        self.running_codes: tuple[str, ...] | None = None
        self.closed = False

    async def ensure_running(self, codes, *, session_day=None):
        self.running_codes = codes
        self.session_day = session_day

    def night_series(self, code):
        return ()

    def latest(self, code):
        return self._ticks.get(code)

    async def aclose(self):
        self.closed = True


def _tick(code: str, price: float) -> NightTick:
    return NightTick(
        code=code, price=price, change=23.8, change_rate=2.43, volume=18248,
        open_interest=159000, oi_change=-100, market_basis=22.03,
        bsop_hour="235027", t_ms=999,
    )


@pytest.fixture
def runtime(monkeypatch):
    rt = fr.FuturesQuotesRuntime(lambda: _FakeClient())
    rt._master = MASTER
    rt._master_at = float("inf")  # TTL 만료 방지 — 다운로드로 새지 않게
    monkeypatch.setattr(fr.time, "monotonic", lambda: 0.0)
    # 세션 날짜는 봉 리셋 기준일 뿐이라 여기선 고정한다(캘린더 디스크 접근 회피).
    monkeypatch.setattr(fr, "spark_date", lambda _t: "20260806")
    return rt


async def test_night_tick_overrides_rest_value(runtime, monkeypatch):
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    snap = await runtime.snapshot()
    by_id = {c.item.id: c for c in snap.cards}

    # 틱이 있는 종목만 야간 값으로 갈린다
    assert by_id["KOSPI200_F"].quote.value == 1004.95
    assert by_id["KOSPI200_F"].data_session == "night"
    assert by_id["KOSPI200_F"].quote.t_ms == 999


async def test_silent_products_keep_daytime_close(runtime, monkeypatch):
    """무음 종목은 주간 마감본을 유지한다 — 비우면 야간 내내 빈 카드가 된다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    snap = await runtime.snapshot()
    by_id = {c.item.id: c for c in snap.cards}

    for card_id in ("KOSDAQ150_F", "VKOSPI_F"):
        assert by_id[card_id].data_session == "day"
        assert by_id[card_id].quote.value > 0  # REST 주간 마감본이 남아 있다


async def test_daytime_ignores_ws_and_closes_it(runtime, monkeypatch):
    """주간엔 REST 가 이미 실시간이다 — 틱이 있어도 쓰지 않고 세션을 닫는다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "day")
    ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})
    runtime._ws = ws

    snap = await runtime.snapshot()
    by_id = {c.item.id: c for c in snap.cards}

    assert by_id["KOSPI200_F"].quote.value != 1004.95
    assert all(c.data_session == "day" for c in snap.cards)
    assert ws.closed is True
    assert ws.running_codes is None


async def test_night_subscribes_current_near_month_codes(runtime, monkeypatch):
    """구독 코드는 마스터의 근월물이다 — 롤오버되면 새 코드로 다시 열려야 한다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    ws = _FakeWs({})
    runtime._ws = ws

    await runtime.snapshot()
    assert ws.running_codes == ("A01609", "A06609", "A04608")


async def test_closed_session_does_not_open_ws(runtime, monkeypatch):
    monkeypatch.setattr(fr, "futures_session", lambda _t: "closed")
    ws = _FakeWs({})
    runtime._ws = ws

    snap = await runtime.snapshot()
    assert ws.running_codes is None
    assert all(c.data_session == "day" for c in snap.cards)


async def test_missing_rest_quote_drops_card_even_with_tick(runtime, monkeypatch):
    """REST 가 그 종목을 못 주면 카드를 만들지 않는다 — 틱만으로는 만기·괴리율이 없다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")

    class _PartialClient:
        async def fetch_futures_quotes(self, rows, *, foreground=False):
            return [_quote(r.code, 100.0) for r in rows if r.code != "A06609"]

    runtime._client_factory = lambda: _PartialClient()
    runtime._ws = _FakeWs({"A06609": _tick("A06609", 1384.4)})

    snap = await runtime.snapshot()
    assert "KOSDAQ150_F" not in {c.item.id for c in snap.cards}


def test_ws_tick_parsing_uses_named_columns() -> None:
    """필드는 순서로 온다 — 인덱스를 손으로 세면 벤더가 필드를 늘릴 때 조용히 어긋난다."""
    from hoga.live.kis_futures_ws import _COLUMNS, KisFuturesNightWs

    fields = [""] * len(_COLUMNS)
    fields[_COLUMNS.index("futs_shrn_iscd")] = "A01609"
    fields[_COLUMNS.index("bsop_hour")] = "235027"
    fields[_COLUMNS.index("futs_prpr")] = "1004.95"
    fields[_COLUMNS.index("futs_prdy_vrss")] = "23.80"
    fields[_COLUMNS.index("futs_prdy_ctrt")] = "2.43"
    fields[_COLUMNS.index("acml_vol")] = "18248"
    fields[_COLUMNS.index("mrkt_basis")] = "22.03"
    fields[_COLUMNS.index("hts_otst_stpl_qty")] = "159000"

    ws = KisFuturesNightWs(lambda: None)
    ws._on_frame("H0MFCNT0", "^".join(fields))

    tick = ws.latest("A01609")
    assert tick is not None
    assert tick.price == 1004.95
    assert tick.change == 23.80
    assert tick.market_basis == 22.03
    assert tick.volume == 18248
    assert tick.bsop_hour == "235027"


def test_empty_price_is_not_a_tick() -> None:
    """가격이 빈 프레임(체결 없음) — 0 으로 채우면 카드가 0 을 그린다.

    TR 필터는 전송 계층 책임이라 여기서 시험하지 않는다(`test_kis_ws_client`).
    """
    from hoga.live.kis_futures_ws import _COLUMNS, KisFuturesNightWs

    ws = KisFuturesNightWs(lambda: None)
    fields = [""] * len(_COLUMNS)
    fields[_COLUMNS.index("futs_shrn_iscd")] = "A01609"
    ws._on_frame("H0MFCNT0", "^".join(fields))
    assert ws.latest("A01609") is None


def test_quote_replace_keeps_expiry_fields() -> None:
    """틱으로 덮을 때 만기·잔존일이 날아가면 안 된다 — 그건 마스터/REST 에만 있다."""
    q = _quote("A01609", 981.15)
    merged = replace(q, value=1004.95, t_ms=999)
    assert merged.expiry == "202609"
    assert merged.days_left == 36
    assert merged.last_trade_date == "20260910"
