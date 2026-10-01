"""Pure projection shared by full and incremental second responses."""
from __future__ import annotations

from hoga.api.models import SecondAggregatesResponse, SecondBarModel, SecondPriceModel

from .second_trade_agg import aggregate_bars


def _project_response(
    merged: dict, scope: tuple, source: str | None, storage_error: str | None,
) -> SecondAggregatesResponse:
    code, venue, date, seconds, start, end, include_prices, regular_session_only, day_start = scope
    selected = merged
    if regular_session_only:
        # Storage resolution is one second. Keep the closing execution bucket.
        selected = {t: row for t, row in selected.items()
                  if day_start + 9 * 3_600_000 <= t <= day_start + (15 * 60 + 30) * 60_000}
    rows = sorted((row for t, row in selected.items() if start <= t < end), key=lambda r: r["t_ms"])
    bars = aggregate_bars(rows, seconds * 1000)
    result = SecondAggregatesResponse(
        code=code, venue=venue, date=date, seconds=seconds,
        status="observed" if rows else "unavailable",
        coverage="unverified", storage_error=storage_error, source=source,
        first_observed_ms=min(row["first"][0] for row in selected.values()) if selected else None,
        last_observed_ms=max(row["last"][0] for row in selected.values()) if selected else None,
        bars=[SecondBarModel(**{k: row[k] for k in SecondBarModel.model_fields}) for row in bars],
        prices=[SecondPriceModel(t_ms=row["t_ms"], price=p, side=side, qty=qty, count=count)
                for row in rows for p, side, qty, count in row["prices"]] if include_prices else [],
    )
    return result
