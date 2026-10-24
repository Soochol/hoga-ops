"""Production raw collector: fixed page budget, existing background governor, compact original rows."""

from __future__ import annotations

import datetime as dt
from dataclasses import asdict

from hoga.api.screener_daily_ingest import MAX_PAGES, RawSample
from hoga.live import kiwoom_access, kiwoom_daily_candles
from hoga.util.timeenc import KST


def collector(client, scheduler, *, runner=None):
    capacity = runner or kiwoom_access.run_with_capacity

    async def fetch(code, first, last, round_index):
        started = dt.datetime.now(KST)
        pages = 0

        def page(fetch_fn, index):
            nonlocal pages
            if pages >= MAX_PAGES:
                raise RuntimeError("daily_ingest_page_budget_exhausted")
            pages += 1
            return capacity(
                scheduler,
                key=("daily-ingest", code, first, last, round_index, started.isoformat(), index),
                api_id="ka10081",
                priority="background",
                client=client,
                fetch_fn=fetch_fn,
            )

        result = await kiwoom_daily_candles.fetch_daily_candles(
            client,
            code,
            first.strftime("%Y%m%d"),
            last.strftime("%Y%m%d"),
            adjust=False,
            adjusted_as_of=None,
            run_page=page,
        )
        rows = [
            {
                "code": code,
                "date": dt.datetime.fromtimestamp(c.t_ms / 1000, KST).date().isoformat(),
                **{k: getattr(c, k) for k in ("open", "high", "low", "close", "volume")},
            }
            for c in result.candles
            if first <= dt.datetime.fromtimestamp(c.t_ms / 1000, KST).date() <= last
        ]
        for row in rows:
            if row["volume"] != int(row["volume"]):
                raise ValueError("Nonintegral daily quantity")
            row["volume"] = int(row["volume"])
        raw = [
            r for r in result.source_rows if first.strftime("%Y%m%d") <= str(r.get("dt", "")) <= last.strftime("%Y%m%d")
        ]
        return RawSample(
            code, started, dt.datetime.now(KST), rows, raw, [asdict(v) for v in result.violations], pages=pages
        )

    return fetch
