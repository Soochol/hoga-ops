"""KIS 지수선물옵션 .mst 마스터 — download + parse (옵션 심리 패널, ADR-0135).

주식 마스터(``kis_master.py``)와 달리 이 파일은 **고정폭이 아니라 파이프 구분**이라
바이트 슬라이싱이 필요 없다. 무자격 다운로드인 점은 같다.

실측 포맷 (2026-08-03, 10,117행):

    1|A01609|KR4A01690002|F 202609| |00000.00|1|2001|KOSPI200
    N|BAFBRW962|KR4BAFBR9622|위클리M C 2608W2   962.5|2|00962.50| |2001|KOSPI200
    │ │        │            │                        │ │        │ │    └ 기초자산명
    │ │        │            │                        │ │        │ └────── 기초자산코드
    │ │        │            │                        │ │        └──────── (미사용)
    │ │        │            │                        │ └───────────────── 행사가
    │ │        │            │                        └─────────────────── ※ 콜풋 아님
    │ │        │            └──────────────────────────────────────────── 한글명
    │ │        └───────────────────────────────────────────────────────── 표준코드(ISIN)
    │ └────────────────────────────────────────────────────────────────── 단축코드
    └──────────────────────────────────────────────────────────────────── (미사용)

**필드 4는 콜/풋 구분이 아니다.** 값이 2/3 으로 깔끔하게 갈려 콜풋처럼 보이지만
한글명과 대조하면 절반이 어긋난다(실측: f4=2 중 C 1884 / P 2251). 이걸 콜풋으로
쓰면 콜과 풋이 절반씩 뒤섞여 P/C 비율이 **그럴듯하게 틀린** 값을 내므로, 판별은
반드시 단축코드 첫 글자로 한다 — B=콜 / C=풋 이 4592/4592 예외 없이 일치하고,
개별조회 프로브의 델타 부호(B…=+0.4928, C…=−0.5077)로도 교차 확인됐다.

시리즈는 단축코드 3자 접두로 갈린다(한글명과 1:1 확인):
    B01/C01 = 정규 월물      B05/C05 = 미니
    B09/C09 = 위클리(목)     BAF/CAF = 위클리M(월)
계약 승수가 다르므로 **정규와 미니를 합산하면 안 된다**(OI·거래량 중복 집계).
"""
from __future__ import annotations

import io
import re
import urllib.request
import zipfile
from typing import Literal, NamedTuple

OptionRight = Literal["call", "put"]
OptionSeries = Literal["monthly", "monthly_mini", "weekly_thu", "weekly_mon"]

MASTER_URL = "https://new.real.download.dws.co.kr/common/master/fo_idx_code_mts.mst.zip"

#: 심리 패널 스코프. KOSDAQ150(3003)은 아직 대상이 아니다.
KOSPI200_UNDERLYING = "2001"

#: 파이프 구분 필드 수(실측 10,117행 전부 9). 미만이면 잘린 행.
_FIELD_COUNT = 9

#: 단축코드 3자 접두 → 시리즈. 여기 없는 접두(A=선물, D=스프레드)는 옵션이 아니다.
_SERIES_BY_PREFIX: dict[str, OptionSeries] = {
    "B01": "monthly", "C01": "monthly",
    "B05": "monthly_mini", "C05": "monthly_mini",
    "B09": "weekly_thu", "C09": "weekly_thu",
    "BAF": "weekly_mon", "CAF": "weekly_mon",
}

#: 정규/미니 만기는 'C 202608', 위클리는 '위클리C 2608W1' 형식.
_EXPIRY_MONTHLY = re.compile(r"[CP]\s*(\d{6})")
_EXPIRY_WEEKLY = re.compile(r"[CP]\s*(\d{4}W\d)")


class OptionMasterRow(NamedTuple):
    code: str
    name: str
    right: OptionRight
    strike: float
    #: 정규/미니는 'YYYYMM', 위클리는 'YYMMWn' — 형식이 다르므로 series 와 함께 읽을 것.
    expiry: str
    series: OptionSeries


class KisOptionMasterFetchError(Exception):
    """download/unzip/parse 실패. 빈 카탈로그를 조용히 반환하지 않기 위한 신호."""


def download_option_master() -> bytes:
    """마스터 .mst 다운로드 + 압축 해제 (무자격)."""
    try:
        data = urllib.request.urlopen(MASTER_URL, timeout=60).read()  # noqa: S310 — 고정 https 상수
        z = zipfile.ZipFile(io.BytesIO(data))
        return z.read(z.namelist()[0])
    except Exception as e:
        raise KisOptionMasterFetchError(f"옵션 .mst download/unzip 실패: {e}") from e


def _parse_expiry(name: str, series: OptionSeries) -> str | None:
    pattern = _EXPIRY_MONTHLY if series in ("monthly", "monthly_mini") else _EXPIRY_WEEKLY
    m = pattern.search(name)
    return m.group(1) if m else None


def parse_option_master(raw: bytes) -> list[OptionMasterRow]:
    """원시 바이트 → KOSPI200 옵션 행. 0행이면 예외(빈 카탈로그 영속 방지)."""
    out: list[OptionMasterRow] = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        f = line.decode("cp949", errors="replace").split("|")
        if len(f) < _FIELD_COUNT or f[7] != KOSPI200_UNDERLYING:
            continue
        code = f[1].strip()
        series = _SERIES_BY_PREFIX.get(code[:3])
        if series is None:  # 선물(A…)·스프레드(D…)
            continue
        # 콜/풋은 첫 글자로만 판별한다 — 이유는 모듈 docstring 참조.
        right: OptionRight | None = (
            "call" if code[:1] == "B" else "put" if code[:1] == "C" else None
        )
        if right is None:
            continue
        name = f[3].strip()
        expiry = _parse_expiry(name, series)
        if expiry is None:
            continue
        try:
            strike = float(f[5])
        except ValueError:
            continue
        if strike <= 0:
            continue
        out.append(OptionMasterRow(code, name, right, strike, expiry, series))
    if not out:
        raise KisOptionMasterFetchError("옵션 .mst 파싱 0행 — empty/HTML/malformed")
    return out


def fetch_option_master() -> list[OptionMasterRow]:
    """다운로드 + 파싱. 블로킹 I/O — 호출자가 threadpool 로 오프로드한다."""
    return parse_option_master(download_option_master())


def atm_window(
    rows: list[OptionMasterRow], underlying: float, *, width: int = 20
) -> list[OptionMasterRow]:
    """기초자산에 가장 가까운 행사가를 중심으로 ±``width`` 행사가의 콜·풋을 고른다.

    2계층 수집의 **고빈도 계층**이 쓴다. P/C 비율·IV 스큐는 ATM 주변만으로 충분하고,
    전수(~780종목)를 30초마다 돌 수는 없기 때문이다.

    반대로 Max Pain·GEX 에는 이 함수를 쓰면 **안 된다** — 두 지표는 정의상 전 행사가
    합산이고, 실측상 OI 는 ATM 에 몰려 있지도 않다(2026-08-03: 60% OTM 인 1597.5 의
    OI 14,449 vs ATM 1000.0 의 1,674). ATM 창만 넣으면 값 자체가 무의미해진다.
    """
    strikes = sorted({r.strike for r in rows})
    if not strikes:
        return []
    center = min(range(len(strikes)), key=lambda j: abs(strikes[j] - underlying))
    keep = set(strikes[max(0, center - width) : center + width + 1])
    return [r for r in rows if r.strike in keep]


def near_month_chain(
    rows: list[OptionMasterRow], *, series: OptionSeries = "monthly"
) -> tuple[str, list[OptionMasterRow]]:
    """가장 이른 만기와 그 체인을 반환.

    만기 문자열이 'YYYYMM'(정규)이라 사전순 = 시간순이다. 위클리('YYMMWn')도
    같은 성질을 갖는다. 만기 경과 종목은 마스터에서 사라지므로 최소값이 근월물이다.
    """
    scoped = [r for r in rows if r.series == series]
    if not scoped:
        raise KisOptionMasterFetchError(f"series={series} 행이 없다")
    near = min(r.expiry for r in scoped)
    return near, [r for r in scoped if r.expiry == near]
