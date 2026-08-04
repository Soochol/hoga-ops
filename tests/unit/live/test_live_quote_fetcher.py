"""LiveQuoteFetcher unit tests — fetch + 마지막-시세 캐시 + phase 게이팅을 FastAPI 없이
직접 검증한다(분리 전엔 /quotes 라우트 안이라 TestClient 전용 증거였다)."""
from __future__ import annotations

from datetime import date

import pytest

from hoga.live import api as live_api
from hoga.live.api import LiveQuoteFetcher
from hoga.live.quote_models import Quote


@pytest.fixture(autouse=True)
def _adapter_delegates_to_fake_client(monkeypatch):
    """어댑터 모듈 함수를 **전달된 클라이언트의 메서드로 위임**시킨다.

    PR-D(#1040)로 `fetch_and_gate` 가 클라이언트를 받아 `kiwoom_multi_quote.
    fetch_multi_price(client, ...)` 를 부른다. 이 파일은 fetcher 의 **게이팅 로직**을
    보는 곳이고 와이어 파싱은 `test_kiwoom_multi_quote` 가 덮으므로, 기존 `_FakeKis`
    를 그대로 살리는 이 위임이 가장 작은 이음매다.
    """
    async def _fetch(client, codes, *, venue="KRX"):
        return await client.fetch_multi_price(codes, venue=venue)

    monkeypatch.setattr(live_api.kiwoom_multi_quote, "fetch_multi_price", _fetch)

Q = [Quote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500),
     Quote("000660", 183500, -0.8, -1500, open=184000, high=185000, low=182000)]


class _FakeKis:
    """fetch_multi_price 만 흉내 — codes 교집합 반환, 호출 수 기록, fail 시 raise."""
    def __init__(self, quotes: list[Quote], *, fail: bool = False) -> None:
        self._quotes = quotes
        self.calls = 0
        self.venues: list[str] = []
        self._fail = fail

    async def fetch_multi_price(self, codes: list[str], *, venue: str = "KRX") -> list[Quote]:
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
    # 캐시에 적재됨(closed 서빙용). 키는 (venue, code) — OHLC 가 venue 마다 다르다.
    # 값과 함께 출처(phase)도 남는다 — closed 서빙이 종가 여부를 물을 수 있어야 한다.
    assert f._last_quotes[("KRX", "005930")].quote.price == 72400
    assert f._last_quotes[("KRX", "005930")].phase == "open"


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


# --- venue 격리: OHLC 는 venue 마다 다르므로(005930 시가 KRX 257,000 vs UN 225,500 실측)
#     한 venue 의 캐시가 다른 venue 요청에 새면 캔들·시가가 통째로 틀린다 ---

async def test_closed_does_not_serve_other_venues_cache() -> None:
    """KRX 로 캐시를 채운 뒤 UN 을 요청하면 **KRX 봉을 주지 않고** 그 venue 로 다시 받는다.
    캐시 키가 code 뿐이면 'not missing' 으로 판정돼 KRX 봉이 UN 인 척 서빙됐다."""
    f = LiveQuoteFetcher()
    krx = _FakeKis([Quote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500)])
    await f.fetch_and_gate(krx, ["005930"], "closed")  # type: ignore[arg-type]

    un = _FakeKis([Quote("005930", 72500, 1.4, 900, open=70000, high=73200, low=69800)])
    out = await f.fetch_and_gate(un, ["005930"], "closed", venue="UN")  # type: ignore[arg-type]

    assert un.calls == 1                      # KRX 캐시로 때우지 않고 UN 을 실제 조회
    assert out[0].open == 70000               # UN 시가(72000=KRX 가 아니다)


async def test_stale_last_good_is_venue_scoped() -> None:
    """KIS 실패/우회 경로도 같은 규칙 — 요청 venue 의 표본이 없으면 다른 venue 것을
    대신 주지 않고 그 코드를 비운다(틀린 봉보다 '—' 가 정직하다)."""
    f = LiveQuoteFetcher()
    await f.fetch_and_gate(_FakeKis(Q), ["005930"], "open")  # type: ignore[arg-type]

    assert [q.code for q in f.stale_last_good(["005930"], "open")] == ["005930"]
    assert f.stale_last_good(["005930"], "open", venue="UN") == []


async def test_closed_omits_uncached_code() -> None:
    f = LiveQuoteFetcher()
    kis = _FakeKis([Quote("005930", 72400, 1.2, 750)])
    out = await f.fetch_and_gate(kis, ["005930", "999999"], "closed")  # type: ignore[arg-type]
    assert {q.code for q in out} == {"005930"}  # 999999 는 KIS도 캐시도 없음 → 누락


# --- 종가 표본 판정: 장중 캐시를 종가로 서빙하지 않는다 ---
#
# 이 블록은 원래 "장중 캐시를 그대로 서빙 — 재fetch 안 함"을 **계약으로 못 박고
# 있었다**. 그게 버그였다: 캐시를 채우는 유일한 주체가 프론트 폴링이라, 탭이 가려져
# 폴링이 끊기면 그 순간 값이 캐시에 남고 마감 후 그게 종가 자리에 나온다.
# 실측 2026-08-01 — 관심종목의 삼성전자가 07/31 오전 10시대 247,000 을 종가
# (262,500) 자리에 표시. 새로고침도 못 고쳤고 백엔드 재시작만이 복구 경로였다.

async def test_closed_refetches_when_cache_is_only_an_intraday_sample() -> None:
    """장중 표본밖에 없으면 closed 는 **다시 조회한다** — 그 값은 종가가 아니다."""
    f = LiveQuoteFetcher()
    morning = _FakeKis([Quote("005930", 247000, 19.32, 40000)])
    await f.fetch_and_gate(morning, ["005930"], "open")  # type: ignore[arg-type]

    # 마감 후. KIS 는 진짜 종가를 줄 준비가 돼 있다.
    night = _FakeKis([Quote("005930", 262500, 26.81, 55500)])
    out = await f.fetch_and_gate(night, ["005930"], "closed")  # type: ignore[arg-type]

    assert night.calls == 1          # 캐시로 때우지 않는다
    assert out[0].price == 262500    # 오전 값(247000)이 아니라 종가
    assert out[0].stale is False


async def test_closed_reuses_closing_sample_without_refetch() -> None:
    """종가 표본이 이미 있으면 재조회하지 않는다 — 감속(600s 하트비트)의 전제 유지."""
    f = LiveQuoteFetcher()
    kis = _FakeKis(Q)
    await f.fetch_and_gate(kis, ["005930"], "closed")  # type: ignore[arg-type]
    assert kis.calls == 1

    out = await f.fetch_and_gate(kis, ["005930"], "closed")  # type: ignore[arg-type]
    assert kis.calls == 1            # 두 번째는 캐시 히트
    assert out[0].stale is False


async def test_closed_marks_stale_when_refetch_fails_over_intraday_sample() -> None:
    """재조회가 실패하면 장중 표본을 **숨기지 않되 stale 로 표시**한다.

    값을 지우면 목록이 통째로 '—' 가 되어 더 나쁘고, 표시 없이 내보내면 5시간 묵은
    값이 방금 받은 값과 구분되지 않는다(그게 이 버그가 무증상이었던 이유). 정밀
    소비자는 프론트의 isStaleLiveQuote 로 이 플래그를 보고 거른다."""
    f = LiveQuoteFetcher()
    morning = _FakeKis([Quote("005930", 247000, 19.32, 40000)])
    await f.fetch_and_gate(morning, ["005930"], "open")  # type: ignore[arg-type]

    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "closed")  # type: ignore[arg-type]

    assert out[0].price == 247000            # 값은 남는다
    assert out[0].stale is True              # 그러나 종가라고 주장하지 않는다
    assert out[0].stale_reason == "pre_close_sample"


async def test_closed_refetches_yesterdays_closing_sample() -> None:
    """어제 종가 표본은 오늘의 종가가 아니다 — 날짜가 다르면 재조회.

    앱을 하루 걸러 켜는 사용 패턴에서 실제로 걸린다: 어제 밤 표본이 closed phase 로
    저장돼 있어 phase 조건만으로는 통과해 버린다."""
    f = LiveQuoteFetcher()
    yesterday, today = date(2026, 7, 30), date(2026, 7, 31)
    stale_night = _FakeKis([Quote("005930", 207000, 0.5, 1000)])
    await f.fetch_and_gate(stale_night, ["005930"], "closed", today=yesterday)  # type: ignore[arg-type]

    kis = _FakeKis([Quote("005930", 262500, 26.81, 55500)])
    out = await f.fetch_and_gate(kis, ["005930"], "closed", today=today)  # type: ignore[arg-type]

    assert kis.calls == 1
    assert out[0].price == 262500


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
    assert out[0].stale_reason == "fetch_failed"


async def test_pre_open_failure_after_cache_returns_stale_last_good_without_ohlc() -> None:
    f = LiveQuoteFetcher()
    kis_ok = _FakeKis(Q)
    await f.fetch_and_gate(kis_ok, ["005930"], "open")  # type: ignore[arg-type]

    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "pre_open")  # type: ignore[arg-type]

    assert len(out) == 1
    assert out[0].code == "005930"
    assert out[0].price == 72400
    assert out[0].change_pct is None
    assert out[0].change_won is None
    assert out[0].open is None
    assert out[0].high is None
    assert out[0].low is None
    assert out[0].stale is True
    assert out[0].stale_reason == "fetch_failed"


async def test_closed_cold_failure_serves_empty() -> None:
    f = LiveQuoteFetcher()
    out = await f.fetch_and_gate(_FakeKis(Q, fail=True), ["005930"], "closed")  # type: ignore[arg-type]
    assert out == []  # cold fetch 실패 + 캐시 비어있음 → 빈 결과(예외 미전파)
