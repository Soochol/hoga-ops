"""키움 REST 클라이언트가 공유하는 HTTP 전송 정책 — 연결 재사용 + 연결 재시도.

## 왜 있나 (2026-09-04 실측)

`/live` 종목 클릭 → 분봉 첫 표시가 느리다는 신고를 재 보니, 우리 쪽 대기가 아니라
**키움 REST 콜 1건의 지연**이 전부였다. 그 콜을 다시 쪼개면:

- 연결을 재사용하면 **0.46s** — 벤더의 실제 382행 조회 처리(바닥값)
- 연결을 새로 맺으면 **+0.8~1.4s**, 나쁘면 TLS 핸드셰이크만 **3.1s**
  (1.1/2.1/3.1초의 1초 계단 = 패킷 재전송 타임아웃)

httpx 기본 `keepalive_expiry` 는 **5초**다. 종목 클릭 간격은 통상 그보다 길어서
클릭마다 연결을 새로 맺고 있었다. 8초 유휴를 끼운 5회 요청 A/B: 5s 만료 1854ms →
90s 만료 243ms.

연결이 자주 끊긴 이유는 만료값 하나가 아니다 — 계정별로 클라이언트가 따로이고
`kiwoom_capacity._pick_account` 는 라운드로빈이 아니라 `min(available_at)` 이라,
바쁜 계정에서 **거의 안 쓰이는 계정으로 스필**하면 그 풀은 언제나 콜드였다.
만료를 늘리면 모든 계정의 풀이 따뜻해져 그 스필도 같이 싸진다 — 계정 선택 로직을
건드릴 이유가 없다.

## ⚠ `limits` 는 Client 가 아니라 **transport** 에 준다

`httpx.Client._init_transport` 는 `if transport is not None: return transport` 다.
즉 transport 를 명시하는 순간 **`Client(limits=…)` 는 조용히 무시된다** — 에러도
경고도 없이. 이 리포는 테스트가 `MockTransport` 를 주입하려고 transport 인자를
전부 열어 뒀으므로(18개 파일), 여기서 limits 를 Client 로 넘겼다면 "설정했는데
안 먹는" 상태가 됐을 것이다. 그래서 두 값을 **transport 안에** 넣어 함께 돌린다.

## retries 를 같이 켜는 이유 — 이 둘은 분리해서 넣으면 안 된다

만료를 늘리면 **서버가 조용히 끊은 연결**을 풀에서 꺼내 쓸 창이 생긴다. 키움은
`Connection: keep-alive` 를 주지만 `Keep-Alive: timeout=` 을 주지 않아 **서버측
idle timeout 이 미지**다. 그런데 `kiwoom_rest.KiwoomRestClient.call` 에는 재시도가
없다 — `httpx.TransportError` 를 곧장 `KiwoomTransportError` 로 올린다. 그래서
만료만 늘리면 지연을 줄이는 대신 간헐 실패를 새로 만든다.

`AsyncHTTPTransport(retries=N)` 는 **연결 단계 에러만** 재시도한다(요청이 서버에
닿은 뒤의 실패는 재시도하지 않는다). stale 연결은 정확히 그 연결 단계에서 터지므로
이 옵션이 그 구멍만 정확히 덮는다 — 비멱등 재전송 위험이 없다.

## 값을 90초로 고른 근거와 튜닝 방법

서버 idle timeout 이 미지이므로 A/B 에서 이긴 300초를 그대로 쓰지 않는다. 서버가
60초에 끊는다면 60~300초 사이의 요청은 stale 을 맞고, 그 비용은 `retries=1` 이
흡수하지만 **왕복 한 번이 그만큼 늘어난다**. 90초는 "클릭 간격은 덮되 서버 만료를
크게 넘기지 않는" 보수적 출발점이다.

튜닝은 추측이 아니라 로그로 한다 — `kiwoom_rest` 가 전송 실패를 상시 경고로 남긴다
(`kiwoom.rest.transport_error`). 그 줄이 **0건이면 값을 늘려도 안전**하고, 늘기
시작하면 그 빈도가 곧 서버 idle timeout 의 하한을 말한다. 급하면 재빌드 없이
`HOGA_KIWOOM_KEEPALIVE_S` 로 덮을 수 있다.
"""

from __future__ import annotations

import os

import httpx

#: httpx 기본값은 5.0초다 — 그 값이 이 모듈이 존재하는 이유다(위 실측 참조).
DEFAULT_KEEPALIVE_S = 90.0

#: 연결 단계 에러만 재시도한다. stale 연결 하나를 흡수하는 데 1회면 족하고,
#: 더 늘리면 진짜로 죽은 벤더를 앞에 두고 대기 시간만 배로 늘린다.
CONNECT_RETRIES = 1

_ENV_KEEPALIVE_S = "HOGA_KIWOOM_KEEPALIVE_S"


def keepalive_s() -> float:
    """유효 keepalive 만료(초). 음수·비수치는 기본값으로 되돌린다.

    0 은 **유효한 값**이다 — httpx 기본 동작(즉시 만료)으로 되돌리는 kill switch 라
    회귀가 의심될 때 코드를 되돌리지 않고 끌 수 있다.
    """
    raw = os.environ.get(_ENV_KEEPALIVE_S)
    if raw is None:
        return DEFAULT_KEEPALIVE_S
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_KEEPALIVE_S
    return value if value >= 0 else DEFAULT_KEEPALIVE_S


def limits() -> httpx.Limits:
    """연결 수 상한은 httpx 기본을 그대로 둔다 — 우리가 바꾸는 축은 **만료**뿐이다."""
    return httpx.Limits(keepalive_expiry=keepalive_s())


def async_transport() -> httpx.AsyncHTTPTransport:
    """`httpx.AsyncClient` 용 기본 transport. **주입된 transport 를 덮지 말 것** —
    호출부는 `transport or kiwoom_http.async_transport()` 로 써서 테스트의
    `MockTransport` 가 그대로 이기게 한다."""
    return httpx.AsyncHTTPTransport(retries=CONNECT_RETRIES, limits=limits())


def sync_transport() -> httpx.HTTPTransport:
    """`httpx.Client` 용. 비동기와 **클래스가 다르다** — 서로 바꿔 넣으면 httpx 가
    요청 시점에야 터진다(생성은 통과한다)."""
    return httpx.HTTPTransport(retries=CONNECT_RETRIES, limits=limits())
