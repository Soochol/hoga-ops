"""KIS 국내휴장일조회 (CTCA0903R) — sync trading-day source for the calendar.

Sync httpx.Client (NOT KisClient's AsyncClient) so the executor/threadpool
calendar path calls it without the event-loop-binding hazard (ADR-0050
amendment). The bearer token comes from the shared KisTokenProvider via
kis_runtime — one cache + cooldown with the async fetch path.

Probe-verified 2026-06-05: one call returns ~24 rows forward from BASS_DT;
output keys are bass_dt/wday_dvsn_cd/bzdy_yn/tr_day_yn/opnd_yn/sttl_day_yn;
trading day ⇔ opnd_yn == "Y". We advance BASS_DT past the last returned row
until the target month is covered — robust whether KIS returns one day or
many per call. Cold-path only (results are month-cached by calendar.py).
Each page call gets ONE retry: the endpoint returns transient 500s (~1/6
observed in live probes), and with zero retries a single blip aborted the
whole month.
"""
from __future__ import annotations

import calendar as stdlib_calendar

import httpx

from hoga.collector.orchestrator import next_kst_day

_PATH = "/uapi/domestic-stock/v1/quotations/chk-holiday"
_TR_ID = "CTCA0903R"
# 24+ rows/call → a month is ~2 calls; this guards a runaway loop, not quota.
_MAX_CALLS_PER_MONTH = 8
_RETRIES_PER_CALL = 1  # one retry per page call on transient HTTP/network errors

# Test seam: tests inject an httpx.MockTransport here (module-level on purpose
# — the sync client is built per fetch, so there is no instance to inject into).
_transport_for_tests: httpx.BaseTransport | None = None


class KisHolidayFetchError(Exception):
    """HTTP / rt_cd / parse failure.
    Maps to UpstreamCode.KIS_HOLIDAY_FETCH_FAILED."""


class KisCredentialsMissing(KisHolidayFetchError):
    """KIS_APP_KEY/KIS_APP_SECRET unset — distinct subclass so callers can give
    the right remediation ("set keys" vs "retry later").
    Maps to UpstreamCode.KIS_CREDENTIALS_MISSING."""


def _resolve_provider():
    """Return (token, app_key, app_secret, base_url) or None when creds absent.

    Late import + tiny tuple so tests monkeypatch THIS seam without touching
    kis_runtime. Token issuance/cooldown lives in KisTokenProvider (Phase 1).
    reload_env: the UI's ".env 수정 후 재시도" copy points at the calendar/
    enqueue retries that land here — a creds miss re-reads .env so the
    promised loop works without a restart. The background poller gate also
    reaches this (cheap: one .env stat per 60s failure-TTL expiry), so the
    calendar self-heals within a minute of the keys appearing; the live
    poller itself still starts on the next watchlist mutation or restart.
    """
    from hoga.live.kis_runtime import ensure_kis_token_provider_from_env

    got = ensure_kis_token_provider_from_env(reload_env=True)
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


def _get_page(client: httpx.Client, bass_dt: str, auth: tuple[str, str, str]) -> dict:
    """One chk-holiday call with one transient-failure retry. Returns the JSON
    body. Raises KisHolidayFetchError after the retry also fails or on rt_cd."""
    token, app_key, app_secret = auth
    last_exc: Exception | None = None
    for _attempt in range(1 + _RETRIES_PER_CALL):
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
        except Exception as e:  # noqa: BLE001 — network/HTTP/JSON → retry once
            last_exc = e
            continue
        if body.get("rt_cd") != "0":
            # rt_cd errors are KIS-level rejections (auth, params) — retrying
            # the identical request won't change the answer.
            raise KisHolidayFetchError(
                f"chk-holiday rt_cd={body.get('rt_cd')} msg={body.get('msg1', '')[:100]}"
            )
        return body
    raise KisHolidayFetchError(f"chk-holiday call failed: {last_exc}") from last_exc


def fetch_month_trading_days(year: int, month: int) -> set[str]:
    """Trading days (opnd_yn=='Y') of (year, month) via BASS_DT-advance loop.

    Raises KisHolidayFetchError on any failure (KisCredentialsMissing when the
    env keys are absent) — calendar._trading_days_for maps that to None →
    weekday fallback. Never returns a partial/empty month silently: the loop
    runs until the month-end is covered AND the result is non-empty, or raises.
    """
    # Inside the contract: token issuance raises KisAuthError (cooldown/HTTP) —
    # normalize it here so callers can rely on KisHolidayFetchError alone.
    try:
        resolved = _resolve_provider()
    except Exception as e:  # noqa: BLE001 — KisAuthError et al. → one failure class
        raise KisHolidayFetchError(f"KIS token unavailable: {e}") from e
    if resolved is None:
        raise KisCredentialsMissing("KIS_APP_KEY/KIS_APP_SECRET missing")
    token, app_key, app_secret, base_url = resolved

    last_day = stdlib_calendar.monthrange(year, month)[1]
    month_end = f"{year:04d}{month:02d}{last_day:02d}"
    bass_dt = f"{year:04d}{month:02d}01"
    pages: list[list[dict]] = []

    with httpx.Client(base_url=base_url, transport=_transport_for_tests, timeout=15.0) as client:
        for _ in range(_MAX_CALLS_PER_MONTH):
            body = _get_page(client, bass_dt, (token, app_key, app_secret))
            out = body.get("output")
            rows = out if isinstance(out, list) else [out] if isinstance(out, dict) else []
            if not rows:
                raise KisHolidayFetchError("chk-holiday returned no rows")
            pages.append(rows)
            last = max(str(r.get("bass_dt", "")) for r in rows)
            if len(last) != 8 or not last.isdigit():
                # Schema drift (missing/malformed bass_dt) must stay inside the
                # documented exception contract, not escape as ValueError.
                raise KisHolidayFetchError(f"chk-holiday malformed bass_dt: {last!r}")
            if last >= month_end:
                result = _collect_month_from_pages(pages, year, month)
                if not result:
                    # Every real KRX month has ≥1 trading day. An empty set here
                    # means KIS answered without covering the requested month —
                    # caching it as success would render the whole month as
                    # holidays with no banner and gate the live poller off
                    # (ADR-0064 class). Fail instead.
                    raise KisHolidayFetchError(
                        f"chk-holiday covered {year}-{month:02d} with 0 trading days"
                    )
                return result
            # advance BASS_DT past the last returned row (single source of
            # day-stepping: orchestrator.next_kst_day)
            bass_dt = next_kst_day(last)
    raise KisHolidayFetchError(
        f"month {year}-{month:02d} not covered after {_MAX_CALLS_PER_MONTH} calls"
    )
