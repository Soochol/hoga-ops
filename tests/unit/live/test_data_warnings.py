"""`data_warnings` 분류 단일 출처의 가드 (ADR-0143).

**이 파일이 막는 방향**은 셋이다:

1. 생성기가 **분류표에 없는 사유**를 쓰는 것 (새 사유를 만들고 등록을 잊음)
2. `error_policy` 의 `kind` 와 분류표의 `kind` 가 **갈리는 것** (같은 사실의 두 벌)
3. 정보성 경고에 실패 kind 가 붙는 것 (프론트가 "벤더가 못 줬다" 로 표시하게 됨)

**못 보는 것**: `make_data_warning(reason_variable, ...)` 처럼 사유가 **변수**로 들어가는
호출부는 소스 스캔이 값을 읽을 수 없다(현재 2곳: `_kis_capacity_degraded_batch_warning`
· `live_index_investor_net._warning`). 이들은 호출부가 넘기는 값이 정책 산출이라
2번 검사가 간접적으로 덮지만, **리터럴이 아닌 새 호출부를 추가하면 1번 검사 밖**이다.
"""
from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from hoga.live.data_warnings import (
    WARNING_CLASSIFICATION,
    LiveDataWarning,
    classify_warning_reason,
    make_data_warning,
)
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomBatchLimitError,
    KiwoomRateLimitError,
    KiwoomTransportError,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = (
    "hoga/live/live_candle_backfill.py",
    "hoga/live/live_daily_candle_backfill.py",
    "hoga/live/api.py",
    "hoga/live/screener_daily_candles.py",
    "hoga/live/live_index_investor_net.py",
)


def _literal_reasons_in_source() -> set[str]:
    """소스에서 사유 리터럴을 뽑는다 — **두 형태**.

    ① `make_data_warning("literal", ...)` — 직접 호출
    ② `reason = "literal"` — 변수로 담아 넘기는 형태

    ②가 뒤늦게 붙었다. 이 파일 docstring 이 "변수로 들어가는 호출부는 못 본다" 고
    한계를 적어 뒀는데, **실제로 그 구멍에 미등록 사유가 하나 숨어 있었다**
    (`index_kis_capacity_overloaded`, 2026-08-10 발견). 한계를 적어 두는 것과 막는
    것은 다르다 — 적을 수 있으면 대개 막을 수도 있다.
    """
    found: set[str] = set()
    for rel in _SCANNED:
        src = (_REPO_ROOT / rel).read_text(encoding="utf-8")
        found.update(re.findall(r'make_data_warning\(\s*"([a-z_]+)"', src))
        found.update(re.findall(r'^\s*reason = "([a-z_]+)"', src, re.M))
    return found


def test_every_generated_reason_is_classified() -> None:
    """생성기가 쓰는 사유는 전부 분류표에 있어야 한다.

    없으면 `classify_warning_reason` 이 보수적 폴백 `(None, True)` 로 떨어뜨려
    **정보성 경고가 실패로 표시**되거나, kind 가 비어 프론트가 다시 reason 문자열을
    역추론하게 된다 — 이 리팩터링이 없애려는 바로 그 상태다.
    """
    unregistered = _literal_reasons_in_source() - set(WARNING_CLASSIFICATION)

    assert not unregistered, (
        f"생성기가 쓰는데 분류표에 없는 사유: {sorted(unregistered)}. "
        "hoga/live/data_warnings.py::WARNING_CLASSIFICATION 에 (kind, is_failure) 를 "
        "추가할 것 — 근거는 인벤토리 문서에 행으로 남긴다(ADR-0143)."
    )


def test_scanner_actually_finds_reasons() -> None:
    """스캐너 자체의 회귀 — 0건을 읽으면 위 검사가 공집합끼리 맞아떨어진다.

    파서가 조용히 아무것도 못 읽으면 "미등록 없음" 이 되어 가드가 **영원히 초록**이다.
    한 번도 빨개질 수 없는 가드는 아무것도 증명하지 못한다.
    """
    found = _literal_reasons_in_source()

    assert "transport_error" not in found  # 정책 경유라 리터럴이 아니다
    assert "rest_bypassed" in found
    assert "rate_limit_upstream" in found
    assert len(found) >= 8


@pytest.mark.parametrize(
    ("exc", "reason"),
    [
        (KiwoomTransportError(httpx.ConnectTimeout("x")), "transport_error"),
        (KiwoomRateLimitError("유량=5"), "rate_limit_upstream"),
        (KiwoomBatchLimitError(code=5, msg="1634"), "batch_limit_exceeded"),
        (KiwoomAuthError("no token"), "auth_error"),
        (KiwoomApiError(code=3, msg="rejected"), "api_error"),
        # `KiwoomCapacityOverloaded` 는 **일부러 뺐다** — 아래 비대칭 테스트가 소유한다.
    ],
)
def test_policy_kind_matches_classification_table(exc: BaseException, reason: str) -> None:
    """**같은 사실의 두 출처가 갈리지 않는다.**

    `error_policy` 는 예외에서 `kind` 를 계산하고, 분류표는 `reason` 에서 계산한다.
    둘이 어긋나면 같은 실패가 경로에 따라 다른 kind 로 나가고, 프론트는 그 차이를
    볼 방법이 없다 — #1251 과 같은 종류의 무증상 드리프트다.
    """
    policy = classify_live_error(exc)
    table_kind, is_failure = classify_warning_reason(reason)

    assert policy.reason == reason
    assert policy.kind == table_kind, (
        f"{type(exc).__name__}: policy.kind={policy.kind!r} 인데 "
        f"분류표는 {table_kind!r} 이다"
    )
    assert is_failure is True


def test_capacity_overload_kind_intentionally_differs_from_policy() -> None:
    """**의도적 비대칭 — 이 사유 하나뿐이다.** 두 kind 는 축이 다르다.

    `error_policy` 의 `kind="rate_limit"` 은 **처방 축**이다: 백오프 없이 1초 뒤
    재시도하라는 뜻이고, 그건 옳다. 반면 wire kind 는 **표시 축**이라 "누가
    거절했나" 를 말한다 — 큐 포화는 **우리 쪽**이고 벤더는 이 구간을 거절한 적이
    없다.

    `rate_limit` 으로 표시하면 프론트가 "호출 한도로 지연" 문구를 붙여 묻지도 않은
    쪽에 책임을 지운다. `candleEmptyState` 가 `capacity_overloaded` 를
    `fetch_budget_exhausted` 와 **한 집합**(`DEFERRED_FETCH_REASONS`)에 둔 것이
    이 판정의 근거다.

    이 테스트가 없으면 위 parametrize 에서 빠진 것이 **누락처럼 보인다.**
    """
    policy = classify_live_error(KiwoomCapacityOverloaded("full"))
    table_kind, is_failure = classify_warning_reason("capacity_overloaded")

    assert policy.reason == "capacity_overloaded"
    assert policy.kind == "rate_limit"  # 처방 축 — retry_after 1s
    assert table_kind == "deferred"  # 표시 축 — 벤더에게 묻지 않았다
    assert is_failure is True


def test_informational_reasons_carry_no_failure_kind() -> None:
    """정보성 4종은 kind 없음 + `is_failure=False`.

    실패 kind 가 붙으면 프론트가 "벤더가 이 구간을 주지 않았다" 로 표시한다.
    `rest_bypassed` 는 **사용자가 그렇게 설정한 것**이고 `*_fallback_to_krx` 는
    오히려 **성공**이다.
    """
    for reason in (
        "rest_bypassed",
        "minute_fallback_to_krx",
        "daily_fallback_to_krx",
        "index_minute_depth_limited",
    ):
        kind, is_failure = classify_warning_reason(reason)
        assert kind is None, f"{reason} 에 실패 kind {kind!r} 가 붙었다"
        assert is_failure is False


def test_unknown_reason_falls_back_to_failure() -> None:
    """미등록은 **실패 쪽으로 기운다** — 조용히 사라지는 것보다 낫다."""
    kind, is_failure = classify_warning_reason("brand_new_reason")

    assert kind is None
    assert is_failure is True


def test_model_preserves_every_generated_key() -> None:
    """**`response_model` 이 생성기의 키를 스트립하지 않는가.**

    `data_warnings` 를 `list[dict]` 에서 모델로 올리면서 생긴 유일한 새 위험이다.
    FastAPI 는 선언되지 않은 키를 **에러 없이 버리므로**, 모델이 불완전하면 프론트가
    읽던 값이 조용히 사라지고 증상은 한참 뒤에 온다(CLAUDE.md "API wire 계약").

    `extra="allow"` 가 그걸 막는데, 그 설정이 지워져도 테스트는 통과할 수 있다 —
    선언된 키만 쓰는 payload 로는 차이가 안 나기 때문이다. 그래서 **선언 밖 키를
    일부러 하나 섞어** 통과를 확인한다.
    """
    generated = [
        make_data_warning("transport_error", "boom", date="20260518"),
        make_data_warning("rest_bypassed", "cache only", batch="a__b"),
        make_data_warning("invariant_violation", "x", date="20260518", batch="a__b"),
        # 선언 밖 키 — `extra="allow"` 가 없으면 여기서 사라진다.
        {**make_data_warning("api_error", "y"), "vendor_code": "8005"},
    ]

    for raw in generated:
        dumped = LiveDataWarning.model_validate(raw).model_dump(exclude_none=True)
        assert dumped == raw, (
            f"모델을 통과하며 키가 갈렸다: 넣은 것={sorted(raw)} 나온 것={sorted(dumped)}. "
            "`extra=\"allow\"` 가 살아 있는지, 새 키를 모델에 선언했는지 확인할 것."
        )


def test_make_data_warning_omits_absent_keys() -> None:
    """`date`/`batch` 는 선택이고 `None` 이면 **키 자체를 뺀다**.

    프론트 미러가 optional 로 받으므로 `null` 을 실어 보낼 이유가 없다. 정보성은
    `kind` 키도 없다 — "kind 가 있는데 is_failure=False" 라는 모순 상태를 만들지
    않기 위해서다.
    """
    minute = make_data_warning("transport_error", "boom", date="20260518")
    assert minute == {
        "reason": "transport_error",
        "msg": "boom",
        "is_failure": True,
        "kind": "transport",
        "date": "20260518",
    }

    info = make_data_warning("rest_bypassed", "cache only", batch="a__b")
    assert "kind" not in info
    assert "date" not in info
    assert info["is_failure"] is False
    assert info["batch"] == "a__b"
