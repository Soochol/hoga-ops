"""Candle-linked tape reads; never fetches vendor execution history."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime
from pathlib import Path
from typing import Literal

import duckdb
from fastapi import APIRouter, HTTPException, Query

from hoga.api import compute_jobs
from hoga.api.compute_pools import ComputePools, thread_pools
from hoga.api.models import TradeSpotResponse
from hoga.api.params import CODE_PATTERN
from hoga.util.timeenc import KST

from .second_trade_store import second_trade_store


def _encode_cursor(payload: dict, secret: bytes) -> str:
    body = json.dumps(payload, sort_keys=True).encode()
    return base64.urlsafe_b64encode(hmac.digest(secret, body, "sha256") + body).decode()


def _decode_cursor(token: str, secret: bytes) -> dict:
    try:
        raw = base64.b64decode(token, altchars=b"-_", validate=True)
        if not hmac.compare_digest(raw[:32], hmac.digest(secret, raw[32:], "sha256")):
            raise ValueError("signature")
        payload = json.loads(raw[32:])
        if type(payload["offset"]) is not int or payload["offset"] < 0:
            raise ValueError("offset")
        return payload
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, "체결 페이지 커서가 유효하지 않습니다") from exc


def build_router(*, data_dir: Path, compute: ComputePools | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/trades", tags=["trades"])
    pools = compute or thread_pools()
    secret = secrets.token_bytes(32)

    async def read(params: dict, snapshot: dict) -> TradeSpotResponse:
        try:
            return await compute_jobs.run_job(pools.narrow, compute_jobs.trade_spot_job,
                                               str(data_dir), params, snapshot)
        except (OSError, ValueError, duckdb.Error) as exc:
            raise HTTPException(503, "체결 데이터 조회 실패 · 다시 조회하세요") from exc

    @router.get("/spot", response_model=TradeSpotResponse)
    async def get_spot(
        code: str = Query(pattern=CODE_PATTERN), date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = Query(...), source_pref: str = "",
        from_ms: int = Query(ge=0), to_ms: int = Query(ge=0),
        min_amount_manwon: int = Query(0, ge=0, le=1_000_000_000),
        limit: int = Query(200, ge=1, le=200),
        cursor: str | None = Query(None, max_length=2048),
    ) -> TradeSpotResponse:
        try:
            day_start = int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=KST).timestamp() * 1000)
        except ValueError as exc:
            raise HTTPException(422, "잘못된 거래일") from exc
        if not (day_start <= from_ms < to_ms <= day_start + 86_400_000) or from_ms % 1000 or to_ms % 1000:
            raise HTTPException(422, "체결 구간은 같은 거래일의 1초 경계여야 합니다")
        params = dict(code=code, date=date, venue=venue, source_pref=source_pref,
                      from_ms=from_ms, to_ms=to_ms, min_amount_manwon=min_amount_manwon, limit=limit)
        fingerprint = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
        previous = _decode_cursor(cursor, secret) if cursor else None
        if previous and previous.get("request") != fingerprint:
            raise HTTPException(422, "다른 조회의 체결 페이지 커서입니다")
        params["offset"] = previous["offset"] if previous else 0
        snapshot: dict = {}
        today = date == datetime.now(KST).strftime("%Y%m%d")
        # An available preferred archive must not wait on the live collector RPC.
        result = await read(params, {}) if today and venue == "KRX" and source_pref == "hogaplay" else None
        if today and (result is None or result.source != "hogaplay"):
            from .lifecycle import get_capture_session  # noqa: PLC0415 — lifecycle owner
            owner = get_capture_session()
            remote = getattr(owner, "seconds_snapshot", None)
            if remote is not None:
                try:
                    snapshot = await remote(code, venue, date) or {}
                except (ConnectionError, TimeoutError):
                    snapshot = {"error": "collector_unavailable"}
            else:
                store = second_trade_store(data_dir)
                snapshot = {"live": store.live_rows(code, venue, date),
                            "pending": store.pending_corrections(code, venue, date), "error": store.storage_error}
        if result is None or result.source != "hogaplay":
            result = await read(params, snapshot)
        generation = f"{result.source}:{result.representation}:{result.revision}"
        if previous and previous.get("generation") != generation:
            raise HTTPException(409, "체결 데이터가 변경되었습니다. 처음부터 다시 조회하세요")
        if result.has_more:
            result.next_cursor = _encode_cursor({"request": fingerprint, "generation": generation,
                                                 "offset": params["offset"] + limit}, secret)
        return result

    return router
