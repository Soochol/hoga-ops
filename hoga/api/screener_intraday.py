from __future__ import annotations

import asyncio
import datetime as dt
import logging
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.live import kiwoom_access, kiwoom_multi_quote, kiwoom_rest_runtime, settings as live_settings
from hoga.live.data_warnings import make_data_warning
from hoga.live.error_policy import LiveErrorPolicy, classify_live_error
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.quote_models import Quote

log = logging.getLogger(__name__)

_SCHEMA = {
    "code": pl.Utf8,
    "date": pl.Date,
    "open": pl.Float64,
    "high": pl.Float64,
    "low": pl.Float64,
    "close": pl.Float64,
    "volume": pl.Int64,
}
_CODE_LEN = 6


@dataclass(frozen=True)
class IntradayDailyOverlay:
    rows: pl.DataFrame
    fetched_at_ms: int | None
    #: 상태 태그(`intraday_partial` · `intraday_quote_invalid` …). **사유는 여기 없다** —
    #: 아래 `failure` 가 소유한다. 이 배열은 `screener_runner` 에서 depth·etf 경고와
    #: 한 평면으로 합쳐지므로 `intraday_` 접두가 네임스페이스 역할을 한다.
    warnings: list[str]
    #: 장중 조회가 실패했을 때의 **구조화된 사유**(ADR-0143). `make_data_warning` 산출이라
    #: `reason`·`kind`·`is_failure` 를 담고 **접두가 없다**.
    #:
    #: 이전에는 `f"intraday_{worst.reason}"` 로 위 배열에 섞여 들어갔다. 접두는 평면
    #: 충돌을 막으려던 것이었는데, 그 탓에 프론트가 접두를 붙인 사유별 문구표
    #: (`REASON_COPY`)를 따로 들고 있어야 했다 — 같은 사실의 6벌 중 하나였다.
    failure: dict | None = None


_CACHE: dict[tuple[Path, str, tuple[str, ...]], IntradayDailyOverlay] = {}
_CACHE_AT: dict[tuple[Path, str, tuple[str, ...]], int] = {}
_LOCKS: dict[tuple[Path, str, tuple[str, ...]], asyncio.Lock] = {}


def _empty(
    warnings: list[str] | None = None,
    *,
    failure: dict | None = None,
) -> IntradayDailyOverlay:
    return IntradayDailyOverlay(
        rows=pl.DataFrame(schema=_SCHEMA),
        fetched_at_ms=None,
        warnings=warnings or [],
        failure=failure,
    )


def intraday_overlay_bypassed(data_dir: Path) -> bool:
    return live_settings.rest_bypass_enabled(data_dir)


def _date(yyyymmdd: str) -> dt.date:
    return dt.datetime.strptime(yyyymmdd, "%Y%m%d").date()


def _has_valid_price_ohlc(q) -> bool:
    nums = [q.price, q.open, q.high, q.low]
    return (
        all(isinstance(v, int) and v > 0 for v in nums)
        and q.high >= max(q.open, q.price)
        and q.low <= min(q.open, q.price)
    )


async def _fetch_quotes_in_chunks(
    client: KiwoomRestClient,
    unique_codes: tuple[str, ...],
    *,
    today: str,
    data_dir: Path,
) -> tuple[list[Quote], list[LiveErrorPolicy], int]:
    """`ka10095` 를 **청크마다 별도 요청으로** 제출하고 성공분·실패분을 함께 돌려준다.

    청킹이 `fetch_multi_price` **안**에 있으면 유량 거버너가 무력해진다(ADR-0137). 거버너는
    `fetch_fn` 하나를 요청 1건으로 세는데 그 안에서 N 번 HTTP 를 쏘면 버킷은 1 을,
    벤더는 N 을 센다. 실측: 4,295종목 → 43콜을 0.23초에 발사 → 6번째에서
    `1700 유량=5`. **청크를 거버너 위로 올리는 것**이 페이싱의 전제다.

    동시 제출은 거버너가 흡수한다 — TR 버킷이 직렬화하고, 같은 TR 의 `user_visible`
    (관심종목 시세)이 도착하면 background 인 이 요청들이 뒤로 밀린다. 순차 await 로
    바꾸면 그 양보 기계가 청크 사이 왕복시간만큼 헛돈다.
    """
    chunks = kiwoom_multi_quote.chunk_codes(list(unique_codes))
    # data_dir 을 넘겨야 거버너가 계정 풀을 갱신한다 — 풀 크기가 곧 처리량 배수다(ADR-0138).
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
    results = await asyncio.gather(
        *(
            kiwoom_access.run_with_capacity(
                scheduler,
                key=("screener-intraday", today, tuple(chunk)),
                api_id="ka10095",
                priority="background",
                client=client,
                # 기본인자 바인딩 — 제너레이터가 다 돌고 나서 실행되므로 late binding 이면
                # 모든 청크가 마지막 chunk 를 조회한다.
                fetch_fn=lambda c, ch=chunk: kiwoom_multi_quote.fetch_multi_price(c, ch),
            )
            for chunk in chunks
        ),
        return_exceptions=True,
    )

    quotes: list[Quote] = []
    failures: list[LiveErrorPolicy] = []
    for result in results:
        if isinstance(result, BaseException):
            policy = classify_live_error(result)
            if not failures:
                # 같은 이유로 43청크가 죽으면 43줄이 된다 — 상세는 첫 실패만 남기고
                # 나머지는 위쪽 요약 로그가 개수로 말한다.
                log.log(
                    policy.log_level,
                    "screener 장중 시세 청크 실패 %s[%s]: %s",
                    policy.kind, policy.code, policy.message,
                    exc_info=result if policy.include_traceback else None,
                )
            failures.append(policy)
        else:
            quotes.extend(result)
    return quotes, failures, len(chunks)


async def build_intraday_overlay(
    *,
    data_dir: Path,
    codes: list[str],
    today: str,
    now_ms: int,
    ttl_ms: int = 15_000,
) -> IntradayDailyOverlay:
    unique_codes = tuple(
        sorted({c for c in codes if isinstance(c, str) and len(c) == _CODE_LEN})
    )
    if not unique_codes or intraday_overlay_bypassed(data_dir):
        warnings = ["rest_bypassed_intraday_overlay_skipped"] if unique_codes else None
        return _empty(warnings)
    key = (data_dir, today, unique_codes)
    cached = _CACHE.get(key)
    cached_at = _CACHE_AT.get(key)
    if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
        return cached

    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _CACHE.get(key)
        cached_at = _CACHE_AT.get(key)
        if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
            return cached

        # PR-D(#1040) 칼 컷오버 — 소스는 키움 `ka10095` 다. 쿨다운 스코프 정렬은
        # 더 필요 없다: 키움 유량은 **TR별**이라 같은 api_id 를 쓰는 호출자끼리
        # 자동으로 같은 버킷을 공유한다(#1015). 계정 차원이 사라졌기 때문이다.
        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            # ADR-0134 dev 무자격 프로필에서 **정상 경로**다 — 결함이 아니므로 INFO.
            log.info(
                "screener 장중 오버레이 휴면 → 전일 확정 폴백 (키움 자격증명 없음, %d종목)",
                len(unique_codes),
            )
            return _empty(failure=make_data_warning(
                "credentials_missing", "kiwoom credentials are not configured",
            ))

        quotes, failures, chunk_count = await _fetch_quotes_in_chunks(
            client, unique_codes, today=today, data_dir=data_dir
        )
        if failures and not quotes:
            worst = failures[0]
            # ADR-0137 R3 — 로그의 책임자는 예외가 난 곳이 아니라 **폴백을 고른 곳**이다.
            # 하위 층(kiwoom_capacity)은 "ka10095 rate-limited" 만 알고, 그래서 어떤
            # 기능이 무엇으로 대체됐는지는 여기만 안다. 문장을 영향으로 시작하는 이유다.
            log.warning(
                "screener 장중 오버레이 강등 → 전일 확정 폴백 "
                "(%d종목 · %d청크 전량 실패 · 원인 %s[%s]: %s)",
                len(unique_codes), chunk_count, worst.kind, worst.code, worst.message,
            )
            return _empty(failure=make_data_warning(worst.reason, worst.message))

        rows = []
        invalid = False
        volume_unavailable = False
        d = _date(today)
        for q in quotes:
            if not _has_valid_price_ohlc(q):
                invalid = True
                continue
            if not isinstance(q.volume, int) or q.volume <= 0:
                volume_unavailable = True
                continue
            rows.append({
                "code": q.code,
                "date": d,
                "open": float(q.open),
                "high": float(q.high),
                "low": float(q.low),
                "close": float(q.price),
                "volume": int(q.volume),
            })
        warnings: list[str] = []
        failure: dict | None = None
        if failures:
            # ADR-0137 R5 — 부분 성공을 전량 폐기하지 않는다. 앞선 청크가 받아온
            # 수백 종목은 조건 평가에 그대로 쓸 수 있고, 못 받은 몫만 전일 확정으로
            # 남는다. 다만 그 사실을 숨기지 않는다.
            worst = failures[0]
            log.warning(
                "screener 장중 오버레이 부분 성공 → %d/%d청크 "
                "(%d종목 요청 · 원인 %s[%s]: %s)",
                chunk_count - len(failures), chunk_count, len(unique_codes),
                worst.kind, worst.code, worst.message,
            )
            warnings.append("intraday_partial")
            failure = make_data_warning(worst.reason, worst.message)
        if invalid:
            warnings.append("intraday_quote_invalid")
        if volume_unavailable:
            warnings.append("intraday_volume_unavailable")
        overlay = IntradayDailyOverlay(
            rows=pl.DataFrame(rows, schema=_SCHEMA) if rows else pl.DataFrame(schema=_SCHEMA),
            fetched_at_ms=now_ms,
            warnings=warnings,
            failure=failure,
        )
        _CACHE[key] = overlay
        _CACHE_AT[key] = now_ms
        return overlay
