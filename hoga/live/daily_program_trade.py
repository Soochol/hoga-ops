"""Stock daily program quantities (ka90013), separate from intraday 0w sidecars.

Official contract: https://openapi.kiwoom.com/m/guide/apiguide/01/ka90013
The three quantity columns are shares; missing values stay null. One page carries
all trade sides, so changing the chart's display mode needs no vendor request.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from pydantic import BaseModel

from hoga.live import kiwoom_access, kiwoom_rest_runtime
from hoga.live.candle_models import daily_anchor_ms
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.single_flight import SingleFlight

_DATE_LENGTH = 8


class DailyProgramTradePoint(BaseModel):
    t_ms: int
    net_qty: int | None
    buy_qty: int | None
    sell_qty: int | None


@dataclass(frozen=True)
class ProgramTradeViolation:
    date_yyyymmdd: str
    reason: str
    detail: str


def _quantity(raw: object, *, gross: bool = False) -> int | None:
    if not isinstance(raw, (str, int)) or isinstance(raw, bool):
        return None
    try:
        value = int(str(raw).strip().replace(",", ""))
    except ValueError:
        return None
    return abs(value) if gross else value


async def fetch_daily_program_trade(client, code: str, from_s: str, to_s: str, *, run_page):
    def covered(rows, _page):
        dates = [str(row.get("dt", "")) for row in rows]
        return any(len(day) == _DATE_LENGTH and day.isdigit() and day < from_s for day in dates)

    rows, truncated = await client.walk(
        "ka90013", {"stk_cd": code, "date": to_s, "amt_qty_tp": "2"},
        max_pages=64, stop=covered, run_page=run_page,
    )
    # Never mark a truncated range as cached/complete. The shared walkback
    # converts this vendor error to a visible warning and allows a later retry.
    if truncated:
        raise KiwoomApiError("program_daily", "프로그램 매매 연속 조회 한도에 도달했습니다")
    points: dict[str, dict] = {}
    violations = []
    for row in rows:
        day = str(row.get("dt", ""))
        try:
            if len(day) != _DATE_LENGTH or not day.isdigit():
                raise ValueError
            datetime.strptime(day, "%Y%m%d")
        except ValueError:
            violations.append(ProgramTradeViolation("(unknown)", "malformed_row", "invalid date"))
            continue
        if not from_s <= day <= to_s or day in points:
            continue
        buy_qty = _quantity(row.get("prm_buy_qty"), gross=True)
        sell_qty = _quantity(row.get("prm_sell_qty"), gross=True)
        net_qty = _quantity(row.get("prm_netprps_qty"))
        # Net-selling days can have an unusable net field while both gross
        # share counts are present. Their exact difference recovers the net;
        # never substitute zero or infer a missing gross quantity.
        if net_qty is None and buy_qty is not None and sell_qty is not None:
            net_qty = buy_qty - sell_qty
        point = DailyProgramTradePoint(
            t_ms=daily_anchor_ms(day), net_qty=net_qty,
            buy_qty=buy_qty, sell_qty=sell_qty,
        )
        if any(value is None for value in (point.net_qty, point.buy_qty, point.sell_qty)):
            violations.append(ProgramTradeViolation(day, "malformed_row", "missing program quantity"))
        points[day] = point.model_dump()
    return [points[day] for day in sorted(points)], violations, None


class DailyProgramTradeBackfill:
    def __init__(self, *, data_dir, cache, scheduler, walkback):
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._walkback = walkback
        self._inflight = SingleFlight()

    async def collect(self, *, code, frm, too, today_d):
        async def fetch_batch(code_, from_s, to_s):
            client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
            if client is None:
                raise KiwoomApiError("program_daily", "kiwoom client not initialized")

            def run_page(fetch_fn, page_idx):
                return kiwoom_access.run_with_capacity(
                    self._scheduler,
                    key=("daily-program-trade", code_, from_s, to_s, page_idx),
                    api_id="ka90013", priority="background", client=client, fetch_fn=fetch_fn,
                )

            return await fetch_daily_program_trade(client, code_, from_s, to_s, run_page=run_page)

        async with self._inflight.acquire(code):
            return await self._walkback(
                cache=self._cache, fetch_batch=fetch_batch, output_key="points",
                code=code, frm=frm, too=too, today_d=today_d,
            )
