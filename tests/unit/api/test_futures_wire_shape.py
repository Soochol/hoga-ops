"""선물 wire shape — `response_model` 이 **조용히 버리는** 키가 없는지 잰다.

FastAPI 는 모델에 선언되지 않은 키를 에러 없이 스트립한다. 그래서 중첩 객체를 새로
입힐 때의 실패 모드는 500 이 아니라 "프론트가 읽던 값이 어느 날부터 없다" 이고,
증상은 한참 뒤에 온다 — 이 리포가 반복해서 다룬 유형이다(CLAUDE.md).

여기서 특히 위험한 것이 **`day` 서브객체**다. 카드의 주간↔야간 선택지가 통째로 그
안에 들어 있어서, 한 필드라도 스트립되면 선택이 반쯤 빈 카드를 그린다.

라우트 함수를 직접 부르는 기존 테스트로는 이걸 못 잰다 — 그쪽은 `response_model`
단계를 건너뛴다. 그래서 여기서는 **생산 함수의 출력을 모델에 통과시켜** 왕복 비교한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api.market_routes import (
    FuturesCandlesResponse,
    FuturesQuotesResponse,
    _FuturesRuntimeHolder,
)
from hoga.live.futures_runtime import (
    FuturesCard,
    FuturesLineupItem,
    FuturesSnapshot,
    SparkSeries,
)
from hoga.live.kis_futures_endpoints import FuturesQuote

ITEM = FuturesLineupItem(id="KOSPI200_F", product="kospi200", label="KOSPI 200 F",
                         underlying_id="KOSPI200")


def _quote(value: float, t_ms: int) -> FuturesQuote:
    return FuturesQuote(
        code="A01609", product="kospi200", label="KOSPI 200 F", expiry="202609",
        value=value, change=23.8, change_rate=2.43, prev_close=981.15, volume=18248,
        open_interest=156977, oi_change=-2311, market_basis=4.02, disparity=0.2,
        days_left=35, last_trade_date="20260910", t_ms=t_ms,
    )


class _FakeRuntime:
    def __init__(self, snapshot=None, series=None) -> None:
        self._snapshot = snapshot
        self._series = series or {}

    async def snapshot(self):
        return self._snapshot

    async def sparks(self):
        return self._series


def _holder(runtime) -> _FuturesRuntimeHolder:
    holder = _FuturesRuntimeHolder(Path("/tmp"))
    holder._runtime = runtime  # 싱글턴 배선을 우회한다 — 여기서 재는 것은 직렬화다
    return holder


def _keys(obj) -> set[str]:
    return set(obj) if isinstance(obj, dict) else set()


@pytest.mark.asyncio
async def test_night_quote_keeps_every_day_field_through_the_model():
    """`day` 의 열 필드가 전부 살아 돌아와야 한다 — 하나라도 빠지면 '주간' 선택이
    그 항목만 조용히 비운다."""
    night = FuturesCard(ITEM, _quote(1004.95, 999), "night", day_quote=_quote(978.75, 111))
    got = await _holder(_FakeRuntime(FuturesSnapshot((night,), "night", None))).collect()
    assert got is not None

    dumped = FuturesQuotesResponse.model_validate({**got, "session": "night"}).model_dump()

    produced = _keys(got["quotes"][0]["day"])
    survived = _keys(dumped["quotes"][0]["day"])
    assert produced == survived, f"스트립된 키: {produced - survived}"
    assert dumped["quotes"][0]["day"]["value"] == 978.75  # 야간 값이 아니라 주간 값이다
    assert dumped["quotes"][0]["value"] == 1004.95


@pytest.mark.asyncio
async def test_day_quote_has_no_duplicate_day_block():
    """주간 카드는 최상위가 이미 주간 값이다 — `day` 를 채우면 같은 숫자가 두 벌이 되고,
    화면이 둘 중 무엇을 믿을지 판단할 근거가 사라진다."""
    day = FuturesCard(ITEM, _quote(978.75, 111), "day")
    got = await _holder(_FakeRuntime(FuturesSnapshot((day,), "day", None))).collect()
    assert got is not None

    assert got["quotes"][0]["day"] is None


@pytest.mark.asyncio
async def test_night_series_carries_the_day_shape_through_the_model():
    """값의 `day` 와 그림의 `day` 는 짝이다. 한쪽만 살면 '주간' 선택이 숫자만 바꾸고
    그림은 비운다."""
    series = {
        "KOSPI200_F": SparkSeries(
            (1000.0, 1004.95), None, "night", None, day_series=((975.0, 978.75), 974.0)
        )
    }
    got = await _holder(_FakeRuntime(series=series)).collect_sparks()
    assert got is not None

    dumped = FuturesCandlesResponse.model_validate(got).model_dump()

    produced = _keys(got["series"]["KOSPI200_F"]["day"])
    survived = _keys(dumped["series"]["KOSPI200_F"]["day"])
    assert produced == survived, f"스트립된 키: {produced - survived}"
    assert dumped["series"]["KOSPI200_F"]["day"]["closes"] == [975.0, 978.75]
    assert dumped["series"]["KOSPI200_F"]["day"]["day_open"] == 974.0


@pytest.mark.asyncio
async def test_day_series_absent_when_the_shape_is_already_daytime():
    series = {"KOSPI200_F": SparkSeries((975.0, 978.75), 974.0, "day")}
    got = await _holder(_FakeRuntime(series=series)).collect_sparks()
    assert got is not None

    assert got["series"]["KOSPI200_F"]["day"] is None


@pytest.mark.asyncio
async def test_recalled_night_keeps_every_field_including_the_date():
    """`night` 의 열한 필드가 전부 살아야 한다. **`session_day` 가 특히 위험하다** —
    스트립돼도 값은 멀쩡히 뜨고 날짜만 사라져서, 지난 밤이 오늘 야간으로 읽힌다."""
    card = FuturesCard(
        ITEM, _quote(978.75, 111), "day",
        night_quote=_quote(1004.95, 999), night_session_day="20260807",
    )
    got = await _holder(_FakeRuntime(FuturesSnapshot((card,), "day", None))).collect()
    assert got is not None

    dumped = FuturesQuotesResponse.model_validate({**got, "session": "day"}).model_dump()

    produced = _keys(got["quotes"][0]["night"])
    survived = _keys(dumped["quotes"][0]["night"])
    assert produced == survived, f"스트립된 키: {produced - survived}"
    assert dumped["quotes"][0]["night"]["session_day"] == "20260807"
    assert dumped["quotes"][0]["night"]["value"] == 1004.95
    assert dumped["quotes"][0]["value"] == 978.75  # 최상위는 여전히 주간이다


@pytest.mark.asyncio
async def test_recalled_night_series_survives_the_model():
    series = {
        "KOSPI200_F": SparkSeries(
            (975.0, 978.75), 974.0, "day", night_series=((998.1, 1004.95), "20260807")
        )
    }
    got = await _holder(_FakeRuntime(series=series)).collect_sparks()
    assert got is not None

    dumped = FuturesCandlesResponse.model_validate(got).model_dump()

    produced = _keys(got["series"]["KOSPI200_F"]["night"])
    survived = _keys(dumped["series"]["KOSPI200_F"]["night"])
    assert produced == survived, f"스트립된 키: {produced - survived}"
    assert dumped["series"]["KOSPI200_F"]["night"]["closes"] == [998.1, 1004.95]
    assert dumped["series"]["KOSPI200_F"]["night"]["session_day"] == "20260807"


@pytest.mark.asyncio
async def test_day_and_night_are_never_both_present():
    """둘은 반대 방향이라 **동시에 차면 화면이 어느 쪽으로 토글할지 모른다.**
    야간 카드는 `day` 만, 주간 카드는 `night` 만 갖는다."""
    night = FuturesCard(ITEM, _quote(1004.95, 999), "night", day_quote=_quote(978.75, 111))
    day = FuturesCard(
        ITEM, _quote(978.75, 111), "day",
        night_quote=_quote(1004.95, 999), night_session_day="20260807",
    )
    for card in (night, day):
        got = await _holder(_FakeRuntime(FuturesSnapshot((card,), "day", None))).collect()
        assert got is not None
        row = got["quotes"][0]
        assert (row["day"] is None) != (row["night"] is None), row


@pytest.mark.asyncio
async def test_top_level_quote_fields_survive_the_model():
    """`day` 를 얹으면서 기존 필드를 건드리지 않았는지 — 회귀 방향이 반대인 가드다."""
    night = FuturesCard(ITEM, _quote(1004.95, 999), "night", day_quote=_quote(978.75, 111))
    got = await _holder(_FakeRuntime(FuturesSnapshot((night,), "night", None))).collect()
    assert got is not None

    dumped = FuturesQuotesResponse.model_validate({**got, "session": "night"}).model_dump()

    produced = _keys(got["quotes"][0])
    survived = _keys(dumped["quotes"][0])
    assert produced == survived, f"스트립된 키: {produced - survived}"
