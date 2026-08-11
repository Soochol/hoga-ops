"""큐에서 기다리는 동안 클라이언트가 떠난 `/api/range` 요청은 **계산을 시작하지 않는다**.

왜 필요한가(2026-08-11 실측): `/study` 저장뷰는 봉·지표를 바꿀 때마다 react-query 가
in-flight 를 abort 하는데, 서버는 그걸 모른 채 끝까지 계산했다. 같은 URL 이 최대 4벌
완주하면서 `RANGE_COMPUTE_CONCURRENCY` 레인을 141~185초씩 물었고, 뒤의 요청은 큐에서
180초를 기다렸다 — **아무도 안 읽을 결과를 만드느라.**

여기서 `httpx.ASGITransport` 를 쓰지 않고 ASGI 를 직접 부르는 이유: 이 동작의 전부가
**receive 큐에 어떤 메시지가 어떤 순서로 들어오는가**에 달려 있다. 트랜스포트를 끼면
그 순서를 우리가 못 정하고, 정작 재현하려는 상황(빈 `http.request` 뒤에 대기 중인
`http.disconnect`)을 만들 수 없다.
"""
from __future__ import annotations

import asyncio

import pytest

from hoga.api.app import create_app
from hoga.api.models import (
    FillStrength,
    QuoteRatio,
    RangeBundle,
    RangeSegment,
    VolumeProfile,
)

# 넓은 구간 = 상한을 탄다. 이탈 감지가 의미를 갖는 것이 이 쪽이다.
QUERY = (
    "code=005930&from=20260101&to=20260512&bucket_ms=60000&venue=KRX&mode=sidecar"
)

# uvicorn 은 body 가 없는 GET 에도 이 메시지를 **한 번** 보낸다. 이 한 줄이 이 파일의
# 존재 이유다 — 이것을 먼저 비우지 않으면 `is_disconnected()` 가 이걸 소비하고 False 를
# 돌려준다(starlette 은 호출당 메시지 하나만 읽는다).
EMPTY_BODY = {"type": "http.request", "body": b"", "more_body": False}
DISCONNECT = {"type": "http.disconnect"}


def _bundle(**kw) -> RangeBundle:
    bucket_ms = kw["bucket_ms"]
    return RangeBundle(
        code=kw["code"],
        from_date=kw["from_date"],
        to_date=kw["to_date"],
        bucket_ms=bucket_ms,
        segments=[RangeSegment(date=kw["from_date"], session_open_ms=1, session_close_ms=2)],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
        ),
        volume_profile_by_day=[],
    )


@pytest.fixture
def app(tmp_path):
    return create_app(data_dir=tmp_path / "data")


async def _call(app, messages: list[dict]) -> int:
    """receive 큐를 이 테스트가 통제하는 ASGI 호출. 응답 status 를 돌려준다.

    큐가 비면 **영원히 기다린다** — 실제 서버와 같다(uvicorn 도 disconnect 가 올
    때까지 receive 를 붙잡는다). `is_disconnected()` 는 이걸 즉시 취소하므로,
    이 대기가 테스트를 멈추게 하면 그건 코드가 receive 를 잘못 쓰고 있다는 뜻이다.
    """
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/range",
        "raw_path": b"/api/range",
        "query_string": QUERY.encode(),
        "root_path": "",
        "headers": [(b"host", b"test")],
        "client": ("test", 1),
        "server": ("test", 80),
    }
    queue = list(messages)
    sent: list[dict] = []

    async def receive():
        if queue:
            return queue.pop(0)
        await asyncio.Event().wait()  # 더 없음 — 실제 서버와 같은 무한 대기

    async def send(message):
        sent.append(message)

    await asyncio.wait_for(app(scope, receive, send), timeout=5)
    start = next(m for m in sent if m["type"] == "http.response.start")
    return start["status"]


async def test_disconnected_request_never_reaches_compute(app, monkeypatch):
    """이탈한 요청은 `build_range_bundle` 에 **도달하지 않는다**.

    이 단언이 이 파일의 본론이다 — 상태 코드는 받을 사람이 없어 아무래도 좋지만,
    계산을 돌렸는지 아닌지는 다른 요청의 대기 시간을 좌우한다.
    """
    calls: list[str] = []

    def stub(engine, **kw):
        calls.append(kw["code"])
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    status = await _call(app, [EMPTY_BODY, DISCONNECT])

    assert calls == [], "이탈한 요청이 계산까지 갔다 — permit 을 그만큼 물고 있었다는 뜻"
    assert status == 499


async def test_disconnect_before_body_is_also_caught(app, monkeypatch):
    """`http.request` 조차 오기 전에 끊긴 경우 — `body()` 가 `ClientDisconnect` 를 던진다.

    이 갈래가 없으면 그 예외가 500 으로 새어 나가 로그가 결함 보고로 오염된다.
    """
    calls: list[str] = []

    def stub(engine, **kw):
        calls.append(kw["code"])
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    status = await _call(app, [DISCONNECT])

    assert calls == []
    assert status == 499


async def test_live_request_is_unaffected(app, monkeypatch):
    """연결이 살아 있으면 예전 그대로 계산한다.

    이탈 감지가 **정상 요청을 오판하지 않는다**는 반대 방향 단언이다. 이게 없으면
    "전부 499" 라는 최악의 회귀가 위 두 테스트를 통과한 채로 지나간다.
    """
    calls: list[str] = []

    def stub(engine, **kw):
        calls.append(kw["code"])
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    status = await _call(app, [EMPTY_BODY])

    assert calls == ["005930"]
    assert status == 200
