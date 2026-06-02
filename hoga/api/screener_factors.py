"""수정주가 보정 계수(factor store). factor = adj_close / raw_close.

계수는 코퍼레이트 액션 때만 바뀌는 계단 함수 — 종목당 변곡점(seg_start, factor) 몇 개로
전 역사를 표현. 수정주가 = 원주가 × 계수 (ADR-0057).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass


@dataclass(frozen=True)
class FactorSegment:
    seg_start: dt.date
    factor: float


def compute_factor_segments(
    rows: list[tuple[dt.date, float, float]], *, tol: float = 1e-4
) -> list[FactorSegment]:
    """rows: (date, raw_close, adj_close) — date ASC 정렬 가정.

    factor=adj/raw 를 run-length로 압축: factor가 직전 대비 tol(상대) 넘게 바뀌면 새 세그먼트.
    raw_close==0(불량/결측)은 스킵(직전 세그먼트 유지). 첫 유효행이 첫 세그먼트(seg_start=그 날짜).
    """
    segments: list[FactorSegment] = []
    prev: float | None = None
    for d, raw_c, adj_c in rows:
        if raw_c == 0:
            continue
        f = adj_c / raw_c
        if prev is None or abs(f - prev) / prev > tol:
            segments.append(FactorSegment(d, f))
            # prev = 세그먼트-오픈 factor — sub-threshold 누적 변동엔 새 세그먼트를 안 만든다(안정성)
            prev = f
    return segments
