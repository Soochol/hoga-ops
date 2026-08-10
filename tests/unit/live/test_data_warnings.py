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
    """소스에서 `make_data_warning("literal", ...)` 의 첫 인자를 뽑는다."""
    found: set[str] = set()
    for rel in _SCANNED:
        src = (_REPO_ROOT / rel).read_text(encoding="utf-8")
        found.update(re.findall(r'make_data_warning\(\s*"([a-z_]+)"', src))
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
        (KiwoomCapacityOverloaded("full"), "capacity_overloaded"),
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
