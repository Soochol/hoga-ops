"""시장 종합(`/market`) 읽기 전용 API (#1121).

**저장 축과 분리돼 있다.** 여기 표면들은 놓친 폴링의 대가가 잠깐의 낡음뿐이라
수요 구동 TTL 로 충분하다 — 결손이 영구 구멍인 장중 수급만 서버가 무조건 적재한다
(`investor_flow_collector`, #1099).

캐시 규약은 `_get_index_quotes`(live/api.py)의 확립된 패턴을 그대로 따른다:

1. 스냅샷은 **캐시만** 보고 만든다 — 자격증명·용량이 없어도 last-good 을 돌려준다.
2. `asyncio.Lock` 이 곧 단일비행. TTL 재확인은 **락 안에서** 한다.
3. 실패해도 last-good 을 **축출하지 않고**, `fetched_at` 은 갱신한다 — 업스트림이
   죽었을 때 TTL 주기로만 재시도하고 뜨거운 루프에 빠지지 않는다.
4. 로그는 `debug` — 배경 폴링의 실패를 warning 으로 남기면 로그 벽이 된다.

유량은 제약이 아니다: 버킷이 `(앱키, TR)` 당 5 req/s 이고 신규 TR 은 전부 자기 창구를
새로 받는다(#1015·ADR-0138). 그래도 우선순위는 `background` 다 — 클릭 응답이 아니라
주기 폴링이므로 사용자 조작에 양보하는 쪽이 맞다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from hoga.live import kiwoom_access, market_overview
from hoga.live.market_funds_runtime import MarketFundsCache

log = logging.getLogger(__name__)

# TTL 은 벤더 갱신 주기와 화면 위치가 정한다(#1099) — 유량이 정하지 않는다.
TTL_SECTORS_S = 30.0      # 지수·등락종목수: 화면 최상단
TTL_PROGRAM_S = 60.0      # 100행 ≈ 100분이라 자기 백필 — 주기는 신선도 문제일 뿐
TTL_STREAKS_S = 300.0     # 연속일수는 일 단위 축
TTL_BREADTH_S = 300.0     # 52주 신고·신저는 느리게 움직인다

_MARKETS = ("0", "1")  # 코스피 · 코스닥 — 별도 콜이다
_STEX_ALL = "3"


class _TtlCache:
    """TTL + 단일비행 + last-good. 네 규약(모듈 docstring)을 한 곳에 봉인한다."""

    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._value: Any = None
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    @property
    def value(self) -> Any:
        return self._value

    async def get(self, fetch: Any) -> Any:
        now = time.monotonic()
        if now - self._fetched_at < self._ttl_s and self._value is not None:
            return self._value
        async with self._lock:
            # 락 안에서 재확인 — 대기 중에 다른 코루틴이 이미 채웠을 수 있다.
            now = time.monotonic()
            if now - self._fetched_at < self._ttl_s and self._value is not None:
                return self._value
            try:
                fresh = await fetch()
            except Exception as e:  # noqa: BLE001 — 배경 폴링의 실패는 last-good 으로 흡수한다.
                log.debug("market_routes.fetch_failed error=%s", e)
                self._fetched_at = time.monotonic()  # 뜨거운 재시도 루프 방지
                return self._value
            if fresh is not None:
                self._value = fresh
            self._fetched_at = time.monotonic()
            return self._value


# 시장 폭 질의 표 — `(api_id, 고정 파라미터, 가변 축, 출력 이름)`. 표로 두는 이유는
# 네 카운트가 파라미터 하나만 다른 같은 모양이라, 코드로 펼치면 build_router 가
# 읽을 수 없게 길어지기 때문이다.
_BREADTH_QUERIES: tuple[tuple[str, str, str, str], ...] = (
    ("ka10016", "ntl_tp", "1", "new_high_52w"),
    ("ka10016", "ntl_tp", "2", "new_low_52w"),
    ("ka10019", "flu_tp", "1", "surge"),
    ("ka10019", "flu_tp", "2", "plunge"),
)

_KA10016_BASE = {
    "high_low_close_tp": "1", "stk_cnd": "0", "trde_qty_tp": "00000",
    "crd_cnd": "0", "updown_incls": "0", "dt": "250", "stex_tp": _STEX_ALL,
}
_KA10019_BASE = {
    "tm_tp": "1", "tm": "60", "trde_qty_tp": "00000", "stk_cnd": "0",
    "crd_cnd": "0", "pric_cnd": "0", "updown_incls": "1", "stex_tp": _STEX_ALL,
}


# 정규장 09:00–15:30 = 390분. 커버리지 분모의 근거이고, 수집 게이트
# (`ws_capture_window`)와 같은 창이다.
_SESSION_MINUTES = 390


def _recent_dates(today: str, *, days: int) -> list[str]:
    """오늘부터 거슬러 달력일 목록(오래된 순). 확정본이 없는 날은 호출부가 건너뛰므로
    휴장일을 여기서 거를 필요가 없다 — 파일 존재가 곧 거래일 판정이다."""
    import datetime as _dt  # noqa: PLC0415

    base = _dt.datetime.strptime(today, "%Y%m%d")
    out = [(base - _dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(days)]
    return sorted(out)


def _investor_flow_payload(data_dir: Path, *, daily_days: int = 40) -> dict[str, Any]:
    """장중 수급 — 저장된 표본을 읽어 3주체 누적 시계열 + 커버리지로.

    **읽기 경로는 벤더를 부르지 않는다.** 표본은 수집기가 이미 찍어 뒀고, 소급 조회가
    불가능한 데이터라 여기서 다시 부를 수도 없다(#1105).

    잠정/확정은 **확정 파일의 존재로 파생**한다 — 플래그를 저장하지 않는다(#1115).
    """
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415
    from hoga.live.investor_flow_collector import POLL_INTERVAL_S  # noqa: PLC0415
    from hoga.live.investor_flow_store import InvestorFlowStore, compute_coverage  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    store = InvestorFlowStore(data_dir)
    samples = store.load_samples(date)
    poll_ms = int(POLL_INTERVAL_S * 1000)

    series: dict[str, list[dict[str, Any]]] = {}
    for s in samples:
        got = market_overview.market_investor_row(s.rows)
        if got is None:
            continue
        label, values = got
        series.setdefault(label, []).append({"t_ms": s.sampled_at_ms, **values})

    # 일별(확정) 이력 — 확정본이 있는 날만. **비어 있는 것이 정상 시작 상태**다:
    # 장중 표본은 소급 백필이 불가능하지만 확정본은 `base_dt` 랜덤 액세스라 뒤늦게도
    # 채워진다(일일 배치의 캐치업). 화면은 "확정 이력이 쌓이는 중" 을 말해야 한다.
    daily: list[dict[str, Any]] = []
    for d in _recent_dates(date, days=daily_days):
        confirmed = store.load_confirmed(d)
        if confirmed is None:
            continue
        got = market_overview.market_investor_row(confirmed.rows)
        by_market: dict[str, Any] = {}
        for label in market_overview.WHOLE_MARKET_INDS.values():
            picked = market_overview.market_investor_row(
                [r for r in confirmed.rows
                 if market_overview.WHOLE_MARKET_INDS.get(str(r.get("inds_cd") or "")) == label]
            )
            if picked is not None:
                by_market[label] = picked[1]
        if got is not None or by_market:
            daily.append({"date": d, "markets": by_market})

    cov = compute_coverage(samples, poll_interval_ms=poll_ms)
    return {
        "daily": daily,
        "date": date,
        # 단위는 수집 시 요청이 정했다 — 이름에 박아 화면이 축을 못 헷갈리게 한다.
        "unit": "amt_eok",
        "confirmed": store.is_confirmed(date),
        "coverage": {
            "first_sample_ms": cov.first_sample_ms,
            "last_sample_ms": cov.last_sample_ms,
            "sample_count": cov.sample_count,
            "expected_count": market_overview.expected_sample_count(
                session_minutes=_SESSION_MINUTES, poll_interval_ms=poll_ms
            ),
            "gap_ranges": cov.gap_ranges,
        },
        "markets": series,
    }


async def _collect_sectors(call: Any) -> dict[str, Any]:
    """지수 값 + 등락종목수 + KRX 업종 (ka20003, 시장별 1콜).

    등락종목수는 **종합지수 행에만** 싣는다(#1100) — 업종 행에는 화면이 쓰지 않아
    싣지 않고, 지수 상품(코스피200·코스닥150)은 표시 규칙상 대상이 아니다.
    """
    out: dict[str, Any] = {"markets": {}}
    for mrkt_tp in _MARKETS:
        inds_cd = "001" if mrkt_tp == "0" else "101"
        rows = await call("ka20003", {"mrkt_tp": mrkt_tp, "inds_cd": inds_cd},
                          key=("market-sectors", mrkt_tp))
        if rows is None:
            continue
        parsed = market_overview.parse_index_sectors(rows)
        out["markets"][mrkt_tp] = {
            "index": next(
                ({"code": b.code, "name": b.name, "value": b.value,
                  "change_pct": b.change_pct, "rising": b.rising, "falling": b.falling,
                  "flat": b.flat, "upper": b.upper, "lower": b.lower}
                 for b in parsed if b.is_whole_market),
                None,
            ),
            "sectors": [
                {"code": b.code, "name": b.name, "value": b.value, "change_pct": b.change_pct}
                for b in parsed if not b.is_whole_market
            ],
        }
    return out


async def _collect_program(call: Any, api_id: str, *, scaled: bool, axis: str) -> dict[str, Any]:
    """프로그램 매매 추이. `scaled` 는 **기본값 없이** 호출부가 밝힌다 — 같은 이름의
    `kospi200` 이 ka90005 는 ×100, ka90010 은 소수점이라 한 파서로 묶으면 100배 틀린다."""
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415

    date = now_kst().strftime("%Y%m%d")
    out: dict[str, Any] = {"axis": axis, "markets": {}}
    for mrkt_tp, label in (("P00101", "KOSPI"), ("P10102", "KOSDAQ")):
        rows = await call(
            api_id,
            {"date": date, "amt_qty_tp": "1", "mrkt_tp": mrkt_tp,
             "min_tic_tp": "0" if scaled else "1", "stex_tp": _STEX_ALL},
            key=("market-program", api_id, mrkt_tp),
        )
        if rows is None:
            continue
        out["markets"][label] = market_overview.parse_program_trend(
            rows,
            kospi200_scaled=scaled,
            # 일별 축 + 코스닥의 kospi200·basis 는 실측상 틀린 값이다(파서 독스트링).
            trust_index_columns=scaled or label == "KOSPI",
        )
    return out


async def _collect_breadth(walk: Any) -> dict[str, Any]:
    """시장 폭 4카운트 × 2시장. `walk` 는 `(rows, truncated)` 를 주는 커서 호출."""
    out: dict[str, Any] = {"markets": {}}
    for mrkt_tp, label in (("001", "KOSPI"), ("101", "KOSDAQ")):
        bucket: dict[str, Any] = {}
        for api_id, axis_key, axis_val, name in _BREADTH_QUERIES:
            base = _KA10016_BASE if api_id == "ka10016" else _KA10019_BASE
            # ka10019 는 `jmp_rt` **내림차순**이라 임계 아래로 떨어지면 다음 페이지가
            # 필요 없다 — 의미도 살고(1,000+ 대신 두 자리) 콜도 준다. ka10016 은
            # 임계 개념이 없어 전량 센다.
            is_jump = api_id == "ka10019"
            got = await walk(
                api_id,
                {"mrkt_tp": mrkt_tp, axis_key: axis_val, **base},
                key=("market-breadth", api_id, mrkt_tp, axis_val),
                stop=(lambda rows, _page: market_overview.below_threshold(rows)) if is_jump else None,
            )
            if got is None:
                continue
            rows, truncated = got
            count = (
                market_overview.count_above_threshold(rows) if is_jump else len(rows)
            )
            bucket[name] = {"count": count, "truncated": truncated}
        if bucket:
            out["markets"][label] = bucket
    return out


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/market", tags=["market"])

    sectors_cache = _TtlCache(TTL_SECTORS_S)
    # 축마다 캐시가 갈려야 한다 — 한 캐시를 공유하면 당일/일별 토글이 서로의 값을 지운다.
    program_cache = _TtlCache(TTL_PROGRAM_S)
    daily_program_cache = _TtlCache(TTL_PROGRAM_S)
    streaks_cache = _TtlCache(TTL_STREAKS_S)
    breadth_cache = _TtlCache(TTL_BREADTH_S)
    # 증시 주변 자금은 벤더가 다르다(KOFIA) — 키움 거버너·TTL 축과 분리해 자체 캐시를 쓴다.
    funds_cache = MarketFundsCache()

    def _seam() -> tuple[Any, Any] | None:
        """(거버너, 클라이언트). 무자격이면 None — 라우트는 빈 응답을 돌려준다."""
        from hoga.live import kiwoom_rest_runtime  # noqa: PLC0415 — 지연 import(heavy·시임)

        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            return None
        return kiwoom_rest_runtime.ensure_scheduler(data_dir), client

    async def _call(api_id: str, body: dict[str, str], *, key: tuple) -> list[dict[str, Any]] | None:
        seam = _seam()
        if seam is None:
            return None
        scheduler, client = seam
        page = await kiwoom_access.run_with_capacity(
            scheduler,
            key=key,
            api_id=api_id,
            priority="background",
            client=client,
            # 기본인자 바인딩 — late binding 이면 모든 호출이 마지막 body 를 본다.
            fetch_fn=lambda c, b=body: c.call(api_id, b),
        )
        return list(getattr(page, "rows", []) or [])

    @router.get("/sectors")
    async def get_sectors() -> dict[str, Any]:
        """지수 값 + **등락종목수** + KRX 업종 (ka20003, 시장별 1콜).

        등락종목수는 종합지수(001/101)에만 싣는다(#1100) — 지수 상품(코스피200·
        코스닥150)에는 표시 규칙상 붙이지 않는다. 코스피200 은 벤더에 값 자체가 없다.
        """

        return await sectors_cache.get(lambda: _collect_sectors(_call)) or {"markets": {}}

    @router.get("/program")
    async def get_program(axis: str = "intraday") -> dict[str, Any]:
        """프로그램 매매 추이. `axis=intraday`(ka90005) | `daily`(ka90010).

        ⚠ 두 TR 은 응답 스키마가 같고 **`kospi200` 스케일만 다르다** — 파서에
        `kospi200_scaled` 를 명시적으로 넘기는 이유다(기본값을 두지 않았다).
        """
        api_id = "ka90005" if axis == "intraday" else "ka90010"
        scaled = axis == "intraday"

        cache = program_cache if axis == "intraday" else daily_program_cache
        got = await cache.get(
            lambda: _collect_program(_call, api_id, scaled=scaled, axis=axis)
        )
        return got or {"axis": axis, "markets": {}}

    async def _walk(
        api_id: str, body: dict[str, str], *, key: tuple, stop: Any = None
    ) -> tuple[list[dict[str, Any]], bool] | None:
        """커서를 따라가는 호출. `(rows, truncated)` — 절사 여부가 값과 동급이다.

        **페이지 1장 = submit 1건**이다(ADR-0137). walk 전체를 한 submit 으로 감싸면
        버킷은 1 을 세고 벤더는 N 을 센다 — 그래서 `run_page` 이음매에 넣는다.
        """
        seam = _seam()
        if seam is None:
            return None
        scheduler, client = seam

        def _run_page(fetch_fn: Any, page_idx: int) -> Any:
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=(*key, page_idx),
                api_id=api_id,
                priority="background",
                client=client,
                fetch_fn=fetch_fn,
            )

        return await client.walk(
            api_id,
            body,
            max_pages=market_overview.MAX_BREADTH_PAGES,
            stop=stop,
            run_page=_run_page,
        )

    @router.get("/breadth")
    async def get_breadth() -> dict[str, Any]:
        """시장 폭 — 52주 신고·신저(ka10016), 급등·급락(ka10019).

        **둘 다 카운트를 주지 않고 목록을 준다**(#1096) — 행을 세야 한다. ka10019 는
        200행에서 커서가 안 끝나므로 상한이 필요한데, **끊었다는 사실을 응답이 말한다**
        (`truncated`). 조용한 절사는 "전부 셌다" 로 읽힌다(#1099).

        상·하한 종목수는 여기 없다 — `/sectors` 의 `upper`/`lower` 가 ka20003 에서
        이미 온다(그래서 ka10017 은 배선하지 않았다).
        """

        return await breadth_cache.get(lambda: _collect_breadth(_walk)) or {"markets": {}}

    @router.get("/funds")
    async def get_funds() -> dict[str, Any]:
        """증시 주변 자금 — 예탁금·신용융자·CMA (KOFIA, 이 페이지의 유일한 제3 벤더).

        `KOFIA_API_KEY` 가 없으면 `unavailable="credentials_missing"` 로 이 카드만
        비고 나머지 표면은 정상 동작한다(ADR-0134). 기준일(`as_of`)은 **응답에서**
        오므로 화면은 "T+2" 를 고정 문구로 박으면 안 된다.
        """
        return await funds_cache.get()

    @router.get("/investor-flow")
    async def get_investor_flow() -> dict[str, Any]:
        """장중 수급 — 수집기가 적재한 표본(#1120)을 읽는다. 벤더를 부르지 않는다.

        커버리지가 값과 동급이다: 수집이 죽으면 차트가 **짧은 선을 사실처럼** 그린다.
        재시작 공백은 `gap_ranges` 로 정직하게 드러나고 **메울 수는 없다**(#1105).
        """
        return await asyncio.to_thread(_investor_flow_payload, data_dir)

    @router.get("/streaks")
    async def get_streaks() -> dict[str, Any]:
        """연속 순매수 — **한 콜이 외국인·기관 두 카드**를 채운다(ka10131, #1096)."""

        async def _fetch() -> dict[str, Any]:
            rows = await _call(
                "ka10131",
                {"dt": "1", "mrkt_tp": "001", "netslmt_tp": "2", "stk_inds_tp": "0",
                 "amt_qty_tp": "0", "stex_tp": _STEX_ALL},
                key=("market-streaks",),
            )
            if rows is None:
                return {"외국인": [], "기관": [], "warnings": []}
            # ETF·ETN 제외 — 순위 드로어와 같은 방식(심볼 마스터 기반). KODEX 레버리지
            # 류가 상위를 채우면 "누가 무엇을 사나" 라는 카드의 질문에 답이 안 된다.
            # 마스터 미로드면 못 거른 채 경고를 실어 보낸다(조용한 실패 금지).
            from hoga.api import symbols  # noqa: PLC0415

            warnings: list[str] = []
            drop = symbols.all_etf_etn_codes()
            if drop is None:
                warnings.append("etf_filter_unavailable")
            else:
                rows = [r for r in rows
                        if str(r.get("stk_cd") or "").split("_")[0] not in drop]
            return {
                "warnings": warnings,
                **{
                    actor: market_overview.parse_streaks(rows, actor=actor)
                    for actor in ("외국인", "기관")
                },
            }

        return await streaks_cache.get(_fetch) or {"외국인": [], "기관": [], "warnings": []}

    return router
