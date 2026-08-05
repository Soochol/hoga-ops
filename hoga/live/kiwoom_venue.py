"""키움 **wire venue 인코딩** — 종목코드 접미 ↔ venue 태그의 단일 진실원.

`hoga.live.venue` 는 거래소 도메인(브로커 중립)이고, 여기는 **키움이 그 도메인을
전선에 싣는 방식**이다. KIS 가 `FID_COND_MRKT_DIV_CODE` 에 `J`/`NX`/`UN` 을 싣던
자리에서, 키움은 **종목코드 접미**를 쓴다(#1008).

    005930     KRX  239,500  거래량 27,393,575
    005930_NX  NXT  240,500  거래량 18,346,108
    005930_AL  통합 240,500  거래량 45,739,907  ≈ KRX + NXT (실측 2026-08-03)

WS 구독 코드와 REST `stk_cd` 가 **같은 인코딩**을 쓰므로 한 곳에서 소유한다.

## 왜 새 모듈인가 (ADR-0140, #1124)

이 상수는 **같은 이름으로 두 벌 존재했고, 방향까지 반대였다**:

| 위치 | 내용 | 방향 |
|---|---|---|
| `kiwoom_fields.VENUE_SUFFIX` | `{"_NX": "NXT"}` | 접미 → venue |
| `kiwoom_multi_quote.VENUE_SUFFIX` | `{"KRX":"", "NXT":"_NX", "UN":"_AL"}` | venue → 접미 |

그래서 WS 쪽 `split_venue("005930_AL")` 는 **`("005930_AL", "KRX")`** 를 돌려줬다 —
접미가 안 벗겨져 코드가 오염되고 venue 가 KRX 로 오분류된다. `_AL` 을 안 쓰던
동안에는 드러나지 않았다.

정본을 다른 곳에 둘 수 없는 이유:
- `venue.py` — docstring 이 *"그 매핑은 각 벤더 모듈에 남고, 여기에는 오지 않는다"* 로
  wire 인코딩을 **명시적으로 배제**한다
- `kiwoom_fields` — 스스로 *"키움 **WS 실시간** FID 상수"* 라 선언한 모듈인데, 접미는
  WS 만의 것이 아니라 REST(`stk_cd`)에도 실린다
- `kiwoom_multi_quote` — **기능 모듈에 상수가 얹힌 꼴**이었다. 캔들 모듈 둘이 멀티쿼트가
  필요해서가 아니라 상수만 빌리려고 이걸 import 했다

I/O 없음.
"""
from __future__ import annotations

from hoga.live.venue import Venue

#: venue → 종목코드 접미. KRX 는 무접미다.
VENUE_SUFFIX: dict[Venue, str] = {"KRX": "", "NXT": "_NX", "UN": "_AL"}

#: 접미 → venue 역인덱스. **무접미(KRX)는 뺀다** — `""` 는 모든 문자열의 접미라
#: 순회에 넣으면 첫 비교에서 무조건 매치돼 `_NX`/`_AL` 이 영원히 도달 불가가 된다.
#: KRX 는 "아무 접미도 안 맞았을 때"의 폴백으로만 나온다(`split_venue` 참조).
_SUFFIX_TO_VENUE: tuple[tuple[str, Venue], ...] = tuple(
    (suffix, venue) for venue, suffix in VENUE_SUFFIX.items() if suffix
)


def apply_venue(code: str, venue: str) -> str:
    """bare code + venue → wire 코드. `split_venue` 의 역.

    ⚠ **모르는 venue 는 조용히 KRX(무접미)로 떨어진다.** 이건 의도된 하위호환이
    아니라 남아 있는 함정이다 — `session_gate.AUTO_VENUE`("AUTO") 를 그대로 넘기면
    NXT 시간대에 KRX 를 오구독한다. 호출부가 AUTO 를 먼저 해석해야 한다
    (`kiwoom_session._reconcile` 이 그렇게 한다). AUTO 자체는 ADR-0140 §7 에서
    소멸 예정이라 그때 이 폴백을 엄격화한다.
    """
    return f"{code}{VENUE_SUFFIX.get(venue, '')}"  # type: ignore[arg-type]


def split_venue(item: str) -> tuple[str, Venue]:
    """wire 코드 → (bare_code, venue). `apply_venue` 의 역.

    REAL 프레임의 `item` 은 키움이 **구독 코드를 그대로 에코**한 값이고, REST 응답의
    `stk_cd` 도 접미를 그대로 싣는다. 알려진 접미가 없으면 KRX 다.

    `apply_venue ∘ split_venue = 항등` 이 세 venue 전부에서 성립한다.
    """
    for suffix, venue in _SUFFIX_TO_VENUE:
        if item.endswith(suffix):
            return item[: -len(suffix)], venue
    return item, "KRX"
