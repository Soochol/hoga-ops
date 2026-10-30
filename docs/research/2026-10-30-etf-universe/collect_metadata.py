"""Capture public ETF descriptions for the research shortlist, without holdings.

Run explicitly from this directory. This does not read app settings, credentials,
or production data. Requests are bounded to two starts per second and four in
flight. Saved successful observations are reused on a resumed run.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import hashlib
import json
import re
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
RATE_STATE = {"next_start": 0.0}
DOMESTIC_THEME_CATEGORY = 2
EXCLUDE = re.compile(r"레버리지|인버스|커버드콜|채권|미국|일본|차이나|글로벌|인도|합성|롱.*숏|리츠|부동산|액티브")
CACHE_PATH = ROOT / "fund-metadata.json"
CACHE = json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else {}


def collect(row):
    code = row["itemcode"]
    if code in CACHE and CACHE[code].get("stock_end_type") == "etf":
        return code, "reused"
    path = ROOT / "metadata" / f"{code}.json"
    if path.exists():
        saved = json.loads(path.read_text())
        if saved.get("item_code") == code and saved.get("stock_end_type") == "etf":
            return code, "reused"
    with LOCK:
        start = max(time.monotonic(), RATE_STATE["next_start"])
        RATE_STATE["next_start"] = start + 0.5
    time.sleep(max(0.0, start - time.monotonic()))
    url = f"https://m.stock.naver.com/api/stock/{code}/integration"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = response.read()
        data = json.loads(payload)
        if data.get("itemCode") != code or data.get("stockEndType") != "etf":
            raise ValueError("ETF identity mismatch")
        # This endpoint has descriptions and indicators; component/holdings
        # endpoints are intentionally outside the current research scope.
        result = {
            "source_url": url,
            "retrieved_at": dt.datetime.now(dt.UTC).isoformat(),
            "source_response_sha256": hashlib.sha256(payload).hexdigest(),
            "item_code": code,
            "stock_end_type": data["stockEndType"],
            "name": data.get("stockName"),
            "description": data.get("description"),
            "total_infos": data.get("totalInfos", []),
            "etf_key_indicator": data.get("etfKeyIndicator"),
            "projection": True,
        }
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return code, "saved"
    except (OSError, ValueError, KeyError, TypeError) as error:
        return code, f"error: {type(error).__name__}: {error}"


def main():
    all_rows = json.loads((ROOT / "naver-etf-response.json").read_text())["result"]["etfItemList"]
    rows = [
        row for row in all_rows if row["etfTabCode"] == DOMESTIC_THEME_CATEGORY and not EXCLUDE.search(row["itemname"])
    ]
    outcomes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for number, outcome in enumerate(pool.map(collect, rows), 1):
            outcomes.append({"code": outcome[0], "status": outcome[1]})
            if number % 25 == 0 or outcome[1].startswith("error"):
                print(f"{number}/{len(rows)} {outcome}", flush=True)
    (ROOT / "metadata-collection.json").write_text(json.dumps(outcomes, ensure_ascii=False, indent=2) + "\n")
    merged = dict(CACHE)
    for path in sorted((ROOT / "metadata").glob("*.json")):
        item = json.loads(path.read_text())
        merged[item["item_code"]] = item
    CACHE_PATH.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
    # Compact the temporary per-Code cache only after its durable bundle exists.
    for path in (ROOT / "metadata").glob("*.json"):
        if path.stem in merged:
            path.unlink()
    if (ROOT / "metadata").exists() and not any((ROOT / "metadata").iterdir()):
        (ROOT / "metadata").rmdir()
    print(
        f"Completed {len(rows)} descriptions; failures: {sum(r['status'].startswith('error') for r in outcomes)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
