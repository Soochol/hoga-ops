"""Display-only US FE observations. The domestic manager owns the account lease."""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import time
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation

import websockets
from pydantic import BaseModel, Field
from websockets.exceptions import WebSocketException

from .candle_models import daily_anchor_ms
from .kiwoom_token_provider import KiwoomAuthError
from .us_daily_candles import NY, UsDailyBar

EXCHANGES = {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}
WIRE_EXCHANGES = {v: k for k, v in EXCHANGES.items()}
SYMBOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]{0,19}\Z")
MAX_SUBJECTS = 200
MAX_MINUTES = 391
MAX_AGE_MS = 180_000
REGULAR_OPEN = 9 * 60 + 30
REGULAR_CLOSE = 16 * 60


class UsObservedMinute(UsDailyBar):
    observed_at_ms: int


class UsStockCandleEvent(BaseModel):
    type: str = "us_stock_candles"
    instrument_key: str
    generation: str
    sequence: int
    status: str
    checked_at_ms: int
    minutes: list[UsObservedMinute] = Field(default_factory=list)
    daily: UsDailyBar | None = None


def valid_subject(exchange, symbol) -> bool:
    return isinstance(exchange, str) and exchange in WIRE_EXCHANGES and isinstance(symbol, str) and bool(
        SYMBOL.fullmatch(symbol)
    )


def parse_observation(row, now_ms):
    if not isinstance(row, dict) or row.get("type") != "FE":
        return None
    wire_exchange = row.get("stexTp")
    if not isinstance(wire_exchange, str):
        return None
    exchange, symbol, values = EXCHANGES.get(wire_exchange), row.get("item"), row.get("values")
    if not valid_subject(exchange, symbol) or not isinstance(values, dict) or values.get("290") != "0":
        return None
    try:
        stamp = str(values["22"]) + str(values["51020"])
        wall = datetime.strptime(stamp, "%Y%m%d%H%M%S")
        minute = wall.hour * 60 + wall.minute
        if len(stamp) != len("YYYYMMDDHHMMSS") or wall.second or not REGULAR_OPEN <= minute < REGULAR_CLOSE:
            return None
        local = wall.replace(tzinfo=NY)
        observed = int(local.timestamp() * 1000)
        now = datetime.fromtimestamp(now_ms / 1000, NY)
        if local.date() != now.date() or observed > now_ms + 60_000 or now_ms - observed > MAX_AGE_MS:
            return None
        op, hi, lo, cl = [abs(Decimal(str(values[k]).replace(",", ""))) for k in ("16", "17", "18", "10")]
        if any(not v.is_finite() or v <= 0 for v in (op, hi, lo, cl)) or not lo <= min(op, cl) <= max(op, cl) <= hi:
            return None
    except (ValueError, KeyError, InvalidOperation, TypeError):
        return None
    return (exchange, symbol), UsDailyBar(trading_date=stamp[:8], t_ms=daily_anchor_ms(stamp[:8]),
                                         open=float(op), high=float(hi), low=float(lo), close=float(cl)), observed


class UsStockRealtime:
    def __init__(self, publish, *, token_fn, now_fn=lambda: int(time.time() * 1000), connect=websockets.connect,
                 invalidate_fn=None):
        self.publish, self.token_fn, self.now_fn, self.connect = publish, token_fn, now_fn, connect
        self.invalidate_fn = invalidate_fn
        self.account = None
        self.subjects = frozenset()
        self.task = None
        self.generation = uuid.uuid4().hex
        self.sequence = 0
        self.status = "waiting_account"
        self.minutes: dict[tuple, dict[int, UsObservedMinute]] = {}
        self.daily = {}
        self.observed = {}
        self.dirty = set()

    def event(self, key, *, seed=False):
        minutes = list(self.minutes.get(key, {}).values()) if seed else [
            bar for stamp, bar in self.minutes.get(key, {}).items() if (key, stamp) in self.dirty
        ]
        return UsStockCandleEvent(instrument_key=f"us-stock:{key[0]}:{key[1]}", generation=self.generation,
                                  sequence=self.sequence, checked_at_ms=self.observed.get(key, self.now_fn()),
                                  status=self.status,
                                  minutes=minutes, daily=self.daily.get(key)).model_dump()

    def ingest(self, row):
        parsed = parse_observation(row, self.now_fn())
        if parsed is None:
            return
        key, day, stamp = parsed
        if key not in self.subjects:
            return
        bars = self.minutes.setdefault(key, {})
        if bars and stamp < next(reversed(bars)):
            return
        if self.daily.get(key) and self.daily[key].trading_date != day.trading_date:
            bars.clear()
        previous = bars.get(stamp)
        bars[stamp] = UsObservedMinute(
            trading_date=day.trading_date, t_ms=stamp, open=previous.open if previous else day.close,
            high=max(previous.high, day.close) if previous else day.close,
            low=min(previous.low, day.close) if previous else day.close, close=day.close,
            observed_at_ms=self.now_fn(),
        )
        if len(bars) > MAX_MINUTES:
            del bars[next(iter(bars))]
        self.daily[key] = day
        self.observed[key] = self.now_fn()
        self.dirty.add((key, stamp))
        self.status = "streaming"
        self.sequence += 1

    async def configure(self, account, subjects):
        subjects = frozenset(subjects)
        if self.account == account and self.subjects == subjects and self.task and not self.task.done():
            return
        await self.stop()
        self.account, self.subjects = account, subjects
        self.minutes.clear()
        self.daily.clear()
        self.observed.clear()
        self.dirty.clear()
        self.generation, self.sequence = uuid.uuid4().hex, 0
        self.status = "connecting" if account is not None else "waiting_account"
        for key in subjects:
            self.publish(self.event(key))
        if account is not None and subjects:
            self.task = asyncio.create_task(self.run(), name="us-stock-fe")

    async def stop(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None

    async def flush(self):
        while True:
            await asyncio.sleep(1)
            keys = {key for key, _stamp in self.dirty}
            events = [self.event(key) for key in keys]
            self.dirty.clear()
            for event in events:
                self.publish(event)
                await asyncio.sleep(0)

    async def login(self, ws):
        await ws.send(json.dumps({"trnm": "LOGIN", "token": await self.token_fn(self.account)}))
        while True:
            reply = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if not isinstance(reply, dict):
                raise ValueError("invalid US login envelope")
            if reply.get("trnm") != "PING":
                break
            await ws.send(json.dumps(reply))
        if reply.get("trnm") != "LOGIN" or reply.get("return_code") != 0:
            if self.invalidate_fn:
                await self.invalidate_fn(self.account)
            raise ConnectionError("US login rejected")

    async def run(self):
        delay = 1
        while True:
            try:
                async with self.connect("wss://api.kiwoom.com:10000/api/us/websocket",
                                        open_timeout=12, close_timeout=3, max_size=2**21) as ws:
                    await self.login(ws)
                    self.generation, self.sequence = uuid.uuid4().hex, 0
                    self.minutes.clear()
                    self.daily.clear()
                    self.observed.clear()
                    self.dirty.clear()
                    await ws.send(json.dumps({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{
                        "item": [{"jmcode": symbol, "stex_tp": WIRE_EXCHANGES[exchange]}
                                 for exchange, symbol in sorted(self.subjects)], "type": ["FE"]}]}))
                    flush = asyncio.create_task(self.flush())
                    try:
                        while True:
                            raw = await asyncio.wait_for(ws.recv(), 60)
                            message = json.loads(raw)
                            if not isinstance(message, dict):
                                raise ValueError("invalid US event envelope")
                            if message.get("trnm") == "PING":
                                await ws.send(raw)
                            elif message.get("trnm") == "REG" and message.get("return_code") != 0:
                                raise ConnectionError("US registration rejected")
                            elif message.get("trnm") == "REAL":
                                data = message.get("data", [])
                                if not isinstance(data, list):
                                    raise ValueError("invalid US data envelope")
                                for row in data:
                                    self.ingest(row)
                                delay = 1
                    finally:
                        flush.cancel()
                        await asyncio.gather(flush, return_exceptions=True)
            except (WebSocketException, OSError, TimeoutError, ValueError, TypeError, KiwoomAuthError):
                self.status = "error"
                self.sequence += 1
                for key in self.subjects:
                    self.publish(self.event(key))
            await asyncio.sleep(delay)
            delay = min(60, delay * 2)
