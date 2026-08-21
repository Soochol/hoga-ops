"""GZip 미들웨어 배선 검증.

번들 응답(/api/range)은 반복 구조 숫자 JSON이라 압축비가 크다(호가 잔량 히트맵
실측 246KB→27KB). 라이브 스트림은 WebSocket(/api/ws)이라 HTTP scope만 처리하는
GZipMiddleware를 통과하므로 SSE 버퍼링 우려 없이 켤 수 있다 — 여기선 HTTP 경로가
① Accept-Encoding: gzip 시 압축되고 ② 작은 응답/identity 요청은 무압축인지 확인한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

_RANGE = "/api/range?code=003490&from=20260519&to=20260519&bucket_ms=60000&mode=sidecar&venue=KRX"


def test_large_range_response_is_gzipped(app_client: TestClient) -> None:
    r = app_client.get(_RANGE, headers={"accept-encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"
    # TestClient(httpx)는 content-encoding 헤더를 남긴 채 본문을 자동 디코딩한다 —
    # 디코딩 결과가 온전한 JSON이면 압축 왕복이 손상 없이 동작한 것.
    assert isinstance(r.json()["segments"], list)


def test_identity_request_not_compressed(app_client: TestClient) -> None:
    r = app_client.get(_RANGE, headers={"accept-encoding": "identity"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") != "gzip"


def test_small_response_below_threshold_not_compressed(app_client: TestClient) -> None:
    # /health 는 minimum_size(1024B) 미만이라 압축 대상이 아니다.
    r = app_client.get("/health", headers={"accept-encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") is None


def test_compresslevel_is_pinned_below_the_slow_default(app_client: TestClient) -> None:
    """`compresslevel` 이 **명시돼 있고 기본값 9 보다 낮은지** 못박는다.

    막는 방향: 인자를 지워 Starlette 기본값 **9(최대·최저속)** 로 되돌아가는 회귀.
    이 회귀는 **응답이 보이는 곳 어디도 바뀌지 않는다** — 여전히 gzip 이 붙고 본문도
    같다. 달라지는 것은 이벤트 루프 점유뿐이라(178KB 실측 2.2ms → 13.0ms, 5.9배)
    위의 세 테스트는 전부 초록으로 통과한다. 그래서 배선을 직접 읽는다.

    못 보는 것: 실제 압축 소요 시간(벽시계 단언은 이 리포에서 flaky 로 기각됐다 —
    `reference_wallclock_ratio_assertions_replace_with_call_counts`). 여기서 재는
    것은 **설정값**이지 성능이 아니다.
    """
    from fastapi.middleware.gzip import GZipMiddleware

    entries = [m for m in app_client.app.user_middleware if m.cls is GZipMiddleware]
    assert len(entries) == 1, f"GZipMiddleware 배선이 1개가 아니다: {len(entries)}"
    level = entries[0].kwargs.get("compresslevel")
    assert level is not None, "compresslevel 미지정 — Starlette 기본값 9 로 돌아간다"
    assert level <= 6, f"compresslevel={level} — 9 에 가까울수록 루프 점유가 급증한다"

