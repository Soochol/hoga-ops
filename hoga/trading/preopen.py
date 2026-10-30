"""KRX fixed-price morning orders: account-bound reads and a fresh send-time gate."""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

from hoga.api.trading_days import is_trading_day
from hoga.live.kiwoom_stock_info import _abs_price
from hoga.live.single_flight import SingleFlight
from hoga.trading.contracts import PreopenCloseQuote
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST

CACHE_SECONDS = 15
CACHE_SIZE = 256
WEEKEND = 5
SESSION_BOUNDS = 2


def now_kst() -> datetime:
    return datetime.now(KST)


def session(data_dir: Path, now: datetime) -> tuple[int, int, str | None]:
    """Unknown calendars fail closed. Explicit dated hours cover exceptional openings.

    calendar/preopen_sessions.json: {"20261119": ["09:30", "09:40"]}.
    A null entry closes that date. Invalid files never fall back to normal hours.
    """
    date = now.strftime("%Y%m%d")
    hours = ["08:30", "08:40"]
    verdict = is_trading_day(date, data_dir)
    path = data_dir / "calendar/preopen_sessions.json"
    try:
        if path.exists():
            entries = json.loads(path.read_text())
            if not isinstance(entries, dict):
                raise ValueError("invalid sessions")
            if date in entries:
                hours = entries[date]
                verdict = hours is not None
        if hours is None:
            hours = ["08:30", "08:40"]
        if not isinstance(hours, list) or len(hours) != SESSION_BOUNDS:
            raise ValueError("invalid hours")
        start, end = [
            int(datetime.strptime(date + h, "%Y%m%d%H:%M").replace(tzinfo=KST).timestamp() * 1000) for h in hours
        ]
        if not start < end:
            raise ValueError("invalid interval")
    except (OSError, ValueError, TypeError):
        return 0, 0, "장전 종가 거래시간 설정을 확인하세요."
    if now.weekday() >= WEEKEND or verdict is False:
        reason = "오늘은 장전 종가 거래일이 아닙니다."
    elif verdict is None:
        reason = "오늘의 거래일 정보가 확인되지 않았습니다."
    elif now.timestamp() * 1000 < start:
        reason = f"장전 종가는 {hours[0]}에 시작합니다."
    elif now.timestamp() * 1000 >= end:
        reason = "장전 종가 거래가 종료되었습니다."
    else:
        reason = None
    return start, end, reason


class PreopenClose:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self._cache: OrderedDict[tuple[str, str], tuple[float, str, int]] = OrderedDict()
        self._flight = SingleFlight()

    def check_clock(self, quote: PreopenCloseQuote) -> None:
        now = now_kst()
        start, end, reason = session(self.data_dir, now)
        if (reason or quote.trading_date != now.strftime("%Y%m%d")
                or (start, end) != (quote.starts_at_ms, quote.ends_at_ms)):
            raise TradingError(409, "preopen-session-closed", reason or "거래일·거래시간이 변경되었습니다.")

    async def quote(self, adapter, ref: str, code: str, *, fresh: bool = False) -> PreopenCloseQuote:
        now = now_kst()
        start, end, clock_reason = session(self.data_dir, now)
        quote = PreopenCloseQuote(account_ref=ref, code=code, trading_date=now.strftime("%Y%m%d"),
                                 starts_at_ms=start, ends_at_ms=end, fetched_at_ms=int(now.timestamp() * 1000))
        if adapter is None:
            quote.reason = "토스 OpenAPI는 장전 시간외 종가 주문을 지원하지 않습니다."
            return quote
        if adapter.gateway.environment != "real":
            quote.reason = "장전 종가 주문은 키움 실전 계좌에서 지원합니다."
            return quote
        key = (ref, code)
        async with self._flight.acquire(key):
            cached = self._cache.get(key)
            if (not fresh and cached and cached[1] == quote.trading_date
                    and time.monotonic() - cached[0] < CACHE_SECONDS):
                price = cached[2]
                self._cache.move_to_end(key)
            else:
                # Discard last-good data on failed eligibility reads; orders never reuse it.
                self._cache.pop(key, None)
                info, limits = await asyncio.gather(
                    adapter.gateway.call("ka10100", {"stk_cd": code}),
                    adapter.gateway.call("ka10001", {"stk_cd": code}),
                )
                stock, basic = info[0], limits[0]
                if stock.get("code") != code or basic.get("stk_cd") != code:
                    raise TradingError(503, "preopen-stock-mismatch", "장전 종가 종목 정보를 확인할 수 없습니다.")
                if stock.get("nxtEnable") != "N":
                    quote.reason = "장전 종가는 NXT 미지원이 확인된 종목에서 제공합니다."
                    return quote
                if str(stock.get("marketCode")) not in {"0", "10", "8", "60", "70", "90"}:
                    quote.reason = "장전 종가 지원 대상 종목이 아닙니다."
                    return quote
                if "거래정지" in str(stock.get("state", "")):
                    quote.reason = "거래정지 종목은 장전 종가 주문을 할 수 없습니다."
                    return quote
                price = _abs_price(basic.get("base_pric"))
                if price is None or _abs_price(stock.get("lastPrice")) is None:
                    quote.reason = "장전 종가 적용 가격을 확인할 수 없습니다."
                    return quote
                self._cache[key] = (time.monotonic(), quote.trading_date, price)
                if len(self._cache) > CACHE_SIZE:
                    self._cache.popitem(last=False)
        quote.supported = True
        quote.price = price
        quote.reason = clock_reason
        quote.can_order = clock_reason is None
        return quote
