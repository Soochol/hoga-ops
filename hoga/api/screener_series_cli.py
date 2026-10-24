"""Offline import and comparison. No authentication or provider requests.

python -m hoga.api.screener_series_cli --help
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import shutil
import time
from collections import Counter
from pathlib import Path

from hoga.api import screener_series_store as store
from hoga.api.models import ScanRequest
from hoga.api.screener_runner import run_screener_scan
from hoga.api.screener_series_execution import code_revision, replay_execution, saved_response
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST


def fingerprints(data_dir):
    return {
        name: hashlib.sha256(path.read_bytes()).hexdigest()
        for name in store._BASE_FILES
        if (path := data_dir / "screener" / name).exists()
    }


def clone(source: Path, destination: Path):
    if destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("검증 복사본은 원본 데이터 디렉터리 밖에 만들어야 합니다")
    if destination.exists():
        raise ValueError("검증 복사본의 목적지는 새 디렉터리여야 합니다")
    sdir = source / "screener"
    # No recovery side effects on production: only lock an already existing file.
    with (sdir / ".writer.lock").open("rb") as handle:
        fcntl.flock(handle, fcntl.LOCK_SH)
        try:
            if (sdir / "history_publish.json").exists():
                raise ValueError("원본에 미완료 공개가 있어 읽기 전용 복사를 보류합니다")
            before = fingerprints(source)
            (destination / "screener").mkdir(parents=True)
            for name in before:
                shutil.copyfile(sdir / name, destination / "screener" / name)
            for name in ("calendar", "watchlist.json", "heatmap.json"):
                path = source / name
                if path.is_dir():
                    shutil.copytree(path, destination / name)
                elif path.is_file():
                    shutil.copyfile(path, destination / name)
            if fingerprints(destination) != before or fingerprints(source) != before:
                raise ValueError("복사 중 입력 지문이 달라졌습니다")
            atomic_write_json(destination / "validation-source.json", {"source": str(source), "files": before})
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    return before


def _request(request, policy, volume_basis=None):
    body = request.model_dump(mode="json")
    body.update(calculation_policy=policy, basis="eod", snapshot_id=None)
    for leaf in body["conditions"]:
        if leaf["type"] in {"new_high_vol", "new_high_vol_today"}:
            leaf["params"].pop("volume_basis", None)
            if volume_basis:
                leaf["params"]["volume_basis"] = (
                    "raw" if leaf["params"].get("timeframe", "D").endswith("m") else volume_basis
                )
    return ScanRequest.model_validate(body)


async def compare(data_dir, request, now):
    if not (data_dir / "validation-source.json").exists():
        raise ValueError("compare는 clone으로 만든 별도 데이터 복사본에서만 실행합니다")
    before = fingerprints(data_dir)
    results, durations = {}, {}
    for label, policy, volume in (
        ("legacy", "legacy_v1", None),
        ("raw", "separate_bases_v2", "raw"),
        ("share_adjusted", "separate_bases_v2", "share_adjusted"),
    ):
        started = time.perf_counter()
        results[label] = await run_screener_scan(data_dir=data_dir, req=_request(request, policy, volume), now=now)
        durations[label] = round(time.perf_counter() - started, 3)
    repeated = await run_screener_scan(data_dir=data_dir, req=_request(request, "legacy_v1"), now=now)
    unchanged = results["legacy"].rows == repeated.rows and results["legacy"].has_more == repeated.has_more
    matched = {label: {row.code for row in result.rows} for label, result in results.items()}
    unavailable = {}
    for label, result in results.items():
        unavailable[label] = {
            item.code
            for coverage in (result.bar_coverage, result.history_coverage)
            if coverage is not None
            for item in coverage.incomplete
        }
    codes = set().union(*matched.values(), *unavailable.values())
    differences = [
        {
            "code": code,
            "old_match": code in matched["legacy"],
            "raw_match": code in matched["raw"],
            "share_match": code in matched["share_adjusted"],
            "legacy_vs_raw": (
                "history_unavailable"
                if code in unavailable["legacy"] | unavailable["raw"]
                else "unchanged"
                if (code in matched["legacy"]) == (code in matched["raw"])
                else "basis_change_requires_review"
            ),
            "classification": "history_unavailable"
            if any(code in value for value in unavailable.values())
            else "unchanged"
            if len({code in value for value in matched.values()}) == 1
            else "basis_change_requires_review",
        }
        for code in sorted(codes)
    ]
    source = json.loads((data_dir / "validation-source.json").read_text())
    source_unchanged = fingerprints(Path(source["source"])) == source["files"]
    preserved = before == fingerprints(data_dir) and source_unchanged and unchanged
    return {
        "schema_version": 1,
        "code_revision": code_revision(),
        "at": now.isoformat(),
        "inputs": request.model_dump(mode="json"),
        "legacy_fingerprints": before,
        "preserved": preserved,
        "source_unchanged": source_unchanged,
        "legacy_results_unchanged": unchanged,
        "seconds": durations,
        "matched": {label: sorted(value) for label, value in matched.items()},
        "classifications": dict(Counter(row["classification"] for row in differences)),
        "differences": differences,
        "results": {label: response.model_dump(mode="json") for label, response in results.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["clone", "baseline", "import-pair", "import-evidence", "compare", "read", "replay"]
    )
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--at", help="YYYY-MM-DDTHH:MM:SS+09:00")
    parser.add_argument("--execution-id")
    args = parser.parse_args()
    result = _run(args)
    if args.output:
        atomic_write_json(args.output, result)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def _run(args):
    import datetime as dt  # noqa: PLC0415 — CLI-only parsing

    if args.command == "clone":
        if args.source is None:
            raise ValueError("--source가 필요합니다")
        return clone(args.source, args.data_dir)
    if args.command == "baseline":
        return {"baseline_id": store.ensure_baseline(args.data_dir)}
    if args.command in {"read", "replay"}:
        response = (
            saved_response(args.data_dir, args.execution_id)
            if args.command == "read"
            else asyncio.run(replay_execution(args.data_dir, args.execution_id))
        )
        return response.model_dump(mode="json")
    if args.input is None:
        raise ValueError("--input이 필요합니다")
    data = json.loads(args.input.read_text())
    if args.command == "import-evidence":
        return {"snapshot_id": store.publish_share_evidence(args.data_dir, store.ShareEvidence.model_validate(data))}
    if args.command == "import-pair":
        return {"snapshot_id": store.publish_pair(args.data_dir, **data)}
    now = dt.datetime.fromisoformat(args.at) if args.at else dt.datetime.now(KST)
    return asyncio.run(compare(args.data_dir, ScanRequest.model_validate(data), now))


if __name__ == "__main__":
    main()
