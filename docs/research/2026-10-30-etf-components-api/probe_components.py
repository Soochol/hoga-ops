"""Probe latest public ETF composition responses for the frozen 38 ETF list.

Research evidence only: no broker credentials, server, schedule, price requests,
or production state. One request at a time, at most two request starts per second.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import time
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELECTION = ROOT.parent / "2026-10-30-etf-universe" / "selected.json"
URL = "https://stock.naver.com/api/domestic/detail/{code}/ETFComponent"
REQUIRED = {"itemCode", "componentName", "componentItemCode", "weight", "referenceDate", "componentCount"}


def inspect(code: str, rows: list[dict]) -> dict:
    dates = sorted({str(row.get("referenceDate")) for row in rows})
    counts = sorted({int(row["componentCount"]) for row in rows})
    stock_like = []
    other = []
    weights = []
    for row in rows:
        if not row.keys() >= REQUIRED or row["itemCode"] != code:
            raise ValueError("Missing composition fields or ETF identity mismatch")
        dt.date.fromisoformat(row["referenceDate"])
        weight = Decimal(row["weight"])
        if not weight.is_finite():
            raise ValueError("Non-finite weight")
        weights.append(weight)
        component = row.get("componentItemCode")
        isin = row.get("componentIsinCode") or ""
        # This is a format check, not a security-master certification. A KR7
        # ISIN and a domestic Code can also identify another listed fund.
        if component and re.fullmatch(r"[A-Z0-9]{6}", component) and isin.startswith("KR7"):
            stock_like.append(component)
        else:
            other.append(
                {key: row.get(key) for key in ("componentName", "componentItemCode", "componentIsinCode", "weight")}
            )
    return {
        "row_count": len(rows),
        "declared_counts": counts,
        "declared_count_matches_rows": counts == [len(rows)],
        "reference_dates": dates,
        "single_reference_date": len(dates) == 1,
        "stock_like_rows": len(stock_like),
        "stock_like_unique_codes": len(set(stock_like)),
        "other_rows": other,
        "weight_sum_pct": str(sum(weights)),
        "nonnegative_weights": all(weight >= 0 for weight in weights),
        "full_constituent_coverage_certified": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT)
    output = parser.parse_args().output_dir
    if (output / "probe-results.json").exists() or list((output / "responses").glob("*.json")):
        raise SystemExit("기존 연구 응답을 보존합니다. --output-dir로 새 디렉터리를 지정하세요.")
    selection = json.loads(SELECTION.read_text())
    (output / "responses").mkdir(parents=True, exist_ok=True)
    results = []
    for item in selection:
        code = item["code"]
        url = URL.format(code=code)
        started = time.monotonic()
        result = {"code": code, "name": item["name"], "group_label": item["group_label"], "url": url}
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = response.read()
                result.update(http_status=response.status, content_type=response.headers.get("Content-Type"))
            result["retrieved_at"] = dt.datetime.now(dt.UTC).isoformat()
            result["response_sha256"] = hashlib.sha256(payload).hexdigest()
            result["response_bytes"] = len(payload)
            (output / "responses" / f"{code}.json").write_bytes(payload)
            rows = json.loads(payload)
            if not isinstance(rows, list) or not rows:
                raise ValueError("Expected a nonempty composition list")
            result.update(inspect(code, rows))
            result["status"] = "json_response_verified"
        except (OSError, ValueError, KeyError, TypeError, InvalidOperation) as error:
            result["status"] = "failed"
            result["error"] = f"{type(error).__name__}: {error}"
        results.append(result)
        print(
            f"{code} {result['status']} rows={result.get('row_count')} date={result.get('reference_dates')}", flush=True
        )
        time.sleep(max(0, 0.5 - (time.monotonic() - started)))
    summary = {
        "selection_sha256": hashlib.sha256(SELECTION.read_bytes()).hexdigest(),
        "endpoint_template": URL,
        "authentication_used": False,
        "selected_count": len(selection),
        "success_count": sum(row["status"] == "json_response_verified" for row in results),
        "results": results,
    }
    (output / "probe-results.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"Verified {summary['success_count']}/{len(selection)} ETF responses", flush=True)


if __name__ == "__main__":
    main()
