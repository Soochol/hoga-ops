from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_investor, kiwoom_rest_runtime
from hoga.live.index_registry import get_representative_index
from hoga.live.investor import InvestorNetPoint
from hoga.live.kiwoom_errors import KiwoomRateLimitError, KiwoomTransportError
from hoga.live.kiwoom_investor import KiwoomInvestorError
from hoga.live.live_index_investor_net import LiveIndexInvestorNetFetcher


class _FakeKis:
    """`ka10051` 어댑터의 **하루치** 계약을 재현한다.

    날짜 반복은 이 함수가 아니라 호출자(거버너 위)가 소유한다 — 페이크가 여러 날을
    돌면 배선 계약이 사라져 테스트가 아무것도 검증하지 않는다(ADR-0137).
    """

    def __init__(
        self,
        *,
        blank_dates: frozenset[str] = frozenset(),
        row_absent_dates: frozenset[str] = frozenset(),
    ) -> None:
        self.calls: list[tuple[str, str]] = []
        self.blank_dates = blank_dates
        self.row_absent_dates = row_absent_dates

    async def fetch_market_investor_net_day(
        self, _client, index, date_yyyymmdd: str,
    ) -> InvestorNetPoint | None:
        self.calls.append((index.id, date_yyyymmdd))
        if date_yyyymmdd in self.row_absent_dates:
            # 행은 왔는데 우리 업종이 없다 — 휴장일(None)과 **다른 사건**이다(#1296).
            raise KiwoomInvestorError(
                "index_row_absent",
                f"ka10051 이 {index.id}(업종 101) 행을 주지 않았다 — "
                f"mrkt_tp=10 · base_dt={date_yyyymmdd} 로 28행을 받았고 "
                "업종코드는 ['001', '002'] 이다",
            )
        if date_yyyymmdd in self.blank_dates:
            return None  # 휴장일
        return InvestorNetPoint(
            t_ms=int(date_yyyymmdd), foreign_net=-3519, institution_net=17184,
        )


class _RecordingScheduler:
    def __init__(
        self,
        *,
        raise_rate_limit: bool = False,
        fail_dates: frozenset[str] = frozenset(),
        failure: Exception | None = None,
    ) -> None:
        self.raise_rate_limit = raise_rate_limit
        self.fail_dates = fail_dates
        self.failure = failure
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[object | None], Awaitable],
    ):
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        if self.raise_rate_limit or key[-1] in self.fail_dates:
            raise self.failure or KiwoomRateLimitError("simulated 1700 유량 초과")
        return await call(None)


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 2점(클라이언트 조달·어댑터 함수)을 갈아끼운다."""
    def _install(fake: _FakeKis) -> _FakeKis:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda _d, **_k: object()
        )
        monkeypatch.setattr(
            kiwoom_investor, "fetch_market_investor_net_day",
            fake.fetch_market_investor_net_day,
        )
        return fake

    return _install


def _fetcher(tmp_path, scheduler) -> LiveIndexInvestorNetFetcher:
    return LiveIndexInvestorNetFetcher(
        data_dir=tmp_path, scheduler=scheduler,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_live_index_investor_net_schedules_background_request(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSDAQ"),
        from_label="20260619",
        to_label="20260619",
    )

    assert result["index_id"] == "KOSDAQ"
    assert result["points"] == [
        {"t_ms": 20260619, "foreign_net": -3519, "institution_net": 17184}
    ]
    assert result["data_warnings"] == []
    assert kis.calls == [("KOSDAQ", "20260619")]
    assert scheduler.calls == [
        {
            "key": ("index-investor-net", "KOSDAQ", "20260619"),
            "api_id": "ka10051",
            "priority": "background",
        }
    ]


@pytest.mark.asyncio
async def test_each_calendar_day_is_its_own_capacity_request(tmp_path, kiwoom) -> None:
    """회귀 봉인 — 날짜 반복은 거버너 **위**에 있어야 한다(ADR-0137).

    이전 판은 90일 요청을 submit 1건으로 내고 그 안에서 90콜을 쏘았다. 버킷은 1 을,
    벤더는 90 을 센다. 날짜 수가 사용자 입력이라 상한도 없었다.
    """
    kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260801",
        to_label="20260803",
    )

    assert len(scheduler.calls) == 3, "3일 → submit 3건"
    assert [c["key"][-1] for c in scheduler.calls] == ["20260801", "20260802", "20260803"]
    # key 가 겹치면 거버너가 중복제거로 합쳐 하루치만 실제로 나간다.
    assert len({c["key"] for c in scheduler.calls}) == 3
    assert [p["t_ms"] for p in result["points"]] == [20260801, 20260802, 20260803]


@pytest.mark.asyncio
async def test_non_trading_days_are_not_failures(tmp_path, kiwoom) -> None:
    """휴장일은 빈 응답이라 포인트가 없을 뿐 경고를 만들지 않는다."""
    kiwoom(_FakeKis(blank_dates=frozenset({"20260802"})))
    scheduler = _RecordingScheduler()

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260801",
        to_label="20260803",
    )

    assert [p["t_ms"] for p in result["points"]] == [20260801, 20260803]
    assert result["data_warnings"] == []


@pytest.mark.asyncio
async def test_index_row_absent_is_a_warning_not_a_silent_empty(tmp_path, kiwoom) -> None:
    """#1296 회귀 봉인 — 코스닥이 **경고 없이** 0포인트로 나오던 자리다.

    잘못된 `mrkt_tp` 는 에러가 아니라 매칭 안 되는 행 집합을 낳았고, 그게 "휴장일은
    None, 실패가 아니다" 규칙에 흡수됐다. 어댑터가 이제 그 서명을 구분해 던지므로
    이 층의 기존 배관(`classify_live_error` → `api_error`)이 화면에 노출한다.

    막는 방향: 빈 결과 + `data_warnings == []` 의 조합. 못 보는 것: 거래일인데
    벤더 응답 자체가 빈 경우(여전히 휴장일과 구별되지 않는다).
    """
    kiwoom(_FakeKis(row_absent_dates=frozenset({"20260811"})))
    scheduler = _RecordingScheduler()

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSDAQ"),
        from_label="20260811",
        to_label="20260811",
    )

    assert result["points"] == []
    assert result["data_warnings"], "빈 결과가 조용하면 안 된다 — 그게 #1296 이었다"
    warning = result["data_warnings"][0]
    assert warning["reason"] == "api_error", "유량 한도가 아니다"
    assert "index_row_absent" in warning["msg"]
    assert "mrkt_tp=10" in warning["msg"], "무엇을 보냈는지가 메시지에 남아야 진단이 된다"


@pytest.mark.asyncio
async def test_partial_failure_keeps_the_days_that_succeeded(tmp_path, kiwoom) -> None:
    """ADR-0137 R5 — 이전 판은 예외 하나로 구간 전체를 0포인트로 버렸다."""
    kiwoom(_FakeKis())
    scheduler = _RecordingScheduler(fail_dates=frozenset({"20260802"}))

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260801",
        to_label="20260803",
    )

    assert [p["t_ms"] for p in result["points"]] == [20260801, 20260803]
    warning = result["data_warnings"][0]
    assert warning["reason"] == "rate_limit_upstream"
    assert "1/3일 실패" in warning["msg"], "몇 날이 빠졌는지 숨기지 않는다"


@pytest.mark.asyncio
async def test_live_index_investor_net_surfaces_rate_limit_warning(tmp_path, kiwoom) -> None:
    kiwoom(_FakeKis())
    scheduler = _RecordingScheduler(raise_rate_limit=True)

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260619",
        to_label="20260619",
    )

    assert result["points"] == []
    warning = result["data_warnings"][0]
    assert warning["batch"] == "20260619__20260619"
    assert warning["reason"] == "rate_limit_upstream"
    # ADR-0137 R2 — 사유는 접어도 원문은 남긴다.
    assert "simulated 1700 유량 초과" in warning["msg"]


@pytest.mark.asyncio
async def test_non_rate_limit_failure_is_not_reported_as_rate_limit(tmp_path, kiwoom) -> None:
    """이전 판은 모든 실패를 `rate_limit_upstream` 으로 보고했다 — 네트워크 단절이
    "호출 한도" 로 보였다는 뜻이다(ADR-0137 M1)."""
    import httpx

    kiwoom(_FakeKis())
    scheduler = _RecordingScheduler(
        raise_rate_limit=True, failure=KiwoomTransportError(httpx.ConnectError("down")),
    )

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260619",
        to_label="20260619",
    )

    warning = result["data_warnings"][0]
    # 프론트 유니온이 닫혀 있어 transport_error 를 그대로 실으면 UI 가 조용히 버린다.
    assert warning["reason"] == "api_error"
    assert "down" in warning["msg"], "실체는 msg 에 남는다"


@pytest.mark.asyncio
async def test_missing_credentials_does_not_claim_rate_limit(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda _d, **_k: None)
    scheduler = _RecordingScheduler()

    result = await _fetcher(tmp_path, scheduler).fetch(
        index=get_representative_index("KOSPI"),
        from_label="20260619",
        to_label="20260619",
    )

    assert scheduler.calls == [], "자격증명이 없으면 거버너를 두드리지 않는다"
    assert result["points"] == []
    assert result["data_warnings"][0]["reason"] == "api_error"
