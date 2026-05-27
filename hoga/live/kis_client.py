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


def classify_side(t_ms: int, prpr: int, askp: int, bidp: int) -> tuple[int, str]:
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
        """Authenticated GET to KIS API. Unwraps and validates rt_cd."""
        token = await self.get_access_token()
        headers = {
            "authorization": f"Bearer {token}",
            "appkey": self._creds.app_key,
            "appsecret": self._creds.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }
        resp = await self._client.get(path, params=params, headers=headers)
        resp.raise_for_status()
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
        """Fetch top-5 buy/sell broker breakdown for *code*."""
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
            KisBrokerEntry(name=out[f"shnu_mbcr_name{i}"], qty=int(out[f"total_shnu_qty{i}"]))
            for i in range(1, 6)
        ]
        sell_top = [
            KisBrokerEntry(name=out[f"seln_mbcr_name{i}"], qty=int(out[f"total_seln_qty{i}"]))
            for i in range(1, 6)
        ]
        return KisBrokers(code=code, buy_top=buy_top, sell_top=sell_top)

    # ------------------------------------------------------------------
    # Task 2.4: fetch_candles (FHKST03010100 daily, FHKST03010200 intraday)
    # ------------------------------------------------------------------

    async def fetch_candles(self, code: str, timeframe: str = "D") -> list[KisCandle]:
        """Fetch OHLCV candles for *code*.

        timeframe: "D" for daily (FHKST03010100), "1m" for 1-minute (FHKST03010200).
        """
        today_kst = datetime.now(KIS_KST).date()
        if timeframe == "D":
            path = "/uapi/domestic-stock/v1/quotations/inquire-daily-price"
            tr_id = "FHKST03010100"
            params: dict[str, Any] = {
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
                "fid_period_div_code": "D",
                "fid_org_adj_prc": "0",
                "fid_input_date_1": (today_kst - timedelta(days=90)).strftime("%Y%m%d"),
                "fid_input_date_2": today_kst.strftime("%Y%m%d"),
            }
        else:
            # intraday (1m)
            path = "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice"
            tr_id = "FHKST03010200"
            params = {
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": code,
                "fid_input_hour_1": "153000",
                "fid_pw_data_incu_yn": "Y",
                "fid_etc_cls_code": "",
            }
        body = await self._get(path=path, tr_id=tr_id, params=params)
        candles: list[KisCandle] = []
        for row in body["output2"]:
            if timeframe == "D":
                # Daily: date string YYYYMMDD, close = stck_clpr
                date_str = row["stck_bsop_date"]
                dt = datetime(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    tzinfo=KIS_KST
                )
                close = int(row["stck_clpr"])
                volume = int(row["acml_vol"])
            else:
                # Intraday: date+hour YYYYMMDD + HHMMSS, close = stck_prpr
                date_str = row["stck_bsop_date"]
                hhmmss = row["stck_cntg_hour"]
                dt = datetime(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6]),
                    tzinfo=KIS_KST
                )
                close = int(row["stck_prpr"])
                volume = int(row["cntg_vol"])
            candles.append(KisCandle(
                t_ms=int(dt.timestamp() * 1000),
                open=int(row["stck_oprc"]),
                high=int(row["stck_hgpr"]),
                low=int(row["stck_lwpr"]),
                close=close,
                volume=volume,
            ))
        return candles
