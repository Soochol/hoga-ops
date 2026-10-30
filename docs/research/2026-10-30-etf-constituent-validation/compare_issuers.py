"""Compare saved issuer baskets offline; requires xlrd 2.0.2 for three XLS inputs."""

import decimal
import html
import json
import re
from pathlib import Path

import xlrd

p = Path(__file__).resolve().parent
base = p.parent / "2026-10-30-etf-components-api"
selected = json.loads((p.parent / "2026-10-30-etf-universe/selected.json").read_text())


def cells(s):
    return [
        html.unescape(re.sub("<[^>]*>", "", x)).strip() for x in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", s, re.S)
    ]


def num(x):
    return str(decimal.Decimal(str(x).replace(",", "")).normalize())


result = []
normalized = []
for e in selected:
    code = e["code"]
    brand = e["name"].split()[0]
    rdir = p / "issuer-responses"
    orig = json.loads((base / "responses" / (code + ".json")).read_text())
    stocks = {x["componentItemCode"]: num(x["cuUnitQuantity"]) for x in orig if x["componentItemCode"]}
    rows = []
    date = "2026-10-30"
    declared = None
    if brand == "KODEX":
        d = json.loads((rdir / (code + ".json")).read_text())
        date = d["pdf"]["gijunYMD"]
        assert d["product"]["stkTicker"] == code
        declared = int(d["pdf"]["totalCnt"])
        if (rdir / (code + ".xls")).exists():
            sh = xlrd.open_workbook(rdir / (code + ".xls")).sheet_by_index(0)
            date = sh.cell_value(1, 0)
            for i in range(3, sh.nrows):
                v = sh.row_values(i)
                rows.append({"code": v[3], "isin": v[2], "name": v[1], "quantity": num(v[4])})
        else:
            rows = [{"code": x["itmNo"], "name": x["secNm"], "quantity": num(x["applyQ"])} for x in d["pdf"]["list"]]
    elif brand == "SOL":
        d = json.loads((rdir / (code + ".json")).read_text())
        assert {x["ETF_CD6"] for x in d} == {code}
        assert {x["WORK_DT"] for x in d} == {"20261030"}
        rows = [{"code": x["STOCK_CODE"], "name": x["SEC_NM"], "quantity": num(x["QTY"])} for x in d]
    elif brand == "PLUS":
        d = json.loads((rdir / (code + ".json")).read_text())
        declared = d["totalElements"]
        assert d["last"] and len(d["content"]) == declared
        assert {x["wkdate"] for x in d["content"]} == {"20261030"}
        rows = [
            {"code": x["jmCd"] or x["krJmCd"], "isin": x["krJmCd"], "name": x["jmNm"], "quantity": num(x["amount"])}
            for x in d["content"]
        ]
    else:
        suffix = "-pdf.html" if brand == "TIGER" else "-dated.html" if brand == "HANARO" else ".html"
        f = rdir / (code + suffix)
        s = f.read_text()
        if brand == "RISE":
            assert 'id="datepicker_pdf" value="2026-10-30"' in s
            s = re.search(r'<tbody data-class="tab3PdfList">(.*?)</tbody>', s, re.S)[1]
        if brand == "HANARO":
            declared = int(re.search(r'name="totalFundHoldingsListSize" value="(\d+)"', s)[1])
        if brand == "TIGER":
            declared = int(re.search(r'data-tot-cnt="(\d+)"', s)[1])
        for rr in re.findall(r"<tr\b[^>]*>(.*?)</tr>", s, re.S):
            c = cells(rr)
            if not c:
                continue
            if brand == "HANARO":
                isin = c[1]
                cc = isin[3:9] if isin.startswith("KR7") else isin
                name = c[2]
                q = c[3]
            elif brand == "TIGER":
                cc = c[0]
                isin = None
                name = c[1]
                q = c[2]
            else:
                isin = c[2]
                cc = isin[3:9] if isin.startswith("KR7") else isin
                name = c[1]
                q = c[3]
            rows.append({"code": cc, "isin": isin, "name": name, "quantity": num(q)})
    date = date.replace("/", "").replace("-", "")
    assert date == "20261030"
    date = "2026-10-30"
    assert len({x["code"] for x in rows}) == len(rows), (code, "duplicate issuer codes")
    assert declared is None or declared == len(rows), (code, "truncated issuer rows")
    direct = {x["code"]: x["quantity"] for x in rows if re.fullmatch("[0-9A-Z]{6}", x["code"])}
    diff = [
        {"code": c, "naver": stocks.get(c), "issuer": direct.get(c)}
        for c in sorted(stocks.keys() | direct.keys())
        if stocks.get(c) != direct.get(c)
    ]
    r = {
        "etf_code": code,
        "name": e["name"],
        "issuer": brand,
        "reference_date": date,
        "date_evidence": "response_echo" if brand in ["KODEX", "SOL", "PLUS", "RISE"] else "dated_request",
        "issuer_rows": len(rows),
        "declared_count": declared,
        "naver_stock_count": len(stocks),
        "issuer_stock_count": len(direct),
        "stock_codes_and_cu_quantities_equal": not diff,
        "count_complete": declared == len(rows) if declared else None,
        "differences": diff,
        "cash_quantity_differences": [
            {"naver": x["cuUnitQuantity"], "issuer": y["quantity"]}
            for x in orig
            if not x["componentItemCode"]
            for y in rows
            if not re.fullmatch("[0-9A-Z]{6}", y["code"]) and num(x["cuUnitQuantity"]) != y["quantity"]
        ],
    }
    result.append(r)
    normalized.append({"etf_code": code, "rows": rows})
    print(code, brand, len(rows), "diff", diff)
assert len(result) == len(selected) and all(r["stock_codes_and_cu_quantities_equal"] for r in result)
(p / "issuer-comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
(p / "issuer-normalized.json").write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
