"""Verify per-code vendor pairs and publish one recoverable Parquet batch."""
from __future__ import annotations

import datetime as dt
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import screener_factors
from hoga.api.screener_store import _DAILY_PL_SCHEMA, derive_adjusted
from hoga.api.screener_write_lock import publish_history, screener_write_lock
from hoga.util.atomic_write import atomic_write_parquet_df

DailyPair = tuple[pl.DataFrame, pl.DataFrame]

def verified_factors(raw: pl.DataFrame, adjusted: pl.DataFrame) -> pl.DataFrame:
    """Validate the actual disk derivation, including volume (not just close ratios)."""
    if raw.is_empty() or set(raw["date"]) != set(adjusted["date"]):
        raise ValueError("vendor_history_incomplete")
    code = raw["code"][0]
    pairs = screener_factors.pair_raw_adj(
        list(zip(raw["date"], raw["close"], strict=True)),
        list(zip(adjusted["date"], adjusted["close"], strict=True)))
    segments = screener_factors.compute_factor_segments(pairs)
    if not segments:
        raise ValueError("factor_unavailable")
    factors = screener_factors.segments_to_frame({code: segments})
    derived = screener_factors.apply_factors(raw, factors).sort("date")
    expected = adjusted.sort("date")
    for actual, target in zip(derived.iter_rows(named=True), expected.iter_rows(named=True), strict=True):
        # Exact volume is necessary: even a small error can move a record date.
        if actual["volume"] != target["volume"]:
            raise ValueError("adjusted_volume_mismatch")
        if any(abs(actual[k] - target[k]) > max(1, abs(target[k]) * .001)
               for k in ("open", "high", "low", "close")):
            raise ValueError("adjusted_price_mismatch")
    return factors


class HistoryCorpusExtended(ValueError):
    """The disk corpus grew outside the fetched pair; retry without holding the lock."""

    def __init__(self, code: str, start: dt.date, end: dt.date):
        super().__init__("history_changed_during_collection")
        self.code, self.start, self.end = code, start, end


@dataclass
class CommitResult:
    written_rows: int = 0
    errors: dict[str, str] = field(default_factory=dict)
    extensions: dict[str, HistoryCorpusExtended] = field(default_factory=dict)


def _verify_code(raw: pl.DataFrame, adjusted: pl.DataFrame, existing: pl.DataFrame):
    if raw.is_empty():
        raise ValueError("vendor_history_incomplete")
    code = raw["code"][0]
    if not existing.is_empty() and (
        existing["date"].min() < raw["date"].min()
        or existing["date"].max() > raw["date"].max()
    ):
        raise HistoryCorpusExtended(code, min(existing["date"].min(), raw["date"].min()),
                                    max(existing["date"].max(), raw["date"].max()))
    # Existing observations win over a vendor correction; disagreement is isolated.
    merged = pl.concat([raw, existing]).unique(subset=["code", "date"], keep="last").sort("date")
    return merged, verified_factors(merged, adjusted)


def _merge_batch(base: pl.DataFrame, factors: pl.DataFrame | None, batch: list[DailyPair],
                 *, existing_adjusted: pl.DataFrame | None = None):
    result = CommitResult()
    codes = [raw["code"][0] for raw, _ in batch]
    # Partition only the selected slice once, rather than scan the corpus per code.
    selected = base.filter(pl.col("code").is_in(codes)).partition_by("code", as_dict=True)
    accepted_raw, accepted_factors, accepted_codes = [], [], []
    for (raw, adjusted), code in zip(batch, codes, strict=True):
        existing = selected.get((code,), base.head(0))
        try:
            if existing_adjusted is None:
                merged, fresh = _verify_code(raw, adjusted, existing)
            else:
                # Gap repair may preserve older observations that differ from a
                # fresh vendor response. Verify the unmodified vendor pair first,
                # then require its factors to reproduce EVERY stored adjusted row.
                # Never relabel an altered vendor frame as verified evidence.
                fresh = verified_factors(raw, adjusted)
                if not existing.is_empty() and (
                    existing["date"].min() < raw["date"].min()
                    or existing["date"].max() > raw["date"].max()
                ):
                    raise ValueError("gap_repair_requires_full_existing_range")
                stored = existing_adjusted.filter(pl.col("code") == code).sort("date")
                derived = screener_factors.apply_factors(existing, fresh).sort("date")
                if not derived.equals(stored.select(derived.columns)):
                    raise ValueError("gap_repair_would_change_existing_adjustment")
                merged = pl.concat([raw, existing]).unique(
                    subset=["code", "date"], keep="last").sort("date")
        except HistoryCorpusExtended as exc:
            result.extensions[code] = exc
            continue
        except ValueError as exc:
            result.errors[code] = str(exc)
            continue
        result.written_rows += merged.height - existing.height
        accepted_codes.append(code)
        accepted_raw.append(merged)
        accepted_factors.append(fresh)
    if not accepted_codes:
        return result, None, None
    # Exactly one full-corpus exclusion and concatenation per successful batch.
    merged = pl.concat([base.filter(~pl.col("code").is_in(accepted_codes)), *accepted_raw])
    kept = (factors.filter(~pl.col("code").is_in(accepted_codes))
            if factors is not None else accepted_factors[0].head(0))
    return result, merged, pl.concat([kept, *accepted_factors])


def commit_verified(data_dir: Path, batch: list[DailyPair]) -> CommitResult:
    """Reject bad codes individually; publication/I/O failures still fail the batch."""
    return _commit(data_dir, batch)


def commit_verified_gaps(data_dir: Path, batch: list[DailyPair]) -> CommitResult:
    """Append verified missing dates while preserving existing raw AND adjusted values.

    Used by explicit gap repair and manual refresh. Fetch outside the lock;
    rejected pairs never alter the stored corpus.
    """
    return _commit(data_dir, batch, gaps_only=True)


def _commit(data_dir: Path, batch: list[DailyPair], *, gaps_only=False) -> CommitResult:
    sdir = data_dir / "screener"
    with screener_write_lock(sdir):
        up, fp = sdir / "daily_unadjusted.parquet", sdir / "factors.parquet"
        base = pl.read_parquet(up) if up.exists() else pl.DataFrame(schema=_DAILY_PL_SCHEMA)
        adjusted = pl.read_parquet(sdir / "daily_adjusted.parquet") if gaps_only else None
        result, merged, factors = _merge_batch(
            base, screener_factors.read_factors(fp), batch, existing_adjusted=adjusted)
        if merged is None:
            return result
        with tempfile.TemporaryDirectory(prefix="history-stage-", dir=sdir) as directory:
            staging = Path(directory)
            atomic_write_parquet_df(staging / up.name, merged.sort(["code", "date"]))
            screener_factors.write_factors(factors, staging / fp.name)
            derive_adjusted(staging / up.name, staging / "daily_adjusted.parquet",
                            factors_path=staging / fp.name, unadjusted_df=merged)
            publish_history(sdir, staging)
        return result


def recover_publication(data_dir: Path):
    with screener_write_lock(data_dir / "screener"):
        pass
