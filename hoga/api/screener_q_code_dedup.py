"""ETN `Q` 접두 코드의 **중복 등재** 정리 (#1424 부수 발견).

## 무엇이 잘못돼 있나

같은 ETN 이 로스터·코퍼스에 **두 코드로** 들어 있다 — `Q500023` 과 `500023`.

원인은 키 형태 불일치다. 심볼 마스터는 `kiwoom_master.normalize_code` 로 `Q` 를 벗겨
싣는데(그 도크스트링: *"ETN `Q` 접두를 벗긴다"*), 로스터 `stocks.parquet` 의 **CSV
시드분**은 `.mst` 시절 형태를 그대로 갖고 있다. `merge_roster_from_master` 는 **추가만**
하므로 두 형이 공존하게 됐다.

피해는 둘이었다:

1. **「ETF 제외」가 새어 나갔다** — 문자열 대조라 `Q` 형이 걸리지 않아 ETN 이 일반주
   행세로 통과했다. 그쪽은 `symbols.all_etf_etn_codes()` 가 두 형을 함께 내도록
   봉합했다(별도 PR). **이 모듈이 그 뿌리를 없앤다** — 정리가 끝나면 그 변형 추가는
   무해한 잉여가 된다.
2. **일일 갱신이 같은 종목을 두 번 받는다** — 로스터가 갱신 대상 목록이라
   (`screener._build_plan`), 중복만큼 벤더 호출과 코퍼스 행이 낭비된다.

## 두 부류를 **구분해서** 지운다

| 부류 | 판정 | 지워도 되는 근거 |
| --- | --- | --- |
| `duplicate` | `Q<code>` 이고 `<code>` 가 로스터에 **있다** | 같은 종목이 정규 코드로 이미 있다 |
| `orphan` | `Q<code>` 이고 `<code>` 가 로스터에 **없다** | 코퍼스 행이 0 이고 마스터에도 없다(만기 소멸 ETN) |

**`orphan` 은 코퍼스 행이 0 인 것을 확인하고서만 지운다.** 행이 있으면 그건 이 도구가
모르는 상황이므로 `blocked` 로 보고하고 **건드리지 않는다** — 「없을 것」이라는 전제가
깨졌는데 계속 진행하는 것이 이 종류 작업에서 가장 비싼 실수다.

## ⚠ 삭제가 아니라 **병합**이다

실측(2026-08-23)이 순진한 삭제를 기각했다. 겹치는 (종목, 날짜) 8,998 쌍은 값이 **완전히
일치**하지만(불일치 0), `Q` 형에만 있는 날짜가 **321종목 × 2026-08-03 하루** 있었다 —
정규 코드에 그날 구멍이 있다. 그대로 지웠으면 321개 계열에 하루짜리 구멍을 냈을 것이다.

그래서 `duplicate` 의 행을 둘로 가른다:

- 정규 코드에 **이미 있는 날짜** → 버린다(값이 같은 것을 확인했다)
- `Q` 형에만 있는 날짜 → **코드를 정규 형으로 고쳐 남긴다**(migrate)

즉 이 도구는 무손실이다. 「중복 제거」라는 이름으로 시작했지만 실제로 필요한 것은
**두 계열의 병합**이었다.

## 안전 규율

- **`dry_run=True` 가 기본.** 무엇을 지울지 전수로 보고하고 아무것도 안 쓴다.
- 쓰기 전에 **스냅샷**을 남긴다(`*.pre-qdedup.parquet`) — 이 리포가 코퍼스 변경마다
  스냅샷을 남겨 온 관례 그대로다(`daily_adjusted.prebackfill.parquet` 등).
- `daily_unadjusted` 를 고치고 **`derive_adjusted` 로 재생성**한다. 수정주가를 직접
  건드리지 않는다(SSOT 는 원주가).
"""

from __future__ import annotations

import datetime as dt
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api.screener_store import derive_adjusted
from hoga.util.atomic_write import atomic_write_parquet_df

log = logging.getLogger(__name__)

#: 「같은 값」 판정 허용오차(원). 코퍼스 가격은 원 단위 정수에 가깝고 수정주가 나눗셈에서
#: 부동소수 꼬리만 생기므로, 1전(0.01) 이면 진짜 불일치와 계산 잡음을 가른다.
_CLOSE_EPSILON = 0.01


@dataclass
class DedupReport:
    """무엇을 지웠나(또는 지울 것인가)."""

    duplicates: list[str] = field(default_factory=list)
    orphans: list[str] = field(default_factory=list)
    #: `orphan` 인데 코퍼스 행이 있어 **건드리지 않은** 코드. 전제가 깨진 자리다.
    blocked: list[str] = field(default_factory=list)
    roster_rows_removed: int = 0
    #: 정규 코드에 같은 날짜가 이미 있어 버린 행(값 일치 확인됨).
    corpus_rows_removed: int = 0
    #: `Q` 형에만 있던 날짜 — **코드만 고쳐 남긴** 행. 이것이 0 이 아니면 순진한
    #: 삭제는 그만큼 구멍을 냈을 것이다.
    corpus_rows_migrated: int = 0
    #: 겹치는데 값이 다른 (종목, 날짜) — 병합 전제가 깨진 자리. 0 이어야 한다.
    value_conflicts: int = 0
    dry_run: bool = True

    @property
    def removable(self) -> list[str]:
        return sorted(self.duplicates + self.orphans)


def classify(roster_codes: set[str], corpus_codes: set[str]) -> DedupReport:
    """부수효과 없는 분류 — dry-run 이 이 함수만으로 성립한다."""
    report = DedupReport()
    for code in sorted(c for c in roster_codes if c.startswith("Q") and len(c) > 1):
        stripped = code[1:]
        if stripped in roster_codes:
            report.duplicates.append(code)
        elif code in corpus_codes:
            # 쌍이 없는데 코퍼스에 행이 있다 = 이 도구의 전제 밖. 보고만 한다.
            report.blocked.append(code)
        else:
            report.orphans.append(code)
    return report


def _snapshot(path: Path, stamp: str) -> None:
    if not path.exists():
        return
    dest = path.with_suffix(f".pre-qdedup-{stamp}.parquet")
    if not dest.exists():
        shutil.copyfile(path, dest)


def _merge_q_rows(
    unadjusted: pl.DataFrame, duplicates: set[str], drop: set[str],
) -> tuple[pl.DataFrame, dict[str, int]]:
    """`Q` 계열을 정규 계열로 **병합**한다 — 겹치면 버리고, 없으면 코드를 고쳐 남긴다.

    `value_conflicts` 는 겹치는데 종가가 다른 쌍의 수다. 실측 0 이지만 세어서 보고한다
    — 0 이 아니면 「같은 종목의 두 사본」이라는 전제가 깨진 것이고, 그때는 어느 쪽을
    남길지가 이 도구의 판단 밖이다.
    """
    canon = {q: q[1:] for q in duplicates}
    have = (
        unadjusted.filter(pl.col("code").is_in(list(canon.values())))
        .select(["code", "date", "close"])
    )
    canonical_close = {
        (row["code"], row["date"]): row["close"] for row in have.iter_rows(named=True)
    }
    q_rows = unadjusted.filter(pl.col("code").is_in(list(canon)))
    keep_idx: list[int] = []
    removed = conflicts = 0
    for i, row in enumerate(q_rows.iter_rows(named=True)):
        target = canon[row["code"]]
        twin = canonical_close.get((target, row["date"]))
        if twin is None:
            keep_idx.append(i)            # `Q` 에만 있는 날짜 → 코드만 고쳐 남긴다
            continue
        removed += 1
        if abs(row["close"] - twin) > _CLOSE_EPSILON:
            conflicts += 1
    migrated = q_rows[keep_idx].with_columns(
        pl.col("code").str.slice(1).alias("code")
    ) if keep_idx else q_rows.head(0)
    rest = unadjusted.filter(~pl.col("code").is_in(list(drop)))
    merged = (
        pl.concat([rest, migrated.select(rest.columns)])
        .unique(subset=["code", "date"], keep="last")
        .sort(["code", "date"])
    )
    return merged, {"removed": removed, "migrated": len(keep_idx), "conflicts": conflicts}


def dedup_q_codes(sdir: Path, *, dry_run: bool = True, stamp: str | None = None) -> DedupReport:
    """`Q` 중복을 로스터·코퍼스에서 걷는다. **기본은 dry-run.**

    `stamp` 는 스냅샷 파일명 접미(테스트 재현성). 미지정이면 UTC 타임스탬프.
    """
    roster_path = sdir / "stocks.parquet"
    unadjusted_path = sdir / "daily_unadjusted.parquet"

    roster = pl.read_parquet(roster_path)
    corpus_codes = set(
        pl.scan_parquet(unadjusted_path).select("code").unique().collect()["code"].to_list()
    )
    report = classify(set(roster["code"].to_list()), corpus_codes)
    report.dry_run = dry_run

    drop = set(report.removable)
    if not drop:
        return report

    # 통계는 dry-run 에서도 정확해야 한다 — "무엇을 어떻게 할지" 가 리포트의 존재 이유다.
    report.roster_rows_removed = roster.filter(pl.col("code").is_in(list(drop))).height
    unadjusted = pl.read_parquet(unadjusted_path)
    merged, stats = _merge_q_rows(unadjusted, set(report.duplicates), drop)
    report.corpus_rows_removed = stats["removed"]
    report.corpus_rows_migrated = stats["migrated"]
    report.value_conflicts = stats["conflicts"]
    if dry_run:
        return report

    stamp = stamp or dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S")
    _snapshot(roster_path, stamp)
    _snapshot(unadjusted_path, stamp)

    atomic_write_parquet_df(roster_path, roster.filter(~pl.col("code").is_in(list(drop))))
    atomic_write_parquet_df(unadjusted_path, merged)
    derive_adjusted(
        unadjusted_path, sdir / "daily_adjusted.parquet",
        factors_path=sdir / "factors.parquet", unadjusted_df=merged,
    )
    log.info(
        "q-dedup: 로스터 %d행 제거 · 코퍼스 %d행 제거 + %d행 이관 "
        "(중복 %d · 고아 %d · 보류 %d · 값충돌 %d)",
        report.roster_rows_removed, report.corpus_rows_removed, report.corpus_rows_migrated,
        len(report.duplicates), len(report.orphans), len(report.blocked), report.value_conflicts,
    )
    return report
