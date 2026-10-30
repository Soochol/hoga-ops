"""Register reviewed domestic active ETFs and calculate explicit readiness.

Offline: only frozen public responses, the captured master and confirmed prices.
Existing baseline ETF selections, prices and aggregate scores are never edited.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
from collections import Counter
from decimal import Decimal
from pathlib import Path

import numpy as np
import polars as pl

from hoga.market_breadth_history import calendar_grid

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
TARGET = dt.date(2026, 10, 29)
COMPOSITION_DATE = "2026-10-30"
PERIODS = (20, 60, 120)
SCORE_TOLERANCE = 1e-7
POLICY = json.loads((HERE / "policy.json").read_text())
MASTER = {r["code"]: r for r in json.loads((HERE / "security-master.json").read_text())["entries"]}
ISSUER_MATCHES = (
    {r["code"]: r["matched"] for r in json.loads((HERE / "issuer-sample-comparison.json").read_text())}
    if (HERE / "issuer-sample-comparison.json").exists()
    else {}
)


def read(path):
    return json.loads(path.read_bytes())


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str, allow_nan=False) + "\n")


def exclusion(item):
    name, category, code = item["itemname"], item["etfTabCode"], item["itemcode"]
    if code in POLICY["fund_overrides"]:
        return POLICY["fund_overrides"][code]["decision"]
    for pattern, reason in (
        (r"레버리지|인버스|롱.*숏", "excluded_leverage_or_pair"),
        ("커버드콜", "excluded_option_strategy"),
        (r"채권|국채|은행채|회사채|혼합", "excluded_bond_or_mixed"),
        (r"미국|일본|차이나|글로벌|인도|대만|유럽|싱가포르|홍콩|한중|아시아", "excluded_foreign"),
        (r"리츠|부동산", "excluded_real_estate"),
    ):
        if re.search(pattern, name):
            return reason
    return None if category in {1, 2} else "excluded_provider_scope"


def asset_kind(row):
    code, isin = row.get("componentItemCode"), row.get("componentIsinCode") or ""
    if isin == "KRD010010001":
        return "cash"
    if code in POLICY["nonstock_overrides"]:
        return POLICY["nonstock_overrides"][code]["kind"]
    entry = MASTER.get(code)
    if entry:
        if entry["security_type"] == "stock" and entry["market"] in {"KOSPI", "KOSDAQ"}:
            return "domestic_listed_stock"
        return "other_" + entry["security_type"]
    if isin.startswith("KR4"):
        return "derivative"
    if isin and not isin.startswith("KR"):
        return "foreign_asset"
    return "unresolved_asset"


def active_record(item):
    code = item["itemcode"]
    meta = read(HERE / "raw/metadata" / f"{code}.json")
    rows = read(HERE / "raw/components" / f"{code}.json")
    assert meta["itemCode"] == code and meta["stockEndType"] == "etf"
    assert meta["stockName"] == item["itemname"]
    assert rows and all(r["itemCode"] == code and int(r["componentCount"]) == len(rows) for r in rows)
    assert {r["referenceDate"] for r in rows} == {COMPOSITION_DATE}
    info = {r["code"]: r["value"] for r in meta["totalInfos"]}
    stocks, excluded = [], []
    for row in rows:
        kind = asset_kind(row)
        weight, quantity = Decimal(row["weight"]), Decimal(row["cuUnitQuantity"])
        assert weight.is_finite() and quantity.is_finite()
        if kind in {"unresolved_asset", "foreign_asset"}:
            raise ValueError(f"Unreviewed or foreign asset in candidate {code}: {row['componentName']}")
        if kind == "domestic_listed_stock":
            assert quantity > 0 and weight >= 0
            stock = MASTER[row["componentItemCode"]]
            assert row["componentName"] == stock["name"]
            stocks.append({"etf_code": code, "management_style": "active", **row})
        else:
            excluded.append({"etf_code": code, "asset_kind": kind, **row})
    codes = sorted({r["componentItemCode"] for r in stocks})
    assert codes and len(codes) == len(stocks)
    noncash = [r for r in excluded if r["asset_kind"] != "cash"]
    return (
        {
            "code": code,
            "name": item["itemname"],
            "management_style": "active",
            "issuer": info["issueName"],
            "benchmark": info.get("etfBaseIdx"),
            "source_category_code": item["etfTabCode"],
            "group_id": "active_portfolio",
            "group_label": "액티브",
            "tier": "active_extension",
            "codes": codes,
            "constituent_count": len(codes),
            "constituent_reference_date": COMPOSITION_DATE,
            "score_scope": "direct_domestic_listed_stocks",
            "composition_rows_verified": True,
            "issuer_original_composition_matched": ISSUER_MATCHES.get(code, False),
            "direct_stock_disclosed_weight_pct": str(sum(Decimal(r["weight"]) for r in stocks)),
            "other_noncash_asset_count": len(noncash),
            "other_noncash_assets": [
                {k: r[k] for k in ("componentName", "componentItemCode", "weight", "asset_kind")} for r in noncash
            ],
            "source_urls": [
                f"https://m.stock.naver.com/api/stock/{code}/integration",
                f"https://stock.naver.com/api/domestic/detail/{code}/ETFComponent",
            ],
        },
        stocks,
        excluded,
    )


def registry():
    base = read(BASE / "2026-10-30-etf-universe/selected.json")
    old_rows = read(BASE / "2026-10-30-etf-constituent-validation/memberships.json")
    metadata = read(BASE / "2026-10-30-etf-universe/fund-metadata.json")
    funds, memberships, excluded_assets = [], [], []
    for item in base:
        code = item["code"]
        info = {r["code"]: r["value"] for r in metadata[code]["total_infos"]}
        stocks = [r for r in old_rows if r["etf_code"] == code]
        funds.append(
            {
                **item,
                "management_style": "passive",
                "issuer": info["issueName"],
                "codes": sorted(r["componentItemCode"] for r in stocks),
                "constituent_count": len(stocks),
                "constituent_reference_date": COMPOSITION_DATE,
                "score_scope": "direct_domestic_listed_stocks",
                "composition_rows_verified": True,
                "issuer_original_composition_matched": True,
                "other_noncash_asset_count": 0,
                "other_noncash_assets": [],
            }
        )
        memberships.extend({**r, "management_style": "passive"} for r in stocks)
    decisions = []
    for item in read(HERE / "active-discovery.json"):
        reason = exclusion(item)
        decisions.append({"code": item["itemcode"], "name": item["itemname"], "decision": reason or "included_active"})
        if reason is None:
            fund, stocks, excluded = active_record(item)
            funds.append(fund)
            memberships.extend(stocks)
            excluded_assets.extend(excluded)
    save("active-decisions.json", decisions)
    save("memberships.json", memberships)
    save("excluded-active-assets.json", excluded_assets)
    return funds, memberships


def signal_arrays(prices, codes, sessions):
    grid = calendar_grid(prices, codes, sessions).with_columns(
        *[
            pl.col("close").rolling_mean(window_size=period, min_samples=period).over("code").alias(f"sma{period}")
            for period in PERIODS
        ]
    )
    shape = (len(codes), len(sessions))
    ready = {p: grid[f"sma{p}"].is_not_null().to_numpy().reshape(shape) for p in PERIODS}
    above = {
        p: grid.select((pl.col("close") > pl.col(f"sma{p}")).fill_null(False)).to_series().to_numpy().reshape(shape)
        for p in PERIODS
    }
    return ready, above


def series_for_fund(fund, codes_index, sessions, ready, above):
    indices = [codes_index[code] for code in fund["codes"]]
    denominator = len(indices)
    record = {"etf_code": [fund["code"]] * len(sessions), "date": sessions}
    for period in PERIODS:
        counts = ready[period][indices].sum(axis=0)
        record[f"ready{period}"] = counts
        record[f"breadth{period}"] = np.where(
            counts == denominator, 100 * above[period][indices].sum(axis=0) / denominator, np.nan
        )
    result = pl.DataFrame(record).with_columns(pl.col(pl.Float64).fill_nan(None))
    return result.with_columns(
        pl.when(pl.all_horizontal(*[pl.col(f"breadth{p}").is_not_null() for p in PERIODS]))
        .then(pl.mean_horizontal(*[pl.col(f"breadth{p}") for p in PERIODS]))
        .otherwise(None)
        .alias("score")
    )


def enrich_fund(fund, series, observed_codes, sessions):
    current = series.filter(pl.col("date") == TARGET).row(0, named=True)
    available = series.filter(pl.col("score").is_not_null())
    missing = sorted(set(fund["codes"]) - observed_codes)
    young = [
        code
        for code in fund["codes"]
        if sum(day >= dt.date.fromisoformat(MASTER[code]["listing_date"]) for day in sessions) < max(PERIODS)
    ]
    status = (
        "ready"
        if current["score"] is not None
        else "insufficient_listing_history"
        if young
        else "price_capture_required"
    )
    return {
        **fund,
        "price_as_of": TARGET,
        "current_score": current["score"],
        "current_periods": {str(p): current[f"breadth{p}"] for p in PERIODS},
        "current_ready_count": int(current["ready120"]),
        "calculation_status": status,
        "missing_price_codes": missing,
        "short_listing_history_codes": young,
        "first_calculable_date": available["date"].min(),
        "valid_score_days": available.height,
        "historical_holdings_reconstructed": False,
    }


def build():
    funds, members = registry()
    codes = sorted({r["componentItemCode"] for r in members})
    sessions = [dt.date.fromisoformat(day) for day in read(BASE / "2026-10-30-etf-breadth-history/calendar.json")]
    prices = pl.read_parquet(BASE / "2026-10-30-etf-breadth-history/confirmed-history.parquet")
    extra = HERE / "additional-confirmed-prices.parquet"
    if extra.exists():
        prices = pl.concat([prices, pl.read_parquet(extra)])
    observed = set(prices["code"].unique())
    ready, above = signal_arrays(prices, codes, sessions)
    index = {code: i for i, code in enumerate(codes)}
    frames, enriched = [], []
    for fund in funds:
        series = series_for_fund(fund, index, sessions, ready, above)
        frames.append(series)
        enriched.append(enrich_fund(fund, series, observed, sessions))
    combined = pl.concat(frames).sort(["etf_code", "date"])
    combined.write_parquet(HERE / "etf-comparison-series.parquet")
    save("comparison-etfs.json", enriched)
    original_codes = {r["code"] for r in read(BASE / "2026-10-30-etf-constituent-validation/universe.json")}
    new_codes = set(codes) - original_codes
    stock_rows = [
        {
            **MASTER[c],
            "in_original_477": c in original_codes,
            "price_capture_required": c not in observed,
            "calendar_sessions_since_listing_in_capture": sum(
                day >= dt.date.fromisoformat(MASTER[c]["listing_date"]) for day in sessions
            ),
        }
        for c in codes
    ]
    save("expanded-stock-universe.json", stock_rows)
    save("price-worklist.json", [r for r in stock_rows if r["price_capture_required"]])
    old_scores = {r["code"]: r["score"] for r in read(BASE / "2026-10-30-etf-breadth/etf-breadth.json")}
    assert all(
        abs(f["current_score"] - old_scores[f["code"]]) < SCORE_TOLERANCE
        for f in enriched
        if f["management_style"] == "passive"
    )
    original_indices = [index[c] for c in sorted(original_codes)]
    original_score = sum(100 * above[p][original_indices, -1].sum() / len(original_indices) for p in PERIODS) / len(
        PERIODS
    )
    assert (
        abs(original_score - read(BASE / "2026-10-30-etf-breadth/overall.json")["primary"]["score"]) < SCORE_TOLERANCE
    )
    save(
        "summary.json",
        {
            "universe_id": POLICY["universe_id"],
            "passive_etfs": sum(f["management_style"] == "passive" for f in funds),
            "active_etfs": sum(f["management_style"] == "active" for f in funds),
            "total_etfs": len(funds),
            "stock_codes": len(codes),
            "new_stock_codes_vs_original_477": len(new_codes),
            "missing_price_codes": len(set(codes) - observed),
            "current_status_counts": dict(Counter(f["calculation_status"] for f in enriched)),
            "active_status_counts": dict(
                Counter(f["calculation_status"] for f in enriched if f["management_style"] == "active")
            ),
            "active_constituent_rows": sum(r["management_style"] == "active" for r in members),
            "original_38_scores_unchanged": True,
            "original_477_aggregate_unchanged": True,
            "original_477_score_recomputed": float(original_score),
            "issuer_original_active_matches": sum(
                bool(f["issuer_original_composition_matched"]) for f in enriched if f["management_style"] == "active"
            ),
            "histories": combined.height,
            "holdings_reference_date": COMPOSITION_DATE,
            "price_as_of": TARGET,
            "reused_prices": read(HERE / "reused-price-observations.json"),
            "input_sha256": {
                name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                for name in (
                    "policy.json",
                    "security-master.json",
                    "public-captures.json",
                    "active-discovery.json",
                )
            },
        },
    )
    print(json.dumps(read(HERE / "summary.json"), ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    build()
