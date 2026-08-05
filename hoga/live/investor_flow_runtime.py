"""investor-flow 수집기·확정 수렴의 런타임 배선 (자격증명·거버너 결선).

수집기 본체(`investor_flow_collector`)와 확정 로직(`investor_flow_confirm`)은 순수하게
주입만 받는다 — 실제 키움 클라이언트·거버너를 붙이는 **지저분한 자리**를 여기 한 곳에
모아, 테스트가 본체를 자격증명 없이 돌릴 수 있게 한다.

**무자격이면 조용히 휴면한다**(ADR-0134). dev·워크트리는 키를 비워 두는 것이 기본이라
`ensure_rest_client` 가 None 을 돌려주는 것이 정상 경로다 — 크래시가 아니라 미기동이
옳고, 그래서 스케줄러도 이 경우 태스크를 아예 만들지 않는다(만들면 health 에 영원히
"도는 중인데 아무것도 안 하는" 거짓 행이 남는다).
"""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path
from typing import Any

from hoga.live.investor_flow_collector import InvestorFlowCollector, make_kiwoom_fetch
from hoga.live.investor_flow_confirm import CATCHUP_TRADING_DAYS, confirm_days

log = logging.getLogger(__name__)


def _kiwoom_seam(data_dir: Path) -> tuple[Any, Any] | None:
    """(거버너, 클라이언트). 무자격이면 None — 호출부는 휴면한다."""
    from hoga.live import kiwoom_rest_runtime  # noqa: PLC0415 — 지연 import(heavy·시임)

    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        return None
    return kiwoom_rest_runtime.ensure_scheduler(data_dir), client


def is_available(data_dir: Path) -> bool:
    """키움 자격증명이 있어 수집이 가능한가. 스케줄러가 태스크 생성 여부를 결정한다."""
    from hoga.live import kiwoom_runtime  # noqa: PLC0415

    return bool(kiwoom_runtime.configured_account_ids(data_dir))


def make_collector(data_dir: Path) -> InvestorFlowCollector | None:
    """실 클라이언트에 결선된 수집기. 무자격이면 None."""
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415

    seam = _kiwoom_seam(data_dir)
    if seam is None:
        log.info("investor_flow: 키움 자격증명 없음 — 수집기 미기동(정상, ADR-0134)")
        return None
    scheduler, client = seam
    return InvestorFlowCollector(
        data_dir=data_dir,
        date_fn=lambda: now_kst().strftime("%Y%m%d"),
        now_ms_fn=lambda: int(now_kst().timestamp() * 1000),
        fetch_market_fn=make_kiwoom_fetch(scheduler, client),
    )


async def confirm_recent(data_dir: Path, *, now: dt.datetime) -> int:
    """최근 거래일 중 확정본이 없는 날을 채운다. 무자격이면 0.

    거래일 목록은 달력 SSOT 에서 받는다 — 주말·휴장일에 확정본을 만들면 그날이
    영원히 "확정된 빈 날" 이 되기 때문이다.
    """
    seam = _kiwoom_seam(data_dir)
    if seam is None:
        return 0
    scheduler, client = seam

    from hoga.api.calendar import trading_days_in_range  # noqa: PLC0415

    end = now.strftime("%Y%m%d")
    start = (now - dt.timedelta(days=CATCHUP_TRADING_DAYS * 3)).strftime("%Y%m%d")
    days = trading_days_in_range(start, end)
    if not days:
        return 0
    recent = sorted(days)[-CATCHUP_TRADING_DAYS:]
    return await confirm_days(
        data_dir,
        dates=recent,
        fetch_market_fn=make_kiwoom_fetch(scheduler, client),
        now_ms_fn=lambda: int(now.timestamp() * 1000),
    )
