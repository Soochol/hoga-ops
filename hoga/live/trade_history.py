"""On-demand ka10003 execution history, independent of aggregated candle storage."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from hoga.api.models import TradeHistoryResponse, TradeHistoryRow
from hoga.util.timeenc import KST

from . import kiwoom_access, kiwoom_rest_runtime
from .kiwoom_errors import KiwoomRestError
from .kiwoom_rest import KiwoomRestClient, Page
from .market_overview import signed_int

_SUFFIX = {"KRX": "", "NXT": "_NX", "UN": "_AL"}
_LABELS = {"KRX": {"KRX"}, "NXT": {"NXT"}, "UN": {"통합", "KRX", "NXT"}}
_CLOCK_LENGTH = 6


def _integer(value: object) -> int | None:
    text = str(value).strip().replace(",", "")
    return signed_int(text) if re.fullmatch(r"[+-]*[0-9]+", text) else None


def parse_page(page: Page, *, code: str, date: str, venue: str, next_key: str | None) -> TradeHistoryResponse:
    if not isinstance(page.raw.get("cntr_infr"), list):
        raise KiwoomRestError("ka10003: missing execution rows")
    if page.cont and (not page.next_key or page.next_key == next_key):
        raise KiwoomRestError("ka10003: history cursor did not advance")
    rows: list[TradeHistoryRow] = []
    seen: set[str] = set()
    prev_close = None
    for raw in page.rows:
        # ka10003's unified response labels individual rows KRX/NXT (live probe).
        if raw.get("stex_tp") and raw["stex_tp"] not in _LABELS[venue]:
            raise KiwoomRestError("ka10003: mismatched venue")
        clock = raw.get("tm")
        if not isinstance(clock, str) or len(clock) != _CLOCK_LENGTH or not clock.isdigit():
            continue
        try:
            stamp = int(datetime.strptime(date + clock, "%Y%m%d%H%M%S").replace(tzinfo=KST).timestamp() * 1000)
        except ValueError:
            continue
        price, qty = _integer(raw.get("cur_prc")), _integer(raw.get("cntr_trde_qty"))
        if not price or not qty:
            continue
        volume = _integer(raw.get("acc_trde_qty"))
        volume = volume if volume is not None and volume > 0 else None
        delta = _integer(raw.get("pred_pre"))
        if prev_close is None and delta is not None and abs(price) - delta > 0:
            prev_close = abs(price) - delta
        # The cumulative quantity distinguishes equal-second, equal-size executions.
        digest = hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
        event_id = f"ka10003:{code}:{date}:{venue}:{digest}"
        if event_id in seen:
            continue
        seen.add(event_id)
        rows.append(TradeHistoryRow(event_id=event_id, t_ms=stamp, price=abs(price), qty=abs(qty),
                                    side=1 if qty > 0 else -1, cum_volume=volume))
    # Stable sorting retains supplier order for equal times without a sequence.
    rows.sort(key=lambda row: (row.t_ms, row.cum_volume or 0), reverse=True)
    latest = rows[0] if rows else None
    return TradeHistoryResponse(code=code, date=date, venue=venue, rows=rows,
                                next_key=page.next_key if page.cont else None,
                                latest_at_ms=latest.t_ms if latest else None,
                                latest_volume=latest.cum_volume if latest else None, prev_close=prev_close)


async def fetch_history(
    data_dir: Path, *, code: str, date: str, venue: str, next_key: str | None,
) -> TradeHistoryResponse:
    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        raise KiwoomRestError("kiwoom client not initialized")
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)

    async def fetch(picked: KiwoomRestClient) -> Page:
        return await picked.call("ka10003", {"stk_cd": code + _SUFFIX[venue]},
                                 cont=bool(next_key), next_key=next_key or "")

    page = await kiwoom_access.run_with_capacity(
        scheduler, key=("trade-history", code, date, venue, next_key), api_id="ka10003",
        priority="user_visible", fetch_fn=fetch, client=client,
    )
    return parse_page(page, code=code, date=date, venue=venue, next_key=next_key)
