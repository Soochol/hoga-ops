"""키움 업종분봉(ka20005) → 지수 캔들 어댑터 (ADR-0129).

KIS 업종분봉(`FHKUP03500200`)은 시간 커서가 없어 **최신 102행이 하드 상한**이다
(ADR-0080). 1분봉은 최근 ~102분에 갇혀 `/live` 지수 차트가 사실상 비어 보인다.
키움 `ka20005`는 페이지당 900행 + `cont-yn`/`next-key` 연속조회를 준다.

`kis_*` 를 import하지 않는다(ADR-0116 규율 1). 공유 계약은 중립 모듈
`candle_fetch_result.IndexCandleFetchResult` 하나이고, 그래서 캐시·집계·라우트는
누가 fetch했는지 모른 채 그대로 재사용된다(ADR-0129 D1).

WS 쪽 `kiwoom_frames` 와 같은 역할: **브로커 간 표현 차이를 여기서 전부 흡수**한다.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

import httpx

from hoga.live.candle_fetch_result import (
    DailyInvariantViolation,
    IndexCandleFetchResult,
)
from hoga.live.candle_models import IndexCandlePoint
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
KIWOOM_KST = KST

_BASE_REAL = "https://api.kiwoom.com"
_CHART_PATH = "/api/dostk/chart"
_API_ID = "ka20005"
_ROWS_KEY = "inds_min_pole_qry"

# 키움 TR 유량 실측 1 req/s (ADR-0120). 연속조회는 직렬이라 페이지마다 이만큼 쉰다.
_PAGE_PACING_S = 1.0

# 폭주 방지 상한. 1분봉 1페이지 = 2.1거래일이므로 12페이지면 25거래일 이상 — 프론트가
# 요청하는 창(기본 5거래일, 딥 팬에서도 수십 거래일)을 덮고도 남는다. 도달 시 경고 없이
# 멈추지 않고 out_of_range violation 으로 남겨 "조용한 절단"을 만들지 않는다.
_MAX_PAGES = 12

_DATE_LEN = 8              # YYYYMMDD
_MIN_STAMP_LEN = 12        # YYYYMMDDHHMM — 초는 없을 수도 있다

# `/live` 대표지수 → 키움 업종코드. 실측 확정(2026-07-29).
# ⚠️ `701` 은 이름 때문에 KOSDAQ150 으로 오인하기 쉬우나 **KRX100** 이다.
INDEX_ID_TO_KIWOOM_CODE: dict[str, str] = {
    "KOSPI": "001",
    "KOSDAQ": "101",
    "KOSPI200": "201",
    "KOSDAQ150": "150",
    "KRX100": "701",
}

# 표시 버킷(초) → ka20005 `tic_scope`(분). 7종(1/3/5/10/15/30/60) 모두 900행을 준다고
# 실측했으므로 KIS 처럼 잔 소스를 골라 집계할 이유가 없다 — 표시 버킷 그대로 요청한다.
#
# 지수는 종목과 달리 **정규장만** 온다(2026-08-07 KOSPI 30m 실측: 09:00~15:30, 14봉).
# 그래서 60분에서 시간외가 정규장 봉에 섞이는 문제가 지수에는 존재하지 않는다 —
# 종목 쪽 사정은 `kiwoom_minute_candles.BUCKET_MS_TO_TIC_SCOPE` 주석 참조.
BUCKET_SECONDS_TO_TIC_SCOPE: dict[int, str] = {
    60: "1",
    180: "3",
    300: "5",
    600: "10",
    900: "15",
    1800: "30",
    3600: "60",
}


class KiwoomIndexCandlesError(RuntimeError):
    """ka20005 호출/응답 실패."""


def index_id_to_kiwoom_code(index_id: str) -> str:
    code = INDEX_ID_TO_KIWOOM_CODE.get(index_id)
    if code is None:
        raise KiwoomIndexCandlesError(f"{index_id} has no kiwoom index code")
    return code


def supports_bucket_seconds(bucket_seconds: int) -> bool:
    """이 어댑터가 그 표시 버킷을 **정확한 소스로** 받을 수 있는가.

    False 면 라우트가 KIS 경로를 쓴다. 집계 폴백을 여기 두지 않는 이유: 키움을 쓰는
    유일한 근거가 depth 인데, 잔 소스로 집계하면 그 depth 이점이 배수만큼 깎여
    KIS 대비 우위가 사라진다. 지원 버킷만 정직하게 가져간다.
    """
    return bucket_seconds in BUCKET_SECONDS_TO_TIC_SCOPE


def parse_price(raw: object) -> float:
    """ka20005 가격 문자열 → 값.

    `'-566324'` → `5663.24`. 부호 접두는 **등락 방향**이고 값 자체는 소수점이 제거된
    정수다. `pred_pre` 의 `'--36042'` 처럼 부호가 이중으로 붙는 필드가 있어 부호 문자를
    모두 제거한 뒤 파싱한다.

    ⚠️ 같은 지수 값을 `ka20003`(전업종지수)은 `'-5663.24'` 로 **소수점째** 준다.
    TR 마다 포맷이 다르므로 이 파서를 다른 TR 에 재사용하지 말 것.
    """
    text = str(raw).replace("+", "").replace("-", "").strip()
    if not text:
        raise ValueError("empty price field")
    if "." in text:
        # 방어: 키움이 포맷을 바꿔 소수점을 주기 시작해도 100배 틀린 값을 만들지 않는다.
        return abs(float(text))
    return abs(int(text)) / 100.0


def _parse_row(row: dict[str, Any]) -> tuple[str, IndexCandlePoint]:
    """한 행 → (YYYYMMDD, 캔들). 실패는 ValueError 로 올려 호출자가 violation 으로 만든다."""
    stamp = str(row.get("cntr_tm") or "").strip()
    if len(stamp) < _MIN_STAMP_LEN:
        raise ValueError(f"cntr_tm missing or too short: {stamp!r}")
    date_str, hhmm = stamp[:_DATE_LEN], stamp[_DATE_LEN:_MIN_STAMP_LEN]
    second = stamp[12:14] or "00"
    dt = datetime(
        int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
        int(hhmm[:2]), int(hhmm[2:4]), int(second),
        tzinfo=KIWOOM_KST,
    )
    close = parse_price(row.get("cur_prc"))
    point = IndexCandlePoint(
        t_ms=int(dt.timestamp() * 1000),
        open=parse_price(row.get("open_pric")),
        high=parse_price(row.get("high_pric")),
        low=parse_price(row.get("low_pric")),
        close=close,
        # 봉 거래량. `acml_vol`(당일 누적)이 아니라 `trde_qty`(해당 봉) 를 쓴다.
        volume=int(float(str(row.get("trde_qty") or "0").replace("+", "").replace("-", "") or 0)),
    )
    return date_str, point


def rows_to_result(
    rows: list[dict[str, Any]],
    from_yyyymmdd: str,
    to_yyyymmdd: str,
) -> IndexCandleFetchResult:
    """행 목록 → 정제된 결과. 순수 함수 — I/O 없이 fixture 로 완전 테스트 가능.

    경계 방어는 KIS 경로(`kis_endpoints.fetch_index_minute_candles`)와 **같은 술어·같은
    reason 집합**을 쓴다(ADR-0129 D5): 범위 밖은 조용히 제외, close 비양수와 OHLC
    모순은 violation. 그래야 프론트가 소스를 구분하지 않아도 된다.
    """
    candles: list[IndexCandlePoint] = []
    violations: list[DailyInvariantViolation] = []
    seen_t_ms: set[int] = set()

    for row in rows:
        try:
            date_str, point = _parse_row(row)
        except (KeyError, TypeError, ValueError) as e:
            stamp = str(row.get("cntr_tm") or "")
            violations.append(DailyInvariantViolation(
                date_yyyymmdd=stamp[:_DATE_LEN] if len(stamp) >= _DATE_LEN else "(empty)",
                reason="malformed_row",
                detail=str(e),
            ))
            continue
        if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
            continue
        if point.close <= 0:
            violations.append(DailyInvariantViolation(
                date_yyyymmdd=date_str, reason="close_nonpositive",
                detail=f"close={point.close}",
            ))
            continue
        if (
            point.high < max(point.open, point.close)
            or point.low > min(point.open, point.close)
            or point.high < point.low
        ):
            violations.append(DailyInvariantViolation(
                date_yyyymmdd=date_str, reason="ohlc_inconsistent",
                detail=(
                    f"open={point.open} high={point.high} "
                    f"low={point.low} close={point.close}"
                ),
            ))
            continue
        # 연속조회 페이지는 경계에서 겹칠 수 있다 — 먼저 본 행이 이긴다(결정적).
        if point.t_ms in seen_t_ms:
            continue
        seen_t_ms.add(point.t_ms)
        candles.append(point)

    candles.sort(key=lambda c: c.t_ms)
    return IndexCandleFetchResult(candles=candles, violations=violations)


def _oldest_date_in(rows: list[dict[str, Any]]) -> str | None:
    stamps = [str(r.get("cntr_tm") or "")[:_DATE_LEN] for r in rows]
    valid = [s for s in stamps if len(s) == _DATE_LEN]
    return min(valid) if valid else None


class KiwoomIndexCandlesFetcher:
    """ka20005 연속조회를 `(from, to) -> IndexCandleFetchResult` 하나로 감춘다.

    페이징은 **여기서 끝난다** — 캐시도 라우트도 `cont-yn` 의 존재를 모른다
    (ADR-0129). 그래야 브로커 교체가 클로저 하나 바꾸는 일로 남는다.
    """

    def __init__(
        self,
        token_provider: Any,
        *,
        client: httpx.Client | None = None,
        page_pacing_s: float = _PAGE_PACING_S,
        max_pages: int = _MAX_PAGES,
        sleep: Any = time.sleep,
    ) -> None:
        self._provider = token_provider
        self._client = client or httpx.Client(base_url=_BASE_REAL, timeout=20.0)
        self._page_pacing_s = page_pacing_s
        self._max_pages = max_pages
        self._sleep = sleep

    def close(self) -> None:
        self._client.close()

    def _post(self, body: dict[str, str], cont_yn: str, next_key: str) -> tuple[dict, dict]:
        token = self._provider.get_token()
        resp = self._client.post(
            _CHART_PATH,
            json=body,
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {token}",
                "api-id": _API_ID,
                "cont-yn": cont_yn,
                "next-key": next_key,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomIndexCandlesError(
                f"{_API_ID} HTTP {resp.status_code} {resp.text[:200]}"
            )
        payload = resp.json()
        if payload.get("return_code") != 0:
            raise KiwoomIndexCandlesError(
                f"{_API_ID} return_code={payload.get('return_code')} "
                f"{payload.get('return_msg')}"
            )
        return payload, dict(resp.headers)

    def fetch(
        self,
        index_id: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        bucket_seconds: int,
    ) -> IndexCandleFetchResult:
        """`from_yyyymmdd` 를 덮을 때까지 과거로 페이지를 걸어간다.

        중단 조건 셋: (1) 응답에 `from` **이전** 날짜가 나옴 — 목표 달성,
        (2) `cont-yn != 'Y'` — 더 이상 과거 없음, (3) `_MAX_PAGES` — 폭주 방지.
        (3)에 걸리면 `out_of_range` violation 을 남긴다(조용한 절단 금지).

        (1)이 `<=` 가 아니라 **`<`** 인 이유: 페이지 경계는 900행마다 끊겨 날짜
        경계와 무관하다. `from` 날짜의 캔들이 페이지에 하나라도 걸치면 `<=` 는
        "덮었다"고 판단하는데, 그날 **앞부분은 다음 페이지에 있다** — 요청 범위의
        가장 오래된 하루만 앞이 잘려 들어온다(실측: from=20260723 요청에 07-23 이
        09:52 부터 시작, 09:00~09:51 누락). `from` 이전 날짜를 볼 때까지 걸어야
        그날이 온전해진다. 대가는 대개 페이지 한 번 더다.
        """
        tic_scope = BUCKET_SECONDS_TO_TIC_SCOPE.get(bucket_seconds)
        if tic_scope is None:
            raise KiwoomIndexCandlesError(
                f"bucket_seconds={bucket_seconds} not supported by {_API_ID}"
            )
        body = {"inds_cd": index_id_to_kiwoom_code(index_id), "tic_scope": tic_scope}

        all_rows: list[dict[str, Any]] = []
        cont_yn, next_key = "N", ""
        truncated = False
        for page in range(self._max_pages):
            if page > 0 and self._page_pacing_s > 0:
                self._sleep(self._page_pacing_s)
            payload, headers = self._post(body, cont_yn, next_key)
            rows = payload.get(_ROWS_KEY) or []
            if not rows:
                break
            all_rows.extend(rows)
            oldest = _oldest_date_in(rows)
            if oldest is not None and oldest < from_yyyymmdd:
                break
            cont_yn = headers.get("cont-yn", "N")
            next_key = headers.get("next-key", "")
            if cont_yn != "Y":
                break
        else:
            truncated = True

        result = rows_to_result(all_rows, from_yyyymmdd, to_yyyymmdd)
        if truncated:
            oldest = _oldest_date_in(all_rows) or from_yyyymmdd
            log.warning(
                "kiwoom_index_candles page cap hit: index=%s tf=%ss from=%s reached=%s",
                index_id, bucket_seconds, from_yyyymmdd, oldest,
            )
            return IndexCandleFetchResult(
                candles=result.candles,
                violations=[
                    *result.violations,
                    DailyInvariantViolation(
                        date_yyyymmdd=oldest,
                        reason="out_of_range",
                        detail=(
                            f"{_API_ID} page cap ({self._max_pages}) reached before "
                            f"covering {from_yyyymmdd}"
                        ),
                    ),
                ],
            )
        return result
