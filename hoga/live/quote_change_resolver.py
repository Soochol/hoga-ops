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


@dataclass(frozen=True)
class _AdjustedDailySignature:
    mtime_ns: int
    size: int


_BASELINE_SCALE_MISMATCH_RATIO = 3.0


class QuoteChangeResolver:
    def __init__(self, *, adjusted_daily_path: Path | None) -> None:
        self._adjusted_daily_path = adjusted_daily_path
        self._baseline_cache: dict[str, _Baseline | None] = {}
        self._baseline_cache_signature: _AdjustedDailySignature | None = None

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
        if baseline is not None and adjusted_pct is not None:
            if self._baseline_scale_mismatch(q, baseline):
                warnings.append("adjusted_baseline_scale_mismatch")
                return QuoteChangeResolution(
                    code=q.code,
                    price=q.price,
                    change_pct=None,
                    change_won=None,
                    baseline_price=baseline.close,
                    baseline_date=baseline.date,
                    change_pct_source="unavailable",
                    warnings=warnings,
                )
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
        signature = self._adjusted_daily_signature()
        if signature is None:
            self._baseline_cache.clear()
            self._baseline_cache_signature = None
            return None
        if signature != self._baseline_cache_signature:
            self._baseline_cache.clear()
            self._baseline_cache_signature = signature
        if code in self._baseline_cache:
            return self._baseline_cache[code]
        baseline = self._load_baseline(code)
        self._baseline_cache[code] = baseline
        return baseline

    def _adjusted_daily_signature(self) -> _AdjustedDailySignature | None:
        if self._adjusted_daily_path is None:
            return None
        try:
            stat = self._adjusted_daily_path.stat()
        except FileNotFoundError:
            return None
        return _AdjustedDailySignature(mtime_ns=stat.st_mtime_ns, size=stat.st_size)

    def _load_baseline(self, code: str) -> _Baseline | None:
        if self._adjusted_daily_path is None or not self._adjusted_daily_path.exists():
            return None
        try:
            with duckdb.connect(":memory:") as con:
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

    def _baseline_scale_mismatch(self, q: KisQuote, baseline: _Baseline) -> bool:
        quote_prices = [
            value for value in (q.price, q.open, q.high, q.low)
            if value is not None and value > 0
        ]
        if not quote_prices or baseline.close <= 0:
            return False
        quote_min = min(quote_prices)
        quote_max = max(quote_prices)
        return (
            baseline.close * _BASELINE_SCALE_MISMATCH_RATIO < quote_min
            or baseline.close / _BASELINE_SCALE_MISMATCH_RATIO > quote_max
        )
