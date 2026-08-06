"""야간 스파크라인 — WS 틱 5분 버킷팅 (ADR-0141).

**주 회귀 가드는 자정 경계다.** 야간장은 18:00–05:00 이라 시계 그대로 정렬하면
새벽(`020000`)이 저녁(`180000`)보다 **앞**에 온다. 그러면 스파크라인이 좌우
반전되는데 우상향이 우하향으로 보일 뿐 **에러가 아니라서** 테스트가 없으면
눈으로만 잡힌다.

**두 번째 가드는 그림과 값의 소스 일치다.** 틱은 왔는데 봉이 아직 2개가 안 되는
구간(야간 개장 직후)에 주간 그림으로 폴백하면, 값은 야간인데 그림은 주간인 카드가
된다 — 사용자는 그날 주간 하락을 야간에 일어난 것으로 읽는다.
"""
import pytest

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live import futures_runtime as fr
from hoga.live.kis_futures_endpoints import FuturesSpark
from hoga.live.kis_futures_ws import _COLUMNS, KisFuturesNightWs, _bucket_of

MASTER = [
    FuturesMasterRow("A01609", "F 202609", "kospi200", "202609", "2001", "KOSPI200"),
    FuturesMasterRow("A06609", "코스닥150F 202609", "kosdaq150", "202609", "3003", "KSQ150"),
    FuturesMasterRow("A04608", "변동성F 202608", "vkospi", "202608", "0503", "VKOSPI"),
]


def _frame(code: str, hhmmss: str, price: str) -> str:
    fields = [""] * len(_COLUMNS)
    fields[_COLUMNS.index("futs_shrn_iscd")] = code
    fields[_COLUMNS.index("bsop_hour")] = hhmmss
    fields[_COLUMNS.index("futs_prpr")] = price
    return "0|H0MFCNT0|001|" + "^".join(fields)


# ── 버킷 키: 자정 경계 ──────────────────────────────────────────────────────

def test_bucket_origin_is_1800_not_midnight() -> None:
    """18:00 이 0 이어야 저녁→새벽이 단조 증가한다."""
    assert _bucket_of("180000") == 0
    assert _bucket_of("180459") == 0  # 같은 5분 버킷
    assert _bucket_of("180500") == 1


def test_dawn_sorts_after_evening() -> None:
    """시계로 정렬하면 02:00 < 18:00 이라 그림이 좌우 반전된다."""
    evening = _bucket_of("235000")
    dawn = _bucket_of("020000")
    assert evening is not None and dawn is not None
    assert dawn > evening, "새벽 봉이 저녁 봉 뒤에 와야 한다"
    assert _bucket_of("045900") == 131  # 야간 마지막 버킷(660분/5 − 1)


def test_bucket_rejects_garbage() -> None:
    assert _bucket_of("") is None
    assert _bucket_of("88") is None
    assert _bucket_of("xxxxxx") is None


# ── 버킷 누적 ──────────────────────────────────────────────────────────────

def test_series_is_time_ordered_across_midnight() -> None:
    ws = KisFuturesNightWs()
    # 일부러 뒤죽박죽 순서로 넣는다 — 수신 순서에 기대면 안 된다.
    ws._ingest(_frame("A01609", "020000", "1010.0"))  # 새벽
    ws._ingest(_frame("A01609", "180000", "1000.0"))  # 저녁(먼저 일어난 일)
    ws._ingest(_frame("A01609", "235000", "1005.0"))
    assert ws.night_series("A01609") == (1000.0, 1005.0, 1010.0)


def test_last_tick_in_bucket_wins() -> None:
    """한 버킷의 값은 그 구간의 **종가**다."""
    ws = KisFuturesNightWs()
    ws._ingest(_frame("A01609", "180000", "1000.0"))
    ws._ingest(_frame("A01609", "180230", "1001.0"))
    ws._ingest(_frame("A01609", "180459", "1002.0"))
    assert ws.night_series("A01609") == (1002.0,)


def test_series_is_per_code() -> None:
    ws = KisFuturesNightWs()
    ws._ingest(_frame("A01609", "180000", "1000.0"))
    ws._ingest(_frame("A06609", "180000", "1380.0"))
    assert ws.night_series("A01609") == (1000.0,)
    assert ws.night_series("A06609") == (1380.0,)
    assert ws.night_series("A04608") == ()


async def test_new_session_day_clears_bars() -> None:
    """어제 저녁 봉을 오늘 것에 이어 붙이면 자정에 없던 갭이 생긴다."""
    ws = KisFuturesNightWs()
    await ws.ensure_running(("A01609",), session_day="20260806")
    ws._ingest(_frame("A01609", "180000", "1000.0"))
    assert ws.night_series("A01609") == (1000.0,)

    await ws.ensure_running(("A01609",), session_day="20260807")
    assert ws.night_series("A01609") == ()
    await ws.aclose()


async def test_same_session_day_keeps_bars() -> None:
    """폴링마다 ensure_running 이 불린다 — 그때마다 지우면 봉이 안 쌓인다."""
    ws = KisFuturesNightWs()
    await ws.ensure_running(("A01609",), session_day="20260806")
    ws._ingest(_frame("A01609", "180000", "1000.0"))
    await ws.ensure_running(("A01609",), session_day="20260806")
    assert ws.night_series("A01609") == (1000.0,)
    await ws.aclose()


# ── 런타임: 그림 소스와 값 소스의 일치 ────────────────────────────────────

class _FakeClient:
    """주간 REST 는 언제나 그날 주간장 모양을 준다."""

    async def fetch_futures_spark(self, row, *, date_yyyymmdd, foreground=False):
        return FuturesSpark(code=row.code, closes=(900.0, 901.0, 902.0), day_open=899.0)


class _FakeWs:
    def __init__(self, ticks: set[str], series: dict[str, tuple[float, ...]]) -> None:
        self._ticks = ticks
        self._series = series

    def latest(self, code):
        return object() if code in self._ticks else None

    def night_series(self, code):
        return self._series.get(code, ())


@pytest.fixture
def runtime(monkeypatch):
    rt = fr.FuturesQuotesRuntime(lambda: _FakeClient())
    rt._master = MASTER
    rt._master_at = float("inf")
    monkeypatch.setattr(fr, "spark_date", lambda _t: "20260806")
    return rt


async def test_ticking_product_gets_night_series(runtime):
    runtime._ws = _FakeWs({"A01609"}, {"A01609": (1000.0, 1005.0, 1010.0)})
    got = await runtime.sparks()

    assert got["KOSPI200_F"].session == "night"
    assert got["KOSPI200_F"].closes == (1000.0, 1005.0, 1010.0)
    # 야간 시리즈는 기준선을 주지 않는다 — 주간 시가로 색칠하면 등락 방향이 뒤집힌다
    assert got["KOSPI200_F"].day_open is None


async def test_silent_product_gets_daytime_series(runtime):
    """무음 종목은 주간 모양이 맞다 — 값도 주간 마감본이기 때문이다."""
    runtime._ws = _FakeWs({"A01609"}, {"A01609": (1000.0, 1005.0)})
    got = await runtime.sparks()

    assert got["KOSDAQ150_F"].session == "day"
    assert got["KOSDAQ150_F"].closes == (900.0, 901.0, 902.0)
    assert got["KOSDAQ150_F"].day_open == 899.0


async def test_ticking_but_too_few_bars_draws_nothing(runtime):
    """야간 개장 직후 — 값은 야간인데 주간 그림을 붙이면 하락 시점을 오도한다."""
    runtime._ws = _FakeWs({"A01609"}, {"A01609": (1000.0,)})
    got = await runtime.sparks()

    assert "KOSPI200_F" not in got
    # 나머지 카드는 영향 없다
    assert got["KOSDAQ150_F"].session == "day"


async def test_no_ws_falls_back_to_daytime(runtime):
    """주간에는 WS 자체가 없다."""
    runtime._ws = None
    got = await runtime.sparks()
    assert {s.session for s in got.values()} == {"day"}
