"""Observation harness for the /live cache stats (PR-1 gate data).

PR-1 exposes per-cache hit/miss/eviction counters at ``GET /api/live/status``
(``cache_stats``), but the counters are in-memory and reset on restart — nothing
records them. This module closes that gap: a poller snapshots ``cache_stats`` to
a JSONL over a real session, and a summarizer reads the trail and surfaces the
metrics that gate the deferred cache follow-ups (분봉 디스크 영속 · 워밍 일반화 ·
지표 LRU 사이징 · head-refresh).

Split into pure logic (``make_record`` / ``summarize`` / ``format_report`` —
unit-tested) and thin I/O (``fetch_status`` / ``append_record`` / ``read_records``
/ ``poll_loop`` — driven by the ``hoga cache-observe`` / ``cache-report`` CLI).
Records carry ``started_at_ms`` so the summarizer segments by process lifetime:
counters are cumulative within a run and reset across restarts, so a run's final
``minute_backfill.fresh_past_fetches`` IS that session's KIS cold re-spend — the
headline gate for disk persistence.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

STATUS_PATH = "/api/live/status"
DEFAULT_INTERVAL_S = 300.0


# ── pure logic ──────────────────────────────────────────────────────────────

def make_record(status: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    """One JSONL record from a /api/live/status response. Keeps only the fields
    the summarizer needs so the trail stays small over a multi-day session."""
    return {
        "wall_ms": wall_ms,
        "started_at_ms": status.get("started_at_ms"),
        "cache_stats": status.get("cache_stats") or {},
    }


def _ratio(numerator: float, denominator: float) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _lifetimes(records: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split records into per-process runs, keyed by started_at_ms. A None start
    (server without a live session) is treated as its own run. Order preserved;
    a new run begins whenever started_at_ms changes."""
    runs: list[list[dict[str, Any]]] = []
    prev: object = object()  # sentinel distinct from any started_at_ms (incl. None)
    for rec in records:
        start = rec.get("started_at_ms")
        if start != prev or not runs:
            runs.append([])
            prev = start
        runs[-1].append(rec)
    return runs


def _indicator_kind_summary(kind_stats: dict[str, Any]) -> dict[str, Any]:
    hits = kind_stats.get("hits") or 0
    disk_hits = kind_stats.get("disk_hits") or 0
    return {
        "hit_rate": kind_stats.get("hit_rate"),
        "lookups": kind_stats.get("lookups") or 0,
        "misses": kind_stats.get("misses") or 0,
        # disk_hits / hits = fraction served from disk after a memory-LRU miss.
        # High → the LRU is too small for this kind (gate for 5-way sizing).
        "disk_ratio": _ratio(disk_hits, hits),
    }


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce a JSONL trail to the follow-up gate metrics.

    Returns per-process-lifetime cold re-spend, plus the latest snapshot's cache
    hit rates and per-indicator-kind LRU churn. Empty trail → empty report."""
    if not records:
        return {"records": 0, "lifetimes": 0, "runs": [], "latest": None}

    runs = _lifetimes(records)
    run_summaries: list[dict[str, Any]] = []
    for run in runs:
        last = run[-1]
        cs = last.get("cache_stats") or {}
        backfill = cs.get("minute_backfill") or {}
        run_summaries.append({
            "started_at_ms": last.get("started_at_ms"),
            "samples": len(run),
            # Cumulative within a run → the last sample is the session peak.
            "fresh_past_fetches": backfill.get("fresh_past_fetches") or 0,
            "fresh_past_fetch_errors": backfill.get("fresh_past_fetch_errors") or 0,
        })

    latest_cs = records[-1].get("cache_stats") or {}
    latest: dict[str, Any] = {}

    for name in ("past_candles", "past_daily_candles", "investor_net_daily"):
        node = latest_cs.get(name)
        if isinstance(node, dict):
            latest[name] = {
                horizon: {"hit_rate": h.get("hit_rate"), "lookups": h.get("lookups") or 0}
                for horizon, h in node.items()
                if isinstance(h, dict)
            }

    for name in ("index_candles", "index_minute_candles", "today_ttl"):
        node = latest_cs.get(name)
        if isinstance(node, dict):
            latest[name] = {"hit_rate": node.get("hit_rate"), "lookups": node.get("lookups") or 0}

    indicators = latest_cs.get("past_indicators")
    if isinstance(indicators, dict):
        latest["past_indicators"] = {
            kind: _indicator_kind_summary(ks)
            for kind, ks in indicators.items()
            if isinstance(ks, dict)
        }

    return {
        "records": len(records),
        "lifetimes": len(runs),
        "runs": run_summaries,
        # Headline: worst-case session KIS cold re-spend seen across restarts.
        "max_fresh_past_fetches": max((r["fresh_past_fetches"] for r in run_summaries), default=0),
        "latest": latest,
    }


def format_report(report: dict[str, Any]) -> str:
    """Human-readable summary + which follow-up each number gates."""
    if not report.get("records"):
        return "no records yet — run `hoga cache-observe` against a live server first."

    lines: list[str] = []
    lines.append(f"samples={report['records']}  lifetimes={report['lifetimes']}")
    lines.append("")
    lines.append("■ 분봉 디스크 영속 게이트 — 세션별 KIS cold 재지출 (fresh_past_fetches)")
    for i, run in enumerate(report["runs"], 1):
        errs = run["fresh_past_fetch_errors"]
        suffix = f", errors={errs}" if errs else ""
        lines.append(
            f"    run {i}: {run['fresh_past_fetches']} fetches "
            f"({run['samples']} samples{suffix})"
        )
    lines.append(f"    → worst session: {report['max_fresh_past_fetches']} — 높을수록 영속 ROI↑")

    latest = report.get("latest") or {}
    ind = latest.get("past_indicators")
    if ind:
        lines.append("")
        lines.append("■ 지표 LRU 사이징 / 워밍 게이트 — 종류별 hit_rate · disk_ratio(=LRU churn)")
        for kind, s in ind.items():
            lines.append(
                f"    {kind:10s} hit_rate={s['hit_rate']}  disk_ratio={s['disk_ratio']}  "
                f"lookups={s['lookups']}  misses={s['misses']}"
            )
        lines.append("    → disk_ratio 높은 종류 = 그 종류 LRU 상한↑; miss율 높으면 워밍 착수")

    simple = {k: latest[k] for k in ("past_candles", "index_minute_candles") if k in latest}
    if simple:
        lines.append("")
        lines.append("■ 분봉/지수 캐시 효과 — 재방문 head-refresh 참고")
        for name, node in simple.items():
            if "hit_rate" in node:  # flat cache
                lines.append(f"    {name}: hit_rate={node['hit_rate']} lookups={node['lookups']}")
            else:  # horizon-split
                inner = "  ".join(f"{h}={v['hit_rate']}({v['lookups']})" for h, v in node.items())
                lines.append(f"    {name}: {inner}")
    return "\n".join(lines)


# ── I/O ─────────────────────────────────────────────────────────────────────

def fetch_status(base_url: str, *, timeout_s: float = 5.0) -> dict[str, Any]:
    """GET {base_url}/api/live/status via urllib (curl flakes in this env)."""
    url = base_url.rstrip("/") + STATUS_PATH
    with urllib.request.urlopen(url, timeout=timeout_s) as resp:  # noqa: S310 (localhost ops tool)
        return json.loads(resp.read().decode("utf-8"))


def append_record(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line:
            out.append(json.loads(line))
    return out


def poll_loop(
    base_url: str,
    out_path: Path,
    *,
    interval_s: float = DEFAULT_INTERVAL_S,
    count: int | None = None,
    on_sample=None,
    sleep=time.sleep,
    now_ms=lambda: int(time.time() * 1000),
) -> int:
    """Poll status → append a record every interval, until `count` samples (or
    forever if None / KeyboardInterrupt). A failed fetch is logged via
    `on_sample` and skipped — a transient server hiccup must not kill the poll.
    Returns the number of records written."""
    written = 0
    while count is None or written < count:
        try:
            status = fetch_status(base_url)
            record = make_record(status, now_ms())
            append_record(out_path, record)
            written += 1
            if on_sample is not None:
                on_sample(record, None)
        except (urllib.error.URLError, OSError, ValueError) as e:
            if on_sample is not None:
                on_sample(None, e)
        if count is not None and written >= count:
            break
        try:
            sleep(interval_s)
        except KeyboardInterrupt:
            break
    return written
