"""키움 REST 도메인 에러 + retryable 분류 (`kis_errors` 브로커-대칭).

Leaf 모듈이다 — import 해도 HTTP 클라이언트가 딸려오지 않으므로 transport
코어(`kiwoom_rest`)와 소비자가 순환 없이 같은 타입에 의존할 수 있다.

**키움 오류는 두 축이다** — 이것이 KIS 와 다른 결정적 지점이다(ADR-0136 §2):

  HTTP 200 + return_code != 0   1504 경로 불일치 · 1511 필수 파라미터 누락
                                1513 authorization 헤더 없음
  **HTTP 429**                  1700 유량 초과 — `유량=5, API ID=<tr>` 를 응답에 실어준다

조사 중 실제로 이 함정을 밟았다: `return_code` 만 보고 요약한 프로브가 429 로 끊긴
것을 "커서가 끝났다" 로 오독했다(#1015). **분류기는 반드시 두 축을 모두 본다.**
"""
from __future__ import annotations

import re

import httpx

# 재시도할 가치가 있는 전송 실패 — 요청이 키움에 닿지 않았거나 소켓이 끊긴 경우다.
# 읽기/쓰기 **타임아웃은 의도적으로 제외**한다(키움은 요청을 받았고 느릴 뿐이라
# 재시도가 대기를 두 배로 만들고 힘든 업스트림에 부하를 더한다). kis_errors 와 같은 정책.
_RETRYABLE_TRANSPORT: tuple[type[httpx.TransportError], ...] = (
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.PoolTimeout,
)

# 1700 메시지에서 벤더가 알려주는 유량을 뽑는다: "... 유량=5, API ID=ka10080]"
_QUOTA_RE = re.compile(r"유량\s*=\s*(\d+)")


class KiwoomRestError(RuntimeError):
    """키움 REST 계층이 던지는 모든 예외의 베이스.

    모듈별 에러(`KiwoomIndexCandlesError` 등)도 이 타입을 상속하므로, 호출자는
    좁게(모듈별) 또는 넓게(이 타입) 잡을 수 있다.
    """


class KiwoomAuthError(KiwoomRestError):
    """토큰 발급 실패 또는 `1513`(authorization 헤더 부재)."""


class KiwoomApiError(KiwoomRestError):
    """`return_code != 0` 일반 실패."""

    def __init__(self, code: object, msg: str):
        self.code = code
        self.msg = msg
        super().__init__(f"kiwoom api error {code}: {msg}")


class KiwoomBatchLimitError(KiwoomApiError):
    """배치 크기 초과(`1634`) — **재시도해도 영원히 실패한다.**

    함정: 벤더가 이것을 **유량 초과(`1700`)와 똑같은 `return_code == 5` + 똑같은
    한글 문구**("허용된 요청 개수를 초과하였습니다")로 돌려준다. 구분 키는 대괄호
    안의 코드뿐이다. 잘못 분류하면 거버너가 버킷을 물리고 호출자는 "잠시 후 재시도"
    로 읽어 **무한 재시도**에 빠진다.

    올바른 대응은 **청크를 줄이는 것**이다(실측 상한: `ka10095` 100종목, #1040).
    """


class KiwoomRateLimitError(KiwoomRestError):
    """HTTP 429 / `return_code == 5` — 유량 초과.

    벤더가 메시지에 상한을 적어 보내므로(`유량=5`) 파싱해 ``quota`` 로 노출한다.
    거버너가 버킷을 자동 교정하는 데 쓸 수 있다 — `유량=5` 는 `ka10080` 에서만
    확인했고 TR 마다 다를 수 있기 때문이다(ADR-0136 Trigger).

    호출자 관점의 의미는 "지금은 막혔다, 잠시 뒤 재시도" 다. 영구 거절이 아니다.
    """

    def __init__(self, msg: str, *, api_id: str | None = None):
        self.api_id = api_id
        m = _QUOTA_RE.search(msg)
        self.quota: int | None = int(m.group(1)) if m else None
        super().__init__(msg)


class KiwoomTransportError(KiwoomApiError):
    """``httpx.TransportError`` 를 키움 도메인으로 정규화.

    `KiwoomApiError` 를 상속하는 것은 의도적이다 — 기존 `except KiwoomApiError`
    지점(백필 오케스트레이터의 degrade-and-continue 팔)이 수정 없이 흡수한다.
    합성 ``code``('TRANSPORT/<httpx 클래스>')는 벤더 return_code 와 충돌하지 않는다.
    """

    def __init__(self, exc: httpx.TransportError):
        # 발생 시점에 분류해 재시도 루프를 단순하게 유지한다.
        self.retryable = isinstance(exc, _RETRYABLE_TRANSPORT)
        super().__init__(code=f"TRANSPORT/{type(exc).__name__}", msg=str(exc)[:200])
