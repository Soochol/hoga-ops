# Screener Factor Store (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수정주가를 "원주가 × KIS 계수(factor store)"로 파생하는 토대를 만든다 — 계수 산출(순수함수)·저장·적용. 계수 파일이 없으면 기존 휴리스틱으로 폴백하므로 운영 동작은 불변.

**Architecture:** 새 모듈 `screener_factors.py`가 (a) `compute_factor_segments`(원주가+KIS수정주가 → 계단 함수 세그먼트, 순수) (b) `factors.parquet` read/write(원자적) (c) `apply_factors`(polars `join_asof`로 원주가 × 계수). `screener_store.derive_adjusted`는 계수 파일이 있으면 `apply_factors`, 없으면 기존 `adjust_splits` 폴백.

**Tech Stack:** Python, polars(join_asof), pytest. 기존 `hoga/api/_atomic_write.py`, `screener_store.adjust_splits` 재사용.

---

## File Structure

- **Create** `hoga/api/screener_factors.py` — 계수 산출(순수)·저장·적용. 단일 책임: 계수.
- **Modify** `hoga/api/screener_store.py` — `derive_adjusted`가 계수 적용+폴백. 호출부(`seed_all`, `run_update._commit`) 시그니처 갱신.
- **Create** `tests/api/test_screener_factor_compute.py` — 순수함수 + 골든(삼성/카카오/거래정지/단일세그먼트).
- **Create** `tests/api/test_screener_factors_store.py` — read/write/원자성/격리.
- **Create** `tests/api/test_screener_derive_factors.py` — derive 계수 적용 + 거래대금 불변 + 폴백.

---

## Task 1: `compute_factor_segments` 순수함수

**Files:**
- Create: `hoga/api/screener_factors.py`
- Test: `tests/api/test_screener_factor_compute.py`

- [ ] **Step 1: 실패 테스트 작성**

```python
# tests/api/test_screener_factor_compute.py
import datetime as dt
from hoga.api.screener_factors import FactorSegment, compute_factor_segments


def test_clean_split_two_segments():
    # 삼성 50:1: 분할 前 factor=adj/raw=0.02, 後=1.0
    rows = [
        (dt.date(2018, 4, 20), 2581000.0, 51620.0),  # 0.02
        (dt.date(2018, 4, 27), 2650000.0, 53000.0),  # 0.02
        (dt.date(2018, 4, 30), 2650000.0, 53000.0),  # 거래정지(평탄) → 같은 세그먼트
        (dt.date(2018, 5, 4),  51900.0,   51900.0),  # 1.0 (분할 後)
        (dt.date(2018, 5, 8),  52600.0,   52600.0),  # 1.0
    ]
    assert compute_factor_segments(rows) == [
        FactorSegment(dt.date(2018, 4, 20), 0.02),
        FactorSegment(dt.date(2018, 5, 4), 1.0),
    ]


def test_non_clean_ratio_kakao():
    # 카카오 1:5, 실현 factor≈0.2007 (깨끗한 0.2 아님) — 그래도 정확히 잡힘
    rows = [
        (dt.date(2021, 4, 5), 502000.0, 100759.0),   # 0.20071...
        (dt.date(2021, 4, 15), 120500.0, 120500.0),  # 1.0
    ]
    segs = compute_factor_segments(rows)
    assert len(segs) == 2
    assert segs[0].seg_start == dt.date(2021, 4, 5)
    assert abs(segs[0].factor - 100759.0 / 502000.0) < 1e-9
    assert segs[1] == FactorSegment(dt.date(2021, 4, 15), 1.0)


def test_no_split_single_segment():
    rows = [
        (dt.date(2024, 1, 2), 1000.0, 1000.0),
        (dt.date(2024, 1, 3), 1100.0, 1100.0),
    ]
    assert compute_factor_segments(rows) == [FactorSegment(dt.date(2024, 1, 2), 1.0)]


def test_zero_raw_close_skipped():
    rows = [
        (dt.date(2024, 1, 2), 0.0, 0.0),       # 불량/결측 → 스킵
        (dt.date(2024, 1, 3), 1000.0, 1000.0),
    ]
    assert compute_factor_segments(rows) == [FactorSegment(dt.date(2024, 1, 3), 1.0)]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_factor_compute.py -v`
Expected: FAIL — `ModuleNotFoundError: hoga.api.screener_factors`

- [ ] **Step 3: 최소 구현**

```python
# hoga/api/screener_factors.py
"""수정주가 보정 계수(factor store). factor = adj_close / raw_close.

계수는 코퍼레이트 액션 때만 바뀌는 계단 함수 — 종목당 변곡점(seg_start, factor) 몇 개로
전 역사를 표현. 수정주가 = 원주가 × 계수 (ADR-0057).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass


@dataclass(frozen=True)
class FactorSegment:
    seg_start: dt.date
    factor: float


def compute_factor_segments(
    rows: list[tuple[dt.date, float, float]], *, tol: float = 1e-4
) -> list[FactorSegment]:
    """rows: (date, raw_close, adj_close) — date ASC 정렬 가정.

    factor=adj/raw 를 run-length로 압축: factor가 직전 대비 tol(상대) 넘게 바뀌면 새 세그먼트.
    raw_close==0(불량/결측)은 스킵(직전 세그먼트 유지). 첫 유효행이 첫 세그먼트(seg_start=그 날짜).
    """
    segments: list[FactorSegment] = []
    prev: float | None = None
    for d, raw_c, adj_c in rows:
        if raw_c == 0:
            continue
        f = adj_c / raw_c
        if prev is None or abs(f - prev) / prev > tol:
            segments.append(FactorSegment(d, f))
            prev = f
    return segments
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_factor_compute.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/screener_factors.py tests/api/test_screener_factor_compute.py
git commit -m "feat(screener): compute_factor_segments 순수함수 (factor=adj/raw RLE)"
```

---

## Task 2: 계수 저장/로드 (`factors.parquet`, 원자적)

**Files:**
- Modify: `hoga/api/screener_factors.py`
- Test: `tests/api/test_screener_factors_store.py`

- [ ] **Step 1: 실패 테스트 작성**

```python
# tests/api/test_screener_factors_store.py
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_factors import (
    FactorSegment, read_factors, segments_to_frame, write_factors,
)


def test_write_then_read_roundtrip(tmp_path: Path):
    by_code = {
        "005930": [FactorSegment(dt.date(2018, 4, 20), 0.02),
                   FactorSegment(dt.date(2018, 5, 4), 1.0)],
        "000660": [FactorSegment(dt.date(2015, 1, 2), 1.0)],
    }
    df = segments_to_frame(by_code)
    p = tmp_path / "factors.parquet"
    write_factors(df, p)
    out = read_factors(p)
    assert out is not None
    assert out.columns == ["code", "seg_start", "factor"]
    assert out.filter(pl.col("code") == "005930").height == 2
    # code는 VARCHAR(leading-zero 보존), seg_start는 Date
    assert out.schema["code"] == pl.Utf8
    assert out.schema["seg_start"] == pl.Date


def test_read_missing_returns_none(tmp_path: Path):
    assert read_factors(tmp_path / "nope.parquet") is None


def test_read_corrupt_quarantines_and_returns_none(tmp_path: Path):
    p = tmp_path / "factors.parquet"
    p.write_text("not a parquet file")
    assert read_factors(p) is None
    # 손상본은 격리되어 원래 경로엔 없어야 함
    assert not p.exists()
    assert list(tmp_path.glob("factors.parquet.corrupt*"))
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_factors_store.py -v`
Expected: FAIL — `ImportError: cannot import name 'read_factors'`

- [ ] **Step 3: 최소 구현 (screener_factors.py 에 추가)**

```python
# hoga/api/screener_factors.py 끝에 추가
import logging
from pathlib import Path

import polars as pl

from hoga.api._atomic_write import atomic_write_parquet_df

log = logging.getLogger(__name__)

FACTOR_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8, "seg_start": pl.Date, "factor": pl.Float64,
}


def segments_to_frame(by_code: dict[str, list[FactorSegment]]) -> pl.DataFrame:
    """{code: [FactorSegment,...]} → factors DataFrame (code,seg_start,factor)."""
    rows = [
        {"code": code, "seg_start": s.seg_start, "factor": s.factor}
        for code, segs in by_code.items() for s in segs
    ]
    return pl.DataFrame(rows, schema=FACTOR_SCHEMA).sort(["code", "seg_start"])


def write_factors(df: pl.DataFrame, path: Path) -> None:
    """factors.parquet 원자적 기록(SSOT 계약 — 토막 노출 금지)."""
    atomic_write_parquet_df(path, df.select(list(FACTOR_SCHEMA)).sort(["code", "seg_start"]))


def _quarantine(path: Path) -> None:
    stamp = "corrupt"  # 결정적: 호출부가 timestamp 못 쓰므로 단순 접미사 + 충돌 회피 카운터
    target = path.with_name(f"{path.name}.{stamp}")
    i = 0
    while target.exists():
        i += 1
        target = path.with_name(f"{path.name}.{stamp}-{i}")
    try:
        path.rename(target)
        log.warning("factors.parquet unusable; quarantined to %s", target.name)
    except OSError:
        log.exception("could not quarantine corrupt factors.parquet")


def read_factors(path: Path) -> pl.DataFrame | None:
    """factors.parquet 로드. 없으면 None. 손상이면 격리 후 None(폴백 유도)."""
    if not path.exists():
        return None
    try:
        return pl.read_parquet(path)
    except Exception:  # noqa: BLE001 — 손상 parquet은 어떤 예외든 폴백으로 강등
        _quarantine(path)
        return None
```

(격리 접미사는 `.corrupt`, 충돌 시 `.corrupt-1`… → 테스트 glob `corrupt*`가 모두 매치.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_factors_store.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/screener_factors.py tests/api/test_screener_factors_store.py
git commit -m "feat(screener): factors.parquet read/write + 손상 격리(원자적)"
```

---

## Task 3: `derive_adjusted`가 계수 적용 + 거래대금 불변 + 폴백

**Files:**
- Modify: `hoga/api/screener_factors.py` (apply_factors 추가)
- Modify: `hoga/api/screener_store.py:109-115` (`derive_adjusted` 시그니처+본문), 호출부 `seed_all`(`:189`)·`run_update._commit`(`:227`)
- Test: `tests/api/test_screener_derive_factors.py`

- [ ] **Step 1: 실패 테스트 작성**

```python
# tests/api/test_screener_derive_factors.py
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_factors import apply_factors


def _unadj():
    # 한 종목, 분할 前2일/後2일 (원주가)
    return pl.DataFrame({
        "code": ["005930"] * 4,
        "date": [dt.date(2018, 4, 20), dt.date(2018, 4, 27),
                 dt.date(2018, 5, 4), dt.date(2018, 5, 8)],
        "open": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "high": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "low": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "close": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "volume": [235220, 606216, 39565391, 23104720],
    })


def _factors():
    return pl.DataFrame({
        "code": ["005930", "005930"],
        "seg_start": [dt.date(2018, 4, 20), dt.date(2018, 5, 4)],
        "factor": [0.02, 1.0],
    })


def test_apply_factors_adjusts_price_and_volume():
    adj = apply_factors(_unadj(), _factors()).sort("date")
    # 분할 前: close ×0.02, volume ÷0.02
    assert adj["close"][0] == 2581000.0 * 0.02         # 51620
    assert adj["volume"][0] == round(235220 / 0.02)    # 11,761,000
    # 분할 後: 불변(factor 1.0)
    assert adj["close"][2] == 51900.0
    assert adj["volume"][2] == 39565391


def test_apply_factors_preserves_trade_value():
    # 거래대금(close*volume) 불변 — 분할 지점에서 안 튐
    u = _unadj().sort("date")
    adj = apply_factors(u, _factors()).sort("date")
    for i in range(u.height):
        raw_tv = u["close"][i] * u["volume"][i]
        adj_tv = adj["close"][i] * adj["volume"][i]
        assert abs(adj_tv - raw_tv) / raw_tv < 1e-6


def test_apply_factors_output_columns_and_dtype():
    adj = apply_factors(_unadj(), _factors())
    assert adj.columns == ["code", "date", "open", "high", "low", "close", "volume"]
    assert adj.schema["volume"] == pl.Int64
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_derive_factors.py -v`
Expected: FAIL — `ImportError: cannot import name 'apply_factors'`

- [ ] **Step 3: `apply_factors` 구현 (screener_factors.py 에 추가)**

```python
# hoga/api/screener_factors.py 끝에 추가
_PRICE_COLS = ("open", "high", "low", "close")


def apply_factors(unadjusted: pl.DataFrame, factors: pl.DataFrame) -> pl.DataFrame:
    """원주가 × 계수 → 수정주가. backward ASOF(code별, date >= seg_start).

    가격 ×factor, 거래량 ÷factor (거래대금 보존). 가장 오래된 seg_start 이전 날짜(계수 null)는
    그 종목의 최古 factor로 채움(extend backward). 반환은 입력과 동일한 7개 기본 컬럼.
    """
    u = unadjusted.sort(["code", "date"])
    f = factors.select(["code", "seg_start", "factor"]).sort(["code", "seg_start"])
    joined = u.join_asof(f, left_on="date", right_on="seg_start", by="code", strategy="backward")
    joined = joined.with_columns(
        pl.col("factor").fill_null(strategy="backward").over("code")  # 최古 세그먼트 이전 → 최古 factor
    )
    return joined.with_columns(
        [(pl.col(c) * pl.col("factor")).alias(c) for c in _PRICE_COLS]
        + [(pl.col("volume") / pl.col("factor")).round(0).cast(pl.Int64).alias("volume")]
    ).select(["code", "date", *_PRICE_COLS, "volume"])
```

- [ ] **Step 4: apply_factors 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_derive_factors.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: `derive_adjusted` 계수 적용 + 폴백으로 교체**

`hoga/api/screener_store.py` 의 기존 `derive_adjusted`(`:109-115`)를 아래로 교체:

```python
def derive_adjusted(unadjusted_path: Path, out_path: Path, *,
                    factors_path: Path | None = None) -> int:
    """원주가 parquet → 수정주가 parquet. 소요 ms 반환.

    factors_path 가 있고 로드되면 계수 적용(원주가×계수, ADR-0057). 없거나 손상이면
    기존 split 휴리스틱(adjust_splits)으로 폴백. factors에 없는 종목도 휴리스틱 폴백.
    """
    from hoga.api import screener_factors
    t0 = time.perf_counter()
    df = pl.read_parquet(unadjusted_path)
    factors = screener_factors.read_factors(factors_path) if factors_path else None
    if factors is not None and factors.height:
        covered = set(factors["code"].unique().to_list())
        have = df.filter(pl.col("code").is_in(covered))
        miss = df.filter(~pl.col("code").is_in(covered))
        parts = [screener_factors.apply_factors(have, factors)]
        if miss.height:                       # 계수 없는 종목 → 휴리스틱 폴백
            parts.append(adjust_splits(miss).select(parts[0].columns))
        adjusted = pl.concat(parts)
    else:
        adjusted = adjust_splits(df)          # 계수 파일 자체가 없음 → 전면 폴백(현 동작)
    atomic_write_parquet_df(out_path, adjusted)
    return int((time.perf_counter() - t0) * 1000)
```

- [ ] **Step 6: 호출부 시그니처 갱신**

`seed_all`(`screener_store.py:189`) 의 derive 호출을 factors_path 인지로:

```python
    ms = derive_adjusted(sdir / "daily_unadjusted.parquet", sdir / "daily_adjusted.parquet",
                         factors_path=sdir / "factors.parquet")
```

`run_update._commit`(`screener_store.py:227`) 동일:

```python
        ms = derive_adjusted(up, sdir / "daily_adjusted.parquet",
                             factors_path=sdir / "factors.parquet")
```

(factors.parquet 이 아직 없으면 `read_factors`→None→`adjust_splits` 폴백 → 운영 동작 불변.)

- [ ] **Step 7: 기존 derive 회귀 테스트 통과 확인 (폴백 경로)**

Run: `uv run --extra dev pytest tests/api/test_screener_derive.py tests/api/test_screener_adjust.py -v`
Expected: PASS — factors_path 없음/None → adjust_splits 폴백이라 기존 동작 보존

- [ ] **Step 8: 전체 스크리너 테스트 + 타입체크**

Run: `uv run --extra dev pytest tests/api/ -k screener -q`
Expected: PASS (all)

- [ ] **Step 9: 커밋**

```bash
git add hoga/api/screener_factors.py hoga/api/screener_store.py tests/api/test_screener_derive_factors.py
git commit -m "feat(screener): derive_adjusted 계수 적용 + 휴리스틱 폴백(ADR-0057)"
```

---

## Phase 1 완료 기준

- `factors.parquet` 가 있으면 수정주가 = 원주가 × KIS 계수, 없으면 기존 휴리스틱(동작 불변).
- 거래대금 불변 속성 테스트 통과(분할 지점 안 튐).
- 골든(삼성 0.02 / 카카오 0.2007) 계수 정확.
- **운영 영향 0** (계수 파일은 Plan 2 백필이 만들기 전까지 없음 → 폴백).

## 다음 (별도 플랜)
- **Plan 2**: `factor_backfill`(전 종목 KIS adj→계수) + `raw_reconcile`(원주가 합집합) + 임팩트 리포트. ← 여기서 64% 복구 실현.
- **Plan 3**: `action_detector`(D1 ±30%) + `factor_refresh`(플래그+월순환) + 16:00 장중 가드 + `stocks_refresh`, `trigger_update`/scheduler 통합.
