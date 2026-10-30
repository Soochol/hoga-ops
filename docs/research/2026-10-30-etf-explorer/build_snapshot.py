"""Build the native ETF explorer from frozen research evidence; no network/store writes."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RESEARCH = HERE.parent
ACTIVE = RESEARCH / "2026-10-30-etf-active-extension"
OUTPUT = ROOT / "frontend/public/etf-explorer/snapshot.json"
INPUTS = [
    ACTIVE / "comparison-etfs.json",
    ACTIVE / "memberships.json",
    RESEARCH / "2026-10-30-etf-breadth/stock-signals.json",
]
EXPECTED_FUNDS = 119
EXPECTED_ACTIVE = 81
EXPECTED_STOCKS = 896
EXPECTED_MEMBERSHIPS = 4937
MAX_WEIGHT_BPS = 10000


def basis_points(value, *, signed=False):
    scaled = Decimal(str(value)) * 100
    if (
        not scaled.is_finite()
        or scaled != scaled.to_integral_value()
        or not (-MAX_WEIGHT_BPS if signed else 0) <= scaled <= MAX_WEIGHT_BPS
    ):
        raise ValueError("Disclosed weights must be nonnegative percentages with at most two decimal places")
    return int(scaled)


def build():
    funds, memberships, signals = [json.loads(path.read_text()) for path in INPUTS]
    states = {s["code"]: [s["periods"][str(p)]["state"] for p in (20, 60, 120)] for s in signals}
    stocks = {}
    grouped = {f["code"]: [] for f in funds}
    for row in memberships:
        code = row["componentItemCode"]
        stock = {"name": row["componentName"], "states": states.get(code)}
        assert code not in stocks or stocks[code] == stock
        stocks[code] = stock
        grouped[row["etf_code"]].append({"code": code, "weightBps": basis_points(row["weight"])})
    exported = []
    for fund in funds:
        holdings = sorted(grouped[fund["code"]], key=lambda r: (-r["weightBps"], r["code"]))
        assert len(holdings) == fund["constituent_count"] == len({h["code"] for h in holdings})
        assert {h["code"] for h in holdings} == set(fund["codes"])
        exported.append(
            {
                "code": fund["code"],
                "name": fund["name"],
                "style": fund["management_style"],
                "issuer": fund["issuer"].replace("(ETF)", ""),
                "benchmark": fund["benchmark"],
                "score": fund["current_score"],
                "status": fund["calculation_status"],
                "issuerMatched": fund["issuer_original_composition_matched"],
                "holdings": holdings,
                "otherAssets": [
                    {
                        "name": a["componentName"],
                        "kind": a["asset_kind"],
                        "weightBps": basis_points(a["weight"], signed=True),
                    }
                    for a in fund["other_noncash_assets"]
                ],
            }
        )
    holding_dates = {f["constituent_reference_date"] for f in funds}
    price_dates = {f["price_as_of"] for f in funds}
    assert len(holding_dates) == len(price_dates) == 1
    assert len(exported) == EXPECTED_FUNDS
    assert sum(f["style"] == "active" for f in exported) == EXPECTED_ACTIVE
    assert len(stocks) == EXPECTED_STOCKS and len(memberships) == EXPECTED_MEMBERSHIPS
    snapshot = {
        "schemaVersion": 1,
        "holdingsAsOf": next(iter(holding_dates)),
        "priceAsOf": next(iter(price_dates)),
        "funds": exported,
        "stocks": stocks,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    validation = {
        "funds": len(exported),
        "active": EXPECTED_ACTIVE,
        "stocks": len(stocks),
        "memberships": len(memberships),
        "sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in INPUTS},
        "output": str(OUTPUT.relative_to(ROOT)),
        "outputSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
    }
    (HERE / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2) + "\n")
    print(f"{OUTPUT.relative_to(ROOT)}: {OUTPUT.stat().st_size:,} bytes; {len(exported)} ETFs / {len(stocks)} stocks")


if __name__ == "__main__":
    build()
