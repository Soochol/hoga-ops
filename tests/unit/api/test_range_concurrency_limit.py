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
#
# ⚠ **모드가 `hoga` 인 것이 이 상수의 계약이다 — 이 자리는 두 번 옮겨졌다.**
# 원래 `mode=sidecar` 였는데 v3.4 가 sidecar 를 가르며 `candles` 로, v3.5 가 candles 를
# 가르며 `hoga` 로 옮겼다. 그대로 뒀다면 이 파일의 단언은 **이름은 그대로인 채 다른
# 레인을 재게** 됐을 것이다. 모드를 가를 때마다 여기부터 볼 것 — 공유 레인에 남은
# 모드가 무엇인지가 이 상수의 정의다(지금은 hoga 하나뿐이다).
URL = (
    "/api/range?code={code}&from=20260101&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=hoga"
)
# 좁은 구간 = 상한 밖. `/live` 가 오늘·스크롤백 청크를 요청하는 모양이다.
NARROW_URL = (
    "/api/range?code={code}&from=20260512&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=hoga"
)
# 넓은 sidecar = **자기 레인**. 위 `URL` 과 같은 구간이라 섞으면 레인들이 동시에 도는
# 모양이 된다.
SIDECAR_URL = (
    "/api/range?code={code}&from=20260101&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=sidecar"
)
# 넓은 candles = **또 다른 레인**(v3.5).
CANDLES_URL = (
    "/api/range?code={code}&from=20260101&to=20260512&bucket_ms=60000"
    "&venue=KRX&mode=candles"
)
# 좁은 sidecar — 모드 분리가 **일수 분리를 대체하지 않는다**는 것을 재는 URL.
NARROW_SIDECAR_URL = (
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
    """`url_template` 로 동시 요청을 넣고, compute 안에 동시에 들어온 최대 수를 센다."""
    return await _max_concurrent_for_urls(
        app, monkeypatch, [url_template.format(code=c) for c in codes],
    )


async def _max_concurrent_for_urls(app, monkeypatch, urls):
    """임의의 URL 묶음을 동시에 넣고 compute 안의 최대 동시 수를 센다.

    벽시계로 **비율**을 재지 않는다(리포 규칙) — 재는 것은 `max_inside` 라는
    카운트고, sleep 은 "요청들이 도착할 틈" 을 주는 동기화 수단일 뿐이다.

    URL 을 직접 받는 형태가 따로 있는 이유는 **레인이 둘**이기 때문이다(ADR-0085 v3.4).
    한 템플릿만 받으면 한 레인 안의 상한밖에 못 재고, 두 레인이 **서로 독립으로 도는지**
    는 못 잰다 — 그건 두 모드를 한 배치에 섞어야 보인다.
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
            asyncio.gather(*(ac.get(url) for url in urls)),
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


async def test_wide_sidecar_uses_its_own_lane(app, monkeypatch):
    """넓은 sidecar 는 **자기 레인**의 상한을 탄다(ADR-0085 v3.4).

    모드로 가르는 근거는 팽창률이다 — candles **6.7×** · hoga 6~8× 인데 sidecar 는
    **3.8×** 로 부선형이다(peak 이 polars 라 그 구간에서 GIL 을 놓는다). 그런 요청을
    candles 와 같은 줄에 세우면 이득을 버리면서 서로를 막는다.

    상한이 **없어지는 것이 아니다**: 부선형인 것은 sidecar 끼리일 때고, peak 밖(depth
    히트맵 · 응답 생성)은 여전히 파이썬이라 무제한으로 열면 v3 의 계기였던
    "자연 상한 = 22" 가 이 클래스에서 재현된다.
    """
    assert routes.RANGE_SIDECAR_CONCURRENCY > 0, (
        f"sidecar 전용 레인이 꺼져 있다 — HOGA_RANGE_SIDECAR_CONCURRENCY="
        f"{routes.RANGE_SIDECAR_CONCURRENCY} (-1=공유 · 0=무제한). 둘 다 랜딩 값이 아니다."
    )
    codes = ["005930", "000660", "035420", "064350", "010120", "042660"]
    max_inside = await _max_concurrent_computes(app, monkeypatch, SIDECAR_URL, codes)
    # **정확히 레인 상한만큼** 돈다 — `<=` 로 두면 레인이 죽어 공유 상한에 갇혀도
    # 통과한다(레인 값이 공유 상한 이상인 한). 레인이 실제로 **별개**라는 것은
    # 아래 두-레인 테스트가 잰다.
    assert max_inside == min(routes.RANGE_SIDECAR_CONCURRENCY, len(codes)), (
        f"sidecar 레인이 상한만큼 돌지 않았다 — 동시 {max_inside}건 "
        f"(레인 {routes.RANGE_SIDECAR_CONCURRENCY} · 요청 {len(codes)})"
    )


async def test_wide_candles_uses_its_own_lane(app, monkeypatch):
    """넓은 candles 도 자기 레인을 탄다(ADR-0085 v3.5).

    ⚠ **가르는 근거가 sidecar 와 반대다.** sidecar 는 부선형이라 동시성 이득을 살리려
    갈랐고, candles 는 **가장 초선형**이라(6.7×) 이득이 아니라 **간섭 제거**가 목적이다 —
    hoga 와 한 줄에 있으면 서로를 막고 그 대기가 곧 저장뷰 화면의 지연이었다.
    그래서 레인 폭도 반대로 **좁을수록** 좋다.
    """
    assert routes.RANGE_CANDLES_CONCURRENCY > 0, (
        f"candles 전용 레인이 꺼져 있다 — HOGA_RANGE_CANDLES_CONCURRENCY="
        f"{routes.RANGE_CANDLES_CONCURRENCY} (-1=공유 · 0=무제한). 둘 다 랜딩 값이 아니다."
    )
    codes = ["005930", "000660", "035420", "064350", "010120", "042660"]
    max_inside = await _max_concurrent_computes(app, monkeypatch, CANDLES_URL, codes)
    assert max_inside == min(routes.RANGE_CANDLES_CONCURRENCY, len(codes)), (
        f"candles 레인이 상한만큼 돌지 않았다 — 동시 {max_inside}건 "
        f"(레인 {routes.RANGE_CANDLES_CONCURRENCY} · 요청 {len(codes)})"
    )


async def test_every_lane_runs_independently(app, monkeypatch):
    """세 레인은 **서로를 막지 않는다** — 이것이 "레인" 이라는 말의 내용 전부다.

    한 모드만 던지면 상한 값만 재게 되고, 레인 값이 공유 상한과 같은 날 분리가 죽어도
    아무도 모른다. 모드를 **한 배치에 섞어야** 합이 보인다.

    모드를 새로 가르면 이 테스트에 그 모드를 **추가**해야 한다 — 안 그러면 새 레인은
    자기 상한만 검증되고 "독립인가" 는 아무도 안 본다.
    """
    codes = ["005930", "000660", "035420", "064350"]
    urls = [
        template.format(code=c)
        for template in (URL, SIDECAR_URL, CANDLES_URL)
        for c in codes
    ]
    max_inside = await _max_concurrent_for_urls(app, monkeypatch, urls)

    expected = (
        min(routes.RANGE_COMPUTE_CONCURRENCY, len(codes))
        + min(routes.RANGE_SIDECAR_CONCURRENCY, len(codes))
        + min(routes.RANGE_CANDLES_CONCURRENCY, len(codes))
    )
    assert max_inside == expected, (
        f"레인 합이 안 맞는다 — 동시 {max_inside}건 (기대 {expected} = "
        f"공유 {routes.RANGE_COMPUTE_CONCURRENCY} + sidecar {routes.RANGE_SIDECAR_CONCURRENCY} "
        f"+ candles {routes.RANGE_CANDLES_CONCURRENCY}). "
        "합이 더 작으면 어느 둘이 한 줄에 서 있는 것이다."
    )


async def test_narrow_sidecar_still_bypasses_every_lane(app, monkeypatch):
    """모드 분리는 **일수 분리를 대체하지 않는다.**

    sidecar 레인이 생겼다고 `/live` 의 하루짜리 sidecar 까지 그 줄에 세우면, 이번엔
    `/study` 5개월 sidecar 뒤에 갇힌다 — 무게 분리가 원래 없애려던 그 head-of-line 이
    레인 안에서 재현될 뿐이다. 좁은 요청은 모드와 무관하게 그냥 지나간다.
    """
    codes = ["005930", "000660", "035420", "064350", "010120", "042660"]
    max_inside = await _max_concurrent_computes(app, monkeypatch, NARROW_SIDECAR_URL, codes)
    assert max_inside == len(codes), (
        f"좁은 sidecar 가 줄을 섰다 — 동시 {max_inside}건 / {len(codes)}건"
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
