"""Resolve prices, original amounts and exact share units from a pinned snapshot."""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import polars as pl

from hoga.api import screener_series_store as store


@dataclass
class Series:
    original: dict[dt.date, dict]
    prices: dict[dt.date, dict]
    evidence: store.ShareEvidence | None
    conflicts: set[dt.date]

    def quantity(self, day: dt.date, anchor: dt.date, basis: str) -> Fraction | None:
        row = self.original.get(day)
        if row is None or day in self.conflicts or not valid_row(row):
            return None
        value = Fraction(row["volume"])
        if basis == "raw":
            return value
        evidence = self.evidence
        if evidence is None or not evidence.verified_from <= day <= anchor <= evidence.verified_to:
            return None
        for event in evidence.events:
            if day < event.effective_date <= anchor:
                if event.kind == "unsupported":
                    return None
                value *= Fraction(event.numerator, event.denominator)
        return value

    def amount(self, day: dt.date) -> float | None:
        row = self.original.get(day)
        if row is None or day in self.conflicts or not valid_row(row):
            return None
        amount = row.get("trade_value_won")
        if amount is not None:
            return float(amount) if math.isfinite(amount) and amount >= 0 else None
        return sum(row[key] for key in ("open", "high", "low", "close")) / 4 * row["volume"]


def valid_quantity(row: dict) -> bool:
    return type(row.get("volume")) is int and row["volume"] >= 0


def valid_price(row: dict) -> bool:
    try:
        o, h, low, c = [float(row[key]) for key in ("open", "high", "low", "close")]
        return all(math.isfinite(v) and v > 0 for v in (o, h, low, c)) and h >= max(o, c) and low <= min(o, c)
    except (KeyError, TypeError, ValueError):
        return False


def valid_row(row: dict) -> bool:
    return valid_price(row) and valid_quantity(row)


def _violation_dates(observation, basis):
    dates = set()
    for violation in observation.get("violations", []):
        if violation.get("basis", "unadjusted") != basis:
            continue
        try:
            dates.add(dt.datetime.strptime(violation["date_yyyymmdd"], "%Y%m%d").date())
        except (ValueError, KeyError):
            return None
    return dates


def _dated(rows):
    return {dt.date.fromisoformat(row["date"]): row for row in rows}


def load_series(
    data_dir: Path, manifest: dict, codes: list[str], *, first=dt.date.min, last=dt.date.max
) -> dict[str, Series]:
    raw = (
        pl.scan_parquet(store.baseline_path(data_dir, manifest, "daily_unadjusted.parquet"))
        .filter(pl.col("code").is_in(codes), pl.col("date").is_between(first, last))
        .collect()
    )
    by_code = raw.partition_by("code", as_dict=True)
    result = {}
    for code in codes:
        frame = by_code.get((code,))
        original = (
            {row["date"]: {**row, "date": row["date"].isoformat()} for row in frame.iter_rows(named=True)}
            if frame is not None
            else {}
        )
        observation_id = manifest["observations"].get(code)
        prices, conflicts = {}, set()
        if observation_id:
            observation = store.read_object(data_dir, observation_id)
            conflicts.update(dt.date.fromisoformat(day) for day in observation.get("conflicts", []))
            invalid_raw = _violation_dates(observation, "unadjusted")
            invalid_prices = _violation_dates(observation, "adjusted")
            for day, row in _dated(observation["unadjusted"]).items():
                if not first <= day <= last or not row.get("complete", True):
                    continue
                old = original.get(day)
                if old and any(old[key] != row[key] for key in ("open", "high", "low", "close", "volume")):
                    conflicts.add(day)
                elif old is None:
                    original[day] = row
                elif row.get("trade_value_won") is not None:
                    original[day] = {**old, "trade_value_won": row["trade_value_won"]}
            conflicts.update(original if invalid_raw is None else invalid_raw)
            if observation["adjusted_as_of"] == manifest["adjusted_as_of"] and invalid_prices is not None:
                prices = {
                    day: row
                    for day, row in _dated(observation["adjusted"]).items()
                    if first <= day <= last
                    and valid_price(row)
                    and row.get("complete", True)
                    and day not in invalid_prices
                }
        evidence_id = manifest["quantity"].get(code)
        evidence = store.ShareEvidence.model_validate(store.read_object(data_dir, evidence_id)) if evidence_id else None
        if evidence is not None and evidence.instrument_id != f"stock:{code}":
            evidence = None
        result[code] = Series(original, prices, evidence, conflicts)
    return result
