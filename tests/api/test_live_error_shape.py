"""``/api/live`` 에러 형태 계약 — 구조화 detail(code + message) 단일 형태.

2026-07-30 이전 이 라우터는 같은 API 표면에 **세 가지** 에러 형태를 냈다:

1. ``{"code": <StrEnum>, "message": ...}``  — ``hoga/api/*`` 라우터들
2. ``{"code": "<raw str>", "msg": ...}``    — ``/api/live`` 422·502 (19곳)
3. 평문 문자열 ``detail``                    — ``/api/live`` 503 (28곳)

프론트 ``apiCall`` 은 ``detail.message`` 만 읽으므로 2·3번은 **사람이 읽을 메시지를
잃고** ``"<status> <path>"`` 로 폴백했다. 즉 통일은 미관 문제가 아니라 "에러 문구가
사용자에게 도달하지 않는다" 는 결함의 수정이다.

여기서는 값이 아니라 **형태**를 고정한다 — 코드 문자열은 이전과 동일해서 기존
소비자·테스트가 그대로 통과한다.
"""
from __future__ import annotations

import ast
from pathlib import Path

from hoga.api.error_codes import CaptureErrorCode, LiveErrorCode, UpstreamCode

_LIVE_API = Path("hoga/live/api.py")
_FRONTEND_TYPES = Path("frontend/src/api/types.ts")


def _http_exception_details() -> list[tuple[int, ast.expr]]:
    """``raise HTTPException(status, detail)`` 의 (줄번호, detail 노드) 목록."""
    tree = ast.parse(_LIVE_API.read_text(encoding="utf-8"))
    found: list[tuple[int, ast.expr]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name != "HTTPException":
            continue
        if len(node.args) >= 2:
            found.append((node.lineno, node.args[1]))
    return found


def test_live_api_raises_at_least_one_http_exception() -> None:
    """가드가 빈 목록을 훑으며 조용히 통과하는 것을 막는다."""
    assert len(_http_exception_details()) > 20


def test_every_live_error_detail_is_a_structured_dict() -> None:
    """평문 문자열 detail 금지 — 프론트가 message 를 읽을 수 없다."""
    offenders = [
        f"{_LIVE_API}:{lineno}"
        for lineno, detail in _http_exception_details()
        if not isinstance(detail, ast.Dict)
    ]
    assert offenders == [], (
        "detail 은 {'code': LiveErrorCode.X, 'message': ...} 형태여야 한다: "
        + ", ".join(offenders)
    )


def test_every_live_error_detail_uses_code_and_message_keys() -> None:
    """``code`` + ``message`` 는 필수, ``msg`` 는 금지 — apiCall 은 ``message`` 만 읽는다.

    추가 키는 허용한다(예: ``date_range_too_large`` 의 ``max_days``) — 구조화된 부가
    정보는 UI 가 더 나은 문구를 만들 수 있게 하고, 두 필수 키를 가리지 않는다. ``msg``
    는 ``message`` 가 없으므로 이 검사에 걸린다.

    (HTTP 200 ``data_warnings[].msg`` 는 다른 계약이고 여기 검사 대상이 아니다 —
    이 가드는 HTTPException detail 만 본다.)
    """
    offenders: list[str] = []
    for lineno, detail in _http_exception_details():
        if not isinstance(detail, ast.Dict):
            continue  # 위 테스트가 보고한다
        keys = {
            str(k.value) for k in detail.keys if isinstance(k, ast.Constant)
        }
        if not {"code", "message"} <= keys:
            offenders.append(f"{_LIVE_API}:{lineno} keys={sorted(keys)}")
    assert offenders == [], (
        "detail 은 code·message 를 반드시 포함해야 한다: " + ", ".join(offenders)
    )


def test_every_live_error_code_comes_from_the_enum() -> None:
    """raw 문자열 code 금지 — 타이포를 잡아 줄 것이 없다(StrEnum 은 잡는다)."""
    offenders: list[str] = []
    for lineno, detail in _http_exception_details():
        if not isinstance(detail, ast.Dict):
            continue
        for key, value in zip(detail.keys, detail.values, strict=True):
            if not (isinstance(key, ast.Constant) and key.value == "code"):
                continue
            # 허용: LiveErrorCode.X / UpstreamCode.X / CaptureErrorCode.X
            is_enum = (
                isinstance(value, ast.Attribute)
                and isinstance(value.value, ast.Name)
                and value.value.id in {
                    "LiveErrorCode", "UpstreamCode", "CaptureErrorCode",
                }
            )
            if not is_enum:
                offenders.append(f"{_LIVE_API}:{lineno}")
    assert offenders == [], (
        "code 는 error_codes enum 에서 와야 한다: " + ", ".join(offenders)
    )


def test_frontend_mirrors_every_live_error_code() -> None:
    """ADR-0004 미러 규율 — enum 값 추가 시 프론트 union 도 같은 커밋에서 갱신한다.

    미러가 어긋나면 프론트가 존재하지 않는 코드를 분기하거나(죽은 코드) 실제로 오는
    코드를 타입에서 놓친다. 두 방향 모두 검사한다.
    """
    types_src = _FRONTEND_TYPES.read_text(encoding="utf-8")
    start = types_src.index("export type LiveErrorCode =")
    block = types_src[start : types_src.index(";", start)]
    mirrored = set(part.strip().strip("|").strip().strip("'") for part in block.split("\n")[1:])
    mirrored.discard("")

    backend = {c.value for c in LiveErrorCode}
    assert backend - mirrored == set(), f"프론트 미러 누락: {sorted(backend - mirrored)}"
    assert mirrored - backend == set(), f"프론트에만 있는 코드: {sorted(mirrored - backend)}"


def test_the_three_enums_do_not_share_values() -> None:
    """카테고리 분리(ADR-0009)가 값 수준에서도 유지되는지 — 같은 문자열이 두 enum 에
    있으면 소비자가 어느 카테고리인지 판단할 수 없다."""
    live = {c.value for c in LiveErrorCode}
    upstream = {c.value for c in UpstreamCode}
    capture = {c.value for c in CaptureErrorCode}
    assert live & upstream == set()
    assert live & capture == set()
    assert upstream & capture == set()
