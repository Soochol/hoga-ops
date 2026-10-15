"""Supplier-provided program quantity changes, paged by ka90008's opaque key."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from hoga.api.models import ProgramTradeHistoryResponse, ProgramTradeTickRow
from hoga.util.timeenc import KST

from . import kiwoom_access, kiwoom_rest_runtime
from .kiwoom_errors import KiwoomRestError
from .kiwoom_rest import KiwoomRestClient, Page
from .market_overview import signed_int

_SUFFIX = {"KRX": "", "NXT": "_NX", "UN": "_AL"}
_LABEL = {"KRX": "KRX", "NXT": "NXT", "UN": "통합"}
_CLOCK_LENGTH = 6


def _integer(value: object) -> int | None:
    text = str(value).strip().replace(",", "")
    return signed_int(text) if re.fullmatch(r"[+-]*[0-9]+", text) else None


def parse_page(page: Page, *, code: str, date: str, venue: str, next_key: str | None) -> ProgramTradeHistoryResponse:
    if not isinstance(page.raw.get("stk_tm_prm_trde_trnsn"), list):
        raise KiwoomRestError("ka90008: missing history rows")
    if page.cont and (not page.next_key or page.next_key == next_key):
        raise KiwoomRestError("ka90008: history cursor did not advance")
    rows: list[ProgramTradeTickRow] = []
    seen: set[str] = set()
    latest: int | None = None
    for raw in page.rows:
        if raw.get("stex_tp") and raw["stex_tp"] != _LABEL[venue]:
            raise KiwoomRestError("ka90008: mismatched venue")
        clock = raw.get("tm")
        if not isinstance(clock, str) or len(clock) != _CLOCK_LENGTH or not clock.isdigit():
            continue
        try:
            stamp = int(datetime.strptime(date + clock, "%Y%m%d%H%M%S").replace(tzinfo=KST).timestamp() * 1000)
        except ValueError:
            continue
        latest = max(latest or stamp, stamp)
        qty = _integer(raw.get("prm_netprps_qty_irds"))
        if qty is None or qty == 0:
            continue
        price = _integer(raw.get("cur_prc"))
        # Cumulative fields distinguish legitimate equal-second/equal-size reports.
        # A repeated boundary row has the same identity on both vendor pages.
        digest = hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
        event_id = f"ka90008:{code}:{date}:{venue}:{digest}"
        if event_id in seen:
            continue
        seen.add(event_id)
        rows.append(ProgramTradeTickRow(event_id=event_id, t_ms=stamp,
                                       price=abs(price) if price else None, event_delta_qty=qty))
    rows.sort(key=lambda row: row.t_ms, reverse=True)
    return ProgramTradeHistoryResponse(code=code, date=date, venue=venue, rows=rows,
                                      next_key=page.next_key if page.cont else None, latest_at_ms=latest)


async def fetch_history(
    data_dir: Path, *, code: str, date: str, venue: str, next_key: str | None,
) -> ProgramTradeHistoryResponse:
    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        raise KiwoomRestError("kiwoom client not initialized")
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
    body = {"stk_cd": code + _SUFFIX[venue], "date": date, "amt_qty_tp": "2"}

    async def fetch(picked: KiwoomRestClient) -> Page:
        return await picked.call("ka90008", body, cont=bool(next_key), next_key=next_key or "")

    page = await kiwoom_access.run_with_capacity(
        scheduler, key=("program-trade-history", code, date, venue, next_key),
        api_id="ka90008", priority="user_visible", fetch_fn=fetch, client=client,
    )
    return parse_page(page, code=code, date=date, venue=venue, next_key=next_key)
