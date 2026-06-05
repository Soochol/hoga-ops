"""KIS 국내휴장일조회 (CTCA0903R) — sync trading-day source for the calendar.

Sync httpx.Client (NOT KisClient's AsyncClient) so the executor/threadpool
calendar path calls it without the event-loop-binding hazard (ADR-0050
amendment). The bearer token comes from the shared KisTokenProvider via
kis_runtime — one cache + cooldown with the async fetch path.

Probe-verified 2026-06-05: one call returns ~24 rows forward from BASS_DT;
output keys are bass_dt/wday_dvsn_cd/bzdy_yn/tr_day_yn/opnd_yn/sttl_day_yn;
trading day ⇔ opnd_yn == "Y". We advance BASS_DT past the last returned row
until the target month is covered — robust whether KIS returns one day or
many per call. Cold-path only (results are month-cached by calendar.py);
sequential calls self-throttle on network RTT, no rate-limit handling needed.
"""
from __future__ import annotations

import calendar as stdlib_calendar
import datetime as _dt

import httpx

_PATH = "/uapi/domestic-stock/v1/quotations/chk-holiday"
_TR_ID = "CTCA0903R"
# 24+ rows/call → a month is ~2 calls; this guards a runaway loop, not quota.
_MAX_CALLS_PER_MONTH = 8

# Test seam: tests inject an httpx.MockTransport here (module-level on purpose
# — the sync client is built per fetch, so there is no instance to inject into).
_transport_for_tests: httpx.BaseTransport | None = None


class KisHolidayFetchError(Exception):
    """creds-missing / HTTP / rt_cd / parse failure.
    Maps to UpstreamCode.KIS_HOLIDAY_FETCH_FAILED."""


def _resolve_provider():
    """Return (token, app_key, app_secret, base_url) or None when creds absent.

    Late import + tiny tuple so tests monkeypatch THIS seam without touching
    kis_runtime. Token issuance/cooldown lives in KisTokenProvider (Phase 1).
    """
    from hoga.live.kis_runtime import ensure_kis_token_provider_from_env

    got = ensure_kis_token_provider_from_env()
    if got is None:
        return None
    provider, creds = got
    return provider.get_token(), creds.app_key, creds.app_secret, creds.base_url


def _collect_month_from_pages(pages: list[list[dict]], year: int, month: int) -> set[str]:
    """Pure: filter opnd_yn=='Y' rows belonging to (year, month)."""
    prefix = f"{year:04d}{month:02d}"
    out: set[str] = set()
    for rows in pages:
        for r in rows:
            d = str(r.get("bass_dt", ""))
            if d.startswith(prefix) and r.get("opnd_yn") == "Y":
                out.add(d)
    return out


def fetch_month_trading_days(year: int, month: int) -> set[str]:
    """Trading days (opnd_yn=='Y') of (year, month) via BASS_DT-advance loop.

    Raises KisHolidayFetchError on any failure — calendar._trading_days_for
    maps that to None → weekday fallback. Never returns a partial month
    silently: the loop runs until the month-end is covered or raises.
    """
    resolved = _resolve_provider()
    if resolved is None:
        raise KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")
    token, app_key, app_secret, base_url = resolved

    last_day = stdlib_calendar.monthrange(year, month)[1]
    month_end = f"{year:04d}{month:02d}{last_day:02d}"
    bass_dt = f"{year:04d}{month:02d}01"
    pages: list[list[dict]] = []

    with httpx.Client(base_url=base_url, transport=_transport_for_tests, timeout=15.0) as client:
        for _ in range(_MAX_CALLS_PER_MONTH):
            try:
                resp = client.get(
                    _PATH,
                    params={"BASS_DT": bass_dt, "CTX_AREA_FK": "", "CTX_AREA_NK": ""},
                    headers={
                        "authorization": f"Bearer {token}",
                        "appkey": app_key,
                        "appsecret": app_secret,
                        "tr_id": _TR_ID,
                        "custtype": "P",
                    },
                )
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:  # noqa: BLE001 — network/HTTP/JSON → one failure class
                raise KisHolidayFetchError(f"chk-holiday call failed: {e}") from e
            if body.get("rt_cd") != "0":
                raise KisHolidayFetchError(
                    f"chk-holiday rt_cd={body.get('rt_cd')} msg={body.get('msg1', '')[:100]}"
                )
            out = body.get("output")
            rows = out if isinstance(out, list) else [out] if isinstance(out, dict) else []
            if not rows:
                raise KisHolidayFetchError("chk-holiday returned no rows")
            pages.append(rows)
            last = max(str(r.get("bass_dt", "")) for r in rows)
            if last >= month_end:
                return _collect_month_from_pages(pages, year, month)
            # advance BASS_DT past the last returned row
            nxt = _dt.date(int(last[:4]), int(last[4:6]), int(last[6:8])) + _dt.timedelta(days=1)
            bass_dt = nxt.strftime("%Y%m%d")
    raise KisHolidayFetchError(
        f"month {year}-{month:02d} not covered after {_MAX_CALLS_PER_MONTH} calls"
    )
