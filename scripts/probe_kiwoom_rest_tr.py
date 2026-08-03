"""키움 REST TR 범용 프로브 — 임의 `api-id` 를 때려 응답·페이징·유량을 채록한다.

지도 #1005(KIS 완전 제거 → 키움 전면 대체)의 조사 티켓 #1007·#1008·#1009 가 공용으로
쓰는 도구다. 셋 다 묻는 것이 같은 축이라 스크립트를 하나로 둔다:

  #1007 대응 매트릭스   — 필드 커버리지 · 유량 · 보유 기간
  #1008 분봉 TR 실측    — 페이지 깊이 · 커서(`cont-yn`/`next-key`) 의미론 · 유량
  #1009 마스터 실측     — 필드 커버리지 · 페이지네이션

**WS 를 열지 않는다.** 키움의 킥은 WS 세션 레벨이고(`kiwoom_ws_client.py:11` 실측:
"동일 앱키 2세션 → 기존이 close(1000,'Bye')로 킥"), 이 프로브는 REST 만 쓴다.
따라서 운영 중인 WS 세션을 죽이지 않는다. 남는 유일한 간섭은 **REST 유량 합산**이라
`--pace` 로 요청 간격을 강제한다(기본 1.0s = 키움 실측 1 req/s 에 맞춘 보수값).

사용:
  uv run python scripts/probe_kiwoom_rest_tr.py --api-id ka10001 \
      --path /api/dostk/stkinfo --body '{"stk_cd":"005930"}'

  uv run python scripts/probe_kiwoom_rest_tr.py --api-id ka10080 \
      --path /api/dostk/chart --body '{"stk_cd":"005930","tic_scope":"1","upd_stkpc_tp":"1"}' \
      --pages 5 --out /tmp/ka10080.json

응답 요약만 보고 싶으면 `--out` 을 생략한다. 필드 전수가 필요하면 `--out` 으로
원본 JSON 을 떨군 뒤 그 파일을 근거로 `docs/research/*-tr-spec.md` 를 쓴다.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kiwoom_runtime import configured_account_ids, ensure_token_provider_for_account

_BASE_REAL = "https://api.kiwoom.com"
# 키움 REST 실측 유량은 ~1 req/s (ADR-0120). 프로브는 조사용이라 절대 앞지르지 않는다.
_DEFAULT_PACE_S = 1.0
# 폭주 방지 — 커서가 끝나지 않는 TR 을 만나도 여기서 멈춘다.
_MAX_PAGES = 200


_ENVELOPE_KEYS = frozenset({"return_code", "return_msg"})


def _list_payload_keys(body: dict[str, Any]) -> list[str]:
    """응답에서 '행 리스트' 를 담은 키들. TR 마다 래퍼 이름이 다르므로 값 모양으로 찾는다."""
    return [k for k, v in body.items() if isinstance(v, list) and v and isinstance(v[0], dict)]


def _summarize(page_no: int, elapsed_ms: float, body: dict[str, Any], headers: httpx.Headers) -> dict[str, Any]:
    """TR 응답 1페이지를 요약한다.

    키움 TR 은 응답 모양이 **두 갈래**다 — 차트·순위처럼 행 리스트를 래퍼 키에 담는
    것과, `ka10001`(종목기본정보)처럼 필드를 **최상위에 평평하게** 싣는 것. 후자를
    "행 0" 으로 처리하면 필드 커버리지 조사(#1007)가 아무것도 못 본다. 그래서
    리스트가 없으면 봉투(`return_code`/`return_msg`)를 뺀 최상위를 1행으로 센다.
    """
    keys = _list_payload_keys(body)
    if keys:
        rows, fields, shape = sum(len(body[k]) for k in keys), sorted(body[keys[0]][0].keys()), "list"
    else:
        flat = sorted(k for k in body if k not in _ENVELOPE_KEYS)
        rows, fields, shape = (1 if flat else 0), flat, "flat"
    return {
        "page": page_no,
        "elapsed_ms": round(elapsed_ms, 1),
        "return_code": body.get("return_code"),
        "return_msg": body.get("return_msg"),
        "shape": shape,
        "list_keys": keys,
        "rows": rows,
        "field_count": len(fields),
        "cont_yn": headers.get("cont-yn"),
        "has_next_key": bool(headers.get("next-key")),
        # 필드 이름 전수 — 커버리지 조사의 출발점
        "fields": fields,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="키움 REST TR 프로브 (WS 미사용)")
    ap.add_argument("--api-id", required=True, help="예: ka10001 / ka10080 / ka20005")
    ap.add_argument("--path", default="/api/dostk/chart",
                    help="예: /api/dostk/chart · /api/dostk/stkinfo · /api/dostk/rkinfo")
    ap.add_argument("--body", default="{}", help="요청 바디 JSON")
    ap.add_argument("--account", type=int, default=0, help="앱키 계정 id (0 = KIWOOM_APP_KEY)")
    ap.add_argument("--pages", type=int, default=1, help="따라갈 연속조회 페이지 수")
    ap.add_argument("--pace", type=float, default=_DEFAULT_PACE_S, help="요청 간 최소 간격(초)")
    ap.add_argument("--out", type=Path, default=None, help="원본 응답 JSON 저장 경로")
    args = ap.parse_args()

    if args.pages > _MAX_PAGES:
        print(f"--pages 는 {_MAX_PAGES} 이하만 허용한다(폭주 방지)", file=sys.stderr)
        return 2
    try:
        req_body = json.loads(args.body)
    except json.JSONDecodeError as exc:
        print(f"--body 가 JSON 이 아니다: {exc}", file=sys.stderr)
        return 2

    load_env()
    data_dir = resolve_data_dir()
    configured = configured_account_ids(data_dir)
    if args.account not in configured:
        print(
            f"account {args.account} 에 자격증명이 없다. 설정된 계정: {configured or '없음'}\n"
            "→ .env 의 KIWOOM_APP_KEY / KIWOOM_APP_SECRET 을 확인하라 "
            "(account k>0 은 접미 _{k+1}).",
            file=sys.stderr,
        )
        return 1
    prov = ensure_token_provider_for_account(args.account, data_dir)
    if prov is None:
        print(f"account {args.account} 토큰 provider 생성 실패", file=sys.stderr)
        return 1

    pages: list[dict[str, Any]] = []
    raw: list[dict[str, Any]] = []
    cont_yn, next_key = "N", ""

    with httpx.Client(base_url=_BASE_REAL, timeout=20.0) as client:
        for page_no in range(1, args.pages + 1):
            if page_no > 1:
                time.sleep(args.pace)
            headers = {
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {prov.get_token()}",
                "api-id": args.api_id,
                "cont-yn": cont_yn,
                "next-key": next_key,
            }
            t0 = time.monotonic()
            resp = client.post(args.path, json=req_body, headers=headers)
            elapsed_ms = (time.monotonic() - t0) * 1000

            if resp.status_code != 200:  # noqa: PLR2004
                print(f"page {page_no}: HTTP {resp.status_code} {resp.text[:300]}", file=sys.stderr)
                return 1
            body = resp.json()
            raw.append(body)
            summary = _summarize(page_no, elapsed_ms, body, resp.headers)
            pages.append(summary)
            print(json.dumps(summary, ensure_ascii=False))

            if body.get("return_code") != 0:
                print(f"page {page_no}: return_code={body.get('return_code')} — 중단", file=sys.stderr)
                break
            cont_yn = resp.headers.get("cont-yn", "N")
            next_key = resp.headers.get("next-key", "")
            if cont_yn != "Y" or not next_key:
                break

    total_rows = sum(p["rows"] for p in pages)
    lat = [p["elapsed_ms"] for p in pages]
    print(
        "\n=== 요약 ===\n"
        f"api-id       {args.api_id}   path {args.path}\n"
        f"페이지        {len(pages)} (요청 {args.pages})\n"
        f"총 행         {total_rows}"
        + (f"   페이지당 평균 {total_rows / len(pages):.1f}" if pages else "")
        + f"\n지연(ms)      min {min(lat):.0f} / 평균 {sum(lat) / len(lat):.0f} / max {max(lat):.0f}\n"
        f"커서 종료      cont-yn={pages[-1]['cont_yn']!r} next-key={'있음' if pages[-1]['has_next_key'] else '없음'}"
        if pages else "페이지 0"
    )
    if args.out:
        args.out.write_text(json.dumps({"pages": pages, "raw": raw}, ensure_ascii=False, indent=2))
        print(f"원본 저장     {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
