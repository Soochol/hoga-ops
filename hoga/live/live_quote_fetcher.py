"""시세 조회·마감 캐시·응답 신선도 정책. FastAPI 라우트와 독립된 모듈."""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime
from typing import NamedTuple

from pydantic import BaseModel, Field

from hoga.live import kiwoom_multi_quote
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.quote_change_resolver import QuoteChangeResolver
from hoga.live.quote_models import Quote
from hoga.live.venue import Venue
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)


def _today_kst_date() -> date:
    return datetime.now(KST).date()


class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    #: 당일 누적 요약 4종 — 10호가 요약 패널이 WS `0B` 결손 시 폴백으로 읽는다.
    #: 마감 후 표시 링버퍼가 비면 `0B` 가 통째로 사라져 그 칸들이 대시가 되는데,
    #: 같은 값이 이 응답의 원천(`ka10095`)에 이미 실려 온다.
    #:
    #: 단위·의미는 **WS 와 같은 축으로 맞춰 뒀다**(파서가 벤더 단위를 흡수한다):
    #: `trade_value` 는 **원**(벤더는 백만원), `vs_prev_volume_pct` 는 오늘 누적 ÷
    #: 전일 전량 × 100 의 **비율**(증감률 아님). 전부 `| None` — 벤더 미제공·장전
    #: 무자격 폴백에서 비는 것이 정상이고, 그 경로가 dev·e2e 의 **정상 경로**다.
    volume: int | None = None
    trade_value: int | None = None
    vs_prev_volume_pct: float | None = None
    fill_strength_pct: float | None = None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: str | None = None
    warnings: list[str] = Field(default_factory=list)
    stale: bool = False
    stale_reason: str | None = None



class _QuoteSample(NamedTuple):
    """마지막-시세 캐시 1건 + **그 표본이 어디서 왔는지**.

    quote 만 담으면 closed 서빙이 "이 값이 종가인가"를 물을 수 없다. 그게 장중
    폴링이 끊긴 시점의 값을 종가로 서빙하던 결함의 근인이었다 — 캐시를 채우는
    유일한 주체가 프론트 폴링이라(/quotes 요청 외에 갱신 스케줄러가 없다), 탭이
    가려져 폴링이 멈추면 그 순간 값이 캐시에 남고 closed 경로가 그걸 종가로
    내보냈다. 실측 2026-08-01: 07/31 오전 10시대 247,000 이 종가(262,500) 자리에.

    phase/day 를 함께 남기면 그 질문에 답할 수 있다 — `is_closing_sample` 참조.
    """
    quote: Quote
    phase: str
    day: date
    generation: int


class LiveQuoteFetcher:
    """시세 조회·마지막 성공 캐시·phase 표시·실패 폴백을 소유한다.

    Quote에는 공급자 관측 시각이 없어 거래일과 요청 시작 순번으로 역행을 막는다.
    늦게 끝난 옛 요청이 새 성공을 지우지 않지만, 새 요청이 실패했다면 옛 성공도
    사용한다. 청킹과 유량 페이싱은 주입된 fetch_chunk_fn을 통해 기존 경로를 따른다.
    """

    def __init__(self, *, change_resolver: QuoteChangeResolver | None = None) -> None:
        # 장중 마지막 quotes — closed 서빙용(스펙 2026-06-08 ⑧ '마지막 시세 유지').
        # 키가 **(venue, code)** 인 이유: OHLC 는 venue 마다 다르다(실측 2026-07-31,
        # 005930 시가 KRX 257,000 vs UN 225,500 — UN 은 프리마켓 체결이 시가가 된다).
        # code 만으로 키잉하면 마지막에 조회된 venue 의 봉이 다른 venue 요청에 그대로
        # 서빙된다 — 장마감(closed)·KIS 실패(stale) 경로가 캐시만 보기 때문이다. 실제
        # 증상: 장 마감 후 venue 를 바꿔도 히트맵 행의 캔들·시가가 그대로.
        self._last_quotes: dict[tuple[str, str], _QuoteSample] = {}
        self._generation = 0
        self._tasks: set[asyncio.Task] = set()
        self._closed = False
        self._change_resolver = change_resolver or QuoteChangeResolver(adjusted_daily_path=None)

    @property
    def change_resolver(self) -> QuoteChangeResolver:
        return self._change_resolver

    async def fetch_with_timeout(
        self,
        client: KiwoomRestClient,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        venue: Venue = "KRX",
        fetch_chunk_fn: kiwoom_multi_quote.ChunkFetcher | None = None,
        timeout: float | None = 1.0,
    ) -> list[LiveQuote]:
        """Own background cache fills even after the HTTP waiter times out."""
        if self._closed:
            raise RuntimeError("quote fetcher is closed")
        task = asyncio.create_task(self.fetch_and_gate(
            client, code_list, phase, today, venue=venue, fetch_chunk_fn=fetch_chunk_fn,
        ), name="live-quote-fill")
        self._tasks.add(task)
        task.add_done_callback(self._completed)
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)

    def _completed(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None:
            log.warning("background quote fill failed: %s", error, exc_info=error)

    async def aclose(self) -> None:
        self._closed = True
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    async def _fetch_partial(
        self, client: KiwoomRestClient, codes: list[str], venue: Venue,
        fetch_chunk_fn: kiwoom_multi_quote.ChunkFetcher | None,
    ) -> tuple[list[Quote], dict[str, str]]:
        failures: dict[str, str] = {}

        async def fetch(chunk: list[str]) -> list[Quote]:
            try:
                rows = await (fetch_chunk_fn(chunk) if fetch_chunk_fn else
                              kiwoom_multi_quote.fetch_chunk(client, chunk, venue=venue))
            except Exception as error:  # noqa: BLE001 — vendor I/O boundary, per-chunk fallback
                reason = ("capacity_overloaded_upstream" if isinstance(error, KiwoomCapacityOverloaded)
                          else classify_live_error(error).reason)
                if reason == "unexpected_error":
                    reason = "fetch_failed"
                failures.update(dict.fromkeys(chunk, reason))
                log.warning("quote chunk failed; using cached rows (%d codes, %s): %s",
                            len(chunk), reason, error)
                return []
            returned = {q.code for q in rows}
            failures.update({code: "quote_missing" for code in chunk if code not in returned})
            return rows

        quotes = await kiwoom_multi_quote.fetch_multi_price(
            client, codes, venue=venue, fetch_chunk_fn=fetch,
        )
        return quotes, failures

    def _remember(
        self, quotes: list[Quote], *, venue: Venue, phase: str, day: date, generation: int,
    ) -> list[Quote]:
        """Commit only successful observations, independently for each venue/code."""
        selected = []
        for quote in quotes:
            key = (venue, quote.code)
            previous = self._last_quotes.get(key)
            if previous is None or (day, generation) >= (previous.day, previous.generation):
                self._last_quotes[key] = _QuoteSample(quote, phase, day, generation)
                selected.append(quote)
            else:
                # A late same-day response must not serve its old price either.
                # Never put a different trading day's quote into this response.
                selected.append(previous.quote if previous.day == day else quote)
        return selected

    @staticmethod
    def is_closing_sample(sample: _QuoteSample | None, today: date) -> bool:
        """이 표본을 **종가로서** 서빙해도 되는가.

        두 조건을 모두 요구한다:
          - `phase == "closed"` — 마감 후에 찍혔다. 장중 표본은 그 시각의 값일 뿐
            종가가 아니다(폴링이 언제 끊겼는지 알 수 없으므로 나이도 알 수 없다).
          - `day == today` — 오늘 찍혔다. 어제 밤 표본을 오늘 밤에 서빙하면 하루
            묵은 종가가 된다(앱을 하루 걸러 켜는 사용 패턴에서 실제로 발생).

        `open` 표본이 마감 직전(예: KRX 15:59)이라 사실상 종가와 같은 경우에도
        재조회를 시킨다 — 같은 값이면 KIS 가 같은 값을 돌려줄 뿐이라 비용은 요청
        1회이고, "같을 것"이라는 추측 위에 종가 표시를 세우지 않는 편이 옳다.
        """
        return sample is not None and sample.phase == "closed" and sample.day == today

    def _to_live_quote(
        self,
        q: Quote,
        *,
        phase: str,
        today: date | None = None,
    ) -> LiveQuote:
        resolved = self._change_resolver.resolve_quote(q, phase=phase, today=today)
        pre = phase == "pre_open"
        return LiveQuote(
            code=q.code,
            price=q.price,
            change_pct=resolved.change_pct,
            change_won=resolved.change_won,
            open=(None if pre else q.open),
            high=(None if pre else q.high),
            low=(None if pre else q.low),
            # 넷 다 **당일 체결에서 파생된 값**이라 OHLC 와 같은 부류다 — 장전에는
            # 같이 지운다. 안 지우면 첫 체결 전에 어제 값이 오늘 요약 자리에 앉는다.
            volume=(None if pre else q.volume),
            trade_value=(None if pre else q.trade_value),
            vs_prev_volume_pct=(None if pre else q.vs_prev_volume_pct),
            fill_strength_pct=(None if pre else q.fill_strength_pct),
            baseline_price=resolved.baseline_price,
            baseline_date=resolved.baseline_date,
            change_pct_source=resolved.change_pct_source,
            warnings=resolved.warnings,
        )

    async def fetch_and_gate(
        self,
        client: KiwoomRestClient,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        venue: Venue = "KRX",
        fetch_chunk_fn: kiwoom_multi_quote.ChunkFetcher | None = None,
    ) -> list[LiveQuote]:
        """code_list 의 시세를 phase 에 맞춰 반환. closed=마지막 **종가** 시세(표본이
        종가가 아니면 재조회 — is_closing_sample), open=라이브, pre_open=등락률 숨김.
        벤더 실패는 절대 전파하지 않는다(오버레이는 500 금지).

        PR-D(#1040) 칼 컷오버로 소스는 키움 `ka10095` 다. venue 는 KIS 처럼
        파라미터가 아니라 **종목코드 접미**로 표현된다."""
        day = today or _today_kst_date()
        self._generation += 1
        generation = self._generation
        if phase == "closed":
            # 장외: 마지막 시세 서빙. 단 **종가 표본일 때만** 캐시를 신뢰한다.
            # 판정 기준이 "캐시에 있는가"였을 때, 장중에 폴링이 끊기면 그 시점 값이
            # 종가 자리에 영구히 눌러앉았다(is_closing_sample 참조). KIS는 장외에도
            # 종가를 반환하므로 재조회가 정확한 복구 경로다. 프론트는 closed에 600s
            # 하트비트라 이 경로의 KIS 콜은 마감 후 첫 요청 1회로 수렴한다.
            refetch = [
                c for c in code_list
                if not self.is_closing_sample(self._last_quotes.get((venue, c)), day)
            ]
            failures: dict[str, str] = {}
            if refetch:
                try:
                    quotes, failures = await self._fetch_partial(
                        client, refetch, venue, fetch_chunk_fn,
                    )
                    self._remember(quotes, venue=venue, phase=phase, day=day, generation=generation)
                except KiwoomCapacityOverloaded:
                    raise   # 사유 보존 — 아래 open 경로와 같은 이유다
                except Exception as e:  # noqa: BLE001 — 오버레이는 절대 500 금지
                    log.warning("live quotes cold fetch failed (%d codes): %s",
                                len(code_list), e)
            rows: list[LiveQuote] = []
            for code in code_list:
                sample = self._last_quotes.get((venue, code))
                if sample is None:
                    continue
                row = self._to_live_quote(sample.quote, phase=phase, today=today)
                # 재조회가 실패해 장중/전일 표본이 남았다면 숨기지 않고 stale 로
                # 표시한다. 값 자체는 목록에 계속 보여 주되(빈 칸보다 낫다), 정밀
                # 소비자(현재가 라인·탭 제목)는 isStaleLiveQuote 로 이걸 거른다.
                if not self.is_closing_sample(sample, day):
                    row = row.model_copy(
                        update={"stale": True, "stale_reason": "pre_close_sample",
                                "warnings": [*row.warnings, failures[code]] if code in failures else row.warnings}
                    )
                rows.append(row)
            return rows
        try:
            quotes, failures = await self._fetch_partial(
                client, code_list, venue, fetch_chunk_fn,
            )
        except KiwoomCapacityOverloaded:
            # **재전파한다.** 청킹이 거버너 위로 올라가면서 이 예외가 여기 안쪽에서
            # 발생하게 됐는데, 여기서 stale 로 접으면 라우트가 붙이는
            # `capacity_overloaded_upstream` 사유가 사라지고 `fetch_failed` 로
            # 뭉개진다 — 과부하와 벤더 실패는 처방이 다르다(ADR-0137).
            raise
        except Exception as e:  # noqa: BLE001 — 10초 폴링 오버레이는 절대 500 금지;
            # KIS rate-limit/api-error/네트워크 타임아웃 등 무엇이든 빈 결과로 graceful
            # (프론트는 '—' 표시). retry-exhausted 신호는 warning 으로만 남긴다.
            log.warning("live quotes fetch failed (%d codes): %s", len(code_list), e)
            return self.stale_last_good(
                code_list,
                phase,
                today=today,
                stale_reason="fetch_failed",
                venue=venue,
            )
        quotes = self._remember(quotes, venue=venue, phase=phase, day=day, generation=generation)
        rows = {q.code: self._to_live_quote(q, phase=phase, today=today) for q in quotes}
        for code, reason in failures.items():
            fallback = self.stale_last_good([code], phase, today, venue=venue, stale_reason=reason)
            if fallback:
                rows[code] = fallback[0]
        return [rows[code] for code in code_list if code in rows]

    def stale_last_good(
        self,
        code_list: list[str],
        phase: str,
        today: date | None = None,
        *,
        stale_reason: str = "rest_bypassed",
        venue: Venue = "KRX",
    ) -> list[LiveQuote]:
        """캐시된 마지막 시세를 stale 표시로 서빙. venue 는 캐시 키의 일부다 —
        요청 venue 의 표본이 없으면 **다른 venue 것을 대신 주지 않고 비운다**(그쪽
        OHLC 는 이 venue 의 봉이 아니다). 프론트는 그 코드를 '—' 로 렌더한다."""
        rows: list[LiveQuote] = []
        for code in code_list:
            sample = self._last_quotes.get((venue, code))
            if sample is None:
                continue
            rows.append(
                self._to_live_quote(sample.quote, phase=phase, today=today).model_copy(
                    update={
                        "stale": True,
                        "stale_reason": stale_reason,
                    }
                )
            )
        return rows
