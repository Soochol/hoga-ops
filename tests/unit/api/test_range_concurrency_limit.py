"""`/api/range` 의 동시 compute 상한 (`RANGE_COMPUTE_CONCURRENCY`).

왜 상한이 있는가: 이 경로는 시간의 대부분이 행→pydantic 모델 생성이라 GIL 을
놓지 않는다. 32코어에서 스레드 6개로 돌려도 wall 이 5.9배로 늘어난다 — 동시에
던진 요청은 서로를 그 수만큼 늦출 뿐이다. 상한을 걸면 총 처리량은 그대로면서
앞선 요청이 먼저 빠져나간다(실측표는 `routes.RANGE_COMPUTE_CONCURRENCY` 주석).

여기서 **동시 요청을 스레드가 아니라 한 이벤트 루프 안에서** 만드는 이유:
운영은 uvicorn 단일 루프다. `TestClient` 를 스레드로 병렬 호출하면 요청마다 다른
루프에서 돌 수 있어, 실제로는 일어나지 않는 모양을 검사하게 된다.
"""
from __future__ import annotations

import asyncio
import threading

import httpx
import pytest

from hoga.api import routes
from hoga.api.app import create_app
from hoga.api.models import (
    FillStrength,
    QuoteRatio,
    RangeBundle,
    RangeSegment,
    VolumeProfile,
)

# 넓은 구간 = 상한을 탄다(`RANGE_WIDE_SPAN_DAYS` 이상).
URL = (
    "/api/range?code={code}&from=20260101&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=sidecar"
)
# 좁은 구간 = 상한 밖. `/live` 가 오늘·스크롤백 청크를 요청하는 모양이다.
NARROW_URL = (
    "/api/range?code={code}&from=20260512&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=sidecar"
)


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


async def _max_concurrent_computes(app, monkeypatch, url_template, codes):
    """`url_template` 로 동시 요청을 넣고, compute 안에 동시에 들어온 최대 수를 센다.

    벽시계로 **비율**을 재지 않는다(리포 규칙) — 재는 것은 `max_inside` 라는
    카운트고, sleep 은 "요청들이 도착할 틈" 을 주는 동기화 수단일 뿐이다.
    """
    inside = 0
    max_inside = 0
    lock = threading.Lock()
    proceed = threading.Event()

    def stub(engine, **kw):
        nonlocal inside, max_inside
        with lock:
            inside += 1
            max_inside = max(max_inside, inside)
        proceed.wait(timeout=5)
        with lock:
            inside -= 1
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    async def release():
        await asyncio.sleep(0.05)  # 상한이 없다면 이 사이에 전부 진입한다
        proceed.set()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        responses, _ = await asyncio.gather(
            asyncio.gather(*(ac.get(url_template.format(code=c)) for c in codes)),
            release(),
        )
    assert all(r.status_code == 200 for r in responses), [r.status_code for r in responses]
    return max_inside


async def test_wide_range_computes_respect_the_limit(app, monkeypatch):
    """넓은 구간은 동시 compute 가 상한을 넘지 않는다."""
    max_inside = await _max_concurrent_computes(
        app, monkeypatch, URL, ["005930", "000660", "035420", "064350"],
    )
    assert max_inside <= routes.RANGE_COMPUTE_CONCURRENCY, (
        f"compute 가 상한을 넘었다 — 동시 {max_inside}건 "
        f"(상한 {routes.RANGE_COMPUTE_CONCURRENCY})"
    )


async def test_narrow_range_bypasses_the_limit(app, monkeypatch):
    """좁은 구간은 **줄을 서지 않는다** — 이 분리가 이 설계의 전부다.

    전부 한 큐에 넣었을 때 실측(무거운 것 6 + 가벼운 것 16 = 22 동시):
    가벼운 요청 중앙값이 0.32s → 2.26s 로 **7배** 나빠졌다. 하루짜리가 5개월짜리
    뒤에 갇히는 head-of-line blocking 이고, 총 wall 은 어느 쪽이든 같았다 —
    즉 단일 큐의 상한은 이득이 아니라 손해 쪽으로의 재분배였다.
    """
    codes = ["005930", "000660", "035420", "064350"]
    max_inside = await _max_concurrent_computes(app, monkeypatch, NARROW_URL, codes)
    assert max_inside == len(codes), (
        f"좁은 요청이 직렬화됐다 — 동시 {max_inside}건 / {len(codes)}건. "
        "무게 분리가 죽으면 /live 의 하루짜리가 /study 의 5개월 뒤에 갇힌다."
    )


async def test_range_limit_permit_survives_a_failing_request(app, monkeypatch):
    """compute 가 예외로 끝나도 permit 이 반환된다.

    `async with` 가 아니라 손으로 acquire/release 하면 정확히 여기서 새고, 증상은
    "한 번 500 난 뒤로 이 엔드포인트가 영영 멎는다" 라 원인을 찾기 어렵다.
    """
    calls: list[str] = []

    def stub(engine, **kw):
        calls.append(kw["code"])
        if kw["code"] == "005930":
            raise RuntimeError("compute exploded")
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        failed = await ac.get(URL.format(code="005930"))
        assert failed.status_code == 500
        # permit 이 샜다면 이 요청은 영원히 대기한다 → 타임아웃으로 죽는다.
        ok = await asyncio.wait_for(ac.get(URL.format(code="000660")), timeout=5)

    assert ok.status_code == 200, ok.text
    assert calls == ["005930", "000660"], "두 번째 요청이 compute 에 도달하지 못했다"


async def test_range_waiters_do_not_occupy_worker_threads(app, monkeypatch):
    """상한을 기다리는 요청은 **스레드를 쥐지 않는다**.

    이 라우트가 동기 `def` 였다면 FastAPI 가 요청마다 스레드풀 스레드를 먼저 잡고
    그 위에서 상한을 기다려, 대기자들이 공용 풀을 채우고 다른 동기 라우트까지
    굶긴다. `async def` + `to_thread.run_sync` 라야 대기가 루프에서 일어난다.

    풀 토큰을 **상한 + 1** 로 낮춰서 그 차이가 드러나게 한다. 기본 40 토큰에서는
    대기자가 스레드를 쥐어도 여유가 남아 아무것도 증명하지 못하고, 상한과 같게
    두면 정상 동작에서도 여유가 0이라 위양성이 난다. +1 이면 계산 중인 것들이
    상한만큼 쓰고 정확히 1칸이 남는다 — 대기자가 스레드를 쥐면 그 1칸이 사라진다.
    """
    import anyio.to_thread

    limiter = anyio.to_thread.current_default_thread_limiter()
    original = limiter.total_tokens
    limiter.total_tokens = routes.RANGE_COMPUTE_CONCURRENCY + 1
    proceed = threading.Event()

    def stub(engine, **kw):
        proceed.wait(timeout=5)
        return _bundle(**kw)

    monkeypatch.setattr("hoga.api.routes.build_range_bundle", stub)

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            range_calls = [
                asyncio.create_task(ac.get(URL.format(code=c)))
                for c in ("005930", "000660", "035420", "064350", "010120", "042660")
            ]
            await asyncio.sleep(0.05)  # range 요청들이 상한 앞에 줄서게 둔다

            # 동기 `def` 라우트다(`routes.stock_dates`). 대기자가 스레드를 쥐고
            # 있었다면 2 토큰이 모두 막혀 이 호출이 타임아웃 난다.
            other = await asyncio.wait_for(ac.get("/api/stock-dates"), timeout=5)
            assert other.status_code == 200, other.text

            proceed.set()
            for r in await asyncio.gather(*range_calls):
                assert r.status_code == 200
    finally:
        proceed.set()
        limiter.total_tokens = original
