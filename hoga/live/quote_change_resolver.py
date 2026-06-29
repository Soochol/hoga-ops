from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import duckdb

from hoga.live.kis_client import KisQuote

ChangePctSource = Literal[
    "kis",
    "adjusted_daily",
    "hidden_pre_open",
    "unavailable",
]

_REJECT_DIFF_PCT_POINTS = 5.0
_EXTREME_KIS_ABS_PCT = 30.0


@dataclass(frozen=True)
class QuoteChangeResolution:
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: ChangePctSource = "unavailable"
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Baseline:
    date: str
    close: int


class QuoteChangeResolver:
    def __init__(self, *, adjusted_daily_path: Path | None) -> None:
        self._adjusted_daily_path = adjusted_daily_path
        self._baseline_cache: dict[str, _Baseline | None] = {}

    def resolve_quote(self, q: KisQuote, *, phase: str) -> QuoteChangeResolution:
        baseline = self._baseline_for(q.code)
        warnings: list[str] = []

        if phase == "pre_open":
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=None,
                change_won=None,
                baseline_price=baseline.close if baseline else None,
                baseline_date=baseline.date if baseline else None,
                change_pct_source="hidden_pre_open",
            )

        adjusted_pct = self._adjusted_change_pct(q, baseline)
        if baseline is not None and adjusted_pct is not None and q.change_pct is not None:
            if self._should_reject_kis(kis_pct=q.change_pct, adjusted_pct=adjusted_pct):
                warnings.append("kis_change_pct_rejected")
                return QuoteChangeResolution(
                    code=q.code,
                    price=q.price,
                    change_pct=adjusted_pct,
                    change_won=round(q.price - baseline.close),
                    baseline_price=baseline.close,
                    baseline_date=baseline.date,
                    change_pct_source="adjusted_daily",
                    warnings=warnings,
                )

        if q.change_pct is not None:
            if self._adjusted_daily_path is not None and self._adjusted_daily_path.exists():
                if baseline is None:
                    warnings.append("adjusted_baseline_unavailable")
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=q.change_pct,
                change_won=q.change_won,
                baseline_price=baseline.close if baseline else None,
                baseline_date=baseline.date if baseline else None,
                change_pct_source="kis",
                warnings=warnings,
            )

        if adjusted_pct is not None and baseline is not None:
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=adjusted_pct,
                change_won=round(q.price - baseline.close),
                baseline_price=baseline.close,
                baseline_date=baseline.date,
                change_pct_source="adjusted_daily",
            )

        if self._adjusted_daily_path is not None and self._adjusted_daily_path.exists():
            warnings.append("adjusted_baseline_unavailable")
        return QuoteChangeResolution(
            code=q.code,
            price=q.price,
            change_pct=None,
            change_won=None,
            change_pct_source="unavailable",
            warnings=warnings,
        )

    def _baseline_for(self, code: str) -> _Baseline | None:
        if code in self._baseline_cache:
            return self._baseline_cache[code]
        baseline = self._load_baseline(code)
        self._baseline_cache[code] = baseline
        return baseline

    def _load_baseline(self, code: str) -> _Baseline | None:
        if self._adjusted_daily_path is None or not self._adjusted_daily_path.exists():
            return None
        try:
            con = duckdb.connect(":memory:")
            row = con.execute(
                f"""
                SELECT CAST(date AS VARCHAR) AS date_s, close
                FROM '{self._adjusted_daily_path}'
                WHERE code = ? AND close > 0
                ORDER BY date DESC
                LIMIT 1
                """,
                [code],
            ).fetchone()
        except Exception:
            return None
        if row is None:
            return None
        return _Baseline(date=str(row[0]), close=int(round(float(row[1]))))

    def _adjusted_change_pct(self, q: KisQuote, baseline: _Baseline | None) -> float | None:
        if baseline is None or baseline.close <= 0 or q.price <= 0:
            return None
        return round((q.price / baseline.close - 1.0) * 100.0, 2)

    def _should_reject_kis(self, *, kis_pct: float, adjusted_pct: float) -> bool:
        diff = abs(kis_pct - adjusted_pct)
        if diff < _REJECT_DIFF_PCT_POINTS:
            return False
        if abs(kis_pct) >= _EXTREME_KIS_ABS_PCT:
            return True
        return diff >= _REJECT_DIFF_PCT_POINTS
