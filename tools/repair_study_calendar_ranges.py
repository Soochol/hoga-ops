"""Restore calendar saves collapsed by the old hogaplay retention clamp.

Dry run: uv run python -m tools.repair_study_calendar_ranges
Apply:   uv run python -m tools.repair_study_calendar_ranges --apply --backup /absolute/path/saves-before.json

Uses the running server's existing GET/PUT API, including its mutation lock and
broadcast. No server restart or direct data-file edits. Affected rows must have
an explicit wider viewport, an exact one-candle range at its right edge, and
that entire viewport must predate the two-year cutoff at creation. No guessed
left edges. IDs, groups, names, memo, tags, viewport and creation time survive;
the normal update API advances updated_at_ms. The full original list is backed
up before any update. Re-running skips already repaired rows.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from hoga.api.models import StudyViewReference, StudyViewReferenceWriteRequest, StudyViewsFile

KST = ZoneInfo("Asia/Seoul")


def repaired_request(row: StudyViewReference) -> StudyViewReferenceWriteRequest | None:
    left, right = row.viewport.left_edge_ms, row.viewport.right_edge_ms
    if row.timeframe not in {"D", "W", "M"} or left is None or left >= right or row.viewport.bar_span <= 1:
        return None
    if row.range.from_ms != right or row.range.to_ms != right:
        return None
    created = datetime.fromtimestamp(row.created_at_ms / 1000, KST)
    cutoff = created.replace(year=created.year - 2, day=28 if created.strftime("%m%d") == "0229" else created.day)
    start, end = (datetime.fromtimestamp(ms / 1000, KST).strftime("%Y%m%d") for ms in (left, right))
    if start >= end or end >= cutoff.strftime("%Y%m%d") or row.range.from_date != end or row.range.to_date != end:
        return None
    return StudyViewReferenceWriteRequest.model_validate({
        **row.model_dump(),
        "range": {"from_date": start, "to_date": end, "from_ms": left, "to_ms": right},
    })


def api_json(method: str, url: str, payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode()
    req = Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def repair(base_url: str, *, apply: bool = False, backup: Path | None = None) -> dict:
    endpoint = base_url.rstrip("/") + "/api/study-views/saves"
    original = api_json("GET", endpoint)
    file = StudyViewsFile.model_validate(original)
    plan = [(row, req) for row in file.saves if (req := repaired_request(row)) is not None]
    report = {"scanned": len(file.saves), "candidates": len(plan), "applied": 0,
              "changes": [{"id": row.id, "before": row.range.model_dump(), "after": req.range.model_dump()}
                          for row, req in plan]}
    if not apply or not plan:
        return report
    if backup is None:
        raise ValueError("--apply requires --backup")
    backup.parent.mkdir(parents=True, exist_ok=True)
    with backup.open("x", encoding="utf-8") as stream:
        json.dump(original, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    originals = {row["id"]: row for row in original["saves"]}
    # The normal PUT updates modification time; bottom-to-top preserves the
    # affected rows' existing relative order in the server's newest-first list.
    for row, req in reversed(plan):
        url = endpoint + "/" + quote(row.id, safe="")
        if api_json("GET", url) != originals[row.id]:
            raise ValueError(f"저장뷰가 변경되었습니다 · 재조회 후 다시 실행하세요: {row.id}")
        payload = req.model_dump(mode="json")
        updated = api_json("PUT", url, payload)
        preserved = ("group_id", "name", "code", "label", "timeframe", "viewport", "memo", "tags", "range")
        if (any(updated[key] != payload[key] for key in preserved)
                or updated["id"] != row.id or updated["created_at_ms"] != row.created_at_ms):
            raise ValueError(f"저장뷰 복구 결과를 확인할 수 없습니다: {row.id}")
        report["applied"] += 1
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    if args.apply and args.backup is None:
        parser.error("--apply requires --backup")
    print(json.dumps(repair(args.base_url, apply=args.apply, backup=args.backup), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
