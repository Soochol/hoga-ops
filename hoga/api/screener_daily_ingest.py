"""Append-only daily ingest: provisional samples, historical confirmation and sticky quarantine.

One nightly raw request also rechecks five trading days. This raw-only contract
never certifies quantity history or republishes a v2 adjusted-price observation.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import gzip
import json
import logging
import os
import re
import time
from dataclasses import dataclass

import httpx
import polars as pl

from hoga.api import screener_series_store as series, screener_series_values as values
from hoga.api.screener_daily_confirmation import FINALIZATION_HOUR
from hoga.api.screener_history_jobs import _finish_disk_write
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

RECHECK_DAYS = 5
RECHECK_SECONDS = 2
RETRY_SECONDS = 1800
MAX_DAILY_ATTEMPTS = 2
MAX_PAGES = 2
CODE_PATTERN = re.compile(r"[A-Z0-9]{6}", re.ASCII)
MAX_CATCHUP_CALENDAR_DAYS = 180
FIELDS = ("open", "high", "low", "close", "volume")


@dataclass
class RawSample:
    code: str
    started_at: dt.datetime
    finished_at: dt.datetime
    rows: list[dict]
    provider_rows: list[dict]
    violations: list[dict]
    pages: int = 1

    def payload(self):
        return {
            "kind": "screener_daily_raw_sample",
            "source": "kiwoom:ka10081",
            "venue": "KRX",
            "session_scope": "provider_daily_all_sessions",
            "code": self.code,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "rows": self.rows,
            "provider_rows": self.provider_rows,
            "violations": self.violations,
            "pages": self.pages,
        }


def root(data_dir):
    return data_dir / "screener" / "daily_ingest"


def load(data_dir):
    path = root(data_dir) / "current.json"
    if not path.exists():
        return {"schema_version": 1, "entries": {}, "attempts": {}, "summary": {}, "confirmed_through": {}}
    value = json.loads(path.read_bytes())
    if value.get("schema_version") != 1 or not isinstance(value.get("entries"), dict):
        raise ValueError("Invalid daily ingest state; refusing an unguarded update")
    return value


def same(left, right):
    return all(left.get(k) == right.get(k) for k in FIELDS)


def eligible(day, sample):
    return dt.datetime.fromisoformat(sample["started_at"]) >= dt.datetime.combine(day, dt.time(FINALIZATION_HOUR), KST)


def due(data_dir, now, last_trading_day):
    state = load(data_dir)
    summary = state["summary"]
    date = now.date().isoformat()
    attempts = state["attempts"].get(date, 0)
    if attempts >= MAX_DAILY_ATTEMPTS:
        return False
    if (
        summary.get("last_attempt_at")
        and _unresolved(summary)
        and now.timestamp() - dt.datetime.fromisoformat(summary["last_attempt_at"]).timestamp() < RETRY_SECONDS
    ):
        return False
    if _closed_retry(summary, now):
        return True
    if summary.get("checked_on") == date and not _unresolved(summary):
        return False
    pending = any(e["status"] == "provisional" and e["date"] < date
                  and e["code"] not in summary.get("retired", {}) for e in state["entries"].values())
    return (
        summary.get("last_trading_day") != last_trading_day.replace("-", "")
        or pending
        or _unresolved(summary)
    )


def _unresolved(summary):
    retryable = summary.get("retryable_unavailable_codes", summary.get("unavailable_codes", 0))
    return bool(summary.get("failed_codes") or retryable or summary.get("commit_pending"))


def blocked(state):
    return {
        key: {
            "code": e["code"],
            "date": e["date"],
            "status": e["status"],
            "reason": e.get("reason"),
            "sample_id": e.get("sample_id"),
            "changed_fields": e.get("changed_fields"),
        }
        for key, e in state["entries"].items()
        if e["status"] in {"provisional", "quarantined"}
        or (state["summary"].get("commit_pending") and e["status"] == "confirmed")
    }


def guard_payload(state):
    return {
        "kind": "screener_daily_ingest_guard",
        "policy": "raw_daily_recheck_v1",
        "enabled_from": state.get("enabled_from"),
        "confirmed_through": state.get("confirmed_through", {}),
        "blocked": blocked(state),
    }


def _sample(data_dir, sample):
    value = sample.payload()
    if sample.started_at.tzinfo is None or sample.finished_at.tzinfo is None or sample.started_at > sample.finished_at:
        raise ValueError("Invalid daily sample timestamps")
    dates = [r["date"] for r in sample.rows]
    if len(dates) != len(set(dates)) or any(r["code"] != sample.code for r in sample.rows):
        raise ValueError("Daily sample code/date mismatch")
    _validate_source(sample)
    identity = series.digest(value)
    path = root(data_dir) / "samples" / (identity + ".json.gz")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        # Atomic helper gives interruption-safe immutable evidence without exposing a partial gzip.
        from hoga.util.atomic_write import _atomic_target  # noqa: PLC0415

        with _atomic_target(path) as temporary, temporary.open("wb") as handle:
            handle.write(gzip.compress(json.dumps(value, ensure_ascii=False).encode(), mtime=0))
            handle.flush()
            os.fsync(handle.fileno())
    return identity, value


def observe(state, sample_id, sample, baseline, reviewed):
    """Pure state transition. Early values may settle; closed disagreements remain quarantined."""
    need_recheck = False
    now = dt.datetime.fromisoformat(sample["finished_at"])
    _mark_invalid(state, sample_id, sample, now)
    for row in sample["rows"]:
        day = dt.date.fromisoformat(row["date"])
        if day > now.date():
            raise ValueError("Future daily sample")
        key = f"{sample['code']}:{row['date']}"
        prior = state["entries"].get(key, {})
        expected = baseline.get(key)
        entry = {
            **prior,
            "code": sample["code"],
            "date": row["date"],
            "sample_id": sample_id,
            "candidate": row,
            "status": "provisional",
            "reason": None,
        }
        valid = values.valid_row(row) and not any(
            v.get("date_yyyymmdd") in {None, day.strftime("%Y%m%d")} for v in sample["violations"]
        )
        reference = prior.get("confirmed") or expected
        preserved_legacy = expected is not None and row["date"] < state.get("enabled_from", "9999-12-31")
        if not valid:
            entry.update(status="quarantined", reason="invalid_daily_observation")
        elif key in reviewed and same(reviewed[key], row):
            entry.update(status="legacy", reason="explicit_v2_correction")
        elif prior.get("status") == "quarantined":
            entry.update(status="quarantined", reason=prior["reason"])
        elif reference is not None and not same(reference, row):
            entry.update(status="quarantined", reason="stored_original_changed", preserved=reference)
        elif reference is not None and (preserved_legacy or prior.get("confirmed")):
            entry.update(status=prior.get("status", "legacy"))
        else:
            first = prior.get("eligible_sample")
            if first and not same(first["row"], row):
                entry.update(status="quarantined", reason="closed_observation_changed", preserved=first["row"])
            elif (
                first
                and day < now.date()
                and (
                    dt.datetime.fromisoformat(sample["started_at"]) - dt.datetime.fromisoformat(first["finished_at"])
                ).total_seconds()
                >= RECHECK_SECONDS
            ):
                entry.update(status="confirmed", confirmed=row, confirmation_samples=[first["id"], sample_id])
            elif eligible(day, sample) and first is None:
                entry["eligible_sample"] = {"id": sample_id, "row": row, "finished_at": sample["finished_at"]}
                need_recheck |= day < now.date()
        if entry["status"] == "quarantined":
            entry["changed_fields"] = _changed_fields(entry, row, reference, prior)
            entry.setdefault(
                "conflict_samples", list(dict.fromkeys([v for v in [prior.get("sample_id"), sample_id] if v]))
            )
        state["entries"][key] = entry
    return need_recheck


def references(data_dir, codes, first, last):
    frame = (
        pl.scan_parquet(data_dir / "screener/daily_unadjusted.parquet")
        .filter(pl.col("code").is_in(codes), pl.col("date").is_between(first, last))
        .collect()
    )
    baseline = {f"{r['code']}:{r['date']}": {**r, "date": r["date"].isoformat()} for r in frame.to_dicts()}
    reviewed = {}
    snapshot = series.load_snapshot(data_dir)
    if snapshot:
        manifest = {k: v for k, v in snapshot[1].items() if k != "daily_ingest"}
        selected = [code for code in codes if code in manifest.get("corrections", {})]
        for code, resolved in values.load_series(data_dir, manifest, selected, first=first, last=last).items():
            for day in resolved.corrected:
                reviewed[f"{code}:{day}"] = resolved.original[day]
    return baseline, reviewed


def _publish(data_dir, state):
    from hoga.api.screener_write_lock import screener_write_lock  # noqa: PLC0415

    # Lock is held only for metadata publication, never for broker requests.
    with screener_write_lock(data_dir / "screener"):
        guard = guard_payload(state)
        snapshot = series.load_snapshot(data_dir)
        if snapshot and snapshot[1].get("daily_ingest") != series.digest(guard):
            identity = series._write_object(series.root(data_dir), guard)
            manifest = {**snapshot[1], "daily_ingest": identity, "parent": snapshot[0]}
            sid = series._write_object(series.root(data_dir), manifest)
            atomic_write_json(series.root(data_dir) / "current.json", {"id": sid})
        atomic_write_json(root(data_dir) / "current.json", state)
        atomic_write_json(root(data_dir) / "status.json", state["summary"])


def append_confirmed(data_dir, state):
    """Missing dates only. A concurrent writer can never replace a preserved observation."""
    from hoga.api.screener_daily_ingest_commit import append_confirmed_rows  # noqa: PLC0415

    return append_confirmed_rows(
        data_dir, [e["confirmed"] for e in state["entries"].values() if e["status"] == "confirmed"]
    )


async def run(data_dir, *, codes, days, fetch, now, progress=None, pause=asyncio.sleep):
    from hoga.api.screener_recovery import owner  # noqa: PLC0415 — same cross-process owner as explicit review

    with owner(data_dir):
        return await _run(data_dir, codes=codes, days=days, fetch=fetch, now=now, progress=progress, pause=pause)


async def _run(data_dir, *, codes, days, fetch, now, progress, pause):
    started = time.monotonic()
    state = await asyncio.to_thread(load, data_dir)
    date = now.date().isoformat()
    state.setdefault("enabled_from", date)
    state.setdefault("confirmed_through", {})
    if state["attempts"].get(date, 0) >= MAX_DAILY_ATTEMPTS:
        return 0
    if state["summary"].get("commit_pending"):
        state["attempts"][date] = state["attempts"].get(date, 0) + 1
        state["summary"]["last_attempt_at"] = now.isoformat()
        state["summary"]["attempts_today"] = state["attempts"][date]
        await _finish_disk_write(_publish, data_dir, state)
        return await _commit_pending(data_dir, state)
    state["attempts"] = {date: state["attempts"].get(date, 0) + 1}
    state["summary"].update(
        checked_on=date, last_attempt_at=now.isoformat(), failed_codes=1, attempts_today=state["attempts"][date]
    )
    await _finish_disk_write(_publish, data_dir, state)
    first, last, days = _bounds(state, days)
    baseline, reviewed = await asyncio.to_thread(references, data_dir, codes, first, last)
    from hoga.api import screener_daily_lifecycle as lifecycle  # noqa: PLC0415

    scope, retired, revision = await asyncio.to_thread(lifecycle.scope, data_dir, now)
    state.update(lifecycle_revision=revision, last_window=days)
    samples, failures = {}, {}
    usage = {"provider_pages": 0, "reused_samples": 0, "skipped_codes": 0, "done": 0}
    one = _worker(data_dir, state, now, first, last, codes, fetch, progress, samples, failures, usage, retired)
    first_round = await _collect(one, codes, 0)
    second_codes = []
    for code in first_round:
        if code is not None:
            identity, payload = samples[code, 0]
            if observe(state, identity, payload, baseline, reviewed):
                second_codes.append(code)
    if second_codes:
        # One shared wait, not a two-second sleep per stock. Distinct round keys prevent coalescing.
        latest = max(dt.datetime.fromisoformat(samples[c, 0][1]["finished_at"]) for c in second_codes)
        await pause(max(0, RECHECK_SECONDS - (dt.datetime.now(KST) - latest).total_seconds()))
        second_round = await _collect(one, second_codes, 1)
        for code in second_round:
            if code is not None:
                identity, payload = samples[code, 1]
                observe(state, identity, payload, baseline, reviewed)
    _reject_zero_days(state, samples, failures)
    _finish_state(state, codes, days, samples, failures, now, started, scope, retired)
    state["summary"].update(provider_pages=usage["provider_pages"], reused_samples=usage["reused_samples"],
                            skipped_codes=usage["skipped_codes"])
    await _finish_disk_write(_publish, data_dir, state)
    written = await _commit_pending(data_dir, state)
    if progress:
        progress(len(codes), len(codes))
    return written


def _finish_state(state, codes, days, samples, failures, now, started, scope, retired=None):
    from hoga.api.screener_history_evidence import missing_reasons  # noqa: PLC0415

    date = now.date().isoformat()
    code_set = set(codes)
    retired = {code: why for code, why in (retired or {}).items() if code in code_set}
    unavailable, excluded, missing_details = {}, {}, {}
    # Never call a missing vendor row a suspension or manufacture zero-volume bars.
    for code in codes:
        present = {r["date"] for _, sample in [samples.get((code, 0), (None, {"rows": []}))] for r in sample["rows"]}
        missing = [dt.date.fromisoformat(day) for day in days if day not in present]
        grouped = missing_reasons(missing, scope.get(code))
        excluded_days = {
            str(day): reason
            for reason, dates in grouped.items()
            if reason in {"pre_listing_history", "delisted", "trading_suspended"}
            for day in dates
        }
        if excluded_days:
            excluded[code] = excluded_days
        if missing:
            fact = scope.get(code)
            previous_id = state.get("missing_dates", {}).get(code, {}).get("sample_id")
            missing_details[code] = {
                "dates": {str(day): reason for reason, dates in grouped.items() for day in dates},
                "sources": fact.sources if fact else [],
                "sample_id": samples.get((code, 0), (previous_id,))[0],
            }
        expected_missing = [str(day) for day in missing if str(day) not in excluded_days]
        if expected_missing and code not in failures:
            unavailable[code] = ("retired_history_unavailable" if code in retired
                                 else "provider_daily_dates_unavailable")
        for day in expected_missing:
            key = f"{code}:{day}"
            if day not in present and day >= state["enabled_from"]:
                state["entries"].setdefault(
                    key, {"code": code, "date": day, "status": "provisional", "reason": "daily_observation_unavailable"}
                )
        for day in excluded_days:
            key = f"{code}:{day}"
            if state["entries"].get(key, {}).get("reason") == "daily_observation_unavailable":
                del state["entries"][key]
    state["missing_dates"] = missing_details
    for e in state["entries"].values():
        if e["status"] == "confirmed":
            state["confirmed_through"][e["code"]] = max(e["date"], state["confirmed_through"].get(e["code"], ""))
    cutoff = days[max(0, len(days) - RECHECK_DAYS)]
    state["entries"] = {
        k: e
        for k, e in state["entries"].items()
        if e["date"] >= cutoff or e["status"] in {"quarantined", "provisional"}
    }
    counts = {
        name: sum(e["status"] == name for e in state["entries"].values())
        for name in ("provisional", "confirmed", "quarantined", "legacy")
    }
    state["summary"] = {
        **counts,
        "attempts_today": state["attempts"][date],
        "checked_on": date,
        "last_trading_day": days[-1].replace("-", ""),
        "last_attempt_at": now.isoformat(),
        "failed_codes": len(failures),
        "errors": failures,
        "unavailable_codes": len(unavailable),
        "unavailable": unavailable,
        "retryable_unavailable_codes": len(set(unavailable) - set(retired)),
        "retired_codes": len(retired),
        "retired": retired,
        "skipped_codes": 0,
        "excluded_codes": len(excluded),
        "excluded_dates": sum(len(dates) for dates in excluded.values()),
        "codes": len(codes),
        "sample_count": len(samples),
        "provider_pages": sum(p["pages"] for _, p in samples.values()),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "commit_pending": True,
    }


async def _commit_pending(data_dir, state):
    from hoga.api.screener_daily_ingest_commit import StoredRowConflict  # noqa: PLC0415

    try:
        written = await _finish_disk_write(append_confirmed, data_dir, state)
    except StoredRowConflict as exc:
        for row in exc.rows:
            entry = state["entries"][f"{row['code']}:{row['date']}"]
            entry.update(
                status="quarantined",
                reason="stored_original_changed_during_commit",
                changed_fields=[key for key in FIELDS if row[key] != row[key + "_stored"]],
            )
        for name in ("confirmed", "quarantined"):
            state["summary"][name] = sum(e["status"] == name for e in state["entries"].values())
        await _finish_disk_write(_publish, data_dir, state)
        written = await _finish_disk_write(append_confirmed, data_dir, state)
    state["summary"]["commit_pending"] = False
    await _finish_disk_write(_publish, data_dir, state)
    return written


async def _collect(one, codes, index):
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(one(code, index)) for code in codes]
    return [task.result() for task in tasks]


def _reject_zero_days(state, samples, failures):
    from hoga.api.screener_store import DailyBar, drop_unconfirmed_days  # noqa: PLC0415

    rows = [r for (code, index), (_, sample) in samples.items() if index == 0 for r in sample["rows"]]
    bars = [DailyBar(**{**r, "date": dt.date.fromisoformat(r["date"])}) for r in rows]
    _, rejected = drop_unconfirmed_days(bars)
    for entry in state["entries"].values():
        if dt.date.fromisoformat(entry["date"]) in rejected and entry["status"] != "quarantined":
            entry.update(status="provisional", reason="mass_zero_volume_day")
            entry.pop("eligible_sample", None)
            entry.pop("confirmed", None)
            failures[entry["code"]] = "mass_zero_volume_day"


def _bounds(state, days):
    first, last = dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1])
    pending = [e["date"] for e in state["entries"].values() if e["status"] == "provisional"]
    if pending:
        first = min(first, dt.date.fromisoformat(min(pending)))
    days = sorted(
        set(days)
        | {
            e["date"]
            for e in state["entries"].values()
            if e["status"] == "provisional" and e["date"] <= last.isoformat()
        }
    )
    # A permanently missing old row must not expand every future Code's request without bound.
    floor = last - dt.timedelta(days=MAX_CATCHUP_CALENDAR_DAYS)
    days = [day for day in days if day >= floor.isoformat()]
    return max(first, floor), last, days


def _worker(data_dir, state, now, first, last, codes, fetch, progress, samples, failures, usage, retired=None):
    sem = asyncio.Semaphore(3)
    checkpoint = root(data_dir) / "runs" / now.date().isoformat()
    checkpoint.mkdir(parents=True, exist_ok=True)

    async def one(code, round_index):
        async with sem:
            phase = "closed" if now.hour >= FINALIZATION_HOUR else "early"
            path = checkpoint / f"{code}.{first}.{last}.{phase}.{round_index}.json"
            try:
                if code in (retired or {}):
                    usage["skipped_codes"] += 1
                    return None
                if (path.exists() and code not in state["summary"].get("errors", {})
                        and code not in state["summary"].get("unavailable", {})):
                    value = json.loads(await asyncio.to_thread(path.read_bytes))
                    identity = value["id"]
                    sample_path = root(data_dir) / "samples" / (identity + ".json.gz")
                    payload = json.loads(gzip.decompress(await asyncio.to_thread(sample_path.read_bytes)))
                    usage["reused_samples"] += 1
                    if series.digest(payload) != identity:
                        raise ValueError("Daily checkpoint evidence changed")
                else:
                    result = await fetch(code, first, last, round_index)
                    if result.code != code or any(
                        not first.isoformat() <= r["date"] <= last.isoformat() for r in result.rows
                    ):
                        raise ValueError("Requested daily code/window mismatch")
                    usage["provider_pages"] += result.pages
                    identity, payload = await _finish_disk_write(_sample, data_dir, result)
                    await _finish_disk_write(atomic_write_json, path, {"id": identity})
                samples[code, round_index] = identity, payload
                return code
            except (ValueError, OSError, RuntimeError, httpx.HTTPError) as exc:
                log.debug("daily observation failed for %s", code, exc_info=True)
                failures[code] = type(exc).__name__ + ":" + str(exc)
                return None
            finally:
                if round_index == 0:
                    usage["done"] += 1
                    if progress and (usage["done"] % 20 == 0 or usage["done"] == len(codes)):
                        progress(usage["done"], len(codes))

    return one


def _validate_source(sample):
    if CODE_PATTERN.fullmatch(sample.code) is None:
        raise ValueError("Invalid daily code")
    for violation in sample.violations:
        try:
            dt.datetime.strptime(violation["date_yyyymmdd"], "%Y%m%d")
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Unlocalized invalid daily source row") from exc
    raw = {str(r.get("dt")): r for r in sample.provider_rows}
    if len(raw) != len(sample.provider_rows):
        raise ValueError("Duplicate daily source dates")
    for row in sample.rows:
        original = raw.get(row["date"].replace("-", ""), {})
        for field, source in (("open", "open_pric"), ("high", "high_pric"), ("low", "low_pric"), ("close", "cur_prc")):
            if abs(float(original.get(source, "nan"))) != row[field]:
                raise ValueError("Daily source price missing or inconsistent")
        quantity = str(original.get("trde_qty", "")).strip().lstrip("+-")
        if not quantity.isascii() or not quantity.isdigit() or int(quantity) != row["volume"]:
            raise ValueError("Daily source quantity missing or inconsistent")


def checked_recently(data_dir, now):
    """Small summary gate; scheduler polling never scans the historical corpus."""
    path = root(data_dir) / "status.json"
    if not path.exists():
        return False
    summary = json.loads(path.read_bytes())
    if summary.get("checked_on") != now.date().isoformat():
        return False
    if summary.get("attempts_today", 0) >= MAX_DAILY_ATTEMPTS:
        return True
    if _closed_retry(summary, now):
        return False
    if not _unresolved(summary):
        return True
    return (now.timestamp() - dt.datetime.fromisoformat(summary["last_attempt_at"]).timestamp()) < RETRY_SECONDS


def _mark_invalid(state, sample_id, sample, now):
    for violation in sample["violations"]:
        day = dt.datetime.strptime(violation["date_yyyymmdd"], "%Y%m%d").date()
        if day > now.date():
            raise ValueError("Future daily source violation")
        key = f"{sample['code']}:{day}"
        state["entries"][key] = {
            **state["entries"].get(key, {}),
            "code": sample["code"],
            "date": str(day),
            "sample_id": sample_id,
            "status": "quarantined",
            "reason": "invalid_daily_observation",
        }


def _changed_fields(entry, row, reference, prior):
    preserved = entry.get("preserved") or reference
    changed = {key for key in FIELDS if preserved is None or preserved.get(key) != row.get(key)}
    if entry["reason"] == "invalid_daily_observation":
        changed = set(FIELDS)
    return sorted(changed | set(prior.get("changed_fields", [])))


def _closed_retry(summary, now):
    previous = summary.get("last_attempt_at")
    return bool(
        previous
        and now.hour >= FINALIZATION_HOUR
        and dt.datetime.fromisoformat(previous).hour < FINALIZATION_HOUR
        and summary.get("checked_on") == now.date().isoformat()
    )
