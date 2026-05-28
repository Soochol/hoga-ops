"""KIS Open API HTTP client (직접 구현, ADR-0038 — 의존성 최소화).

Live Capture write-path uses this client. Per ADR-0038's invariant the
hot-path module never imports pyarrow/polars; this file should not either.

See Deep Sample Audit §C (Audit-3) for the 1-minute token cool-down and
KIS's 6-hour same-token reissue policy.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx

from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisCandle,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)

KIS_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://openapi.koreainvestment.com:9443"
_REISSUE_COOLDOWN_MS = 60_000  # KIS: 1 issuance per minute


def classify_side(
    t_ms: int, prpr: int, askp: int, bidp: int
) -> tuple[Literal[-1, 0, 1, 2], Literal["inferred", "auction"]]:
    """Lee-Ready trade direction inference + auction window guard.

    Returns (side, side_source). See Deep Sample Audit §B (Audit-2) and §H (Audit-5).
    side: -1=sell, 0=mid, 1=buy, 2=auction
    side_source: "inferred" | "auction"
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    in_open_auction = (h == 8 and m >= 50) or (h == 9 and m == 0)
    in_close_auction = h == 15 and 20 <= m < 30
    if in_open_auction or in_close_auction:
        return 2, "auction"
    if prpr >= askp:
        return 1, "inferred"
    if prpr <= bidp:
        return -1, "inferred"
    return 0, "inferred"


class KisAuthError(RuntimeError):
    """Token issue failed or cool-down breached."""


class KisRateLimitError(RuntimeError):
    """msg_cd == 'EGW00201' — backoff caller's responsibility (Audit-4)."""


class KisApiError(RuntimeError):
    """rt_cd != '0' generic failure."""

    def __init__(self, msg_cd: str, msg1: str):
        self.msg_cd = msg_cd
        self.msg1 = msg1
        super().__init__(f"KIS api error {msg_cd}: {msg1}")


@dataclass(frozen=True)
class KisCredentials:
    app_key: str
    app_secret: str
    env: Literal["real"] = "real"  # paper unsupported (spec §10)

    @property
    def base_url(self) -> str:
        if self.env != "real":
            raise ValueError("Only 'real' env is supported (spec §10)")
        return _BASE_REAL


class KisClient:
    def __init__(
        self,
        credentials: KisCredentials,
        token_cache_path: Path,
        *,
        _transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self._creds = credentials
        self._cache_path = token_cache_path
        self._client = httpx.AsyncClient(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        self._token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None
        # Audit-3: track last issuance to enforce 1-per-minute cool-down.
        # monotonic clock so we don't get confused by NTP step or daylight changes.
        self._last_issued_monotonic_ms: Optional[int] = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_access_token(self) -> str:
        # in-memory hit
        if (
            self._token
            and self._token_expires_at
            and datetime.now(KIS_KST) < self._token_expires_at - timedelta(minutes=10)
        ):
            return self._token

        # disk cache hit
        cached = self._read_cache()
        if cached:
            self._token, self._token_expires_at = cached
            return self._token

        return await self._issue_token()

    async def _issue_token(self) -> str:
        """Issue a fresh access_token via /oauth2/tokenP.

        KIS limits issuance to 1 per minute (Audit-3). Additionally, KIS
        returns the same token for any reissue request within 6 hours of the
        previous issue — disk caching is therefore essential and a `_issue`
        call is rarely the right answer in steady-state.
        """
        now_ms = int(time.monotonic() * 1000)
        if (
            self._last_issued_monotonic_ms is not None
            and now_ms - self._last_issued_monotonic_ms < _REISSUE_COOLDOWN_MS
        ):
            raise KisAuthError(
                "token reissue cooldown: KIS allows 1 issuance per minute"
            )
        resp = await self._client.post(
            "/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "appsecret": self._creds.app_secret,
            },
        )
        if resp.status_code != 200:
            raise KisAuthError(
                f"token issue failed: HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        token: str = body["access_token"]
        expires_in = int(body.get("expires_in", 86400))
        expires_at = datetime.now(KIS_KST) + timedelta(seconds=expires_in)
        self._token = token
        self._token_expires_at = expires_at
        self._last_issued_monotonic_ms = now_ms
        self._write_cache(token, expires_at)
        return token

    def _read_cache(self) -> Optional[tuple[str, datetime]]:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(KIS_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(
            json.dumps({"access_token": token, "expires_at": expires_at.isoformat()})
        )
        self._cache_path.chmod(0o600)

    async def _get(self, path: str, tr_id: str, params: dict[str, Any]) -> dict:
        """Authenticated GET to KIS API. Unwraps and validates rt_cd.

        Normalizes upstream HTTP errors into domain exceptions so callers
        don't have to know about httpx — `_get`'s contract is "either
        return a validated body or raise a typed KisXxxError". Without
        this normalization a transient KIS 500 (common per-code) bubbles
        up as httpx.HTTPStatusError and forces the poller to log a
        full traceback at `unexpected_error` level, drowning real bugs
        in noise. Found by /qa: KIS regularly returns 500 for codes
        outside the regular session window — expected, not a defect.
        """
        token = await self.get_access_token()
        headers = {
            "authorization": f"Bearer {token}",
            "appkey": self._creds.app_key,
            "appsecret": self._creds.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }
        try:
            resp = await self._client.get(path, params=params, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            # 4xx/5xx from KIS — surface as KisApiError so the poller can
            # log it once at WARN/INFO without a full traceback.
            raise KisApiError(
                msg_cd=f"HTTP_{e.response.status_code}",
                msg1=e.response.text[:200],
            ) from e
        return self._unwrap(resp.json())

    def _unwrap(self, body: dict) -> dict:
        """Validate rt_cd and raise typed errors. Returns the raw body dict."""
        rt_cd = body.get("rt_cd", "")
        msg_cd = body.get("msg_cd", "")
        msg1 = body.get("msg1", "")
        if rt_cd != "0":
            if msg_cd == "EGW00201":
                raise KisRateLimitError(f"rate limit: {msg1}")
            raise KisApiError(msg_cd=msg_cd, msg1=msg1)
        return body

    # ------------------------------------------------------------------
    # Task 2.1: fetch_orderbook (FHKST01010200)
    # ------------------------------------------------------------------

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        """Fetch 10-level real-time orderbook for *code* (e.g. '005930')."""
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            tr_id="FHKST01010200",
            params={
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
            },
        )
        out1 = body["output1"]
        asks = [
            OrderbookLevel(price=int(out1[f"askp{i}"]), qty=int(out1[f"askp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        bids = [
            OrderbookLevel(price=int(out1[f"bidp{i}"]), qty=int(out1[f"bidp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        return KisOrderbook(
            code=code,
            asks=asks,
            bids=bids,
            total_ask_qty=int(out1["total_askp_rsqn"]),
            total_bid_qty=int(out1["total_bidp_rsqn"]),
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    # ------------------------------------------------------------------
    # Task 2.2: fetch_trades (FHPST01060000, inquire-time-itemconclusion)
    # ------------------------------------------------------------------

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        """Fetch per-trade history via inquire-time-itemconclusion (FHPST01060000).

        Uses Lee-Ready side classification. Auction window trades get side=2.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            tr_id="FHPST01060000",
            params={
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
                "fid_input_hour_1": "153000",
            },
        )
        today_kst = datetime.now(KIS_KST).date()
        trades: list[KisTrade] = []
        for row in body["output2"]:
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            ss = int(hhmmss[4:6])
            dt = datetime(
                today_kst.year, today_kst.month, today_kst.day,
                hh, mm, ss, tzinfo=KIS_KST
            )
            t_ms = int(dt.timestamp() * 1000)
            prpr = int(row["stck_prpr"])
            askp = int(row.get("askp", "0") or "0")
            bidp = int(row.get("bidp", "0") or "0")
            side, side_source = classify_side(t_ms, prpr, askp, bidp)
            trades.append(KisTrade(
                price=prpr,
                qty=int(row["cnqn"]),
                side=side,
                side_source=side_source,
                t_ms=t_ms,
            ))
        return trades

    # ------------------------------------------------------------------
    # Task 2.3: fetch_brokers (FHKST01010600)
    # ------------------------------------------------------------------

    async def fetch_brokers(self, code: str) -> KisBrokers:
        """Fetch top-5 buy/sell broker breakdown for *code*.

        Broker names are canonicalized at the boundary so the buffer / SSE /
        JSONL / promoted parquet downstream all see the same canonical KRX
        member-firm name (see ``hoga.broker_names`` and CONTEXT.md).
        """
        from hoga.broker_names import canonical

        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-member",
            tr_id="FHKST01010600",
            params={
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
            },
        )
        out = body["output"][0]  # KIS returns a 1-element list (Audit-3)
        buy_top = [
            KisBrokerEntry(
                name=canonical(out[f"shnu_mbcr_name{i}"]),
                qty=int(out[f"total_shnu_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        sell_top = [
            KisBrokerEntry(
                name=canonical(out[f"seln_mbcr_name{i}"]),
                qty=int(out[f"total_seln_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        return KisBrokers(code=code, buy_top=buy_top, sell_top=sell_top)

    # ------------------------------------------------------------------
    # fetch_past_minute_candles (FHKST03010230, 주식일별분봉조회)
    # ------------------------------------------------------------------

    async def fetch_past_minute_candles(self, code: str, date_yyyymmdd: str) -> list[KisCandle]:
        """Fetch 1-minute candles for *code* on *date_yyyymmdd* (KST).

        KIS endpoint `inquire-time-dailychartprice` returns at most 120 rows
        per call (about 2 hours of 1-minute bars). A full regular-session day
        (09:00-15:30 KST = 390 minutes) needs ~4 paginated calls — we anchor
        from 15:30 KST and walk the anchor backwards by the earliest received
        candle's HHMMSS until we cover 09:00 or stop receiving new bars.

        KIS retains roughly 1 year of historical minute candles per the
        portal docs (https://apiportal.koreainvestment.com/).
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"
        tr_id = "FHKST03010230"
        # Walk anchor from 15:30 backwards. Stop when the response is empty
        # or the earliest received bar is at/before 09:00.
        anchor_hhmmss = "153000"
        seen_t_ms: set[int] = set()
        all_candles: list[KisCandle] = []
        # Hard cap so a misbehaving KIS response never spirals into infinite
        # pages. 6 calls × 120 bars = 720 rows, well past one regular session.
        for _ in range(6):
            params = {
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": code,
                "FID_INPUT_HOUR_1": anchor_hhmmss,
                "FID_INPUT_DATE_1": date_yyyymmdd,
                "FID_PW_DATA_INCU_YN": "N",
                "FID_FAKE_TICK_INCU_YN": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params)
            rows = body.get("output2") or []
            page_candles: list[KisCandle] = []
            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                hhmmss = row.get("stck_cntg_hour") or ""
                if len(date_str) != 8 or len(hhmmss) != 6:
                    # Defensive: malformed row, skip rather than crash the page.
                    continue
                if date_str != date_yyyymmdd:
                    # KIS quirk: queries against a non-trading-day (Sat/Sun/
                    # holiday) return the PRIOR trading day's bars instead of an
                    # empty list. Without this guard the caller's per-date loop
                    # accumulates the same bars under multiple dates, breaking
                    # lightweight-charts' monotonic-time invariant downstream.
                    # Discovered via /investigate 2026-05-28 against /live.
                    continue
                dt = datetime(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6]),
                    tzinfo=KIS_KST,
                )
                t_ms = int(dt.timestamp() * 1000)
                if t_ms in seen_t_ms:
                    continue
                seen_t_ms.add(t_ms)
                page_candles.append(KisCandle(
                    t_ms=t_ms,
                    open=int(row["stck_oprc"]),
                    high=int(row["stck_hgpr"]),
                    low=int(row["stck_lwpr"]),
                    close=int(row["stck_prpr"]),
                    volume=int(row["cntg_vol"]),
                ))
            if not page_candles:
                break
            all_candles.extend(page_candles)
            # Next anchor = HHMMSS of the earliest bar minus 1 minute. KIS
            # responses come newest-first; the earliest bar's hour drives the
            # next page's anchor.
            earliest_t_ms = min(c.t_ms for c in page_candles)
            earliest_dt = datetime.fromtimestamp(earliest_t_ms / 1000, tz=KIS_KST)
            # If we already covered the session open, stop.
            if earliest_dt.hour < 9 or (earliest_dt.hour == 9 and earliest_dt.minute == 0):
                break
            # Step the anchor back by 1 minute from the earliest bar.
            next_anchor_dt = earliest_dt - timedelta(minutes=1)
            anchor_hhmmss = (
                f"{next_anchor_dt.hour:02d}{next_anchor_dt.minute:02d}{next_anchor_dt.second:02d}"
            )
        # Return in ascending order by t_ms — frontend / aggregator expects ASC.
        all_candles.sort(key=lambda c: c.t_ms)
        return all_candles

    # ------------------------------------------------------------------
    # Task 2.5: fetch_overtime_orderbook (FHPST02300400)
    # ------------------------------------------------------------------

    async def fetch_overtime_orderbook(self, code: str) -> KisOrderbook:
        """Fetch 10-level after-hours orderbook for *code* (FHPST02300400)."""
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-overtime-asking-price",
            tr_id="FHPST02300400",
            params={
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
            },
        )
        out = body["output"]  # single dict (not a list)
        asks = [
            OrderbookLevel(
                price=int(out[f"ovtm_untp_askp{i}"]),
                qty=int(out[f"ovtm_untp_askp_rsqn{i}"]),
            )
            for i in range(1, 11)
        ]
        bids = [
            OrderbookLevel(
                price=int(out[f"ovtm_untp_bidp{i}"]),
                qty=int(out[f"ovtm_untp_bidp_rsqn{i}"]),
            )
            for i in range(1, 11)
        ]
        return KisOrderbook(
            code=code,
            asks=asks,
            bids=bids,
            total_ask_qty=int(out["ovtm_total_askp_rsqn"]),
            total_bid_qty=int(out["ovtm_total_bidp_rsqn"]),
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    # ------------------------------------------------------------------
    # Task 2.6: fetch_overtime_trades (FHPST02310000)
    # ------------------------------------------------------------------

    async def fetch_overtime_trades(self, code: str) -> list[KisTrade]:
        """Fetch after-hours per-trade data for *code* (FHPST02310000).

        If askp/bidp not present in response, defaults side=0 / side_source="inferred".
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-time-overtimeconclusion",
            tr_id="FHPST02310000",
            params={
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
                "fid_hour_cls_code": "1",
            },
        )
        today_kst = datetime.now(KIS_KST).date()
        trades: list[KisTrade] = []
        for row in body["output2"]:
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            ss = int(hhmmss[4:6])
            dt = datetime(
                today_kst.year, today_kst.month, today_kst.day,
                hh, mm, ss, tzinfo=KIS_KST
            )
            t_ms = int(dt.timestamp() * 1000)
            prpr = int(row["stck_prpr"])
            askp_str = row.get("askp")
            bidp_str = row.get("bidp")
            if askp_str and bidp_str:
                askp = int(askp_str)
                bidp = int(bidp_str)
                side, side_source = classify_side(t_ms, prpr, askp, bidp)
            else:
                side: Literal[-1, 0, 1, 2] = 0
                side_source: Literal["inferred", "auction"] = "inferred"
            trades.append(KisTrade(
                price=prpr,
                qty=int(row["cnqn"]),
                side=side,
                side_source=side_source,
                t_ms=t_ms,
            ))
        return trades
