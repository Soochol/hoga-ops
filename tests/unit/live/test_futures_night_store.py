"""야간 선물 세션 기록 (`futures_night_store`) + 런타임 배선.

**이 가드가 막는 방향**: 저장 포맷이 조용히 어긋나는 것과, 야간 틱이 디스크에
안 남는 것. 후자가 특히 아픈 이유는 **소급 복구가 원리적으로 없기 때문**이다 —
KIS 는 야간을 REST 로 주지 않는다(2026-08-08 실측: 분봉 앵커를 야간으로 줘도 주간
83봉, `MF` 분류코드는 `OPSQ2001` 명시 거부, 일봉은 주간 마감값). 안 쓴 밤은 영영 없다.

**못 보는 것**: 실제 WS 프레임 해석(그쪽은 `test_futures_night_spark.py`)과, 저장된
기록을 화면이 어떻게 읽는지(아직 어느 라우트에도 연결돼 있지 않다 — 다음 단계).
"""
import json

import pytest

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live import futures_runtime as fr
from hoga.live.futures_night_store import (
    NightQuoteRecord,
    NightSessionRecord,
    latest_session_day,
    load_session,
    save_session,
    session_path,
)
from hoga.live.kis_futures_endpoints import FuturesQuote
from hoga.live.kis_futures_ws import NightTick

MASTER = [
    FuturesMasterRow("A01609", "F 202609", "kospi200", "202609", "2001", "KOSPI200"),
    FuturesMasterRow("A06609", "코스닥150F 202609", "kosdaq150", "202609", "3003", "KSQ150"),
]


def _record(**over) -> NightQuoteRecord:
    base = {
        "code": "A01609", "price": 1004.95, "change": 23.8, "change_rate": 2.43,
        "volume": 18248, "open_interest": 159000, "oi_change": -100,
        "market_basis": 22.03, "disparity": -0.4, "bsop_hour": "235027", "t_ms": 999,
        "bars": {0: 998.1, 70: 1002.5, 96: 1004.95},
    }
    return NightQuoteRecord(**{**base, **over})


# ── 저장 포맷 ──────────────────────────────────────────────────────────────

def test_roundtrip_preserves_values_and_bucket_keys(tmp_path):
    """**버킷 키가 int 로 돌아와야 한다.** JSON 객체 키는 문자열뿐이라 그냥 읽으면
    `"96"` 이 되고, 정렬이 사전순으로 바뀌어(`"0" < "70" < "96"` 은 우연히 맞지만
    `"100" < "70"` 은 틀리다) 스파크라인이 뒤섞인다."""
    save_session(tmp_path, NightSessionRecord("20260810", 1_700, {"KOSPI200_F": _record()}))

    got = load_session(tmp_path, "20260810")

    assert got is not None
    q = got.quotes["KOSPI200_F"]
    assert q.price == 1004.95
    assert q.market_basis == 22.03
    assert q.bars == {0: 998.1, 70: 1002.5, 96: 1004.95}
    assert all(isinstance(k, int) for k in q.bars)


def test_keys_are_card_ids_not_symbol_codes(tmp_path):
    """롤오버로 근월물 코드가 바뀌어도(3개월마다) 어제 밤을 찾을 수 있어야 한다."""
    save_session(tmp_path, NightSessionRecord("20260810", 1, {"KOSPI200_F": _record()}))

    got = load_session(tmp_path, "20260810")

    assert got is not None
    assert set(got.quotes) == {"KOSPI200_F"}
    assert got.quotes["KOSPI200_F"].code == "A01609"  # 코드는 값으로 남는다


def test_empty_record_writes_no_file(tmp_path):
    """빈 파일을 남기면 "거래가 없었다" 와 "우리가 못 봤다" 가 디스크에서 같아진다."""
    save_session(tmp_path, NightSessionRecord("20260810", 1, {}))

    assert not session_path(tmp_path, "20260810").exists()
    assert load_session(tmp_path, "20260810") is None


def test_missing_file_is_normal_not_an_error(tmp_path):
    assert load_session(tmp_path, "20260810") is None


def test_corrupt_file_reads_as_unknown(tmp_path):
    path = session_path(tmp_path, "20260810")
    path.parent.mkdir(parents=True)
    path.write_text("{ this is not json", encoding="utf-8")

    assert load_session(tmp_path, "20260810") is None


def test_unknown_format_version_is_refused(tmp_path):
    """모르는 버전을 짐작해서 읽으면 조용히 틀린 값을 그린다."""
    path = session_path(tmp_path, "20260810")
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"v": 99, "quotes": {"KOSPI200_F": {}}}), encoding="utf-8")

    assert load_session(tmp_path, "20260810") is None


def test_one_broken_quote_does_not_lose_the_others(tmp_path):
    save_session(
        tmp_path,
        NightSessionRecord("20260810", 1, {"KOSPI200_F": _record(), "KOSDAQ150_F": _record()}),
    )
    path = session_path(tmp_path, "20260810")
    raw = json.loads(path.read_text(encoding="utf-8"))
    del raw["quotes"]["KOSDAQ150_F"]["price"]
    path.write_text(json.dumps(raw), encoding="utf-8")

    got = load_session(tmp_path, "20260810")

    assert got is not None
    assert set(got.quotes) == {"KOSPI200_F"}


def test_rewrite_leaves_no_temp_files(tmp_path):
    """세션 중 분당 한 번 덮어쓴다 — tmp 가 남으면 매일 밤 수백 개가 쌓인다."""
    for i in range(3):
        save_session(tmp_path, NightSessionRecord("20260810", i, {"KOSPI200_F": _record()}))

    files = sorted(p.name for p in (tmp_path / "futures_night").iterdir())
    assert files == ["20260810.json"]


def test_latest_session_day_excludes_today_when_asked(tmp_path):
    """낮에 "어젯밤" 을 보여줄 때 오늘 밤 파일(이미 쌓이는 중)을 집으면 안 된다."""
    for day in ("20260807", "20260810", "20260811"):
        save_session(tmp_path, NightSessionRecord(day, 1, {"KOSPI200_F": _record()}))

    assert latest_session_day(tmp_path) == "20260811"
    assert latest_session_day(tmp_path, before="20260811") == "20260810"


def test_latest_session_day_without_any_record(tmp_path):
    """저장을 켠 첫날의 상태다 — 없다고 답해야 화면이 "기록 없음" 을 말할 수 있다."""
    assert latest_session_day(tmp_path) is None


# ── 런타임 배선 ────────────────────────────────────────────────────────────

def _quote(code: str, value: float) -> FuturesQuote:
    return FuturesQuote(
        code=code, product="x", label="l", expiry="202609", value=value,
        change=-60.9, change_rate=-5.84, prev_close=1042.05, volume=123714,
        open_interest=159288, oi_change=-1469, market_basis=-1.77, disparity=-0.4,
        days_left=36, last_trade_date="20260910", t_ms=1,
    )


class _FakeClient:
    async def fetch_futures_quotes(self, rows, *, foreground=False):
        return [_quote(r.code, 100.0 + i) for i, r in enumerate(rows)]


class _FakeWs:
    def __init__(self, ticks, bars=None) -> None:
        self._ticks = ticks
        self._bars = bars or {}

    async def ensure_running(self, codes, *, session_day=None):
        self.session_day = session_day

    def night_series(self, code):
        return ()

    def night_bars(self, code):
        return dict(self._bars.get(code) or {})

    def latest(self, code):
        return self._ticks.get(code)

    async def aclose(self):
        pass


def _tick(code: str, price: float) -> NightTick:
    return NightTick(
        code=code, price=price, change=23.8, change_rate=2.43, volume=18248,
        open_interest=159000, oi_change=-100, market_basis=22.03, disparity=-0.4,
        bsop_hour="235027", t_ms=999,
    )


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    rt = fr.FuturesQuotesRuntime(lambda: _FakeClient(), tmp_path)
    rt._master = MASTER
    rt._master_at = float("inf")
    monkeypatch.setattr(fr.time, "monotonic", lambda: 1_000.0)
    monkeypatch.setattr(fr, "spark_date", lambda _t: "20260810")
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    return rt


async def test_snapshot_persists_night_ticks(runtime, tmp_path):
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)}, {"A01609": {0: 998.1, 1: 1004.95}})

    await runtime.snapshot()

    got = load_session(tmp_path, "20260810")
    assert got is not None
    assert got.quotes["KOSPI200_F"].price == 1004.95
    assert got.quotes["KOSPI200_F"].bars == {0: 998.1, 1: 1004.95}


async def test_silent_product_is_not_recorded(runtime, tmp_path):
    """무음 종목의 값은 주간 마감본이다. 그걸 야간 기록으로 남기면 다음 날 "어젯밤"
    이라며 그 전날 주간 종가를 보여주게 된다."""
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    await runtime.snapshot()

    got = load_session(tmp_path, "20260810")
    assert got is not None
    assert set(got.quotes) == {"KOSPI200_F"}  # 코스닥150 은 무음이라 빠진다


async def test_keeper_path_also_persists(runtime, tmp_path):
    """keeper 는 `snapshot()` 을 부르지 않는다 — 그 경로에도 저장이 걸려야 한다.
    안 그러면 아무도 화면을 안 본 밤은 keeper 가 도는데도 기록이 0이다."""
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    assert await runtime.ensure_night_stream() is True

    assert load_session(tmp_path, "20260810") is not None


async def test_persist_is_throttled(runtime, tmp_path, monkeypatch):
    """시세 폴링(20~30초)과 keeper(60초)가 같은 경로를 지난다 — 스로틀이 없으면
    같은 파일을 분당 서너 번 덮어쓴다."""
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})
    await runtime.snapshot()
    first = load_session(tmp_path, "20260810")
    assert first is not None

    # 30초 뒤 — 아직 스로틀 안이다.
    monkeypatch.setattr(fr.time, "monotonic", lambda: 1_030.0)
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1111.11)})
    await runtime.snapshot()
    assert load_session(tmp_path, "20260810").quotes["KOSPI200_F"].price == 1004.95

    # 61초 뒤 — 다시 쓴다.
    monkeypatch.setattr(fr.time, "monotonic", lambda: 1_061.0)
    await runtime.snapshot()
    assert load_session(tmp_path, "20260810").quotes["KOSPI200_F"].price == 1111.11


async def test_daytime_writes_nothing(runtime, tmp_path, monkeypatch):
    """주간 값은 REST 로 언제든 다시 받는다 — 야간 파일에 섞으면 그 밤이 오염된다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "day")
    runtime._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    await runtime.snapshot()

    assert not (tmp_path / "futures_night").exists()


async def test_no_data_dir_disables_persistence(monkeypatch, tmp_path):
    """무자격·테스트 경로에서 디스크를 건드리지 않는다."""
    rt = fr.FuturesQuotesRuntime(lambda: _FakeClient())  # data_dir 없음
    rt._master = MASTER
    rt._master_at = float("inf")
    monkeypatch.setattr(fr.time, "monotonic", lambda: 1_000.0)
    monkeypatch.setattr(fr, "spark_date", lambda _t: "20260810")
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    rt._ws = _FakeWs({"A01609": _tick("A01609", 1004.95)})

    await rt.snapshot()  # 예외 없이 끝나면 된다

    assert list(tmp_path.iterdir()) == []
