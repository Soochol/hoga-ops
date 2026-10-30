"""Compare available issuer-original baskets with the captured public components.

An incomplete issuer preview is recorded as such, never promoted to a full match.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import time
import urllib.request
from decimal import Decimal
from http import HTTPStatus
from pathlib import Path

import xlrd
from collect_active import capture, save

HERE = Path(__file__).resolve().parent


def quant(value):
    return str(Decimal(str(value).replace(",", "")).normalize())


def xls_rows(url, code, declared):
    path = HERE / "raw/issuer" / f"{code}.xls"
    log_path = HERE / "issuer-xls-captures.json"
    records = json.loads(log_path.read_text()) if log_path.exists() else {}
    if path.exists():
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == records[code]["sha256"]
    else:
        time.sleep(0.5)
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            assert response.status == HTTPStatus.OK
        records[code] = {
            "url": url,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "retrieved_at": dt.datetime.now(dt.UTC).isoformat(),
        }
        path.write_bytes(raw)
        save("issuer-xls-captures.json", records)
    sheet = xlrd.open_workbook(file_contents=raw).sheet_by_index(0)
    assert re.sub(r"\D", "", str(sheet.cell_value(1, 0))) == "20261030"
    rows = [
        {"itmNo": str(v[3]), "secNm": str(v[1]), "applyQ": v[4]}
        for v in (sheet.row_values(i) for i in range(3, sheet.nrows))
        if str(v[1]).strip()
    ]
    assert len(rows) == declared
    return rows


def kodex_mapping(wanted):
    mapping = {}
    page = 1
    last_page = 1
    while page <= last_page:
        rows = capture(
            f"https://m.samsungfund.com/api/v1/kodex/product.do?ordrColm=NAV&ordrSort=DESC&pageNo={page}",
            f"raw/issuer-list/kodex-{page}.json",
        )
        assert rows
        last_page = math.ceil(int(rows[0]["totalCnt"]) / len(rows)) if page == 1 else last_page
        mapping.update({r["stkTicker"]: {"id": r["fId"], "name": r["fNm"]} for r in rows})
        if wanted <= mapping.keys():
            break
        page += 1
    save("kodex-active-id-map.json", {"pages_read": page, "mapping": {c: mapping[c] for c in wanted if c in mapping}})
    return mapping


def main():
    funds = json.loads((HERE / "comparison-etfs.json").read_text())
    mapping = kodex_mapping(
        {f["code"] for f in funds if f["name"].startswith("KODEX ") and f["management_style"] == "active"}
    )
    results = []
    for fund in funds:
        if fund["management_style"] != "active" or not fund["name"].startswith("KODEX "):
            continue
        code = fund["code"]
        item = {"code": code, "issuer": "KODEX", "matched": False}
        try:
            identifier = mapping[code]["id"]
            url = f"https://m.samsungfund.com/api/v1/kodex/product/{identifier}.do"
            data = capture(url, f"raw/issuer/{code}.json")
            assert data["info"]["product"]["stkTicker"] == code
            pdf = data["pdf"]
            assert pdf["gijunYMD"].replace("-", "") == "20261030"
            rows = pdf["list"]
            item.update(url=url, declared_rows=int(pdf["totalCnt"]), returned_rows=len(rows))
            if len(rows) != int(pdf["totalCnt"]):
                xls_url = "https://m.samsungfund.com" + pdf["pdfExcelDownloadUrl"]
                rows = xls_rows(xls_url, code, int(pdf["totalCnt"]))
                item.update(xls_url=xls_url, full_rows=len(rows))
            if len(rows) == int(pdf["totalCnt"]):
                expected = {
                    r["componentItemCode"]: quant(r["cuUnitQuantity"])
                    for r in json.loads((HERE / "raw/components" / f"{code}.json").read_bytes())
                    if r.get("componentItemCode")
                }
                observed = {
                    r["itmNo"]: quant(r["applyQ"])
                    for r in rows
                    if re.fullmatch(r"[A-Z0-9]{6}", r["itmNo"] or "") and "현금" not in r["secNm"]
                }
                item.update(matched=expected == observed, status="matched" if expected == observed else "mismatch")
        except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
            item.update(status="unavailable", error=f"{type(error).__name__}: {error}")
        results.append(item)
        print(code, item["status"], flush=True)
    code = "444200"
    url = "https://www.soletf.com/api/fund/pdfList?fund_cd=210940&work_dt=20261030"
    item = {"code": code, "issuer": "SOL", "url": url, "matched": False}
    try:
        rows = capture(url, f"raw/issuer/{code}.json")
        assert rows and {r["ETF_CD6"] for r in rows} == {code} and {r["WORK_DT"] for r in rows} == {"20261030"}
        expected = {
            r["componentItemCode"]: quant(r["cuUnitQuantity"])
            for r in json.loads((HERE / "raw/components" / f"{code}.json").read_bytes())
            if r.get("componentItemCode")
        }
        observed = {
            r["STOCK_CODE"]: quant(r["QTY"])
            for r in rows
            if re.fullmatch(r"[A-Z0-9]{6}", r["STOCK_CODE"] or "") and "현금" not in r["SEC_NM"]
        }
        item.update(matched=expected == observed, status="matched" if expected == observed else "mismatch")
    except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
        item.update(status="unavailable", error=f"{type(error).__name__}: {error}")
    results.append(item)
    print(code, item["status"], flush=True)
    save("issuer-sample-comparison.json", results)


if __name__ == "__main__":
    main()
