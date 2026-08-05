"""장중 잠정 표본 → 마감 확정본 수렴 (#1115).

장중에 쌓은 표본은 **잠정**이다. 마감 뒤 같은 `base_dt` 를 다시 부르면 벤더가 확정값을
준다. 수렴시키지 않으면 어제 데이터가 "우리가 마지막으로 찍은 순간의 잠정치" 로 굳어
벤더 값과 조용히 어긋난다.

**멱등 마커는 확정 파일의 존재 자체다.** 별도 상태 파일을 두지 않는다 — 그래서 이
모듈은 "최근 N거래일 중 확정본이 없는 날" 을 찾아 채우는 것으로 충분하고, 오늘 실패해도
내일 런이 자동으로 주워 간다(`watchlist-catchup` 과 같은 정신).

호출부는 `scheduler.run_trading_stage` 다 — **삼값 달력 게이트 뒤**여야 한다. 휴장일에
확정본을 만들면 그날이 영원히 "확정된 빈 날" 이 된다.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hoga.live.investor_flow_collector import AMT_QTY_AMOUNT_EOK, MARKETS, STEX_ALL
from hoga.live.investor_flow_store import DailyConfirmedFile, InvestorFlowStore

log = logging.getLogger(__name__)

# 며칠을 거슬러 확인할 것인가. 연휴 + 하루 이틀의 업스트림 장애를 덮을 만큼이면 되고,
# 이미 확정된 날은 파일 존재로 즉시 스킵되므로 넉넉해도 비용이 없다.
CATCHUP_TRADING_DAYS = 5


async def confirm_days(
    data_dir: Path,
    *,
    dates: list[str],
    fetch_market_fn: Callable[[str, str], Awaitable[list[dict[str, Any]] | None]],
    now_ms_fn: Callable[[], int],
) -> int:
    """확정본이 없는 날을 채운다. 채운 날 수를 반환.

    한 날짜의 실패가 나머지를 막지 않는다 — 확정은 날짜별로 독립이고, 못 채운 날은
    다음 런이 다시 본다(파일이 없으니 자동으로 재대상이 된다).
    """
    store = InvestorFlowStore(data_dir)
    filled = 0
    for date in dates:
        if store.is_confirmed(date):
            continue
        rows: list[dict[str, Any]] = []
        ok = True
        for mrkt_tp in MARKETS:
            got = await fetch_market_fn(mrkt_tp, date)
            if got is None:
                # 한 시장이라도 못 받으면 그날은 확정하지 않는다 — 반쪽 확정본을
                # 쓰면 파일 존재가 곧 확정이라는 계약이 거짓말이 된다.
                ok = False
                break
            rows.extend(got)
        if not ok:
            log.info("investor_flow.confirm.deferred date=%s (다음 런에서 재시도)", date)
            continue
        store.write_confirmed(
            DailyConfirmedFile(
                date=date,
                confirmed_at_ms=now_ms_fn(),
                request={
                    "mrkt_tp": ",".join(MARKETS),
                    "amt_qty_tp": AMT_QTY_AMOUNT_EOK,
                    "base_dt": date,
                    "stex_tp": STEX_ALL,
                },
                rows=rows,
            )
        )
        filled += 1
        log.info("investor_flow.confirm.written date=%s rows=%d", date, len(rows))
    return filled
