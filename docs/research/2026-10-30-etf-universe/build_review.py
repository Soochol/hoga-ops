"""Rebuild ETF research decisions from the frozen list and explicit policy.

This is an offline research utility. It does not access holdings, brokers,
application settings, or production data. No return metric selects a fund.
"""

import collections
import hashlib
import json
import re
from pathlib import Path

P = Path(__file__).resolve().parent
policy = json.loads((P / "selection-policy.json").read_text())
rows = json.loads((P / "naver-etf-response.json").read_text())["result"]["etfItemList"]
meta = json.loads((P / "fund-metadata.json").read_text())
selected = {row["code"]: row for row in policy["selected"]}
patterns = policy["group_patterns"]
style = re.compile(policy["style_pattern"])
reasons = policy["reason_definitions"]
outputs = []
unknown = []
for r in rows:
    code = r["itemcode"]
    n = r["itemname"]
    tab = r["etfTabCode"]
    m = meta.get(code)
    info = {v["code"]: v.get("value") for v in m.get("total_infos", [])} if m else {}
    idx = info.get("etfBaseIdx")
    grp = next((g for g, pat in patterns if re.search(pat, n)), None)
    why = None
    if re.search(r"레버리지|인버스", n):
        why = "excluded_leverage_inverse"
    elif "커버드콜" in n:
        why = "excluded_option_strategy"
    elif re.search(r"롱.*숏", n):
        why = "excluded_pair_strategy"
    elif re.search(r"채권|국채|은행채|회사채|혼합", n):
        why = "excluded_bond_mixed"
    elif re.search(r"미국|일본|차이나|글로벌|인도|대만|유럽|싱가포르|홍콩|한중|아시아", n):
        why = "excluded_foreign"
    elif re.search(r"리츠|부동산", n):
        why = "excluded_real_estate"
    elif tab not in (1, 2):
        why = "excluded_provider_scope"
    elif "액티브" in n:
        why = "excluded_active"
    elif re.search(r"그룹|지주회사|현대차고정|현대차로보틱스", n):
        why = "excluded_issuer_group"
    elif tab == 1:
        why = "reference_market" if code in policy["reference_codes"] else "excluded_broad_market"
    elif style.search(n):
        why = "excluded_style"
    elif code in selected:
        why = "selected"
    elif m:
        if grp:
            same = any(
                idx == {v["code"]: v.get("value") for v in meta[k]["total_infos"]}.get("etfBaseIdx")
                for k in selected
                if selected[k]["group_id"] == grp
            )
            why = (
                "reserve_same_index"
                if same
                else "reserve_alternative"
                if any(z["group_id"] == grp for z in selected.values())
                else "reserve_additional_scope"
            )
        else:
            unknown.append((code, n, idx))
            why = "manual_review_required"
    else:
        unknown.append((code, n, idx))
        why = "manual_review_required"
    if code in selected:
        assert why == "selected", (code, why)
    rec = {
        "code": code,
        "name": n,
        "source_category_code": tab,
        "decision": why,
        "reason": selected[code]["selection_reason"] if why == "selected" else reasons.get(why, "要確認"),
        "group_id": selected[code]["group_id"] if why == "selected" else grp,
        "benchmark": idx,
        "source_market_cap_100m_krw": r["marketSum"],
        "source_snapshot_turnover_million_krw": r["amonut"],
        "source_links": [
            f"https://m.stock.naver.com/domestic/stock/{code}",
            f"https://comp.wisereport.co.kr/ETF/etf_main.aspx?cmp_cd={code}",
        ],
        "metadata_captured": bool(m),
    }
    if why == "selected":
        rec.update(selected[code])
        rec["stage3_constituent_validation_required"] = True
    outputs.append(rec)

assert not unknown, unknown
codes = [row["code"] for row in outputs]
assert len(codes) == len(set(codes))
assert all(re.fullmatch(r"[A-Z0-9]{6}", code) for code in codes)
wise = json.loads((P / "fnguide-lookup.json").read_text())
wise_codes = {row["code"] for row in wise if row["type"] == "ETF"}
assert set(codes) == wise_codes
assert all(code in meta and meta[code]["stock_end_type"] == "etf" for code in selected)
assert all(next(row for row in outputs if row["code"] == code)["benchmark"] for code in selected)
assert not any(
    re.search(r"레버리지|인버스|커버드콜|채권|액티브", row["name"]) for row in outputs if row["decision"] == "selected"
)
for filename, value in (
    ("catalog.json", outputs),
    ("selected.json", [row for code in selected for row in outputs if row["code"] == code]),
):
    (P / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
summary = {
    "research_date": policy["research_date"],
    "total_etfs": len(rows),
    "fnguide_etfs": len(wise_codes),
    "fnguide_etns_excluded": sum(row["type"] == "ETN" for row in wise),
    "list_code_sets_equal": set(codes) == wise_codes,
    "metadata_count": len(meta),
    "decision_counts": dict(sorted(collections.Counter(row["decision"] for row in outputs).items())),
    "selected_tiers": dict(collections.Counter(row["tier"] for row in selected.values())),
    "unknown_decisions": len(unknown),
    "holdings_collected": False,
    "input_sha256": {
        name: hashlib.sha256((P / name).read_bytes()).hexdigest()
        for name in ("naver-etf-response.json", "fnguide-lookup.json", "fund-metadata.json", "selection-policy.json")
    },
}
(P / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
