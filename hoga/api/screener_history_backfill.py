"""스크리너 일봉 코퍼스의 **앞쪽 갭**을 벤더 이력으로 채운다 (이슈 #1424).

## 무엇을 고치나

`daily_unadjusted.parquet` 의 코퍼스 시작일이 종목마다 다르다. 원인은 코퍼스가
CSV 시드(`seed_daily_from_csv`) + 일일 증분(`run_update`)으로만 자라기 때문이다 —
**이력을 뒤로 늘리는 경로가 없었다.** 실측(2026-08-23): 4,690종목 중 477종목이
2025-04-22 부터만 있는데 벤더는 같은 종목의 2024년 244봉을 갖고 있다.

`screener_backfill.factor_backfill` 과 헷갈리지 말 것 — 저쪽은 **계수**를 만들고
이쪽은 **행**을 만든다. 그 이름 때문에 `daily_adjusted.prebackfill.parquet` 스냅샷이
"이력 백필 전"으로 오해되지만, 실제로 그 백필은 어느 종목의 시작일도 앞당기지
않았다(대조 실측: 3,561종목 전부 시작일 동일).

## 왜 역-수정해서 원주가에 쓰나

**벤더 일봉은 수정주가다.** 010120(5:1 분할) 실측: 2024-01-02 벤더 close 14,660 =
코퍼스 adjusted 14,660, 코퍼스 raw 73,300. 그래서 벤더 행을 `daily_unadjusted` 에
그대로 쓰면 원주가 코퍼스가 오염되고 `derive_adjusted` 가 계수를 **한 번 더** 곱한다.

SSOT 는 원주가이므로(`derive_adjusted` 가 매번 그것에서 수정주가를 재생성한다) 쓸 곳은
원주가뿐이다. 그래서 **역-수정**한다:

    raw_price  = adj_price  / factor        (apply_factors 의 `가격 ×factor` 역)
    raw_volume = adj_volume * factor        (apply_factors 의 `거래량 ÷factor` 역)

`factor` 는 그 종목의 **최古 세그먼트 계수**다. `apply_factors` 가 가장 오래된
`seg_start` 이전 날짜를 그 계수로 채우므로(extend-backward, ADR-0057), 백필한 갭
구간에 되적용되는 계수가 정확히 이것이다 → **왕복이 닫힌다**:

    raw_gap = adj_vendor / f  →  derive_adjusted: raw_gap * f = adj_vendor

즉 **adjusted 공간에서 무손실**이다. 스크리너·차트가 읽는 것이 adjusted 이므로
사용자가 보는 값은 벤더와 같아진다. 실측상 대상 477종목 중 422(88.5%)는 계수가
`1.0` 이라 이 식이 항등이다.

⚠ **감수하는 것**(계수 ≠ 1.0 인 55종목 한정): 갭 **안에서** 액면 이벤트가 있었다면
그건 어디에도 기록돼 있지 않다 — `factors.parquet` 은 코퍼스에서 계산되므로 코퍼스가
없는 구간을 원리적으로 못 본다. 그때 재구성된 `raw` 는 그 경계 이후로 역사적으로
부정확하다. **다만 `derive_adjusted` 가 같은 상수를 되곱하므로 adjusted 는 여전히
정확하고**, 부정확은 raw 공간에만 갇힌다.

## 안전 규율

- **`dry_run=True` 가 기본이다.** 아무것도 안 쓰고 리포트만 낸다.
- 계수가 없는 종목은 **건너뛴다**(추정하지 않는다). `apply_factors` 의 전제가
  "각 code 는 최소 1개 세그먼트" 이므로, 계수 없는 종목에 행을 넣으면 그 종목의
  수정주가가 통째로 휴리스틱 폴백(`adjust_splits`)으로 넘어간다.
- 벤더 조회는 **주입**한다(ADR-0057 과 같은 규율) — 무자격 환경에서 유닛 테스트가
  전 경로를 돈다.
- 배치마다 원자적으로 기록해 **resumable** — 중단돼도 완료분이 보존되고, 다음 run 은
  이미 채워진 구간을 자연히 건너뛴다(대상 선정이 현재 코퍼스 시작일 기준이므로).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import screener_factors
from hoga.api.screener_store import (
    _DAILY_PL_SCHEMA,  # 아래 주석 참조
    append_rows,
    derive_adjusted,
    write_status,
)

# `_DAILY_PL_SCHEMA` 를 **복제하지 않고 빌려 쓴다.** 원주가 parquet 에 쓰는 writer 가
# 둘(`run_update` · 이 모듈)이 됐는데, 스키마를 각자 들면 한쪽이 컬럼을 늘릴 때 다른
# 쪽이 조용히 낡는다 — 그 낡음은 append 시점의 타입 오류가 아니라 **읽는 쪽에서** 터진다.
# private 이름을 가져오는 대가보다 드리프트 비용이 크다.

log = logging.getLogger(__name__)

#: (code, from_yyyymmdd, to_yyyymmdd) -> 벤더 **수정주가** 일봉.
#: 반환 순서는 무관하다(아래에서 date 로 정렬·중복 제거한다).
FetchAdjustedDaily = Callable[[str, str, str], Awaitable[list["VendorBar"]]]

_CONCURRENCY = 8  # 벤더 HTTP 캡은 클라이언트가 쥔다 — 여기서는 버킷만 채운다


@dataclass(frozen=True)
class VendorBar:
    """벤더가 준 **수정주가** 일봉 한 개."""

    date: dt.date
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass
class CodePlan:
    """한 종목의 백필 계획 — dry-run 리포트의 단위."""

    code: str
    corpus_start: dt.date
    gap_from: dt.date
    gap_to: dt.date
    factor: float
    fetched_rows: int = 0
    skipped_reason: str | None = None


@dataclass
class BackfillReport:
    plans: list[CodePlan] = field(default_factory=list)
    written_rows: int = 0
    dry_run: bool = True

    @property
    def filled_codes(self) -> int:
        return sum(1 for p in self.plans if p.skipped_reason is None and p.fetched_rows > 0)

    @property
    def skipped(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.plans:
            if p.skipped_reason:
                out[p.skipped_reason] = out.get(p.skipped_reason, 0) + 1
        return out


def corpus_starts(unadjusted_path: Path) -> dict[str, dt.date]:
    """종목별 코퍼스 시작일. 대상 선정과 갭 계산의 유일한 입력."""
    df = (
        pl.scan_parquet(unadjusted_path)
        .group_by("code")
        .agg(pl.col("date").min().alias("first"))
        .collect()
    )
    return dict(zip(df["code"].to_list(), df["first"].to_list(), strict=True))


def oldest_factors(factors_path: Path) -> dict[str, float]:
    """종목별 **최古 세그먼트 계수** — extend-backward 가 갭에 적용할 바로 그 값."""
    factors = screener_factors.read_factors(factors_path)
    if factors is None or not factors.height:
        return {}
    oldest = (
        factors.sort(["code", "seg_start"])
        .group_by("code", maintain_order=True)
        .agg(pl.col("factor").first().alias("factor"))
    )
    return dict(zip(oldest["code"].to_list(), oldest["factor"].to_list(), strict=True))


def unadjust(bars: list[VendorBar], factor: float) -> list[dict]:
    """벤더 수정주가 → 원주가. `apply_factors` 의 정확한 역이다(모듈 도크스트링).

    `factor == 1.0` 이면 항등 — 대상의 88.5%가 여기 해당한다.
    """
    out: list[dict] = []
    for b in bars:
        out.append({
            "open": b.open / factor,
            "high": b.high / factor,
            "low": b.low / factor,
            "close": b.close / factor,
            # 거래량은 반대 방향(거래대금 보존) — `apply_factors` 가 ÷factor 하므로 여기선 ×.
            "volume": int(round(b.volume * factor)),
            "date": b.date,
        })
    return out


def plan_targets(
    starts: dict[str, dt.date],
    factors: dict[str, float],
    *,
    gap_from: dt.date,
    corpus_start_after: dt.date | None,
    codes: list[str] | None,
) -> list[CodePlan]:
    """대상 선정 + 갭 계산. **부수효과 없음** — dry-run 이 이 함수만으로 성립한다."""
    if codes is not None:
        wanted = [c for c in codes if c in starts]
    elif corpus_start_after is not None:
        wanted = sorted(c for c, s in starts.items() if s > corpus_start_after)
    else:
        wanted = sorted(starts)

    plans: list[CodePlan] = []
    for code in wanted:
        start = starts[code]
        gap_to = start - dt.timedelta(days=1)
        plan = CodePlan(
            code=code, corpus_start=start, gap_from=gap_from, gap_to=gap_to,
            factor=factors.get(code, 1.0),
        )
        if gap_to < gap_from:
            # 이미 gap_from 이전부터 있다 — 채울 것이 없다(재실행 시 자연 스킵).
            plan.skipped_reason = "no_gap"
        elif code not in factors:
            # 계수가 없으면 그 종목은 `adjust_splits` 휴리스틱으로 넘어간다 —
            # 행을 넣으면 수정주가 전체가 그 폴백에 걸린다. 추정하지 않는다.
            plan.skipped_reason = "no_factor"
        plans.append(plan)
    return plans


async def history_backfill(
    sdir: Path,
    *,
    fetch_adjusted_daily: FetchAdjustedDaily,
    gap_from: dt.date,
    codes: list[str] | None = None,
    corpus_start_after: dt.date | None = None,
    dry_run: bool = True,
    batch: int = 50,
    concurrency: int = _CONCURRENCY,
    now_ms: int | None = None,
) -> BackfillReport:
    """앞쪽 갭을 채운다. **기본은 dry-run** — 계획만 세우고 아무것도 안 쓴다.

    `codes` 와 `corpus_start_after` 중 하나로 대상을 정한다(둘 다 없으면 전 종목).
    반환 리포트로 무엇이 채워졌고 무엇이 왜 스킵됐는지 전수 확인할 수 있다.
    """
    up = sdir / "daily_unadjusted.parquet"
    starts = corpus_starts(up)
    factors = oldest_factors(sdir / "factors.parquet")
    plans = plan_targets(
        starts, factors,
        gap_from=gap_from, corpus_start_after=corpus_start_after, codes=codes,
    )
    report = BackfillReport(plans=plans, dry_run=dry_run)
    todo = [p for p in plans if p.skipped_reason is None]
    if not todo:
        return report

    sem = asyncio.Semaphore(concurrency)

    async def _one(plan: CodePlan) -> tuple[CodePlan, list[dict]]:
        try:
            async with sem:
                bars = await fetch_adjusted_daily(
                    plan.code,
                    plan.gap_from.strftime("%Y%m%d"),
                    plan.gap_to.strftime("%Y%m%d"),
                )
        except Exception:  # noqa: BLE001 — 한 종목 실패가 수백 종목 백필을 끊으면 안 된다
            log.warning("history_backfill: %s fetch 실패, skip(다음 run 재시도)",
                        plan.code, exc_info=True)
            plan.skipped_reason = "fetch_failed"
            return plan, []
        # 갭 밖 행은 버린다 — 벤더는 기준일에서 걸어 내려오느라 요청보다 넓게 줄 수 있고,
        # 그 행들은 이미 코퍼스에 있다(append 가 멱등이라 해롭진 않지만 통계가 부풀린다).
        inside = [b for b in bars if plan.gap_from <= b.date <= plan.gap_to]
        rows = unadjust(inside, plan.factor)
        plan.fetched_rows = len(rows)
        return plan, [{**r, "code": plan.code} for r in rows]

    pending: list[dict] = []

    def _commit(rows: list[dict]) -> None:
        new = pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA)
        n, last, merged = append_rows(up, new)
        ms = derive_adjusted(
            up, sdir / "daily_adjusted.parquet",
            factors_path=sdir / "factors.parquet", unadjusted_df=merged,
        )
        if now_ms is not None:
            write_status(sdir / "status.json", last_raw_date=last,
                         universe_size=n, derive_ms=ms, now_ms=now_ms)

    for i in range(0, len(todo), batch):
        results = await asyncio.gather(*(_one(p) for p in todo[i:i + batch]))
        for _plan, rows in results:
            pending.extend(rows)
        if pending and not dry_run:
            await asyncio.to_thread(_commit, pending)
            report.written_rows += len(pending)
            pending = []
    return report
