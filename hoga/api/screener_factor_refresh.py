"""이미 계수가 있는 종목의 **factors 갱신** (#1538).

## 왜 별도 모듈인가

`screener_backfill.factor_backfill` 은 **최초 구축** 도구다. 그 안의

```python
todo = [c for c in all_codes if c in raw_by_code and c not in done]
```

은 중단 복구(resumable)를 위한 것이고 그 목적에는 맞다. 문제는 그 구축이 전 종목에
도달하는 순간 `todo` 가 영구히 비어 **factors 가 얼어붙는다**는 것이다 — 게이트가
성공했기 때문에 기능이 죽는다. 실측(2026-08-24): 주식수 변경에 계수가 붙은 비율이
2026-05 에 136/142 였다가 2026-06 에 11/84, **2026-07·08 은 0** 이었고, 결손이
196건·114종목이었다. 피해는 `daily_adjusted` 의 5×·10× 가격 절벽이다(#1279 와 같은 부류).

그래서 `factor_backfill` 의 게이트를 **풀지 않는다**. 저쪽은 "아직 계수가 없는 종목을
채운다" 는 계약을 그대로 두고, 이 모듈이 "이미 있는데 낡은 종목을 고친다" 를 맡는다.
두 계약을 한 함수에 겹치면 재실행이 4,330 콜을 태우는 물건이 된다.

## 무엇을 다시 계산할지 — **설명되지 않는 계단**

전 종목 재계산은 벤더 4,330 콜이다. 그래서 대상을 고른다:

- 연속한 두 거래일 종가의 비가 **1.6배 이상 또는 0.625배 이하**. KRX 일일 변동폭이
  ±30% 라 시세로는 불가능하다 → 주식수 변경(분할·병합·감자)뿐이다.
- **직전 봉이 4일 이내**여야 한다. 이 조건이 「정지 후 재개」를 걸러 낸다 — 재개일의
  기준가는 정지 전 종가와 무관하게 재설정될 수 있고, 그건 주식수가 안 바뀐 것이라
  계수가 필요 없다. 실측에서 이 조건이 212건 중 16건을 걸러 냈다.
- 그 날짜에 `factors` 세그먼트가 **없어야** 한다.

이 판정은 **벤더를 안 부른다** — 그래서 dry-run 이 공짜다.

## ⚠ 덮어쓰면 안 되는 종목이 있다

`008500` 은 벤더 **수정주가 계열이 2026-07-29 부터**다(원주가 코퍼스엔 2025-04-23 부터
305봉). 그대로 재계산하면 첫 세그먼트가 거기 생기고, `apply_factors` 의 extend-backward
가 그 이전 전부에 그 계수를 먹인다 — 그리고 기존 `2025-12-15` 세그먼트를 **잃는다**.
벤더가 더는 줄 수 없는 정보라 되돌릴 수도 없다.

그래서 규칙 하나: **기존 세그먼트 경계가 벤더 수정주가 커버리지보다 앞서면 건드리지
않고 `blocked` 로 보고한다.** 「전제가 깨졌는데 계속 진행하는 것」이 이 종류 작업에서
가장 비싼 실수다(`screener_q_code_dedup` 의 같은 규율).

계수를 **합성**해서(기존 × 새 이벤트 비율) 살리는 길도 있지만, 그 비율을 원주가 계단에서
역산하면 이벤트 당일 시세 변동이 섞여 부정확하다(실측 `008500`: 5:1 인데 계단은 5.68).
**추측하지 않는다.**

## 안전 규율

- **`dry_run=True` 가 기본.** 무엇을 다시 계산할지 전수로 보고하고 벤더도 안 부른다.
- 쓰기 전에 `factors.parquet` **스냅샷**(`factors.pre-refresh-<stamp>.parquet`).
  `daily_adjusted` 는 안 뜬다 — 원주가 + factors 에서 **완전히 재생성**되는 파생물이라
  136MB 를 복사할 이유가 없다(SSOT 는 원주가와 계수다).
- 갱신한 코드의 **기존 행을 지우고** 새 세그먼트를 넣는다. `factor_backfill._flush` 처럼
  concat 만 하면 같은 코드에 세그먼트가 두 벌 쌓인다.
- 재계산 뒤 그 종목의 계단이 **실제로 설명됐는지** 다시 판정해 `unresolved` 로 보고한다.
  벤더 수정주가가 액션을 반영 안 했으면 덮어써도 달라지는 게 없고, 그건 알아야 한다.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import screener_factors
from hoga.api.screener_store import derive_adjusted

log = logging.getLogger(__name__)

#: 연속 거래일 종가비가 이 밖이면 시세로 불가능하다 — KRX 일일 변동폭은 ±30%.
#: 1.6/0.625 는 그 상한(1.3)에서 여유를 둔 값이라, 정상 시세를 대상으로 오인하지 않는다.
RATIO_HI = 1.6
RATIO_LO = 0.625
#: 직전 봉이 며칠 이내여야 「거래가 이어졌다」로 보는가. 주말(2)+공휴일 1~2일을 흡수한다.
#: 이보다 벌어졌으면 정지 후 재개일 수 있고, 재개 기준가는 주식수 변경이 아니다.
MAX_GAP_DAYS = 4

FetchAdj = Callable[[str, str, str], Awaitable[list[tuple[dt.date, float]]]]

_REFRESH_CONCURRENCY = 8


@dataclass(frozen=True)
class UnexplainedStep:
    """계수가 설명하지 못하는 종가 계단 하나."""

    code: str
    date: dt.date
    ratio: float


@dataclass
class RefreshReport:
    """무엇을 다시 계산했나(또는 할 것인가)."""

    steps: list[UnexplainedStep] = field(default_factory=list)
    #: 다시 계산할 종목(= `steps` 의 코드 집합).
    candidates: list[str] = field(default_factory=list)
    refreshed: list[str] = field(default_factory=list)
    #: 벤더 수정주가가 기존 세그먼트를 못 덮어 **건드리지 않은** 코드와 사유.
    blocked: list[tuple[str, str]] = field(default_factory=list)
    #: 벤더 호출·계산이 실패한 코드. 다음 실행에서 재시도된다.
    failed: list[str] = field(default_factory=list)
    #: 갱신했는데 **여전히** 계단이 설명 안 되는 코드 — 벤더 수정주가가 액션을 반영 안 했다.
    unresolved: list[str] = field(default_factory=list)
    segments_before: int = 0
    segments_after: int = 0
    dry_run: bool = True


def find_unexplained_steps(
    unadjusted: pl.DataFrame,
    factors: pl.DataFrame | None,
    *,
    since: dt.date,
    ratio_hi: float = RATIO_HI,
    ratio_lo: float = RATIO_LO,
    max_gap_days: int = MAX_GAP_DAYS,
) -> list[UnexplainedStep]:
    """벤더를 안 부르는 순수 판정 — dry-run 이 이 함수만으로 성립한다.

    `since` 에 기본값을 두지 않는 이유: 전 역사를 훑으면 초기 구축 시절의 알려진
    비대칭까지 대상이 되어 벤더 호출이 불어난다. **어디서부터인지는 호출자가 정한다.**
    """
    if unadjusted.is_empty():
        return []
    df = unadjusted.select(["code", "date", "close"]).sort(["code", "date"])
    stepped = (
        df.with_columns([
            pl.col("close").shift(1).over("code").alias("_prev"),
            pl.col("date").shift(1).over("code").alias("_prev_d"),
        ])
        .drop_nulls(["_prev", "_prev_d"])
        .filter(pl.col("_prev") > 0)
        .with_columns([
            (pl.col("close") / pl.col("_prev")).alias("_ratio"),
            (pl.col("date") - pl.col("_prev_d")).dt.total_days().alias("_gap"),
        ])
        .filter(
            ((pl.col("_ratio") >= ratio_hi) | (pl.col("_ratio") <= ratio_lo))
            & (pl.col("_gap") <= max_gap_days)
            & (pl.col("date") >= since)
        )
    )
    known: set[tuple[str, dt.date]] = set()
    if factors is not None and not factors.is_empty():
        known = {
            (r["code"], r["seg_start"])
            for r in factors.select(["code", "seg_start"]).iter_rows(named=True)
        }
    return [
        UnexplainedStep(code=r["code"], date=r["date"], ratio=r["_ratio"])
        for r in stepped.iter_rows(named=True)
        if (r["code"], r["date"]) not in known
    ]


def _raw_close_by_code(unadjusted: pl.DataFrame, codes: set[str]) -> dict[str, list[tuple[dt.date, float]]]:
    sub = unadjusted.filter(pl.col("code").is_in(list(codes))).select(
        ["code", "date", "close"]
    ).sort(["code", "date"])
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for (code, *_), grp in sub.group_by("code", maintain_order=True):
        out[str(code)] = list(zip(grp["date"].to_list(), grp["close"].to_list(), strict=True))
    return out


def _coverage_block_reason(
    existing_starts: list[dt.date], paired: list[tuple[dt.date, float, float]],
) -> str | None:
    """덮어쓰면 **정보를 잃는가**. 잃으면 사유 문자열, 아니면 None.

    잃는 조건은 하나뿐이다: 기존 세그먼트 경계가 벤더 수정주가가 닿는 범위보다
    **앞서** 있는 것. 그 경계는 지금 벤더 응답으로 재현할 수 없으므로, 덮어쓰면
    영구 손실이다(`008500` 이 그 사례 — 수정주가가 2026-07-29 부터인데 세그먼트는
    2025-04-23·2025-12-15 에 있다).

    기존 세그먼트가 없으면 잃을 것도 없다 — 최초 구축과 같은 상황이라 통과시킨다.
    """
    if not paired:
        return "no_adjusted_rows"
    if not existing_starts:
        return None
    earliest_adj = paired[0][0]
    lost = [d for d in existing_starts if d < earliest_adj]
    if lost:
        return (
            f"vendor_adjusted_starts_{earliest_adj:%Y%m%d}_but_segments_at_"
            + ",".join(f"{d:%Y%m%d}" for d in sorted(lost))
        )
    return None


def _replace_and_write(
    fpath: Path,
    factors: pl.DataFrame | None,
    new_by_code: dict[str, list[screener_factors.FactorSegment]],
    *,
    stamp: str,
) -> pl.DataFrame:
    """스냅샷 → 갱신 코드의 **기존 행 제거** → 새 세그먼트 concat → 원자적 기록.

    제거가 핵심이다. `factor_backfill._flush` 처럼 `기존 ∪ 신규` 만 하면 같은 코드에
    세그먼트가 두 벌 쌓이고, `apply_factors` 의 backward asof 가 그중 뒤엣것을 집어
    조용히 틀린 척도를 먹인다. 저쪽은 `done` 게이트 덕에 그 경로에 못 닿았을 뿐이다.
    """
    if fpath.exists():
        snap = fpath.with_suffix(f".pre-refresh-{stamp}.parquet")
        if not snap.exists():
            shutil.copyfile(fpath, snap)
    fresh = screener_factors.segments_to_frame(new_by_code)
    kept = (
        factors.filter(~pl.col("code").is_in(list(new_by_code)))
        if factors is not None and factors.height
        else fresh.head(0)
    )
    merged = pl.concat([kept.select(fresh.columns), fresh]) if kept.height else fresh
    screener_factors.write_factors(merged, fpath)
    return merged


async def refresh_factors(
    sdir: Path,
    *,
    fetch_adj: FetchAdj,
    since: dt.date,
    dry_run: bool = True,
    stamp: str | None = None,
    concurrency: int = _REFRESH_CONCURRENCY,
    max_codes: int | None = None,
) -> RefreshReport:
    """설명되지 않는 계단을 가진 종목의 계수를 다시 계산한다. **기본은 dry-run.**

    ⚠ **dry-run 은 벤더를 부르지 않는다.** 리허설이 수백 콜을 태우면 아무도 안 돌린다
    (#1424 에서 실제로 그랬다). 대신 dry-run 이 못 채우는 칸이 있다 — `blocked` ·
    `unresolved` 는 벤더 응답이 있어야 정해지므로 리허설에선 비어 있다.

    `max_codes` 는 첫 실행을 잘라 보기 위한 상한이다. 잘랐으면 로그로 남긴다 —
    조용한 절단은 "다 훑었다" 로 읽힌다.
    """
    up = sdir / "daily_unadjusted.parquet"
    fpath = sdir / "factors.parquet"
    unadjusted = pl.read_parquet(up)
    factors = screener_factors.read_factors(fpath)

    report = RefreshReport(dry_run=dry_run)
    report.segments_before = 0 if factors is None else factors.height
    report.steps = find_unexplained_steps(unadjusted, factors, since=since)
    candidates = sorted({s.code for s in report.steps})
    if max_codes is not None and len(candidates) > max_codes:
        log.warning(
            "factor refresh: 후보 %d 종목 중 %d 만 처리한다(max_codes) — 나머지 %d 는 남는다",
            len(candidates), max_codes, len(candidates) - max_codes,
        )
        candidates = candidates[:max_codes]
    report.candidates = candidates
    report.segments_after = report.segments_before
    if dry_run or not candidates:
        return report

    raw_by_code = _raw_close_by_code(unadjusted, set(candidates))
    existing_by_code: dict[str, list[dt.date]] = {}
    if factors is not None:
        for r in factors.filter(pl.col("code").is_in(candidates)).iter_rows(named=True):
            existing_by_code.setdefault(r["code"], []).append(r["seg_start"])

    sem = asyncio.Semaphore(concurrency)
    new_by_code: dict[str, list[screener_factors.FactorSegment]] = {}

    async def _one(code: str) -> tuple[str, list[screener_factors.FactorSegment] | None, str | None]:
        rr = raw_by_code.get(code) or []
        if not rr:
            return code, None, "no_raw_rows"
        try:
            async with sem:
                adj = await fetch_adj(
                    code, rr[0][0].strftime("%Y%m%d"), rr[-1][0].strftime("%Y%m%d")
                )
        except Exception:  # noqa: BLE001 — 한 종목 실패가 배치를 중단시키면 안 된다
            log.warning("factor refresh: %s fetch 실패, skip(다음 실행 재시도)", code, exc_info=True)
            return code, None, None
        paired = screener_factors.pair_raw_adj(rr, adj)
        block = _coverage_block_reason(existing_by_code.get(code, []), paired)
        if block is not None:
            return code, None, block
        return code, screener_factors.compute_factor_segments(paired), None

    results = await asyncio.gather(*(_one(c) for c in candidates))
    for code, segs, block in results:
        if block is not None:
            report.blocked.append((code, block))
        elif segs:
            new_by_code[code] = segs
        else:
            report.failed.append(code)

    if not new_by_code:
        return report

    merged = _replace_and_write(
        fpath, factors, new_by_code,
        stamp=stamp or dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S"),
    )
    report.refreshed = sorted(new_by_code)
    report.segments_after = merged.height

    # 고쳤다고 말하기 전에 **다시 판정한다.** 벤더 수정주가가 액션을 반영 안 했으면
    # 덮어써도 계단이 남는다 — 그 경우를 성공으로 세면 리포트가 거짓이 된다.
    still = find_unexplained_steps(unadjusted, merged, since=since)
    report.unresolved = sorted({s.code for s in still} & set(report.refreshed))

    derive_adjusted(up, sdir / "daily_adjusted.parquet", factors_path=fpath)
    log.info(
        "factor refresh: %d 종목 갱신 · 보류 %d · 실패 %d · 미해소 %d (세그먼트 %d→%d)",
        len(report.refreshed), len(report.blocked), len(report.failed),
        len(report.unresolved), report.segments_before, report.segments_after,
    )
    return report


async def refresh_factors_with_vendor(
    data_dir: Path, *, since: dt.date, dry_run: bool = True, max_codes: int | None = None,
) -> RefreshReport:
    """프로덕션 진입 — 키움 클라이언트로 `fetch_adj` 를 묶어 `refresh_factors` 실행.

    `screener_backfill.run_backfill` 의 `fetch_adj` 와 **같은 배선**이다: 페이지 1장이
    거버너 submit 1건이고(ADR-0137), 수정주가 기준일은 **오늘 하나**로 고정한다
    (#1228 함정 ④ — `base_dt=to` 로 두면 최신 행이 과거인 종목에서 그 뒤 분할이 빠진다).

    자격증명이 없으면 **조용히 skip 하지 않고 loud fail** 한다(백필 계열의 관례).

        uv run python -c "
        import asyncio, datetime as dt
        from pathlib import Path
        from hoga.api.screener_factor_refresh import refresh_factors_with_vendor
        r = asyncio.run(refresh_factors_with_vendor(
            Path.home()/'.local/share/hoga-ops/data',
            since=dt.date(2026, 1, 1)))       # dry_run=True 가 기본
        print(len(r.candidates), '종목 ·', len(r.steps), '계단')"
    """
    from datetime import datetime  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)

    from hoga.live import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)
        kiwoom_access,
        kiwoom_daily_candles,
        kiwoom_rest_runtime,
    )
    from hoga.util.timeenc import KST  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)

    sdir = data_dir / "screener"
    if dry_run:
        # 리허설은 벤더가 아예 필요 없다 — 자격증명 게이트도 지나지 않는다. 그래야
        # 무자격 dev·워크트리에서도 "무엇이 밀렸나" 를 볼 수 있다(ADR-0134).
        async def _unused(code: str, frm: str, to: str) -> list[tuple[dt.date, float]]:
            raise AssertionError("dry-run 은 벤더를 부르지 않는다")

        return await refresh_factors(
            sdir, fetch_adj=_unused, since=since, dry_run=True, max_codes=max_codes
        )

    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        raise RuntimeError("키움 자격증명 없음(KIWOOM_APP_KEY/SECRET) — factor 갱신 불가")
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
    as_of_s = datetime.now(KST).strftime("%Y%m%d")

    async def fetch_adj(code: str, frm: str, to: str) -> list[tuple[dt.date, float]]:
        def _run_page(fetch_fn, page_idx: int):
            return kiwoom_access.run_with_capacity(
                scheduler,
                key=("screener-factor-refresh", code, frm, to, page_idx),
                api_id=kiwoom_daily_candles.API_ID,
                priority="background",
                client=client,
                fetch_fn=fetch_fn,
            )

        res = await kiwoom_daily_candles.fetch_daily_candles(
            client, code, frm, to,
            adjust=True, adjusted_as_of=as_of_s, run_page=_run_page,
        )
        return [
            (datetime.fromtimestamp(c.t_ms / 1000, tz=KST).date(), float(c.close))
            for c in res.candles
        ]

    return await refresh_factors(
        sdir, fetch_adj=fetch_adj, since=since, dry_run=False, max_codes=max_codes
    )
