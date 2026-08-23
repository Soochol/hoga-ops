"""스크리너 일봉 코퍼스의 **결손 거래일**을 벤더 이력으로 채운다 (이슈 #1424).

## 두 종류의 결손을 **같은 방식으로** 다룬다

대상 판정이 「코퍼스 시작 이전」이 아니라 **「거래일 달력 대비 없는 날」**이다. 그래서
모양이 다른 두 결손이 한 경로로 처리된다:

| | 모양 | 실측 |
| --- | --- | --- |
| **앞쪽 갭** | 코퍼스 시작 이전이 통째로 없음 | 477종목(보통주), 2025-04-22 이전 |
| **내부 구멍** | 코퍼스 안쪽에 날짜가 빔 | 705종목 × 31거래일 = **21,855칸**(2026 6~7월) |

내부 구멍의 원인은 별개였다 — 로스터 멤버십 누락이라 그 날 이 집합 **전체**가 안 받아졌고,
`merge_roster_from_master` 가 스케줄러에 배선된 2026-08-03 부터 멈췄다. **출혈은 이미
멎었고 이 도구가 채우는 것은 남은 흉터다.**

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

## ⚠ 「없는 날」과 「안 받은 날」은 오프라인으로 구별되지 않는다 (#1532)

달력 대비 결손은 **상한**이다 — 그 종목이 애초에 존재하지 않던 날(상장 전·폐지 후)이
섞인다. 상장일은 심볼 마스터에 없고, 벤더에 물으면 그 자체가 줄이려는 호출이다.
두 축으로 좁힌다:

- **꼬리는 오프라인으로 자른다.** 그 종목의 **마지막 관측일 이후**는 세지 않는다.
  거래가 멎었거나(폐지·정지) 일일 갱신의 몫이거나 둘 중 하나이고, 둘 다 이 도구가
  채울 것이 아니다. 실측: 내부 구멍 25,650 → 23,243칸.
- **앞쪽은 런타임이 배운다.** 조회 결과의 **가장 이른 봉**을 `backfill_probe.json` 에
  적어 두고, 다음 계획이 그보다 앞을 안 센다. 벤더가 아무것도 안 주면 그 사실을 적어
  다음 런이 **그 종목을 아예 건너뛴다**. 한 번의 헛 호출이 이후 런을 정확하게 만든다.

리포트의 `leading` 은 그래서 **학습 전에는 상한**이다. `BackfillReport.leading_is_upper_bound`
가 그것을 명시한다 — 숫자만 보고 "이만큼 채울 수 있다" 로 읽지 말 것.

## 안전 규율

- **`dry_run=True` 가 기본이고, 벤더를 아예 부르지 않는다.** 계획(어느 종목의 어느
  날이 비었는지)만 세운다 — 그건 달력과 코퍼스만으로 나온다.
- **거래일 달력 커버리지 밖은 결손으로 세지 않는다.** `trading_days` 는 커밋된 시드라
  무자격에서도 정확하지만 범위 밖은 `None`(모름)이다 — 모르는 날을 결손으로 단정하면
  주말·휴장일을 벤더에 물으러 간다.
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
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import screener_factors, trading_days
from hoga.api.screener_store import (
    _DAILY_PL_SCHEMA,  # 아래 주석 참조
    append_rows,
    derive_adjusted,
    write_status,
)
from hoga.util.atomic_write import atomic_write_json

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


PROBE_FILENAME = "backfill_probe.json"

#: 프로브 파일의 날짜 형식 길이(`YYYYMMDD`). 이 리포의 날짜 문자열 관례와 같다.
_YYYYMMDD_LEN = 8


def read_probe(sdir: Path) -> dict[str, dt.date | None]:
    """종목별 **벤더가 가진 가장 이른 봉**. `None` = 조회했는데 아무것도 없었다.

    이 파일이 없으면 빈 dict — 첫 런은 아무것도 모르는 상태에서 시작한다(그게 정상이다).
    손상이면 조용히 빈 dict 로 떨어진다. 이건 **캐시**이지 진실이 아니라, 잃어도 다음
    런이 다시 배울 뿐이다.
    """
    path = sdir / PROBE_FILENAME
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    out: dict[str, dt.date | None] = {}
    for code, value in (raw.items() if isinstance(raw, dict) else []):
        if value is None:
            out[code] = None
        elif isinstance(value, str) and len(value) == _YYYYMMDD_LEN and value.isdigit():
            out[code] = dt.date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    return out


def write_probe(sdir: Path, probe: dict[str, dt.date | None]) -> None:
    atomic_write_json(
        sdir / PROBE_FILENAME,
        {c: (d.strftime("%Y%m%d") if d is not None else None) for c, d in sorted(probe.items())},
    )


@dataclass
class CodePlan:
    """한 종목의 백필 계획 — dry-run 리포트의 단위."""

    code: str
    corpus_start: dt.date
    #: **거래일 달력 대비 없는 날** 전량(앞쪽 갭 + 내부 구멍이 한 목록에 섞인다).
    missing_dates: list[dt.date]
    factor: float
    fetched_rows: int = 0
    skipped_reason: str | None = None

    @property
    def gap_from(self) -> dt.date:
        """벤더 조회 범위의 시작 — 결손의 최소 날짜."""
        return min(self.missing_dates)

    @property
    def gap_to(self) -> dt.date:
        """벤더 조회 범위의 끝. 범위 **안의** 비결손일은 받아도 버린다(멱등이라 무해)."""
        return max(self.missing_dates)

    @property
    def leading(self) -> int:
        """코퍼스 시작 이전 결손 수 — 리포트에서 두 종류를 갈라 보기 위한 것."""
        return sum(1 for d in self.missing_dates if d < self.corpus_start)

    @property
    def interior(self) -> int:
        return len(self.missing_dates) - self.leading


@dataclass
class BackfillReport:
    plans: list[CodePlan] = field(default_factory=list)
    written_rows: int = 0
    dry_run: bool = True

    @property
    def filled_codes(self) -> int:
        return sum(1 for p in self.plans if p.skipped_reason is None and p.fetched_rows > 0)

    @property
    def missing_cells(self) -> dict[str, int]:
        """결손 칸 수를 종류별로 — 「무엇을 채우는가」가 리포트의 첫 질문이다."""
        live = [p for p in self.plans if p.skipped_reason is None]
        return {
            "leading": sum(p.leading for p in live),
            "interior": sum(p.interior for p in live),
        }

    @property
    def leading_is_upper_bound(self) -> bool:
        """`leading` 을 **상한으로 읽어야 하는가** (#1532).

        프로브가 아직 모르는 종목이 하나라도 있으면 참이다 — 그 종목의 앞쪽 결손에는
        「상장 전」이 섞여 있을 수 있고, 그건 채울 수 있는 날이 아니다. 숫자만 보고
        "이만큼 채운다" 로 읽지 말라는 신호다. 한 번 돌리고 나면 대개 거짓이 된다.
        """
        return any(
            p.skipped_reason is None and p.code not in self.probed
            for p in self.plans
        )

    #: 이번 런에서 **새로 배운** 프로브(종목 → 벤더의 가장 이른 봉, `None` = 없음).
    probed: dict[str, dt.date | None] = field(default_factory=dict)

    @property
    def skipped(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.plans:
            if p.skipped_reason:
                out[p.skipped_reason] = out.get(p.skipped_reason, 0) + 1
        return out


def corpus_dates(unadjusted_path: Path) -> tuple[dict[str, dt.date], dict[str, set[dt.date]]]:
    """(종목별 시작일, 종목별 보유 날짜 집합).

    한 번의 스캔으로 둘을 낸다 — 대상 선정은 시작일을, 결손 계산은 보유 집합을 쓴다.
    """
    df = pl.scan_parquet(unadjusted_path).select(["code", "date"]).collect()
    present: dict[str, set[dt.date]] = {}
    for key, sub in df.group_by("code"):
        code = key[0] if isinstance(key, tuple) else key
        present[code] = set(sub["date"].to_list())
    starts = {c: min(ds) for c, ds in present.items() if ds}
    return starts, present


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
    present: dict[str, set[dt.date]],
    trading: set[dt.date],
    *,
    gap_from: dt.date,
    window_to: dt.date,
    corpus_start_after: dt.date | None,
    codes: list[str] | None,
    probe: dict[str, dt.date | None] | None = None,
) -> list[CodePlan]:
    """대상 선정 + **결손 날짜 계산**. 부수효과 없음 — dry-run 이 이 함수만으로 성립한다.

    `trading` 은 거래일 달력의 **커버리지 안** 날짜만이어야 한다(호출부가 자른다).
    모르는 날을 결손으로 세면 주말·휴장일을 벤더에 물으러 간다.
    """
    if codes is not None:
        wanted = [c for c in codes if c in starts]
    elif corpus_start_after is not None:
        wanted = sorted(c for c, s in starts.items() if s > corpus_start_after)
    else:
        wanted = sorted(starts)

    probe = probe or {}
    plans: list[CodePlan] = []
    for code in wanted:
        seen = present.get(code, set())
        # ── 꼬리: 마지막 관측일 이후는 세지 않는다(#1532). 폐지·정지이거나 일일 갱신의
        #    몫이거나 둘 중 하나이고, 둘 다 이 도구가 채울 것이 아니다.
        hi = min(window_to, max(seen)) if seen else window_to
        # ── 앞: 프로브가 아는 만큼만. 벤더가 아무것도 안 줬던 종목(`None`)은 앞쪽을
        #    아예 안 센다 — 그 헛 호출을 두 번 하지 않기 위한 것이 프로브의 존재 이유다.
        lo = gap_from
        if code in probe:
            earliest = probe[code]
            lo = min(seen) if earliest is None else max(gap_from, earliest)
        missing = sorted({d for d in trading if lo <= d <= hi} - seen)
        plan = CodePlan(
            code=code, corpus_start=starts[code], missing_dates=missing,
            factor=factors.get(code, 1.0),
        )
        if not missing:
            plan.skipped_reason = "no_gap"          # 재실행 시 자연 스킵
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
    window_to: dt.date,
    data_dir: Path | None = None,
    codes: list[str] | None = None,
    corpus_start_after: dt.date | None = None,
    dry_run: bool = True,
    batch: int = 50,
    concurrency: int = _CONCURRENCY,
    now_ms: int | None = None,
) -> BackfillReport:
    """앞쪽 갭을 채운다. **기본은 dry-run** — 계획만 세우고 아무것도 안 쓴다.

    `codes` 와 `corpus_start_after` 중 하나로 대상을 정한다(둘 다 없으면 전 종목).
    `[gap_from, window_to]` 안의 **거래일 중 코퍼스에 없는 날**이 대상이고, 달력
    커버리지 밖은 잘라 낸다. `data_dir` 은 거래일 오버레이 위치(미지정이면 시드만).
    반환 리포트로 무엇이 채워졌고 무엇이 왜 스킵됐는지 전수 확인할 수 있다.
    """
    up = sdir / "daily_unadjusted.parquet"
    starts, present = corpus_dates(up)
    factors = oldest_factors(sdir / "factors.parquet")
    # 달력은 **커버리지 안**만 쓴다 — 시드 범위 밖은 `None`(모름)이고, 모르는 날을
    # 결손으로 단정하면 주말·휴장일을 벤더에 물으러 간다(`trading_days` 도크스트링).
    end = trading_days.coverage_end(data_dir)
    coverage_to = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8])) if end else gap_from
    trading = {
        dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        for s in trading_days.trading_days(data_dir)
    }
    probe = read_probe(sdir)
    plans = plan_targets(
        starts, factors, present, trading,
        gap_from=gap_from, window_to=min(window_to, coverage_to),
        corpus_start_after=corpus_start_after, codes=codes, probe=probe,
    )
    report = BackfillReport(plans=plans, dry_run=dry_run, probed=dict(probe))
    todo = [p for p in plans if p.skipped_reason is None]
    # ⚠ **dry-run 은 벤더를 부르지 않는다.** 결정에 필요한 것은 「무엇이 비었는가」이고
    # 그건 달력과 코퍼스만으로 나온다. 부르면 리허설이 수백 종목치 유량을 태우고
    # 수 분이 걸린다 — 안전 장치가 비용을 만드는 셈이라 아무도 안 돌리게 된다.
    # 벤더가 실제로 그 구간을 줄 수 있는지는 별개 물음이고, 별도 표본 조회로 답한다.
    if dry_run or not todo:
        return report

    sem = asyncio.Semaphore(concurrency)
    learned: dict[str, dt.date | None] = {}

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
        # **결손일만** 남긴다. 벤더는 기준일에서 걸어 내려오느라 요청보다 넓게 주고,
        # 요청 범위 **안**에도 이미 가진 날이 섞여 있다(내부 구멍을 채울 때가 그렇다).
        # append 가 멱등이라 해롭진 않지만 통계가 부풀고 값 출처가 흐려진다.
        # **배운 것을 적는다**(#1532): 벤더가 가진 가장 이른 봉. 아무것도 없으면 `None`
        # 이고, 다음 계획이 이 종목의 앞쪽을 아예 안 센다 — 헛 호출을 두 번 하지 않는다.
        learned[plan.code] = min((b.date for b in bars), default=None)
        wanted = set(plan.missing_dates)
        inside = [b for b in bars if b.date in wanted]
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
    # 프로브는 **쓰기 성공 여부와 무관하게** 저장한다 — 배운 것은 사실이고, 다음 런의
    # 헛 호출을 줄이는 값이다. dry-run 은 애초에 여기 도달하지 않는다(조회를 안 한다).
    if learned:
        probe.update(learned)
        write_probe(sdir, probe)
        report.probed = dict(probe)
    return report
