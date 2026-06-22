#!/usr/bin/env python3
"""Probe KIS domestic index minute continuation behavior.

This script intentionally calls KIS directly instead of the app API so we can
inspect response headers (`tr_cont`) and compare page fingerprints.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kis_runtime import ensure_kis_token_provider_from_env


BASE_URL = "https://openapi.koreainvestment.com:9443"


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    raw = body.get("output2") or body.get("output") or []
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    return []


def _date(row: dict[str, Any]) -> str:
    return str(row.get("stck_bsop_date") or row.get("bsop_date") or row.get("stck_bsop_date1") or "")


def _time(row: dict[str, Any]) -> str:
    return str(row.get("stck_cntg_hour") or row.get("bsop_hour") or row.get("stck_bsop_hour") or "")


def _fingerprint(rows: list[dict[str, Any]]) -> str:
    payload = json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


def _summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    dates = Counter(_date(row) or "(missing)" for row in rows)
    keys = sorted({key for row in rows[:5] for key in row})
    first = rows[0] if rows else {}
    last = rows[-1] if rows else {}
    return {
        "rows": len(rows),
        "fingerprint": _fingerprint(rows),
        "dates": dict(sorted(dates.items())),
        "first": {"date": _date(first), "time": _time(first)},
        "last": {"date": _date(last), "time": _time(last)},
        "sample_keys": keys,
    }


async def _fetch(
    client: httpx.AsyncClient,
    *,
    token: str,
    app_key: str,
    app_secret: str,
    path: str,
    tr_id: str,
    tr_cont: str,
    params: dict[str, str],
) -> tuple[httpx.Response, dict[str, Any]]:
    headers = {
        "authorization": f"Bearer {token}",
        "appkey": app_key,
        "appsecret": app_secret,
        "tr_id": tr_id,
        "custtype": "P",
    }
    if tr_cont:
        headers["tr_cont"] = tr_cont
    response = await client.get(path, params=params, headers=headers)
    try:
        body = response.json()
    except ValueError:
        body = {"_raw": response.text[:500]}
    return response, body


async def _probe_endpoint(
    *,
    endpoint_name: str,
    path: str,
    tr_id: str,
    base_params: dict[str, str],
    continuation_values: set[str],
    max_pages: int,
    force_next: bool,
    token: str,
    app_key: str,
    app_secret: str,
) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    tr_cont = ""
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as client:
        for page_no in range(max_pages):
            response, body = await _fetch(
                client,
                token=token,
                app_key=app_key,
                app_secret=app_secret,
                path=path,
                tr_id=tr_id,
                tr_cont=tr_cont,
                params=base_params,
            )
            rows = _rows(body)
            response_tr_cont = response.headers.get("tr_cont") or response.headers.get("tr-cont") or ""
            page = {
                "page": page_no + 1,
                "request_tr_cont": tr_cont,
                "status": response.status_code,
                "response_tr_cont": response_tr_cont,
                "body_keys": sorted(body.keys()),
                "rt_cd": body.get("rt_cd"),
                "msg_cd": body.get("msg_cd"),
                "msg1": body.get("msg1"),
                **_summarize_rows(rows),
            }
            pages.append(page)
            if response.status_code != 200 or body.get("rt_cd") != "0":
                break
            if response_tr_cont in continuation_values:
                tr_cont = "N"
                await asyncio.sleep(0.1)
                continue
            if force_next and page_no == 0:
                tr_cont = "N"
                await asyncio.sleep(0.1)
                continue
            break
    return {
        "endpoint": endpoint_name,
        "path": path,
        "tr_id": tr_id,
        "params": base_params,
        "pages": pages,
        "unique_page_fingerprints": sorted({page["fingerprint"] for page in pages}),
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-code", default="0001")
    parser.add_argument("--max-pages", type=int, default=3)
    parser.add_argument("--force-next", action="store_true")
    parser.add_argument("--past-values", default="Y")
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()

    load_env()
    data_dir = args.data_dir or resolve_data_dir()
    ensured = ensure_kis_token_provider_from_env(data_dir)
    if ensured is None:
        raise SystemExit("KIS_APP_KEY/KIS_APP_SECRET are missing")
    provider, creds = ensured
    token = await asyncio.to_thread(provider.get_token)

    probes: list[dict[str, Any]] = []
    past_values = [item.strip() for item in args.past_values.split(",") if item.strip()]
    for past_value in past_values:
        for unit in ("30", "60", "120", "300", "600", "3600"):
            probes.append(await _probe_endpoint(
                endpoint_name=f"time-indexchartprice:{unit}:past-{past_value}",
                path="/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice",
                tr_id="FHKUP03500200",
                base_params={
                    "FID_COND_MRKT_DIV_CODE": "U",
                    "FID_ETC_CLS_CODE": "0",
                    "FID_INPUT_ISCD": args.index_code,
                    "FID_INPUT_HOUR_1": unit,
                    "FID_PW_DATA_INCU_YN": past_value,
                },
                continuation_values={"M", "F"},
                max_pages=args.max_pages,
                force_next=args.force_next,
                token=token,
                app_key=creds.app_key,
                app_secret=creds.app_secret,
            ))

    for unit in ("60", "120", "300", "600"):
        probes.append(await _probe_endpoint(
            endpoint_name=f"index-timeprice:{unit}",
            path="/uapi/domestic-stock/v1/quotations/inquire-index-timeprice",
            tr_id="FHPUP02110200",
            base_params={
                "FID_INPUT_HOUR_1": unit,
                "FID_INPUT_ISCD": args.index_code,
                "FID_COND_MRKT_DIV_CODE": "U",
            },
            continuation_values={"M"},
            max_pages=args.max_pages,
            force_next=args.force_next,
            token=token,
            app_key=creds.app_key,
            app_secret=creds.app_secret,
        ))

    probes.append(await _probe_endpoint(
        endpoint_name="index-tickprice",
        path="/uapi/domestic-stock/v1/quotations/inquire-index-tickprice",
        tr_id="FHPUP02110100",
        base_params={
            "FID_INPUT_ISCD": args.index_code,
            "FID_COND_MRKT_DIV_CODE": "U",
        },
        continuation_values={"M"},
        max_pages=args.max_pages,
        force_next=args.force_next,
        token=token,
        app_key=creds.app_key,
        app_secret=creds.app_secret,
    ))

    for past_value in past_values:
        for unit in ("60", "120"):
            probes.append(await _probe_endpoint(
                endpoint_name=f"time-itemchartprice-U:{unit}:past-{past_value}",
                path="/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
                tr_id="FHKST03010200",
                base_params={
                    "FID_COND_MRKT_DIV_CODE": "U",
                    "FID_INPUT_ISCD": args.index_code,
                    "FID_INPUT_HOUR_1": unit,
                    "FID_PW_DATA_INCU_YN": past_value,
                    "FID_ETC_CLS_CODE": "",
                },
                continuation_values={"M", "F"},
                max_pages=args.max_pages,
                force_next=args.force_next,
                token=token,
                app_key=creds.app_key,
                app_secret=creds.app_secret,
            ))

    for past_value in past_values:
        probes.append(await _probe_endpoint(
            endpoint_name=f"postman-daily-indexchartprice-time-params:60:past-{past_value}",
            path="/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
            tr_id="FHKST03010200",
            base_params={
                "FID_COND_MRKT_DIV_CODE": "U",
                "FID_INPUT_ISCD": args.index_code,
                "FID_INPUT_HOUR_1": "60",
                "FID_PW_DATA_INCU_YN": past_value,
                "FID_ETC_CLS_CODE": "",
            },
            continuation_values={"M", "F"},
            max_pages=args.max_pages,
            force_next=args.force_next,
            token=token,
            app_key=creds.app_key,
            app_secret=creds.app_secret,
        ))

    print(json.dumps({
        "index_code": args.index_code,
        "max_pages": args.max_pages,
        "force_next": args.force_next,
        "past_values": past_values,
        "probes": probes,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
