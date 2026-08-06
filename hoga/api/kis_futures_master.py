"""KIS 지수선물 .mst 마스터 — 선물(``A…``) 행 파서 (`/market` 선물 토글).

**옵션 파서(`kis_option_master.py`)와 같은 파일을 읽지만 스코프가 정반대다.** 저쪽은
``A…``(선물)·``D…``(스프레드)를 버리고 기초자산을 KOSPI200(``2001``)으로 한정한다.
그래서 저 파서의 필터를 넓히는 대신 여기 별도 파서를 둔다 — 옵션 심리 패널(ADR-0135)이
같은 함수를 쓰고 있어, 필터를 건드리면 P/C 비율에 코스닥150 옵션이 섞인다.

다운로드는 **재사용한다**. 물리적으로 같은 .mst 파일이라 URL 을 2벌로 두면 진실 소스가
갈린다(ETF 제외 소스 2벌이 127건 누수를 낸 전례).

실측 포맷 (2026-08-06, 선물 181행):

    1|A01609|KR4A01690002|F 202609| |00000.00|1|2001|KOSPI200
    3|A06609|KR4A06690007|코스닥150F 202609| |00000.00|1|3003|KSQ150
    │ │      │            │                   │ │        │ │    └ 기초자산명
    │ │      │            │                   │ │        └────── 기초자산코드
    │ │      │            │                   │ └─────────────── 월물 순번
    │ │      │            │                   └───────────────── 행사가(선물은 0)
    │ │      │            └───────────────────────────────────── 한글명
    │ │      └────────────────────────────────────────────────── 표준코드(ISIN)
    │ └───────────────────────────────────────────────────────── 단축코드
    └─────────────────────────────────────────────────────────── (미사용)

**종목코드는 반드시 이 단축코드(`A01609`)를 쓴다.** KIS 공식 예제가 쓰는
``101W09``/``101W9000`` 형식은 **작동하지 않는데 조용하다** — REST 는 `rt_cd=0`
"정상처리" + 전 필드 빈 문자열로, 존재하지 않는 코드와 응답이 완전히 같다. WS 는
``SUBSCRIBE SUCCESS`` 를 받고 0틱이다(2026-08-06 실측). 즉 어느 계층에서도 실패가
소리를 내지 않으므로, 코드 형식을 바꿀 일이 생기면 반드시 음성 대조군과 함께 친다.

**월물 주기가 상품마다 다르다.** KOSPI200·코스닥150 은 3/6/9/12 월물만 상장이라
8월에도 근월이 9월물이다(8월물 없음은 결측이 아니다). 반면 VKOSPI·미니는 연속월이라
같은 날 근월이 8월물이다. 그래서 근월 선택은 **상품별로** 한다.
"""
from __future__ import annotations

import re
from typing import Literal, NamedTuple

# 같은 .mst 파일이다 — 진실 소스를 1벌로 유지하려고 옵션 모듈 것을 그대로 쓴다.
# (이름에 option 이 들어가지만 받는 대상은 지수선물옵션 마스터 전체다.)
from hoga.api.kis_option_master import download_option_master

FuturesProduct = Literal["kospi200", "kospi200_mini", "kosdaq150", "vkospi"]

#: 단축코드 3자 접두 → 상품. 여기 없는 접두는 화면 스코프 밖이다 — 섹터·테마
#: 지수선물(`A08`·`AA*`, 각 4월물)은 카드에 올리지 않으므로 파싱하지 않는다.
_PRODUCT_BY_PREFIX: dict[str, FuturesProduct] = {
    "A01": "kospi200",
    "A05": "kospi200_mini",
    "A06": "kosdaq150",
    "A04": "vkospi",
}

#: 한글명의 만기. 'F 202609'·'미니F 202608'·'코스닥150F 202609'·'변동성F 202608'
#: 이 전부 같은 꼬리를 갖는다. 스프레드('SP 2609-2612')는 F 가 없어 걸리지 않지만,
#: 애초에 `D…` 접두라 상품 표에서 먼저 탈락한다.
_EXPIRY = re.compile(r"F\s*(\d{6})")

#: 파이프 구분 필드 수. 옵션 파서와 같은 파일이므로 같은 값이다.
_FIELD_COUNT = 9


class FuturesMasterRow(NamedTuple):
    code: str
    name: str
    product: FuturesProduct
    #: 'YYYYMM'. 사전순 = 시간순이라 최소값이 근월이다(만기 경과분은 마스터에서 사라진다).
    expiry: str
    underlying_code: str
    underlying_label: str


class KisFuturesMasterFetchError(Exception):
    """download/parse 실패. 빈 카탈로그를 조용히 반환하지 않기 위한 신호."""


def parse_futures_master(raw: bytes) -> list[FuturesMasterRow]:
    """원시 바이트 → 선물 행. 0행이면 예외(빈 카탈로그 영속 방지)."""
    out: list[FuturesMasterRow] = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        f = line.decode("cp949", errors="replace").split("|")
        if len(f) < _FIELD_COUNT:
            continue
        code = f[1].strip()
        product = _PRODUCT_BY_PREFIX.get(code[:3])
        if product is None:  # 옵션(B/C…)·스프레드(D…)·섹터선물(A08·AA*)
            continue
        name = f[3].strip()
        m = _EXPIRY.search(name)
        if m is None:
            continue
        out.append(
            FuturesMasterRow(
                code=code,
                name=name,
                product=product,
                expiry=m.group(1),
                underlying_code=f[7].strip(),
                underlying_label=f[8].strip(),
            )
        )
    if not out:
        raise KisFuturesMasterFetchError("선물 .mst 파싱 0행 — empty/HTML/malformed")
    return out


def near_month(rows: list[FuturesMasterRow], product: FuturesProduct) -> FuturesMasterRow:
    """상품의 근월물 1건.

    **근월은 상품마다 다르다** — 같은 날 KOSPI200 은 9월물, VKOSPI 는 8월물이다.
    전역 최소 만기를 골라 모든 상품에 쓰면 존재하지 않는 종목코드가 만들어진다.
    """
    scoped = [r for r in rows if r.product == product]
    if not scoped:
        raise KisFuturesMasterFetchError(f"product={product} 행이 없다")
    return min(scoped, key=lambda r: r.expiry)


def fetch_futures_master() -> list[FuturesMasterRow]:
    """다운로드 + 파싱. 블로킹 I/O — 호출자가 threadpool 로 오프로드한다."""
    try:
        raw = download_option_master()
    except Exception as e:  # 옵션 모듈의 예외형을 선물 쪽 신호로 번역한다(재발생하므로 BLE001 무관)
        raise KisFuturesMasterFetchError(f"선물 .mst download 실패: {e}") from e
    return parse_futures_master(raw)
