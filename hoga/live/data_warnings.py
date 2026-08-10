"""wire `data_warnings` 항목의 **분류 단일 출처** (ADR-0143).

## 왜 이 모듈이 생겼나

`error_policy` 는 예외마다 `kind`·`permanent` 를 계산하는데, wire 로는 `reason` 과
`msg` 만 나갔다. 그래서 프론트 **6개 모듈이 그 버려진 사실을 `reason` 문자열로부터
각자 역추론**했고, 그중 하나가 갈린 것이 #1251 이었다(전송 실패가 non-blocking 으로
분류돼 재시도·박제·재발행 가드를 동시에 통과).

백엔드 자신도 이 결손의 피해자였다. `live_index_investor_net._reason_for` 는
`policy.kind` 로 판단해 놓고 그 kind 를 **버리고** reason 만 실어 보낸다 — 프론트
유니온에 매핑이 없어서 접은 것이다. 접기의 원인이 프론트 표의 한계였고, 그 표들이
지금 이 모듈이 대체하는 것이다.

## 축이 둘인 이유

`kind` 와 `is_failure` 는 **직교한다.**

`data_warnings` 는 실패 전용 채널이 아니다. `rest_bypassed`(모드 안내) ·
`*_fallback_to_krx`(대체 **성공**) · `index_minute_depth_limited`(벤더 보유의 사실)은
실패가 아닌데 같은 배열로 온다. 이들에게 실패 kind 를 억지로 주면 프론트가 "벤더가
못 줬다" 로 표시하게 된다 — `candleEmptyState` 가 `rest_bypassed` 를 벤더 실패
허용목록에서 일부러 뺀 이유와 같다("이 목록에 새는 순간 우회 안내 분기가 도달 불가").

그래서 **정보성 경고는 `kind=None` + `is_failure=False`** 다. `informational` 이라는
kind 를 만들지 않는 이유: 정보성끼리의 구별은 `reason` 이 이미 한다(`rest_bypassed` 와
`minute_fallback_to_krx` 는 reason 자체가 유일하다). kind 는 **실패의 처방 부류**를
묶는 축이므로 실패에만 붙인다. 이러면 "kind 가 있는데 is_failure=False" 라는 모순
상태가 애초에 생기지 않는다.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from hoga.live.error_policy import LiveErrorKind


class LiveDataWarning(BaseModel):
    """wire `data_warnings` 항목의 **shape 계약** (ADR-0143).

    이전에는 `list[dict]` 였다. 스트립 위험이 없는 대신 **계약도 없어서**, 생성기가
    키를 빠뜨려도 wire 계약 테스트가 볼 수 없었다 — 이 리팩터링이 고쳐 온 "같은
    사실이 여러 벌" 문제와 같은 뿌리다.

    **`extra="allow"` 가 load-bearing 이다.** 선언된 키는 계약이 되지만 그 밖의 키는
    **그대로 통과**한다. 이게 없으면 `response_model` 이 선언 안 된 키를 **조용히
    스트립**해서, 프론트가 읽던 값이 에러 없이 사라진다(CLAUDE.md "API wire 계약").
    `/api/live/series` 가 같은 이유로 채택한 패턴이다 — 최상위 키만 계약으로 두고
    나머지는 열어 둔다.

    `date` 와 `batch` 는 배타가 아니다: 분봉은 날짜 단위, 일봉·지수는 배치 단위,
    `invariant_violation` 은 둘 다 싣는다. 생성기가 `None` 인 키를 아예 빼서 보내므로
    (`make_data_warning`) 여기서도 optional 이다.
    """

    model_config = ConfigDict(extra="allow")

    reason: str
    msg: str
    #: 실패의 처방 부류. **정보성 경고에는 없다** — kind 는 실패에만 붙는다.
    kind: LiveErrorKind | None = None
    #: 실패인가. `data_warnings` 는 실패 전용 채널이 아니다(모드 안내·대체 성공·보유 한계).
    is_failure: bool | None = None
    date: str | None = None
    batch: str | None = None

# reason → (kind, is_failure). **미등록 사유는 여기 없다는 것 자체가 버그다** —
# `tests/unit/live/test_data_warnings.py` 가 생성기 전수와 대조한다.
#
# 값의 근거는 `docs/superpowers/plans/2026-08-10-failure-reason-inventory.md` 에
# 행마다 적혀 있다. 요약하면 **자의적 창작은 없다** — 기존 코드가 이미 하던 판정을
# 승격했거나(`rate_limit_aborted` 를 congestion 으로 묶던 `classifyRestWarning`),
# 이미 갈라 두었던 것을 이름 붙였다(`fetch_budget_exhausted` 의 `DEFERRED_FETCH_REASONS`).
WARNING_CLASSIFICATION: dict[str, tuple[LiveErrorKind | None, bool]] = {
    # ── error_policy 산출 (전부 실패) ──────────────────────────────────────
    "transport_error": ("transport", True),
    "rate_limit_upstream": ("rate_limit", True),
    # ⚠ **여기만 `policy.kind` 와 일부러 다르다** — 두 kind 는 축이 다르다.
    # `error_policy` 의 `kind="rate_limit"` 은 **처방 축**이다(백오프 없이 1초 뒤
    # 재시도). 반면 이 표는 **표시 축**이라 "누가 거절했나" 를 말해야 하는데,
    # 큐 포화는 **우리 쪽**이고 벤더는 이 구간을 거절한 적이 없다. `rate_limit` 으로
    # 표시하면 "호출 한도" 문구가 붙어 묻지도 않은 쪽에 책임을 지운다 —
    # `fetch_budget_exhausted` 와 같은 부류이고, 프론트 `candleEmptyState` 의
    # `DEFERRED_FETCH_REASONS` 가 이미 둘을 **한 집합에** 묶어 두었다.
    "capacity_overloaded": ("deferred", True),
    "api_error": ("vendor_api", True),
    "auth_error": ("auth", True),
    "batch_limit_exceeded": ("batch_limit", True),
    "internal_processing_error": ("internal", True),
    "unexpected_error": ("unexpected", True),
    # ── 정책 밖 · 진짜 실패 ────────────────────────────────────────────────
    # 우리 쪽 쿨다운이지만 **그 쿨다운을 벤더 거절이 만들었다** — 뿌리가 상류라
    # `rate_limit` 이다(프론트 `classifyRestWarning` 이 이미 같은 판정).
    "rate_limit_aborted": ("rate_limit", True),
    # 벤더에게 묻지도 않았다 — 우리가 요청당 상한을 걸어 다음 사이클로 미뤘다.
    "fetch_budget_exhausted": ("deferred", True),
    # 받긴 받았는데 행 검증에 걸렸다(ADR-0020).
    "invariant_violation": ("data_quality", True),
    # `/index-candles` 가 거버너 용량 한계에 걸려 HTTP 500 대신 경고로 강등한 것.
    # `capacity_overloaded` 와 같은 부류(우리 쪽 큐)인데 **사유가 따로 있다** — 지수
    # 경로가 프론트에서 '일시 지연' 으로 구분되기 때문이다(#1185 이전 결정).
    # **이 사유는 `make_data_warning(reason_variable, …)` 로 들어가 리터럴 스캔이
    # 못 봤다** — 등록 없이 폴백 `(None, True)` 로 떨어지고 있었다(2026-08-10 발견).
    "index_kis_capacity_overloaded": ("deferred", True),
    # 디스크 파일 부재 — **배선 안 됨**이지 데이터 품질 문제가 아니다. 파일을 만들기
    # 전엔 재시도가 무의미하고 처방은 "수집을 돌려라" 다. `not_wired` 가 생기기 전에는
    # `data_quality` 로 뒀는데(Phase 1), 그 kind 는 "받긴 받았다" 를 함의해서 틀렸다.
    "screener_daily_missing": ("not_wired", True),
    # 스크리너 장중 오버레이가 자격증명을 못 찾았다. `auth_error`(벤더가 거절)와
    # 처방이 다르다 — 이쪽은 앱 설정, 저쪽은 벤더 쪽 등록이다.
    "credentials_missing": ("not_wired", True),
    # ── 정책 밖 · 실패 아님 ────────────────────────────────────────────────
    # 우회가 켜져 있어 캐시만 서빙 — 사용자가 그렇게 설정한 것이다.
    "rest_bypassed": (None, False),
    # NXT/UN 이 비어 KRX 로 대체했다 — **성공한 것**이다.
    "minute_fallback_to_krx": (None, False),
    "daily_fallback_to_krx": (None, False),
    # 벤더 보유가 거기까지라는 사실 진술.
    "index_minute_depth_limited": (None, False),
}


def classify_warning_reason(reason: str) -> tuple[LiveErrorKind | None, bool]:
    """사유 → (kind, is_failure). 미등록이면 보수적으로 `(None, True)`.

    **미등록에서 예외를 던지지 않는 이유**: 경고 하나가 응답 전체를 500 으로 만들면
    안 된다. 경고는 이미 "실패했지만 계속 진행한다" 는 뜻이라, 그 분류 실패로 본체를
    죽이는 것은 처방을 거꾸로 뒤집는 것이다.

    대신 **실패 쪽으로 기운다**. 미등록 사유가 정보성인데 실패로 표시되면 사용자가
    한 번 놀라고 마는 반면, 실패인데 정보성으로 표시되면 조용히 사라진다 —
    #1251 이 정확히 그 방향의 사고였다.
    """
    return WARNING_CLASSIFICATION.get(reason, (None, True))


def make_data_warning(
    reason: str,
    msg: str,
    *,
    date: str | None = None,
    batch: str | None = None,
) -> dict:
    """wire `data_warnings` 항목 하나. **모든 생성기가 이 함수를 지난다.**

    `date` 와 `batch` 는 배타가 아니라 **둘 다 선택**이다 — 분봉은 날짜 단위,
    일봉·지수는 배치 단위, `invariant_violation` 은 둘 다 싣는다. `None` 인 키는
    아예 빼서 내려보낸다(프론트 미러가 optional 로 받는다).
    """
    kind, is_failure = classify_warning_reason(reason)
    warning: dict = {"reason": reason, "msg": msg, "is_failure": is_failure}
    if kind is not None:
        warning["kind"] = kind
    if date is not None:
        warning["date"] = date
    if batch is not None:
        warning["batch"] = batch
    return warning
