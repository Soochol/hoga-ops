"""LiveQuoteFetcher unit tests — fetch + 마지막-시세 캐시 + phase 게이팅을 FastAPI 없이
직접 검증한다(분리 전엔 /quotes 라우트 안이라 TestClient 전용 증거였다)."""
from __future__ import annotations

from hoga.live.api import LiveQuoteFetcher
from hoga.live.kis_client import KisQuote

Q = [KisQuote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500),
     KisQuote("000660", 183500, -0.8, -1500, open=184000, high=185000, low=182000)]


class _FakeKis:
    """fetch_multi_price 만 흉내 — codes 교집합 반환, 호출 수 기록, fail 시 raise."""
    def __init__(self, quotes: list[KisQuote], *, fail: bool = False) -> None:
        self._quotes = quotes
        self.calls = 0
        self.venues: list[str] = []
        self._fail = fail

    async def fetch_multi_price(self, codes: list[str], *, venue: str = "KRX") -> list[KisQuote]:
        self.calls += 1
        self.venues.append(venue)
        if self._fail:
            raise RuntimeError("kis down")
        want = set(codes)
        return [q for q in self._quotes if q.code in want]


async def test_open_returns_live_and_caches() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)
    out = await f.fetch_and_gate(kis, ["005930", "000660"], "open")  # type: ignore[arg-type]
    assert {q.code: q.change_pct for q in out} == {"005930": 1.2, "000660": -0.8}
    assert (out[0].open, out[0].high, out[0].low) == (72000, 73000, 71500)  # open 경로 OHLC 통과
    # 캐시에 적재됨(closed 서빙용).
    assert f._last_quotes["005930"].price == 72400


async def test_open_threads_quote_venue() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)

    await f.fetch_and_gate(kis, ["005930"], "open", venue="NXT")  # type: ignore[arg-type]

    assert kis.venues == ["NXT"]


async def test_pre_open_hides_change_keeps_price() -> None:
    f = LiveQuoteFetcher()
    out = await f.fetch_and_gate(_FakeKis(Q), ["005930"], "pre_open")  # type: ignore[arg-type]
    assert out[0].price == 72400
    assert out[0].change_pct is None and out[0].change_won is None
    assert out[0].open is None and out[0].high is None and out[0].low is None  # pre 게이트가 OHLC도 None


async def test_closed_cold_fetches_once_then_serves_cache() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)
    out1 = await f.fetch_and_gate(kis, ["005930", "000660"], "closed")  # type: ignore[arg-type]
    assert {q.code for q in out1} == {"005930", "000660"}
    assert kis.calls == 1
    # 두 번째: 캐시 히트 → 재fetch 없음.
    out2 = await f.fetch_and_gate(kis, ["005930", "000660"], "closed")  # type: ignore[arg-type]
    assert kis.calls == 1
    assert {q.code for q in out2} == {"005930", "000660"}


async def test_closed_cold_fetch_threads_quote_venue() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)

    await f.fetch_and_gate(kis, ["005930"], "closed", venue="UN")  # type: ignore[arg-type]

    assert kis.venues == ["UN"]


async def test_closed_omits_uncached_code() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis([KisQuote("005930", 72400, 1.2, 750)])
    out = await f.fetch_and_gate(kis, ["005930", "999999"], "closed")  # type: ignore[arg-type]
    assert {q.code for q in out} == {"005930"}  # 999999 는 KIS도 캐시도 없음 → 누락


async def test_closed_serves_cache_from_prior_open_no_refetch() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)
    await f.fetch_and_gate(kis, ["005930", "000660"], "open")  # type: ignore[arg-type]
    assert kis.calls == 1
    out = await f.fetch_and_gate(kis, ["005930", "000660"], "closed")  # type: ignore[arg-type]
    assert kis.calls == 1  # 장중 캐시를 그대로 서빙 — 재fetch 안 함
    assert {q.code for q in out} == {"005930", "000660"}


async def test_open_kis_failure_returns_empty_never_raises() -> None:
    f = LiveQuoteFetcher()
    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "open")  # type: ignore[arg-type]
    assert out == []  # 오버레이는 절대 500 금지 — 빈 결과로 graceful


async def test_open_failure_after_cache_returns_stale_last_good() -> None:
    f = LiveQuoteFetcher()
    kis_ok = _FakeKis(Q)
    await f.fetch_and_gate(kis_ok, ["005930"], "open")  # type: ignore[arg-type]

    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "open")  # type: ignore[arg-type]

    assert len(out) == 1
    assert out[0].code == "005930"
    assert out[0].price == 72400
    assert out[0].change_pct == 1.2
    assert out[0].change_won == 750
    assert out[0].stale is True
    assert out[0].stale_reason == "kis_fetch_failed"


async def test_closed_cold_failure_serves_empty() -> None:
    f = LiveQuoteFetcher()
    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "closed")  # type: ignore[arg-type]
    assert out == []  # cold fetch 실패 + 캐시 비어있음 → 빈 결과(예외 미전파)
