#!/usr/bin/env python
"""커밋된 종목 마스터 시드(`kiwoom_master_seed.json`)를 `ka10099` 로 재생성한다.

시드가 있는 이유는 **`.mst` 가 무인증 정적 파일이었다는 성질을 되사는 것**이다
(`kiwoom_master.load_seed` docstring) — `ka10099` 는 인증이 필요하므로 자격증명 없는
첫 부팅에서 검색이 통째로 비지 않게 리포에 카탈로그가 하나 있어야 한다.

## schema_version

    3 → 행 4-tuple  [code, name, market, security_type]
    4 → 행 5-tuple  [..., nxt_enabled]   ← ADR-0140 §4 (#1127)

`load_seed` 는 4-tuple 을 읽으면 `nxt_enabled=None`(**모름**)으로 둔다. `False`(미상장)
로 읽으면 구 시드가 "전 종목 NXT 미상장"이라 거짓 증언하게 된다.

## 실행

    uv run python scripts/build_kiwoom_master_seed.py            # 점검(diff 만)
    uv run python scripts/build_kiwoom_master_seed.py --write    # 파일 갱신

자격증명(`KIWOOM_APP_KEY*`)이 필요하다. 운영 캡처와 겹치지 않게 **유휴 앱키**를 쓴다
(`--account`, 기본 0).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hoga.api.kiwoom_master import API_ID, MARKET_PARAM, SEED_PATH, parse_market
from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kiwoom_rest_runtime import ensure_rest_client

SCHEMA_VERSION = 4


async def _fetch(account: int) -> list[list]:
    client = ensure_rest_client(resolve_data_dir(), account)
    if client is None:
        raise SystemExit(f"계정 {account} 자격증명 없음 — .env 의 KIWOOM_APP_KEY* 확인")
    rows: list[list] = []
    for market, mrkt_tp in MARKET_PARAM.items():
        page = await client.call(API_ID, {"mrkt_tp": mrkt_tp})
        parsed = parse_market(page.rows, market)  # type: ignore[arg-type]
        print(f"  {market:6s} {len(page.rows):5d}행 → SPEC 안 {len(parsed):5d}행")
        rows.extend([r.code, r.name, r.market, r.security_type, r.nxt_enabled] for r in parsed)
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--account", type=int, default=0, help="키움 앱키 계정 번호(기본 0)")
    ap.add_argument("--write", action="store_true", help="시드 파일을 실제로 갱신")
    args = ap.parse_args(argv)

    load_env()
    rows = asyncio.run(_fetch(args.account))

    prior = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    n_y = sum(1 for r in rows if r[4] is True)
    print(f"\n총 {len(rows):,}행 (이전 {len(prior['rows']):,}행)")
    print(f"  nxt_enabled=True  {n_y:,}행")
    print(f"  schema_version    {prior.get('schema_version')} → {SCHEMA_VERSION}")

    if not args.write:
        print("\ndry-run 이다. 갱신하려면 --write 를 붙여라.")
        return 0

    # **기존 행 순서를 보존**한다 — 순서가 바뀌면 "5번째 원소 추가"여야 할 diff 가
    # 파일 전체 재작성(55K 줄)이 되어 리뷰가 불가능해진다. 새 종목만 뒤에 붙인다.
    fresh = {r[0]: r for r in rows}
    ordered: list[list] = []
    for old_row in prior["rows"]:
        r = fresh.pop(old_row[0], None)
        # 상장폐지 등으로 이번 응답에 없으면 옛 행을 살리되 nxt_enabled 는 **모름**(None).
        ordered.append(r if r is not None else [*old_row[:4], None])
    ordered.extend(fresh[c] for c in sorted(fresh))
    if fresh:
        print(f"  신규 종목 {len(fresh):,}개는 끝에 붙였다")

    payload = {
        "schema_version": SCHEMA_VERSION,
        "source": prior.get("source", "kiwoom ka10099 (mrkt_tp=0/10)"),
        "generated_on": datetime.now().strftime("%Y-%m-%d"),
        "note": prior.get("note", ""),
        "rows": ordered,
    }
    # indent=0 — 원본과 같은 포맷이라야 diff 가 값 변화만 보여준다.
    SEED_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=0) + "\n", encoding="utf-8"
    )
    print(f"\n갱신 완료 — {SEED_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
