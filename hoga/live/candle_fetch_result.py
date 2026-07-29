"""캔들 fetch 결과 — **브로커 중립** 포트 타입 (ADR-0129 D2).

WS 쪽 `ticks.WsTick` 과 같은 자리다: KIS 어댑터(`kis_endpoints`)와 키움 어댑터
(`kiwoom_index_candles`)가 **서로를 모른 채** 같은 것을 반환하게 하는 공용 계약.

원래 이 타입들은 `kis_endpoints.py` 에 있었다. 그 모듈은 KIS HTTP 어댑터 그 자체라,
키움 어댑터가 거기서 import 하면 ADR-0116 규율 1(`kis_*` ↔ `kiwoom_*` 상호 import
금지) 정면 위반이 된다. 그래서 접두 없는 모듈로 분리했다. `kis_endpoints` 는 기존
사용처를 위해 re-export 를 유지한다.

`IndexCandlePoint`(`kis_models`)는 옮기지 않았다 — 바로 옆 `KisCandle` 이 "브로커 중립
캔들 포트, 이름의 Kis 는 역사적, 리네임은 22개 사용처 파급이라 보류"로 선례를 세웠고,
`kis_models` 는 어댑터가 아니라 모델 모듈이라 같은 처리로 일관성을 지킨다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from hoga.live.kis_models import IndexCandlePoint, KisCandle


@dataclass(frozen=True)
class DailyInvariantViolation:
    """A row dropped by a candle fetcher's boundary defense.

    Surfaced to the handler so wire data_warnings can tell operators which
    dates were silently lost — ADR-0040's defensive-parse policy made explicit
    (grill Q3 decision in 2026-05-28 daily backfill spec).

    소스 무관 계약(ADR-0129 D5): 키움 어댑터도 이 `reason` 집합만 쓴다. 브로커 전용
    reason 을 새로 만들면 프론트가 소스를 구분해야 해서 응답의 중립성이 깨진다.
    """
    date_yyyymmdd: str
    reason: Literal[
        "close_nonpositive", "ohlc_inconsistent", "malformed_row", "out_of_range"
    ]
    detail: str


@dataclass(frozen=True)
class DailyCandleFetchResult:
    """Return value of fetch_past_daily_candles.

    `candles` is the cleaned, ASC-sorted result; `violations` is the per-row
    drop log so the caller can surface them to data_warnings.
    """
    candles: list[KisCandle]
    violations: list[DailyInvariantViolation] = field(default_factory=list)


@dataclass(frozen=True)
class IndexCandleFetchResult:
    """지수 캔들 fetch 결과 — `fetch_batch` 포트의 반환 타입.

    `collect_index_minute_candles_with_cache(..., fetch_batch)` 가 받는 클로저의
    계약이 `(from_s, to_s) -> IndexCandleFetchResult` 이고, 캐시·집계·경고 파이프라인은
    이것만 보므로 **누가 fetch 했는지 모른다**. 브로커 교체는 이 클로저를 바꾸는 것이
    전부다(ADR-0129 D1 — 새 Protocol 을 추출하지 않는 이유).
    """
    candles: list[IndexCandlePoint]
    violations: list[DailyInvariantViolation] = field(default_factory=list)
