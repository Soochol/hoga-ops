"""Tests for scripts/repromote_kis_live.py.

The script's job: for each JSONL under live/{date}/ OR live/_archive/{date}/,
delete the existing kis_live parquet dir and call promote_one again so it
re-encodes ts_ms with the ADR-0049 contract.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import polars as pl
import pytest

from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "repromote_kis_live.py"


def _load_script_module() -> Any:
    spec = importlib.util.spec_from_file_location("repromote_kis_live", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["repromote_kis_live"] = module
    spec.loader.exec_module(module)
    return module


def _seed_jsonl(path: Path, code: str, date: str, *, unix_ms: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        "t_ms": unix_ms,
        "kind": "ob",
        "payload": {"code": code, "t_ms": unix_ms,
                    "bids": [], "asks": [],
                    "total_bid_qty": 0, "total_ask_qty": 0},
    })
    path.write_text(line + "\n")


def _seed_corrupt_parquet(target_dir: Path, code: str, date: str) -> None:
    """Pre-existing kis_live dir with the OLD (corrupted) encoding — Unix ms in ts_ms."""
    target_dir.mkdir(parents=True, exist_ok=True)
    row: dict[str, Any] = {"ts_ms": 1779931845123, "phase": "regular"}
    for i in range(1, 11):
        row[f"bid_p{i}"] = 0
        row[f"bid_q{i}"] = 0
        row[f"ask_p{i}"] = 0
        row[f"ask_q{i}"] = 0
    row["total_bid_qty"] = 0
    row["total_ask_qty"] = 0
    pl.DataFrame([row]).write_parquet(target_dir / "snapshots.parquet")
    pl.DataFrame({"ts_ms": pl.Series([], dtype=pl.Int64)}).write_parquet(
        target_dir / "trades.parquet"
    )
    (target_dir / "meta.json").write_text(json.dumps({
        "source": "kis_live", "code": code, "date": date,
        "row_counts": {"snapshots": 1, "trades": 0, "brokers": 0},
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }))


def test_repromote_uses_live_jsonl_when_present(tmp_path: Path) -> None:
    """Live/{date}/{code}.jsonl present → delete kis_live dir + re-promote from it."""
    date = "20260527"
    code = "005930"
    unix_ms = hhmmssms_to_unix_ms(date, 90000000)  # 2026-05-27 09:00:00 KST
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"
    live_dir = data_dir / "live"

    _seed_corrupt_parquet(parquet_root / date / code / "kis_live", code, date)
    _seed_jsonl(live_dir / date / f"{code}.jsonl", code, date, unix_ms=unix_ms)

    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))

    # Re-promoted parquet must use HHMMSSmmm encoding (90000000 = 09:00:00.000).
    df = pl.read_parquet(parquet_root / date / code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms), (
        "re-promoted parquet must honor ADR-0049 encoding contract"
    )


def test_repromote_falls_back_to_archive_when_live_jsonl_missing(tmp_path: Path) -> None:
    """live/_archive/{date}/{code}.jsonl is used when live/{date}/ has no JSONL."""
    date = "20260527"
    code = "005930"
    unix_ms = hhmmssms_to_unix_ms(date, 90000000)
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"
    archive_dir = data_dir / "live" / "_archive"

    _seed_corrupt_parquet(parquet_root / date / code / "kis_live", code, date)
    _seed_jsonl(archive_dir / date / f"{code}.jsonl", code, date, unix_ms=unix_ms)

    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))

    df = pl.read_parquet(parquet_root / date / code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms)


def test_repromote_reports_skip_when_no_jsonl_anywhere(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Neither live/{date}/ nor _archive has the JSONL → report and continue."""
    date = "20260527"
    code = "005930"
    data_dir = tmp_path
    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))
    captured = capsys.readouterr()
    assert "no JSONL" in captured.out or "skip" in captured.out


def test_repromote_continues_on_single_code_failure(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One bad code's promote_one failure must not abort the batch."""
    date = "20260527"
    good_code = "005930"
    bad_code = "000660"
    unix_ms = hhmmssms_to_unix_ms(date, 90000000)
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"

    _seed_corrupt_parquet(parquet_root / date / good_code / "kis_live", good_code, date)
    _seed_jsonl(
        data_dir / "live" / date / f"{good_code}.jsonl",
        good_code, date, unix_ms=unix_ms,
    )
    _seed_jsonl(
        data_dir / "live" / date / f"{bad_code}.jsonl",
        bad_code, date, unix_ms=unix_ms,
    )

    mod = _load_script_module()
    real_promote = mod.promote_one

    async def patched(*args: Any, **kw: Any) -> None:
        if kw.get("code") == bad_code:
            raise RuntimeError("simulated promote_one failure")
        await real_promote(*args, **kw)

    monkeypatch.setattr(mod, "promote_one", patched)

    with pytest.raises(SystemExit) as excinfo:
        asyncio.run(mod.repromote(data_dir, date=date, code=None))
    assert excinfo.value.code == 1

    captured = capsys.readouterr()
    assert "FAILED" in captured.out
    assert bad_code in captured.out
    assert "recovered=1" in captured.out
    df = pl.read_parquet(
        parquet_root / date / good_code / "kis_live" / "snapshots.parquet"
    )
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms)
