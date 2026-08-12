"""장중 잠정 표본 → 마감 확정본 수렴 (#1115).

장중에 쌓은 표본은 **잠정**이다. 마감 뒤 같은 `base_dt` 를 다시 부르면 벤더가 확정값을
준다. 수렴시키지 않으면 어제 데이터가 "우리가 마지막으로 찍은 순간의 잠정치" 로 굳어
벤더 값과 조용히 어긋난다.

**⚠ 당일 17:00 확정본은 벤더 최종값이 아니다.** 마감 뒤 재조회가 곧 최종이라는 것이
#1115 의 암묵 전제였는데 2026-08-12 실측이 그것을 깼다(코스피 기관 `orgn_netprps`):

    확정 4일 뒤(8/3) · 3일(8/4) · 2일(8/5) · 1일(8/6)  →  Δ = 0
    당일 17:01 (8/7)   6915 → 7825   (+910, 13%)
    당일 17:21 (8/10)  3635 → 2464  (-1171, 32%)
    당일 17:02 (8/11)  1399 → 1204   (-195, 14%)

8/3~8/7 은 **같은 배치(8/7 17:01:02)가 썼는데 8/7 만 갈린다** — 배치도 파라미터도 아닌
"그날이 오늘이었는가" 가 원인이다. 그리고 수렴은 단조가 아니다(8/7 은 8880 장중 →
6915 확정 → 7825 최종으로 방향이 바뀐다). 그래서 "확정 시각만 조금 늦춘다" 는 처방은
안정 시점 실측 없이 고를 수 없었고, **다음 거래일 재확정**이 그 실측을 불필요하게
만든다 — D+1 은 이미 Δ0 이 실측된 지점이다(표본 4개).

**멱등 마커는 두 단계다.** 파일의 **존재**는 여전히 "표시상 확정"(화면 배지 · 일별
이력의 원천, `InvestorFlowStore.is_confirmed`)이지만, 배치가 "다시 물을 것인가" 를
판정하는 술어는 `is_final()` — 확정 스탬프의 KST 날짜가 대상일보다 뒤인가 — 다.
당일에 쓴 확정본은 비최종이라 다음 거래일 런이 덮어쓰고, 그 뒤로는 영구 스킵된다.
별도 상태 파일은 여전히 없다: 최종성도 파일 안 `confirmed_at_ms` 에서 파생한다.

호출부는 `scheduler.run_trading_stage` 다 — **삼값 달력 게이트 뒤**여야 한다. 휴장일에
확정본을 만들면 그날이 영원히 "확정된 빈 날" 이 된다.
"""
from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hoga.live.investor_flow_collector import AMT_QTY_AMOUNT_EOK, MARKETS, STEX_ALL
from hoga.live.investor_flow_store import DailyConfirmedFile, InvestorFlowStore
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

# 며칠을 거슬러 확인할 것인가. 연휴 + 하루 이틀의 업스트림 장애를 덮을 만큼이면 되고,
# 최종 확정된 날은 즉시 스킵되므로 넉넉해도 비용이 없다. **재확정에는 D+1 하루면
# 충분하므로**(위 실측) 이 창은 재확정 정책이 아니라 캐치업 여유로만 남는다.
CATCHUP_TRADING_DAYS = 5


def is_final(day: DailyConfirmedFile) -> bool:
    """이 확정본을 더 이상 다시 묻지 않아도 되는가.

    **판정은 "확정 스탬프의 KST 날짜 > 대상일"** 이다. 쓰기는 전부 거래일 게이트 뒤
    (`run_trading_stage`)에서만 일어나므로, 대상일보다 늦은 날짜의 스탬프는 자동으로
    "다음 거래일 이후" 를 뜻한다 — 거래일 달력을 여기서 다시 볼 필요가 없다.

    **"한 번 재확정했는가" 카운터가 아닌 이유**: 서버가 당일 저녁 재기동해 같은 날
    20:00 에 런이 한 번 더 돌면 그 두 번째 쓰기도 여전히 궤적 중간값이다. 날짜 비교면
    그 파일은 계속 비최종이라 다음 거래일이 다시 잡지만, 카운터면 오염값이 최종으로
    굳는다.

    `YYYYMMDD` 문자열은 고정폭 zero-padded 라 사전식 비교가 곧 날짜 비교다.
    """
    stamped = dt.datetime.fromtimestamp(day.confirmed_at_ms / 1000, tz=KST)
    return stamped.strftime("%Y%m%d") > day.date


def _changed_row_count(old: list[dict[str, Any]], new: list[dict[str, Any]]) -> int:
    """재확정이 실제로 몇 행을 바꿨나 — 당일-확정 편차의 공짜 텔레메트리."""
    old_by = {str(r.get("inds_cd") or ""): r for r in old}
    return sum(1 for r in new if old_by.get(str(r.get("inds_cd") or "")) != r)


async def confirm_days(
    data_dir: Path,
    *,
    dates: list[str],
    fetch_market_fn: Callable[[str, str], Awaitable[list[dict[str, Any]] | None]],
    now_ms_fn: Callable[[], int],
) -> int:
    """확정본이 없거나 **아직 최종이 아닌** 날을 채운다. 쓴 날 수를 반환.

    한 날짜의 실패가 나머지를 막지 않는다 — 확정은 날짜별로 독립이고, 못 채운 날은
    다음 런이 다시 본다(파일이 없으니 자동으로 재대상이 된다).

    스킵 판정에 `store.is_confirmed()` 가 아니라 `load_confirmed()` + `is_final()` 을
    쓴다. 부수효과로 **손상된 확정본이 자가 치유**된다 — 존재 검사만 하던 시절엔
    파싱 실패 파일이 영구히 "확정됨" 으로 남아 화면에서 그날이 통째로 사라졌다.
    """
    store = InvestorFlowStore(data_dir)
    filled = 0
    for date in dates:
        prev = store.load_confirmed(date)
        if prev is not None and is_final(prev):
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
        if prev is None:
            log.info("investor_flow.confirm.written date=%s rows=%d", date, len(rows))
        else:
            # 재확정 — 바뀐 행 수가 곧 "당일 확정본이 얼마나 틀렸나" 의 관측치다.
            # changed=0 이 쌓이면 이 재확정 자체가 불필요하다는 증거가 된다.
            log.info(
                "investor_flow.confirm.rewritten date=%s rows=%d changed=%d "
                "(당일 확정본은 벤더 최종값이 아니다)",
                date,
                len(rows),
                _changed_row_count(prev.rows, rows),
            )
    return filled
