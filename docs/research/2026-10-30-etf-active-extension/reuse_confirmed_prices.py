"""Reuse additional confirmed prices from the already frozen research snapshot.

Offline resolver reads only. No broker client, token, provider call or publication.
Run with the production interpreter from its checkout to use its resolver version.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_series_store as store,
    screener_series_values as values,
)

HERE = Path(__file__).resolve().parent
DATA = Path.home() / ".local/share/hoga-ops/data"


def main():
    source = json.loads((HERE.parent / "2026-10-30-etf-breadth-history/after-snapshot.json").read_text())
    snapshot, manifest = store.load_snapshot(DATA, source["id"])
    assert manifest == source["manifest"] and manifest["adjusted_as_of"] == "2026-10-30"
    master = {r["code"]: r for r in json.loads((HERE / "security-master.json").read_text())["entries"]}
    base = {
        r["code"] for r in json.loads((HERE.parent / "2026-10-30-etf-constituent-validation/universe.json").read_text())
    }
    candidates = set()
    for file in (HERE / "raw/components").glob("*.json"):
        for row in json.loads(file.read_bytes()):
            code = row.get("componentItemCode")
            if master.get(code, {}).get("security_type") == "stock" and code not in base:
                candidates.add(code)
    codes = sorted(candidates & manifest["observations"].keys())
    chosen, ledger = [], []
    for code in codes:
        identity = manifest["observations"][code]
        observation = store.current_observation(DATA, store.read_object(DATA, identity))
        if confirmation.state(observation) == "confirmed" and observation["adjusted_as_of"] == "2026-10-30":
            chosen.append(code)
            ledger.append({"code": code, "observation_id": identity, "confirmation_state": "confirmed"})
    rows = []
    for offset in range(0, len(chosen), 20):
        found = values.load_series(
            DATA, manifest, chosen[offset : offset + 20], first=dt.date(2018, 1, 2), last=dt.date(2026, 10, 29)
        )
        rows.extend(
            {"code": code, "date": day, **{key: price[key] for key in ("open", "high", "low", "close")}}
            for code, item in found.items()
            for day, price in item.prices.items()
        )
    if rows:
        pl.DataFrame(rows).sort(["code", "date"]).write_parquet(HERE / "additional-confirmed-prices.parquet")
    record = {
        "source_snapshot": snapshot,
        "adjusted_as_of": "2026-10-30",
        "codes": chosen,
        "rows": len(rows),
        "observations": ledger,
        "provider_requests": 0,
        "production_writes": 0,
    }
    (HERE / "reused-price-observations.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"reused_codes": len(chosen), "rows": len(rows), "snapshot": snapshot}))


if __name__ == "__main__":
    main()
