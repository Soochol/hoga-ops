"""Production collector: fixed anchor, historical confirmation and per-page governor."""

from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import asdict

from hoga.api import screener_daily_confirmation as confirmation
from hoga.api.screener_history_jobs import _candles_frame
from hoga.api.screener_recovery import RecoveryStop
from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.util.timeenc import KST


def _rows(code, result, target):
    amounts = {dt.datetime.fromtimestamp(c.t_ms / 1000, KST).date(): c.trade_value_won for c in result.candles}
    frame = _candles_frame(code, result.candles, target.first, target.last)
    return [
        {**row, "date": row["date"].isoformat(), "trade_value_won": amounts.get(row["date"]), "complete": True}
        for row in frame.to_dicts()
    ]


def collector(data_dir, *, client=None, scheduler=None, clock=None, pause=None):
    """The production owner supplies credentials; every check round goes to the broker."""
    clock = clock or (lambda: dt.datetime.now(KST))
    pause = pause or asyncio.sleep

    async def fetch(target, anchor, check):
        chosen = client or kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if chosen is None:
            raise RecoveryStop("kiwoom_credentials_unavailable")
        capacity = scheduler or kiwoom_rest_runtime.ensure_scheduler(data_dir)

        async def sample(round_index):
            started_at = clock()
            results = []
            for adjust in (False, True):
                async def page(fetch_fn, index, adjusted=adjust):
                    check()
                    result = await kiwoom_access.run_with_capacity(
                        capacity, key=("screener-recovery", target.code, anchor, round_index, adjusted, index),
                        api_id=kiwoom_daily_candles.API_ID, priority="background", client=chosen, fetch_fn=fetch_fn,
                    )
                    check()
                    return result

                result = await kiwoom_daily_candles.fetch_daily_candles(
                    chosen, target.code, target.first.strftime("%Y%m%d"), target.last.strftime("%Y%m%d"),
                    adjust=adjust, adjusted_as_of=anchor.strftime("%Y%m%d") if adjust else None, run_page=page,
                )
                results.append(result)
            return confirmation.DailySample(
                started_at=started_at, finished_at=clock(),
                unadjusted=_rows(target.code, results[0], target), adjusted=_rows(target.code, results[1], target),
                price_events=results[1].adjustment_events,
                provider_rows={"unadjusted": results[0].source_rows, "adjusted": results[1].source_rows},
                violations=[
                    {**asdict(violation), "basis": basis}
                    for basis, result in zip(("unadjusted", "adjusted"), results, strict=True)
                    for violation in result.violations
                ],
            )

        first = await sample(0)
        check()
        await pause(confirmation.RECHECK_SECONDS)
        check()
        second = await sample(1)
        evidence = confirmation.DailyConfirmation(first=first, second=second)
        payload = {
            "code": target.code, "adjusted_as_of": anchor.isoformat(),
            "observed_at": second.finished_at.isoformat(),
            **{field: getattr(second, field) for field in (*confirmation.FIELDS, "provider_rows")},
            "confirmation": evidence.model_dump(mode="json"),
        }
        confirmation.state(payload)
        return payload
    return fetch
