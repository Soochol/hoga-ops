"""JSON 라우트가 FastAPI 의 `dump_json` fast path 를 유지하는지 (성능 가드).

## 왜 가드가 필요한가

fastapi 0.136.1 `routing.get_request_handler`:

    use_dump_json = response_field is not None and isinstance(response_class, DefaultPlaceholder)

참이면 pydantic-core(Rust)가 **바이트로 직행**하고, 파이썬 dict 물질화 +
`json.dumps` 를 통째로 건너뛴다. 지금 이 앱의 모든 JSON 라우트가 이 경로를 탄다.

**함정은 이 조건이 `response_class` 를 커스텀으로 바꾸는 순간 조용히 꺼진다는 것이다.**
`FastAPI(default_response_class=...)` · `APIRouter(default_response_class=...)` ·
`@router.get(..., response_class=...)` 셋 중 어느 층이든 하나면 된다. 에러도 경고도
없고, 응답 내용은 **바이트까지 동일**하다 — 느려질 뿐이다.

이게 가설이 아닌 이유: "속도를 위해 `ORJSONResponse` 를 달아라" 는 구 FastAPI 시절의
표준 조언이고, `ORJSONResponse` 자신의 docstring 이 이제 **deprecated** 라고 말한다.
그 조언을 따르면 **정확히 반대 결과**가 난다. 실측(2026-08-21, 000660, 5회 median):

    경로                                   하루 sidecar   3개월 sidecar
    A) fast path (현행)                        0.7ms         210.6ms
    B) dict + stdlib json.dumps                2.7ms         959.4ms
    C) dict + orjson (= ORJSONResponse)        1.8ms         733.1ms

즉 `ORJSONResponse` 는 A 대비 **2.7×~3.5× 느리다**. orjson 이 `json.dumps` 보다
빠른 것은 맞지만(C < B), 커스텀 클래스를 다는 순간 **A 가 건너뛰던 dict 물질화가
되살아나** 그 이득을 통째로 삼킨다. 세 경로의 출력은 바이트 동일이었다.

## 이 가드가 닫는 방향

- **닫는 방향**: 커스텀 `response_class` 도입 → fast path 강등
- **못 보는 것**: fast path 를 타면서 **느린** 경우(모델이 비대해지는 등)는 이 가드의
  대상이 아니다. 여기서 재는 것은 경로 선택이지 속도 자체가 아니다.
- **등록 의존**: 없음. 정당한 예외가 생기면 `FAST_PATH_EXEMPT` 에 **사유와 함께** 넣는다.
"""
from pathlib import Path

from fastapi.datastructures import DefaultPlaceholder
from fastapi.routing import APIRoute

from hoga.api.app import create_app

# 커스텀 response_class 를 쓸 **정당한 이유**가 있는 라우트. (method, path) → 사유.
#
# 비어 있는 것이 정상이다. 채우기 전에 물을 것: 그 라우트가 정말 JSON 모델을
# 반환하는가? 파일·스트림·204 라면 `response_field` 가 None 이라 애초에 여기 안 걸린다.
FAST_PATH_EXEMPT: dict[tuple[str, str], str] = {}


def _demoted_routes(app) -> list[tuple[str, str, str]]:
    """모델은 있는데 fast path 를 못 타는 라우트 — (method, path, response_class 이름)."""
    out: list[tuple[str, str, str]] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.response_field is None:
            continue
        if isinstance(route.response_class, DefaultPlaceholder):
            continue
        cls = route.response_class
        name = getattr(cls, "__name__", type(cls).__name__)
        for method in sorted(route.methods):
            if (method, route.path) in FAST_PATH_EXEMPT:
                continue
            out.append((method, route.path, name))
    return out


def test_json_routes_keep_the_pydantic_dump_json_fast_path(tmp_path: Path) -> None:
    """모델을 가진 라우트는 전부 `use_dump_json` 경로여야 한다.

    실패하면 커스텀 `response_class` 가 어딘가에 붙었다는 뜻이다 — 앱·라우터·라우트
    세 층 중 하나. 응답은 바이트까지 같으므로 **다른 어떤 테스트도 이걸 못 잡는다.**
    """
    app = create_app(data_dir=tmp_path / "data")

    # ⚠ **비공허성 먼저.** `response_field` 가 전부 None 이 되면(FastAPI 내부 변경 ·
    # 조립 실패) 아래 단언은 빈 목록을 통과시켜 **0개를 검사하고 초록**이 된다. 그런
    # 가드는 아무것도 증명하지 못하므로 모집단 자체를 먼저 세운다.
    inspected = sum(
        1 for r in app.routes if isinstance(r, APIRoute) and r.response_field is not None
    )
    assert inspected >= 80, (
        f"모델 있는 라우트를 {inspected}개밖에 못 봤다(2026-08-21 실측 88개). "
        "가드가 빈 집합을 검사하고 있을 수 있다 — `response_field` 접근 방식부터 확인할 것."
    )

    demoted = _demoted_routes(app)

    assert not demoted, (
        f"fast path 를 잃은 라우트 {len(demoted)}개: {sorted(demoted)[:10]}. "
        "커스텀 response_class 가 붙으면 pydantic 의 바이트 직행이 꺼지고 dict 물질화가 "
        "되살아난다 — 3개월 sidecar 실측 210.6ms → 733.1ms(ORJSONResponse). "
        "`ORJSONResponse` 를 성능 목적으로 달았다면 되돌릴 것(그 클래스는 deprecated 다). "
        "정당한 이유가 있으면 FAST_PATH_EXEMPT 에 사유와 함께 등록한다."
    )


def test_exempt_registry_has_no_fossils(tmp_path: Path) -> None:
    """면제 목록은 줄어들기만 한다 — 고쳐진 라우트의 항목은 지운다.

    화석을 남기면 같은 (method, path) 가 나중에 다시 강등돼도 조용히 통과한다.
    """
    demoted_keys = {(m, p) for m, p, _ in _demoted_routes(create_app(data_dir=tmp_path / "data"))}
    fossils = set(FAST_PATH_EXEMPT) - demoted_keys

    assert not fossils, (
        f"면제 목록에 화석이 남았다: {sorted(fossils)}. 해당 라우트가 fast path 로 "
        "돌아왔거나 사라졌다는 뜻이니 목록에서 지울 것."
    )
