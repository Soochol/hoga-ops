"""KIS 시장별 투자자매매동향(시세) 조회 — `KisInvestorEndpointsMixin`.

``kis_futures_endpoints.py`` 와 같은 믹스인 규약을 따른다: ``self._get`` 을 KisClient 의
MRO 로 해결하고 자체 상태를 두지 않는다.

**이 TR 은 메뉴가 `[국내주식] 시세분석` 인데 시장구분 코드표에 파생이 들어 있다.**
카테고리 위치가 코드표가 아니다 — `[국내선물옵션]` 44개 API 에는 투자자 동향이 하나도
없고(시세분석 카테고리 자체가 없다), 키움 REST 337개 TR 에도 파생 투자자 TR 이 0건이라
**파생 투자자 수급의 유일한 벤더 경로가 여기다**(2026-08-07 전수 조사).

시장구분(`FID_INPUT_ISCD`) → 업종구분(`FID_INPUT_ISCD_2`) 쌍은 `deriv_flow_products` 가
소유한다. 이 믹스인은 쌍을 받아 던지기만 하는 얇은 층이다.

**응답 `output` 의 형태가 문서와 예시에서 갈린다** — Layout 표는 `object`, Example 은
배열이다. 어느 쪽이 와도 첫 행을 돌려주도록 둘 다 받는다. 실측 없이 한쪽만 가정하면
장 열린 뒤에야 터진다.

**빈 응답을 성공으로 오인하지 않는다.** KIS 는 존재하지 않는 코드에도 `rt_cd=0`
"정상처리" + 전 필드 빈 문자열을 준다(fail-open, `kis_futures_endpoints` 와 같은 함정).
그래서 rt_cd 가 아니라 **행에 값이 있는지**로 판정한다.

모의투자 미지원 TR 이다 — 실계좌 앱키에서만 돈다.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

_PATH = "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market"
_TR = "FHPTJ04030000"

#: 행이 비었는지 판정할 대표 필드. 세 주체의 순매수 대금 중 하나라도 값이 있으면
#: 벤더가 실제로 답한 것으로 본다. 0 은 유효한 값이므로 **빈 문자열/None 만** 배제한다
#: (장 초반엔 실제로 0 이 온다 — 0 을 결측으로 접으면 09:00 표본이 통째로 사라진다).
_PRESENCE_KEYS = ("frgn_ntby_tr_pbmn", "prsn_ntby_tr_pbmn", "orgn_ntby_tr_pbmn")


def _has_values(row: dict[str, Any]) -> bool:
    return any(str(row.get(k) or "").strip() != "" for k in _PRESENCE_KEYS)


class KisInvestorEndpointsMixin:
    async def fetch_market_investor(
        self, iscd: str, iscd2: str, *, foreground: bool = False
    ) -> dict[str, Any] | None:
        """시장 하나의 투자자별 당일 누적 (TR ``FHPTJ04030000``).

        **행을 파싱하지 않고 원본 dict 그대로 돌려준다** — 저장 계약이 "한 줄 = 벤더
        응답 하나" 이고, 단위 해석이 갈려도 원본이 남아 있으면 다시 읽을 수 있기
        때문이다(장중 표본은 소급 조회가 불가능하다).

        빈 행이면 None — 호출부는 그 표본을 건너뛴다.
        """
        body = await self._get(  # type: ignore[attr-defined]
            path=_PATH,
            tr_id=_TR,
            params={"FID_INPUT_ISCD": iscd, "FID_INPUT_ISCD_2": iscd2},
            foreground=foreground,
        )
        out = body.get("output")
        row: dict[str, Any] | None = None
        if isinstance(out, list):
            row = out[0] if out else None
        elif isinstance(out, dict):
            row = out
        if row is None or not _has_values(row):
            log.debug("kis_investor: 빈 응답 iscd=%s iscd2=%s", iscd, iscd2)
            return None
        return row
