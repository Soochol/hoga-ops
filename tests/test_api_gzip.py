"""GZip 미들웨어 배선 검증.

번들 응답(/api/range)은 반복 구조 숫자 JSON이라 압축비가 크다(호가 잔량 히트맵
실측 246KB→27KB). 라이브 스트림은 WebSocket(/api/ws)이라 HTTP scope만 처리하는
GZipMiddleware를 통과하므로 SSE 버퍼링 우려 없이 켤 수 있다 — 여기선 HTTP 경로가
① Accept-Encoding: gzip 시 압축되고 ② 작은 응답/identity 요청은 무압축인지 확인한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


_RANGE = "/api/range?code=003490&from=20260519&to=20260519&bucket_ms=60000&mode=sidecar"


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
