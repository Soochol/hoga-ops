"""Verified individual account fills and shared account-history cursor/cache helpers."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

from hoga.trading.contracts import AccountExecution, AccountExecutions
from hoga.trading.kiwoom import code_of, integer
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST

_CURSOR_FIELDS = 4
_CACHE_LIMIT = 256


def parse_execution(row: dict, *, account_ref: str, date: str, code: str) -> AccountExecution | None:
    quantity = integer(row.get("cntr_qty"))
    if quantity is None:
        raise TradingError(503, "invalid-execution", "개별 체결 수량을 확인할 수 없습니다.")
    if int(quantity) == 0:
        return None  # Receipts, rejections and unfilled/canceled remainders aren't executions.
    native, number = str(row.get("ord_no", "")).strip(), str(row.get("cntr_no", "")).strip()
    clock = str(row.get("cntr_tm", "")).strip().replace(":", "")
    price = integer(row.get("cntr_uv"))
    actual_code = code_of(row.get("stk_cd", ""))
    side_text = str(row.get("io_tp_nm", ""))
    side = "BUY" if "매수" in side_text else "SELL" if "매도" in side_text else None
    if (actual_code != code or not re.fullmatch(r"\d{7}", native)
            or not re.fullmatch(r"\d{7}", number) or int(number) == 0
            or not re.fullmatch(r"\d{6}", clock) or price is None or int(price) <= 0 or side is None):
        raise TradingError(503, "invalid-execution", "개별 체결의 종목·번호·시각·가격을 확인할 수 없습니다.")
    stamp = int(datetime.strptime(date + clock, "%Y%m%d%H%M%S").replace(tzinfo=KST).timestamp() * 1000)
    raw_venue = str(row.get("dmst_stex_tp", "")).strip()
    venue = raw_venue if raw_venue in {"KRX", "NXT"} else None
    digest = hashlib.sha256(f"{account_ref}:{date}:{native}:{number}:{raw_venue}".encode()).hexdigest()
    return AccountExecution(execution_id=digest, order_ref=native, code=code, trading_date=date,
                            t_ms=stamp, side=side, price=price, quantity=quantity, venue=venue)


class ExecutionHistory:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "trading/executions.sqlite3"
        self.secret = secrets.token_bytes(32)
        self.cache: OrderedDict[tuple, tuple[float, AccountExecutions]] = OrderedDict()
        self.lock = asyncio.Lock()

    def cursor(self, scope: tuple[str, str, str], token: str) -> str:
        body = json.dumps([*scope, token], separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(hmac.digest(self.secret, body, "sha256") + body).decode()

    def decode(self, scope: tuple[str, str, str], token: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(token)
            if not hmac.compare_digest(raw[:32], hmac.digest(self.secret, raw[32:], "sha256")):
                raise ValueError("invalid signature")
            values = json.loads(raw[32:])
            if not isinstance(values, list) or len(values) != _CURSOR_FIELDS or tuple(values[:3]) != scope:
                raise ValueError("mismatched scope")
            if not isinstance(values[3], str) or not values[3]:
                raise ValueError("empty cursor")
            return values[3]
        except (ValueError, TypeError, UnicodeError) as exc:
            raise TradingError(
                422, "execution-cursor-expired", "체결 조회 연결이 만료되었습니다. 다시 조회하세요."
            ) from exc

    def archive(self, ref: str, code: str, date: str, rows: list[AccountExecution]) -> list[AccountExecution]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS fills (account TEXT, code TEXT, date TEXT, id TEXT, body TEXT, "
                       "PRIMARY KEY(account, code, date, id))")
            db.executemany("INSERT OR REPLACE INTO fills VALUES (?, ?, ?, ?, ?)",
                           [(ref, code, date, r.execution_id, r.model_dump_json()) for r in rows])
            stored = db.execute("SELECT body FROM fills WHERE account=? AND code=? AND date=?",
                                (ref, code, date)).fetchall()
        return sorted((AccountExecution.model_validate_json(r[0]) for r in stored),
                      key=lambda r: (r.t_ms, r.execution_id))

    @staticmethod
    async def original_close(adapter, code: str, date: str, venue: str) -> str | None:
        # The chart's own adjusted close / this original close gives its actual price basis,
        # even when the chart is seated at an older adjustment anchor. No guessed factors.
        suffix = {"KRX": "", "NXT": "_NX", "UN": "_AL"}[venue]
        daily, _ = await adapter.gateway.call("ka10081", {
            "stk_cd": code + suffix, "base_dt": date, "upd_stkpc_tp": "0",
        })
        daily_rows = daily.get("stk_dt_pole_chart_qry")
        if not isinstance(daily_rows, list) or any(not isinstance(bar, dict) for bar in daily_rows):
            raise adapter.gateway.failure(False)
        for bar in daily_rows:
            if str(bar.get("dt", "")) == date:
                text = str(bar.get("cur_prc", "")).lstrip("+-")
                price = integer(text, optional=True)
                return price if price is not None and int(price) > 0 else None
        return None

    async def read(self, adapter, ref: str, code: str, date: str, cursor: str | None, venue: str) -> AccountExecutions:
        scope = (ref, code, date + ":" + venue)
        native_cursor = self.decode(scope, cursor) if cursor else ""
        key = (*scope, native_cursor)
        today = datetime.now(KST).strftime("%Y%m%d")
        # Share requests across windows, including equal-day reads for different chart resolutions.
        async with self.lock:
            cached = self.cache.get(key)
            ttl = 5 if date == today else 300
            if cached and time.monotonic() - cached[0] < ttl:
                self.cache.move_to_end(key)
                return cached[1]
            page, next_key = await adapter.gateway.call("kt00009", {
                "ord_dt": date, "stk_bond_tp": "1", "mrkt_tp": "0", "sell_tp": "0", "qry_tp": "1",
                "stk_cd": code, "fr_ord_no": "", "dmst_stex_tp": "%",
            }, cursor=native_cursor)
            raw_rows = page.get("acnt_ord_cntr_prst_array")
            if not isinstance(raw_rows, list) or any(not isinstance(row, dict) for row in raw_rows):
                raise adapter.gateway.failure(False)
            if next_key and next_key == native_cursor:
                raise adapter.gateway.failure(False)
            rows: dict[str, AccountExecution] = {}
            for raw in raw_rows:
                if raw.get("acnt_no") and raw["acnt_no"] != adapter._account_no:
                    raise adapter.gateway.failure(False)
                clean = {k: v for k, v in raw.items() if k != "acnt_no"}
                row = parse_execution(clean, account_ref=ref, code=code, date=date)
                if row is not None:
                    # Publish the same account/date-bound opaque order identity as the order API.
                    row.order_ref = adapter.registry.order_ref(ref, row.order_ref, date, row.venue or "SOR")
                    previous = rows.get(row.execution_id)
                    if previous is not None and previous != row:
                        raise adapter.gateway.failure(False)
                    rows[row.execution_id] = row
            # Preserve confirmed individual fills across reloads and vendor retention windows.
            archived = await asyncio.to_thread(self.archive, ref, code, date, list(rows.values()))
            raw_close = next((result.raw_close for cached_key, (_age, result) in self.cache.items()
                              if cached_key[:3] == scope and result.raw_close is not None), None)
            if archived and date < today and raw_close is None:
                raw_close = await self.original_close(adapter, code, date, venue)
            result = AccountExecutions(account_ref=ref, code=code, date=date,
                                       rows=archived if not cursor else list(rows.values()),
                                       next_cursor=self.cursor(scope, next_key) if next_key else None,
                                       fetched_at_ms=int(time.time() * 1000), raw_close=raw_close, price_venue=venue)
            self.cache[key] = (time.monotonic(), result)
            while len(self.cache) > _CACHE_LIMIT:
                self.cache.popitem(last=False)
            return result
