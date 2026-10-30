"""Capture public active-ETF discovery, descriptions and latest compositions.

No credentials or production writes. Existing captured bytes are reused and
hash-checked; requests are serial with at least 0.5 s between request starts.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIST_URL = "https://finance.naver.com/api/sise/etfItemList.nhn"
MAX_REQUEST_STARTS_PER_SECOND = 2
PUBLIC_HEADERS = {"User-Agent": "Mozilla/5.0"}
rate_state = {"last_start": 0.0}
manifest_path = HERE / "public-captures.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def capture(url, relative):
    path = HERE / relative
    if path.exists():
        record = manifest[relative]
        payload = path.read_bytes()
        assert record["url"] == url and hashlib.sha256(payload).hexdigest() == record["sha256"]
        return json.loads(payload.decode(record["encoding"]))
    time.sleep(max(0, rate_state["last_start"] + 1 / MAX_REQUEST_STARTS_PER_SECOND - time.monotonic()))
    rate_state["last_start"] = time.monotonic()
    request = urllib.request.Request(url, headers=PUBLIC_HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()
        encoding = response.headers.get_content_charset() or "utf-8"
        status = response.status
    data = json.loads(payload.decode(encoding))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    manifest[relative] = {
        "url": url,
        "retrieved_at": dt.datetime.now(dt.UTC).isoformat(),
        "http_status": status,
        "encoding": encoding,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }
    save("public-captures.json", manifest)
    return data


def collect():
    listing = capture(LIST_URL, "raw/etf-list.json")["result"]["etfItemList"]
    assert len({r["itemcode"] for r in listing}) == len(listing)
    assert all(re.fullmatch(r"[A-Z0-9]{6}", r["itemcode"]) for r in listing)
    active = [r for r in listing if "액티브" in r["itemname"]]
    save("active-discovery.json", active)
    candidates = [r for r in active if r["etfTabCode"] in {1, 2}]
    save("domestic-category-candidates.json", candidates)
    outcomes = []
    for index, row in enumerate(candidates, 1):
        code = row["itemcode"]
        result = {"code": code, "name": row["itemname"], "source_category_code": row["etfTabCode"]}
        try:
            meta = capture(f"https://m.stock.naver.com/api/stock/{code}/integration", f"raw/metadata/{code}.json")
            assert meta["itemCode"] == code and meta["stockEndType"] == "etf"
            holdings = capture(
                f"https://stock.naver.com/api/domestic/detail/{code}/ETFComponent", f"raw/components/{code}.json"
            )
            assert isinstance(holdings, list) and holdings
            assert all(r["itemCode"] == code and int(r["componentCount"]) == len(holdings) for r in holdings)
            assert len({r["referenceDate"] for r in holdings}) == 1
            result.update(status="captured", reference_date=holdings[0]["referenceDate"], rows=len(holdings))
        except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
            result.update(status="failed", error=f"{type(error).__name__}: {error}")
        outcomes.append(result)
        save("capture-outcomes.json", outcomes)
        if index % 10 == 0 or result["status"] == "failed":
            print(index, "/", len(candidates), code, result["status"], flush=True)
    print(
        "etfs",
        len(listing),
        "active-name",
        len(active),
        "category-1-or-2",
        len(candidates),
        "captured",
        sum(r["status"] == "captured" for r in outcomes),
        flush=True,
    )


if __name__ == "__main__":
    collect()
