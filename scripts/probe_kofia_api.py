"""KOFIA(금융투자협회) 종합통계 오픈API 프로브 — 증시 주변 자금 3계열 스펙 채록.

지도 #1094 의 실측 티켓 #1098 이 쓰는 도구다. `scripts/probe_kiwoom_rest_tr.py` 와
같은 역할이되 벤더가 다르다 — 공공데이터포털(data.go.kr) 이라 인증이 `serviceKey`
쿼리 파라미터이고, 응답이 JSON/XML 두 형태다.

**인증키는 코드에 넣지 않는다.** `.env` 의 `KOFIA_API_KEY` 를 읽는다(ADR-0134 무자격
관례 — 키가 없으면 이 스크립트만 못 돌고 앱은 정상). prod `.env` 에만 두고 dev·워크트리는
비워 둔다.

**Encoding/Decoding 키 함정**: 포털은 인증키를 두 형태로 준다. Encoding 형은
`%2B`·`%3D` 가 이미 퍼센트 인코딩된 문자열이라 httpx `params=` 에 넘기면 **이중 인코딩**
되어 인증이 깨진다. Decoding 형(`+`·`=` 원문)을 `params=` 로 넘기거나, Encoding 형을
URL 문자열에 직접 이어 붙여야 한다. 어느 쪽이 먹는지는 API 마다 달라 **둘 다 시도**한다.

사용:
  uv run python scripts/probe_kofia_api.py --op getSecuritiesMarketTotalCapitalInfo
  uv run python scripts/probe_kofia_api.py --op getCMAStatus --rows 5 --out /tmp/cma.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
from pathlib import Path
from typing import Any

import httpx

from hoga.env import load_env

_BASE = "https://apis.data.go.kr/1160100/service/GetKofiaStatisticsInfoService"

# 증시 주변 자금 카드가 쓰는 3종. 나머지 5종(신탁규모·펀드순자산·DLS/DLB·ELS/ELB·
# 해외파생)은 이번 범위 밖이다.
OPS = {
    "getSecuritiesMarketTotalCapitalInfo": "증시자금추이 — 고객예탁금",
    "getGrantingOfCreditBalanceInfo": "신용공여잔고추이 — 신용융자",
    "getCMAStatus": "일자별CMA현황 — CMA",
}


def _summarize(body: dict[str, Any]) -> dict[str, Any]:
    """응답 1건 요약. 공공데이터포털 표준 봉투는 response.header/body 다."""
    resp = body.get("response") or {}
    header = resp.get("header") or {}
    payload = resp.get("body") or {}
    items = payload.get("items") or {}
    rows = items.get("item") if isinstance(items, dict) else items
    if isinstance(rows, dict):  # 1건이면 리스트가 아니라 객체로 온다
        rows = [rows]
    rows = rows or []
    return {
        "resultCode": header.get("resultCode"),
        "resultMsg": header.get("resultMsg"),
        "totalCount": payload.get("totalCount"),
        "numOfRows": payload.get("numOfRows"),
        "pageNo": payload.get("pageNo"),
        "row_count": len(rows),
        "fields": sorted(rows[0].keys()) if rows else [],
        "first_row": rows[0] if rows else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="KOFIA 종합통계 오픈API 프로브")
    ap.add_argument("--op", required=True, choices=sorted(OPS), help="상세기능 경로명")
    ap.add_argument("--rows", type=int, default=10, help="numOfRows")
    ap.add_argument("--page", type=int, default=1, help="pageNo")
    ap.add_argument("--basDt", default=None, help="기준일자 YYYYMMDD (지원 여부 확인용)")
    ap.add_argument("--out", type=Path, default=None, help="원본 응답 저장 경로")
    args = ap.parse_args()

    load_env()
    key = os.environ.get("KOFIA_API_KEY", "").strip()
    if not key:
        print(
            "KOFIA_API_KEY 가 비어 있다. prod `.env` 에 넣어라 (dev·워크트리는 무자격 유지).",
            file=sys.stderr,
        )
        return 1

    params: dict[str, Any] = {"numOfRows": args.rows, "pageNo": args.page, "resultType": "json"}
    if args.basDt:
        params["basDt"] = args.basDt

    # Encoding/Decoding 두 형태를 순서대로 시도한다 — 먼저 성공하는 쪽이 그 API 의 정답.
    decoded = urllib.parse.unquote(key)
    attempts = [
        ("decoded(params)", {**params, "serviceKey": decoded}, None),
        ("encoded(url)", params, key),
    ]

    with httpx.Client(timeout=30.0) as client:
        for label, qp, raw_key in attempts:
            url = f"{_BASE}/{args.op}"
            if raw_key is not None:
                url = f"{url}?serviceKey={raw_key}"
            r = client.get(url, params=qp)
            ctype = r.headers.get("content-type", "")
            text = r.text
            print(f"--- {label}: HTTP {r.status_code} · {ctype}")
            if r.status_code != 200:  # noqa: PLR2004
                print(f"    {text[:200]}")
                continue
            if "json" not in ctype.lower() and not text.lstrip().startswith("{"):
                # 인증 실패는 XML 에러 봉투로 오는 경우가 많다
                print(f"    JSON 아님(인증 실패 가능): {text[:300]}")
                continue
            body = r.json()
            summary = _summarize(body)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            if args.out:
                args.out.write_text(json.dumps(body, ensure_ascii=False, indent=2))
                print(f"    원본 저장 {args.out}")
            return 0

    print("두 키 형태 모두 실패했다.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
