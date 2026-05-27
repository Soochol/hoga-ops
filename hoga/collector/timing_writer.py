"""Atomic JSON persistence for TimingReport.

Layout: <data_dir>/timing/<date>/<code>.json
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from hoga.api.models import TimingReport


def write_timing_report(data_dir: Path, report: TimingReport) -> Path:
    out_dir = data_dir / "timing" / report.summary.date
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{report.summary.code}.json"

    payload = report.model_dump_json()
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        delete=False,
        dir=out_dir,
        prefix=f".{report.summary.code}.",
        suffix=".tmp",
    ) as fh:
        fh.write(payload)
        tmp_name = fh.name
    os.replace(tmp_name, out_path)
    return out_path
