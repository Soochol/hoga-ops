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
    def __init__(
        self,
        ticks: set[str],
        series: dict[str, tuple[float, ...]],
        observed: list[list[int]] | None = None,
    ) -> None:
        self._ticks = ticks
        self._series = series
        self._observed = observed if observed is not None else [[0, 40]]

    def latest(self, code):
        return object() if code in self._ticks else None

    def night_series(self, code):
        return self._series.get(code, ())

    def night_coverage(self):
        return _ws_with_observed(self._observed).night_coverage()


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


# ── 커버리지: 관측 구간 ─────────────────────────────────────────────────────
#
# 봉 유무로는 갭을 셀 수 없다 — 거래 없는 구간엔 애초에 봉이 없기 때문이다(VKOSPI 는
# 주간에도 하루 2봉). 그래서 "WS 가 연결돼 있었는가" 를 따로 추적한다.

def _ws_with_observed(ranges: list[list[int]]) -> KisFuturesNightWs:
    ws = KisFuturesNightWs()
    ws._observed = ranges
    return ws


def test_coverage_none_before_any_observation() -> None:
    assert KisFuturesNightWs().night_coverage() is None


def test_coverage_from_session_open_is_clean() -> None:
    cov = _ws_with_observed([[0, 40]]).night_coverage()
    assert cov is not None
    assert cov.first_bucket == 0
    assert cov.first_hhmm == "1800"  # 야간 개장부터 봤다
    assert cov.observed_buckets == 41
    assert cov.gap_count == 0


def test_late_start_is_reported_as_first_hhmm() -> None:
    """02:00 부터만 봤다면 화면이 그 사실을 말해야 한다 — 그림만으로는 구별 불가."""
    cov = _ws_with_observed([[96, 100]]).night_coverage()
    assert cov is not None
    assert cov.first_hhmm == "0200"
    assert cov.gap_count == 0


def test_restart_shows_up_as_gap() -> None:
    """재시작·유휴 정지로 관측이 끊기면 구간이 둘로 갈린다."""
    cov = _ws_with_observed([[0, 20], [60, 80]]).night_coverage()
    assert cov is not None
    assert cov.first_bucket == 0
    assert cov.last_bucket == 80
    assert cov.observed_buckets == 21 + 21  # 끊긴 구간은 세지 않는다
    assert cov.gap_count == 1


def test_adjacent_ranges_merge_not_counted_as_gap() -> None:
    """재연결이 잦으면 인접 구간이 쪼개져 들어온다 — 그건 끊김이 아니다."""
    cov = _ws_with_observed([[0, 10], [11, 20], [21, 30]]).night_coverage()
    assert cov is not None
    assert cov.gap_count == 0
    assert cov.observed_buckets == 31


def test_coverage_hhmm_wraps_past_midnight() -> None:
    """버킷 원점이 18:00 이라 되돌릴 때 자정을 감아야 한다."""
    def _first(bucket: int) -> str:
        cov = _ws_with_observed([[bucket, bucket]]).night_coverage()
        assert cov is not None
        return cov.first_hhmm

    assert _first(0) == "1800"
    assert _first(70) == "2350"
    assert _first(96) == "0200"
    assert _first(131) == "0455"


def test_observed_is_not_the_same_as_bar_count() -> None:
    """무음 구간도 관측한 것이다 — 봉 2개뿐이어도 커버리지는 온전할 수 있다.

    이 구분이 없으면 저유동성 종목이 영원히 "누락" 으로 찍힌다.
    """
    ws = _ws_with_observed([[0, 40]])
    ws._ingest(_frame("A04608", "180000", "73.5"))
    ws._ingest(_frame("A04608", "230000", "73.5"))

    assert len(ws.night_series("A04608")) == 2
    cov = ws.night_coverage()
    assert cov is not None
    assert cov.observed_buckets == 41  # 봉은 2개지만 41버킷을 봤다
    assert cov.gap_count == 0


async def test_new_session_clears_observation() -> None:
    ws = KisFuturesNightWs()
    await ws.ensure_running(("A01609",), session_day="20260806")
    ws._observed = [[0, 40]]
    await ws.ensure_running(("A01609",), session_day="20260807")
    assert ws.night_coverage() is None
    await ws.aclose()


async def test_coverage_rides_along_night_series(runtime):
    """야간 시리즈에만 실린다 — 주간은 REST 로 소급 조회되므로 개념이 없다."""
    ws = _FakeWs({"A01609"}, {"A01609": (1000.0, 1005.0, 1010.0)}, observed=[[96, 100]])
    runtime._ws = ws
    got = await runtime.sparks()

    cov = got["KOSPI200_F"].coverage
    assert cov is not None
    assert cov.first_hhmm == "0200"
    # 주간 시리즈에는 없다
    assert got["KOSDAQ150_F"].session == "day"
    assert got["KOSDAQ150_F"].coverage is None
