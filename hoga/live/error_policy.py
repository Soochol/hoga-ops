"""예외 → 처방 정책 테이블 (ADR-0137).

호출자는 "무슨 예외인가" 가 아니라 **"그래서 어떻게 하나"** 를 묻는다. 이 모듈이
그 번역을 한 곳에서 소유한다 — 로그 레벨, traceback 포함 여부, 감독자 백오프,
그리고 사용자에게 보일 사유(`reason`)와 재시도 안내(`permanent`/`retry_after_s`).

**`permanent` 가 이 테이블의 핵심 축이다**(ADR-0137 R4). 재시도해도 소용없는 것에
"잠시 후 재시도" 를 안내하지 않고, 재시도하면 되는 것을 영구 불가처럼 보이게 하지
않는다. 두 벤더가 이 구분을 **같은 응답 코드로** 뭉개서 보내기 때문에 특히 중요하다:

    키움 1700  유량 초과      return_code=5  → permanent=False, 잠시 후 재시도
    키움 1634  배치 상한 초과  return_code=5  → permanent=True,  청크를 줄여야 한다

문구도 한글까지 동일해 대괄호 코드로만 갈린다. 오분류하면 호출자가 무한 재시도에
빠지거나(1634 를 유량으로 읽음) 멀쩡한 일시 장애를 영구 실패로 표시한다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomBatchLimitError,
    KiwoomRateLimitError,
    KiwoomRestError,
    KiwoomTerminalAuthError,
    KiwoomTransportError,
)

LiveErrorKind = Literal[
    "transport",
    "rate_limit",
    "batch_limit",
    "auth",
    "vendor_api",
    "internal",
    "unexpected",
    # 아래 둘은 `classify_live_error` 가 내지 않는다 — 예외에서 오는 것이 아니라
    # **우리 쪽 유예·품질 판정**이라 정책 밖 경고 생성기가 직접 붙인다(ADR-0143).
    # 그래도 이 Literal 에 두는 이유는 kind 문자열의 단일 출처를 지키기 위해서다.
    # 기존 7종에 욱여넣으면 코드가 이미 구별하던 것을 잃는다:
    #   `deferred`     — 벤더에게 **묻지도 않았다**(예산·쿨다운). `rate_limit` 로 접으면
    #                    "벤더가 거절했다" 가 되어 묻지 않은 쪽에 책임을 지운다.
    #   `data_quality` — 받긴 받았는데 행 검증에 걸렸다(ADR-0020: 표시하되 렌더).
    "deferred",
    "data_quality",
]

# 유량 초과의 재시도 간격. 두 벤더 모두 **초당** 한도라 1초면 창이 새로 열린다
# (키움 1700 은 `유량=5` 를 실어 보내는데 그 값은 초당 허용 콜 수지 대기 시간이 아니다).
_RATE_LIMIT_RETRY_AFTER_S = 1.0


@dataclass(frozen=True)
class LiveErrorPolicy:
    kind: LiveErrorKind
    reason: str
    code: str
    message: str
    log_level: int
    include_traceback: bool
    degraded: bool
    backoff_cycles: int
    # ADR-0137 R4 — 재시도가 의미 있나. `permanent=True` 는 같은 요청을 다시 보내도
    # 같은 실패가 난다는 뜻이다(설정 부재·배치 상한·내부 결함).
    permanent: bool = False
    # 일시 실패일 때 권장 재시도 간격. `permanent=True` 면 항상 None.
    retry_after_s: float | None = None


def format_live_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def classify_live_error(  # noqa: PLR0911, PLR0912 — 정책 테이블은 분기 나열이 곧 내용이다.
    # 예외 종류만큼 return 이 있는 게 정상이고, 이걸 dict 로 접으면 각 팔이 exc 에서
    # code/message 를 뽑는 방식이 달라 람다 테이블이 되어 오히려 읽기 어려워진다.
    # (분기 수 상한도 같은 이유로 면제한다 — 벤더/사례가 늘면 팔도 는다.)
    exc: BaseException, *, internal: bool = False,
) -> LiveErrorPolicy:
    if internal:
        return LiveErrorPolicy(
            kind="internal",
            reason="internal_processing_error",
            code=type(exc).__name__,
            message=str(exc),
            log_level=logging.ERROR,
            include_traceback=True,
            degraded=True,
            backoff_cycles=0,
            permanent=True,
        )

    # 거버너 큐 포화 — **벤더가 거절한 게 아니라 우리가 묻지 않았다.**
    #
    # `kind` 와 `reason` 이 갈리는 자리다. `kind` 는 처방 축이라 유량 초과와 같다
    # (기다리면 풀린다) — 그래서 `kind` 로 접는 소비자(`_reason_for` 등)가 손대지
    # 않고도 옳은 처방을 받는다. `reason` 은 표시 축이라 갈라야 한다: "벤더가 주지
    # 않았다" 로 말하면 묻지도 않은 쪽에 책임을 지운다.
    #
    # 이 팔이 없으면 `unexpected_error`(ERROR + traceback + permanent)로 떨어진다 —
    # 일시적인 큐 포화를 내부 결함으로 기록하고 "재시도해도 소용없다" 고 표시하는 셈이다.
    if isinstance(exc, KiwoomCapacityOverloaded):
        return LiveErrorPolicy(
            kind="rate_limit",
            reason="capacity_overloaded",
            code="CAPACITY",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
            retry_after_s=_RATE_LIMIT_RETRY_AFTER_S,
        )

    # --- 키움 (ADR-0136 이후의 주 데이터 경로) --------------------------------
    # 검사 순서가 계약이다: KiwoomBatchLimitError ⊂ KiwoomApiError,
    # KiwoomTransportError ⊂ KiwoomApiError 이므로 구체 타입이 먼저 와야 한다.
    if isinstance(exc, KiwoomBatchLimitError):
        return LiveErrorPolicy(
            kind="batch_limit",
            reason="batch_limit_exceeded",
            code=str(exc.code),
            message=exc.msg,
            log_level=logging.ERROR,
            # 호출자 코드의 결함이다(청크 크기). traceback 이 있어야 어느 호출부인지 안다.
            include_traceback=True,
            degraded=True,
            backoff_cycles=0,
            permanent=True,
        )
    if isinstance(exc, KiwoomRateLimitError):
        return LiveErrorPolicy(
            kind="rate_limit",
            reason="rate_limit_upstream",
            code=f"1700/{exc.api_id}" if exc.api_id else "1700",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
            retry_after_s=_RATE_LIMIT_RETRY_AFTER_S,
        )
    if isinstance(exc, KiwoomTransportError):
        return LiveErrorPolicy(
            kind="transport",
            reason="transport_error",
            code=str(exc.code),
            message=exc.msg,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
            # 발생 시점 분류를 그대로 존중한다 — 타임아웃 계열은 재시도가 대기를
            # 두 배로 만들 뿐이라 `retryable=False` 로 표시돼 온다(kiwoom_errors).
            retry_after_s=3.0 if exc.retryable else None,
            permanent=False,
        )
    if isinstance(exc, KiwoomAuthError):
        return LiveErrorPolicy(
            kind="auth",
            reason="auth_error",
            code="KIWOOM_AUTH",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
            # 자격증명·권한 문제는 사용자가 설정을 고치기 전에는 재시도해도 같다.
            permanent=True,
        )
    if isinstance(exc, KiwoomTerminalAuthError):
        # **타입 계층은 `KiwoomApiError` 인데 표시는 인증이다** — 의도된 어긋남이다.
        # 거버너가 토큰 무효화를 하면 안 되므로 `KiwoomAuthError` 를 상속하지 않지만,
        # 사용자에게는 기다려도 낫지 않는 인증 실패다(`KiwoomTerminalAuthError` docstring).
        # 그래서 이 팔이 generic `KiwoomApiError` 팔보다 **위에** 있어야 한다.
        return LiveErrorPolicy(
            kind="auth",
            reason="auth_error",
            code=str(exc.code),
            message=exc.msg,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
            permanent=True,
        )
    if isinstance(exc, KiwoomApiError):
        return LiveErrorPolicy(
            kind="vendor_api",
            reason="api_error",
            code=str(exc.code),
            message=exc.msg,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
            retry_after_s=_RATE_LIMIT_RETRY_AFTER_S,
        )
    if isinstance(exc, KiwoomRestError):
        # 베이스만 상속한 모듈별 에러(KiwoomIndexCandlesError 등).
        return LiveErrorPolicy(
            kind="vendor_api",
            reason="api_error",
            code=type(exc).__name__,
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
        )

    # --- KIS (ADR-0136 으로 축소 중 · 파생 경로에 존치) ------------------------
    if isinstance(exc, KisTransportError):
        return LiveErrorPolicy(
            kind="transport",
            reason="transport_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
            retry_after_s=3.0,
        )
    if isinstance(exc, KisRateLimitError):
        return LiveErrorPolicy(
            kind="rate_limit",
            reason="rate_limit_upstream",
            code="EGW00201",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
            retry_after_s=_RATE_LIMIT_RETRY_AFTER_S,
        )
    if isinstance(exc, KisAuthError):
        return LiveErrorPolicy(
            kind="auth",
            reason="auth_error",
            code="KIS_AUTH",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
            permanent=True,
        )
    if isinstance(exc, KisApiError):
        return LiveErrorPolicy(
            kind="vendor_api",
            reason="api_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
            retry_after_s=_RATE_LIMIT_RETRY_AFTER_S,
        )
    return LiveErrorPolicy(
        kind="unexpected",
        reason="unexpected_error",
        code=type(exc).__name__,
        message=str(exc),
        log_level=logging.ERROR,
        include_traceback=True,
        degraded=True,
        backoff_cycles=0,
        permanent=True,
    )
