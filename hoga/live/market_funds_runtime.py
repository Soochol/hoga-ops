"""증시 주변 자금 런타임 — KOFIA 호출·캐시 (#1101).

**키움 거버너를 타지 않는다.** 벤더가 다르고 유량 축도 다르다. 거버너에 태우면 키움 버킷을 오염시키고
"이 실패가 어느 벤더인가" 가 흐려진다.

**키가 없으면 이 표면만 조용히 빈다**(ADR-0134) — KIS 키 부재 시 옵션 심리 패널만
비는 것과 같은 문법이다. 예외를 던지지 않는다.

공개일·시각은 고정하지 않는다. 원천 통계와 공공데이터 API의 반영 시점은 다를 수
있으므로 화면 요청이 있는 동안 30초 TTL로 새 기준일을 확인한다. 여러 화면의
요청은 캐시·단일비행으로 공유하고, 실패·빈 응답도 같은 주기로 재시도한다.
24시간 계속 조회해도 오퍼레이션당 최대 2,880회(3종 합계 8,640회)다.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from hoga.live import market_funds

log = logging.getLogger(__name__)

ENV_KEY = "KOFIA_API_KEY"
TTL_S = 30.0
# 카드가 기본으로 보여 주는 최장 구간(120일) + 여유. `numOfRows=200` 이 한 콜에
# 온다고 실측했다(#1098).
DEFAULT_ROWS = 200
# CMA 는 날짜당 8~10행이라 같은 일수를 덮으려면 행이 훨씬 많이 필요하다.
CMA_ROWS = 1400
_TIMEOUT_S = 20.0


def api_key() -> str | None:
    """`.env` 의 인증키(Decoding 정규화). 없으면 None — 호출부는 휴면한다."""
    raw = os.environ.get(ENV_KEY, "").strip()
    return market_funds.normalize_key(raw) if raw else None


async def _get(client: httpx.AsyncClient, op: str, *, key: str, rows: int) -> dict[str, Any] | None:
    """오퍼레이션 1건. 실패는 None — 카드 하나가 비는 것이 앱을 죽이는 것보다 낫다."""
    try:
        r = await client.get(
            f"{market_funds.BASE_URL}/{op}",
            params={"serviceKey": key, "numOfRows": rows, "pageNo": 1, "resultType": "json"},
        )
        if r.status_code != 200:  # noqa: PLR2004
            log.debug("market_funds.http_error op=%s status=%s", op, r.status_code)
            return None
        body = r.json()
    except Exception as e:  # noqa: BLE001 — 제3 벤더 장애가 페이지를 죽이면 안 된다.
        log.debug("market_funds.fetch_failed op=%s error=%s", op, e)
        return None
    code = market_funds.result_code(body)
    if code not in {"00", None}:
        log.debug("market_funds.vendor_error op=%s resultCode=%s", op, code)
        return None
    return body


async def fetch_series(*, key: str) -> list[dict[str, Any]]:
    """세 오퍼레이션 → 날짜 오름차순 병합 행. 부분 실패는 그 계열만 None 으로 남는다."""
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        capital, credit, cma = await asyncio.gather(
            _get(client, market_funds.OP_CAPITAL, key=key, rows=DEFAULT_ROWS),
            _get(client, market_funds.OP_CREDIT, key=key, rows=DEFAULT_ROWS),
            _get(client, market_funds.OP_CMA, key=key, rows=CMA_ROWS),
        )
    return market_funds.merge_series(
        market_funds.parse_single_value_series(capital or {}, field=market_funds.FIELD_DEPOSIT),
        market_funds.parse_single_value_series(credit or {}, field=market_funds.FIELD_CREDIT),
        market_funds.parse_cma_series(cma or {}),
        credit_kospi=market_funds.parse_single_value_series(
            credit or {}, field=market_funds.FIELD_CREDIT_KOSPI,
        ),
        credit_kosdaq=market_funds.parse_single_value_series(
            credit or {}, field=market_funds.FIELD_CREDIT_KOSDAQ,
        ),
    )


class MarketFundsCache:
    """30초 TTL + 단일비행 + last-good. 무자격이면 `unavailable` 을 실어 보낸다."""

    def __init__(self, ttl_s: float = TTL_S) -> None:
        self._ttl_s = ttl_s
        self._rows: list[dict[str, Any]] = []
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    def _payload(self, *, unavailable: str | None = None) -> dict[str, Any]:
        # 기준일은 **응답에서** 온다 — "T+2" 를 고정 문구로 박지 않는다(#1098).
        as_of = self._rows[-1]["date"] if self._rows else None
        return {"unavailable": unavailable, "as_of": as_of, "series": self._rows}

    async def get(self, *, key_fn: Any = api_key, fetch: Any = fetch_series) -> dict[str, Any]:
        key = key_fn()
        if key is None:
            return self._payload(unavailable="credentials_missing")
        now = time.monotonic()
        if now - self._fetched_at < self._ttl_s:
            return self._payload()
        async with self._lock:
            now = time.monotonic()
            if now - self._fetched_at < self._ttl_s:
                return self._payload()
            rows = await fetch(key=key)
            self._fetched_at = time.monotonic()  # 실패해도 갱신 — 뜨거운 재시도 방지
            if rows:
                # 한 오퍼레이션만 실패하거나 이전 날짜의 응답이 돌아와도 마지막
                # 정상값을 지우지 않는다. 새로 관측한 0은 정상값으로 덮어쓴다.
                by_date = {row["date"]: dict(row) for row in self._rows}
                for row in rows:
                    previous = by_date.setdefault(row["date"], dict(row))
                    previous.update({field: value for field, value in row.items() if value is not None})
                self._rows = [by_date[date] for date in sorted(by_date)[-DEFAULT_ROWS:]]
            return self._payload()
