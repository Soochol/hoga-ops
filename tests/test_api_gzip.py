"""HTTP 응답 압축 **부재** 검증 (ADR-0154).

이 파일은 원래 GZipMiddleware 배선을 검증했다. 2026-08-21 에 미들웨어를 제거하면서
같은 자리에서 **반대 방향**을 못박는다 — 압축이 조용히 되살아나지 않는지.

## 왜 가드가 필요한가

압축을 다시 켜는 변경은 **화면·응답 본문 어디도 바꾸지 않는다.** 브라우저가
`Content-Encoding` 을 투명하게 풀기 때문에 프론트는 완전히 동일하게 동작하고,
달라지는 것은 **이벤트 루프 점유**뿐이다. 이 앱은 `--workers` 를 못 써서(#998)
단일 루프가 REST·WS·스케줄러를 전부 처리하므로, 그 점유가 곧 전역 정지다
(2026-08-21 실측: sidecar 3개월 응답 하나가 813ms). 즉 **되돌림이 무증상**이라
사람 눈으로는 못 잡는다.

## 못 보는 것

- 압축이 **다른 층**에서 붙는 경우(리버스 프록시·CDN). 이 앱은 프록시 없이 uvicorn
  이 직접 서빙하는 것이 전제다(README "Access model") — 그 전제가 깨지면 여기서
  잡히지 않는다.
- 실제 CPU 시간. 벽시계 단언은 이 리포에서 flaky 로 기각됐다
  (`reference_wallclock_ratio_assertions_replace_with_call_counts`).
"""
from __future__ import annotations

from fastapi.testclient import TestClient

_RANGE = "/api/range?code=003490&from=20260519&to=20260519&bucket_ms=60000&mode=sidecar&venue=KRX"


def test_large_response_is_not_compressed(app_client: TestClient) -> None:
    """`Accept-Encoding: gzip` 을 보내도 압축되지 않는다.

    막는 방향: 미들웨어를 다시 얹는 회귀. 압축 대상이 되기에 충분히 큰 응답
    (예전 배선의 minimum_size=1024 를 넘겨 실제로 gzip 이 붙던 응답)으로 확인한다.
    """
    r = app_client.get(_RANGE, headers={"accept-encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") is None
    # 압축이 없어도 본문 계약은 그대로다.
    assert isinstance(r.json()["segments"], list)


def test_no_compression_middleware_is_wired(app_client: TestClient) -> None:
    """압축 미들웨어가 **배선에 없는지** 직접 읽는다.

    위 동작 테스트만으로는 부족하다: `minimum_size` 를 크게 잡아 다시 얹으면 그
    표본 응답은 여전히 무압축이라 초록으로 통과한다. 결정 자체를 못박으려면 배선을
    본다. 클래스 이름으로 보는 이유는 brotli 등 다른 압축 미들웨어도 같은 이유로
    금지되기 때문이다.
    """
    names = [m.cls.__name__ for m in app_client.app.user_middleware]
    offenders = [n for n in names if "GZip" in n or "Compress" in n or "Brotli" in n]
    assert not offenders, (
        f"응답 압축 미들웨어가 배선에 있다: {offenders} — 되돌리기 전에 ADR-0154 를 읽을 것"
    )
