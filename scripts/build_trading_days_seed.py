"""거래일 달력 시드 생성기 — PR-H (#1044).

KIS `CTCA0903R`(chk-holiday) 대체. **런타임에 벤더를 조회하지 않는다** — 여기서
역산한 결과를 리포에 커밋하고, 조회 경로는 그 파일만 읽는다.

## 왜 지수 일봉으로 거래일을 역산하는가

`ka20006`(업종일봉, `inds_cd=001` = KOSPI)은 **거래일에만 행이 존재한다.**
휴장일에는 봉 자체가 없다. 그래서 `dt` 목록이 곧 거래일 달력이다.
KIS chk-holiday 와 8개월 대조에서 **불일치 0**이었다(#1011).

## 사용

    uv run python scripts/build_trading_days_seed.py --from 20070101

`--check` 를 주면 파일을 쓰지 않고 기존 시드와 대조만 한다(CI·검산용).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hoga.api.trading_days import SEED_PATH, parse_seed
from hoga.env import load_env
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_runtime import ensure_token_provider_for_account

API_ID = "ka20006"
KOSPI = "001"
# 600행/페이지 ≈ 2.4년. 2007년까지 9페이지면 닿는다 — 여유를 둔다.
_MAX_PAGES = 30


async def collect(from_yyyymmdd: str, to_yyyymmdd: str) -> list[str]:
    load_env()
    prov = ensure_token_provider_for_account(0, Path.cwd() / "data")
    if prov is None:
        raise SystemExit("키움 자격증명이 없다 — 시드를 만들 수 없다")
    client = KiwoomRestClient(prov)
    try:
        days: set[str] = set()
        cursor = to_yyyymmdd
        for page_no in range(_MAX_PAGES):
            page = await client.call(API_ID, {"inds_cd": KOSPI, "base_dt": cursor})
            got = sorted({str(r.get("dt") or "") for r in page.rows if r.get("dt")})
            if not got:
                break
            days.update(d for d in got if from_yyyymmdd <= d <= to_yyyymmdd)
            oldest = got[0]
            print(f"  page {page_no + 1}: {len(got)}행  {oldest} ~ {got[-1]}", file=sys.stderr)
            if oldest <= from_yyyymmdd:
                break
            if oldest >= cursor:
                # 진행 보장 가드 — 보유 바닥에서 커서가 멈춘다(#1043 과 같은 성질).
                print(f"  커서 정체({oldest}) — 보유 바닥이다", file=sys.stderr)
                break
            cursor = oldest
        else:
            raise SystemExit(f"{_MAX_PAGES} 페이지로 {from_yyyymmdd} 에 못 닿았다")
        return sorted(days)
    finally:
        await client.aclose()


def render(days: list[str], *, generated_on: str) -> str:
    head = [
        "# KRX 거래일 목록 — 키움 ka20006(업종일봉 · inds_cd=001)에서 역산.",
        "# 그 TR 은 거래일에만 행이 존재하므로 dt 목록이 곧 거래일 달력이다.",
        "# KIS chk-holiday 와 8개월 대조 불일치 0 (#1011).",
        "#",
        "# 생성: scripts/build_trading_days_seed.py",
        f"# 생성일: {generated_on}",
        f"# 범위: {days[0]} ~ {days[-1]}  ({len(days)}일)",
        "#",
        "# **이 파일이 조회의 유일한 소스다** — 런타임은 벤더를 조회하지 않는다.",
        "# 파일 범위 밖 날짜는 '모른다'(None)로 답한다. 새 거래일은 스케줄러가",
        "# data_dir 오버레이에 덧붙인다(hoga/api/trading_days.py).",
        "",
    ]
    return "\n".join(head) + "\n".join(days) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="frm", default="20070101")
    ap.add_argument("--to", dest="to", default=datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    days = asyncio.run(collect(args.frm, args.to))
    if not days:
        raise SystemExit("거래일을 하나도 못 받았다")

    if args.check:
        existing = parse_seed(SEED_PATH.read_text(encoding="utf-8"))
        overlap = [d for d in days if d in existing or d <= max(existing)]
        missing = [d for d in overlap if d not in existing]
        extra = [d for d in sorted(existing) if args.frm <= d <= args.to and d not in set(days)]
        print(f"대조: 신규수집 {len(days)}일 · 기존 {len(existing)}일")
        print(f"  기존에 없는 날: {len(missing)}  {missing[:10]}")
        print(f"  기존에만 있는 날: {len(extra)}  {extra[:10]}")
        raise SystemExit(1 if (missing or extra) else 0)

    SEED_PATH.write_text(
        render(days, generated_on=datetime.now().strftime("%Y-%m-%d")),
        encoding="utf-8",
    )
    print(f"{SEED_PATH}: {len(days)}일 ({days[0]} ~ {days[-1]})")


if __name__ == "__main__":
    main()
