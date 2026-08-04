import logging

import httpx

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)


def test_transport_error_maps_to_warning_without_traceback_and_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisTransportError(httpx.ConnectError("down")))

    assert policy.kind == "transport"
    assert policy.code == "TRANSPORT/ConnectError"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_rate_limit_error_maps_without_supervisor_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisRateLimitError("EGW00201 exhausted"))

    assert policy.kind == "rate_limit"
    assert policy.code == "EGW00201"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_auth_error_maps_to_warning_with_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisAuthError("token issue failed"))

    assert policy.kind == "auth"
    assert policy.code == "KIS_AUTH"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_generic_kis_api_error_maps_without_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisApiError("HTTP_500", "server error"))

    # kind 는 벤더 중립이다(ADR-0137) — 같은 처방이면 KIS·키움이 같은 kind 를 받는다.
    assert policy.kind == "vendor_api"
    assert policy.code == "HTTP_500"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_unexpected_error_keeps_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(RuntimeError("boom"))

    assert policy.kind == "unexpected"
    assert policy.code == "RuntimeError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_internal_marker_keeps_traceback_but_uses_internal_kind() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(ValueError("bad row"), internal=True)

    assert policy.kind == "internal"
    assert policy.code == "ValueError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_format_live_error_preserves_compatibility_shape() -> None:
    from hoga.live.error_policy import format_live_error

    exc = RuntimeError("boom")

    assert format_live_error(exc) == "RuntimeError: boom"


# --- 키움 (ADR-0136 이후의 주 데이터 경로 · ADR-0137) -------------------------
#
# 이 매핑이 없던 동안 키움 예외는 **전부 unexpected_error(ERROR+traceback)** 로
# 떨어졌다. 유량 초과가 내부 결함처럼 보였고, 사용자에게는 "장중 조회 불가" 한 줄로
# 뭉개졌다(ADR-0137).


def test_kiwoom_rate_limit_is_transient_and_carries_retry_hint() -> None:
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    policy = classify_live_error(
        KiwoomRateLimitError(
            "허용된 요청 개수를 초과하였습니다[1700:유량=5, API ID=ka10095]",
            api_id="ka10095",
        )
    )

    assert policy.kind == "rate_limit"
    assert policy.code == "1700/ka10095"
    assert policy.permanent is False
    assert policy.retry_after_s == 1.0
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False


def test_kiwoom_batch_limit_is_permanent_despite_identical_vendor_wording() -> None:
    """1634 와 1700 은 벤더 문구·return_code 가 같고 처방은 정반대다.

    1700 = 잠시 후 재시도 / 1634 = 청크를 줄여라. 분류가 갈리지 않으면 호출자가
    무한 재시도에 빠진다(kiwoom_errors.KiwoomBatchLimitError docstring).
    """
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomBatchLimitError

    policy = classify_live_error(
        KiwoomBatchLimitError("1634", "허용된 요청 개수를 초과하였습니다")
    )

    assert policy.kind == "batch_limit"
    assert policy.permanent is True
    assert policy.retry_after_s is None
    # 호출자 코드의 결함이므로 traceback 이 붙는다 — 유량 초과와 갈리는 두 번째 축.
    assert policy.include_traceback is True
    assert policy.log_level == logging.ERROR


def test_kiwoom_batch_limit_wins_over_its_api_error_base() -> None:
    """isinstance 검사 순서 계약. KiwoomBatchLimitError ⊂ KiwoomApiError 이므로
    베이스를 먼저 검사하면 1634 가 조용히 일시 실패로 분류된다."""
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomApiError, KiwoomBatchLimitError

    assert issubclass(KiwoomBatchLimitError, KiwoomApiError)
    assert classify_live_error(KiwoomBatchLimitError("1634", "x")).kind == "batch_limit"
    assert classify_live_error(KiwoomApiError("1511", "x")).kind == "vendor_api"


def test_kiwoom_transport_error_respects_retryable_classification() -> None:
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomTransportError

    retryable = classify_live_error(KiwoomTransportError(httpx.ConnectError("down")))
    not_retryable = classify_live_error(KiwoomTransportError(httpx.ReadTimeout("slow")))

    assert retryable.kind == "transport"
    assert retryable.retry_after_s == 3.0
    # 타임아웃은 키움이 요청을 받았고 느릴 뿐 — 재시도가 대기를 두 배로 만든다.
    assert not_retryable.retry_after_s is None


def test_kiwoom_auth_error_is_permanent_until_config_changes() -> None:
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomAuthError

    policy = classify_live_error(KiwoomAuthError("token issue failed"))

    assert policy.kind == "auth"
    assert policy.code == "KIWOOM_AUTH"
    assert policy.permanent is True
    assert policy.retry_after_s is None


def test_kiwoom_base_error_does_not_fall_through_to_unexpected() -> None:
    """모듈별 에러(KiwoomIndexCandlesError 등)는 베이스만 상속한다. 이 팔이 없으면
    벤더 장애가 ERROR+traceback 의 '내부 결함' 으로 기록된다."""
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomRestError

    class KiwoomIndexCandlesError(KiwoomRestError):
        pass

    policy = classify_live_error(KiwoomIndexCandlesError("upstream said no"))

    assert policy.kind == "vendor_api"
    assert policy.include_traceback is False
    assert policy.log_level == logging.WARNING


def test_permanent_policies_never_advertise_a_retry_delay() -> None:
    """R4 불변식 — 재시도해도 소용없는 것에 재시도 간격을 주면 호출자가 루프를 돈다."""
    from hoga.live.error_policy import classify_live_error
    from hoga.live.kiwoom_errors import KiwoomAuthError, KiwoomBatchLimitError

    samples = [
        classify_live_error(KiwoomBatchLimitError("1634", "x")),
        classify_live_error(KiwoomAuthError("x")),
        classify_live_error(KisAuthError("x")),
        classify_live_error(RuntimeError("x")),
        classify_live_error(ValueError("x"), internal=True),
    ]

    for policy in samples:
        assert policy.permanent is True
        assert policy.retry_after_s is None, f"{policy.kind} advertises a retry delay"
