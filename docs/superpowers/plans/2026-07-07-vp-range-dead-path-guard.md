# 범위 볼륨 프로파일 dead path 봉인 (가드 + 관측) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프론트엔드가 사용하지 않는 `mode=full` 전용 `build_volume_profile_range`를 세마포어 + single-flight 가드 뒤로 옮기고 perf 로그를 붙여, 수동/외부 호출이 스레드풀과 DuckDB를 무제한 점유하지 못하게 봉인한다.

**Architecture:** `PeakSliceGuard`(hoga/api/peak_slice_guard.py)는 이미 범용 "세마포어 + single-flight" 클래스다. env 해석 헬퍼를 일반화해 두 번째 가드 인스턴스 `RANGE_PROFILE_GUARD`(기본 동시성 1)를 만들고, `build_volume_profile_range`의 DuckDB 호출을 그 뒤로 옮긴다. API 시그니처·와이어 스키마·결과 바이트는 전혀 변하지 않는다.

**정정된 위험 모델 (2026-07-07 실측):** `query_volume_profile_range`(hoga/tables/trades.py:474)는 MIN/MAX + GROUP BY(빈 ≤ 25개) 스트리밍 집계라 **RAM은 스캔 버퍼 수준으로 유계**다. 실제 비용은 범위 내 모든 `trades.parquet` 풀 스캔 2회(I/O·CPU 초 단위 × 범위 길이)이며, 무캐시·무가드로 `/api/range?mode=full` 요청마다 재실행된다. 현재 프론트엔드는 `mode=full`을 어디서도 호출하지 않는다(grep 검증: `frontend/src`에 RangeMode 타입 선언만 존재). 단, `build_range_bundle`의 파이썬 기본값이 `mode="full"`이고 백엔드 테스트 36곳이 이에 의존하므로 **모드 제거가 아니라 가드 봉인**을 택한다.

**Tech Stack:** Python 3 / FastAPI / DuckDB / pytest (`uv run --extra dev pytest`)

---

### Task 1: `_resolve_concurrency` 일반화 + `RANGE_PROFILE_GUARD` 추가

**Files:**
- Modify: `hoga/api/peak_slice_guard.py:38-45` (`_resolve_concurrency`), `:106-107` (모듈 싱글턴 구역)
- Test: `tests/unit/api/test_peak_slice_guard.py` (없으면 생성)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/api/test_peak_slice_guard.py`에 추가 (파일이 이미 있으면 아래 테스트만 append):

```python
import hoga.api.peak_slice_guard as psg


def test_resolve_concurrency_reads_named_env(monkeypatch):
    monkeypatch.setenv("HOGA_RANGE_PROFILE_CONCURRENCY", "3")
    assert psg._resolve_concurrency("HOGA_RANGE_PROFILE_CONCURRENCY", 1) == 3


def test_resolve_concurrency_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("HOGA_RANGE_PROFILE_CONCURRENCY", "banana")
    assert psg._resolve_concurrency("HOGA_RANGE_PROFILE_CONCURRENCY", 1) == 1


def test_range_profile_guard_exists_with_default_1(monkeypatch):
    monkeypatch.delenv("HOGA_RANGE_PROFILE_CONCURRENCY", raising=False)
    assert isinstance(psg.RANGE_PROFILE_GUARD, psg.PeakSliceGuard)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_peak_slice_guard.py -v`
Expected: FAIL — `_resolve_concurrency() takes 0 positional arguments` / `AttributeError: RANGE_PROFILE_GUARD`

- [ ] **Step 3: 구현**

`hoga/api/peak_slice_guard.py`의 `_resolve_concurrency`를 시그니처 일반화로 교체:

```python
def _resolve_concurrency(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name)
    if raw is None:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default
```

`PeakSliceGuard.__init__`의 기존 호출부(라인 65-67)를 맞춰 수정:

```python
    def __init__(self, concurrency: int | None = None) -> None:
        self._sem = threading.BoundedSemaphore(
            concurrency
            if concurrency is not None
            else _resolve_concurrency("HOGA_PEAK_QUERY_CONCURRENCY", DEFAULT_CONCURRENCY)
        )
```

파일 하단 모듈 싱글턴 구역(라인 106-107)에 추가:

```python
# 범위 볼륨 프로파일(mode=full 전용, 2026-07-07 기준 프론트엔드 미사용 dead path)
# 가드. 스트리밍 GROUP BY라 RAM은 유계지만, 범위 내 전 trades.parquet 풀 스캔 2회를
# 요청마다 무캐시로 반복하므로 스레드풀·DuckDB 점유를 동시성 1로 격리한다.
RANGE_PROFILE_GUARD = PeakSliceGuard(
    concurrency=_resolve_concurrency("HOGA_RANGE_PROFILE_CONCURRENCY", 1)
)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_peak_slice_guard.py -v`
Expected: PASS (기존 peak 가드 테스트 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/peak_slice_guard.py tests/unit/api/test_peak_slice_guard.py
git commit -m "refactor(api): peak_slice_guard env 해석 일반화 + RANGE_PROFILE_GUARD 추가"
```

---

### Task 2: `build_volume_profile_range`를 가드 뒤로 이동 + perf 로그

**Files:**
- Modify: `hoga/api/bundle.py:490-538` (`build_volume_profile_range`), `:52` (import)
- Test: `tests/unit/api/test_vp_range_guard.py` (생성)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/api/test_vp_range_guard.py` 생성:

```python
"""build_volume_profile_range가 RANGE_PROFILE_GUARD.run을 경유하는지 잠근다.

가드 자체의 세마포어/single-flight 동작은 test_peak_slice_guard.py가 커버하므로,
여기서는 '경유' 사실만 spy로 검증한다 — 가드를 우회한 직접 호출이 재도입되면 red.
"""
from unittest.mock import patch

import hoga.api.bundle as bundle_mod


def test_vp_range_routes_through_guard(tmp_path, monkeypatch):
    calls: list[object] = []

    real_run = bundle_mod.RANGE_PROFILE_GUARD.run

    def spy_run(key, compute):
        calls.append(key)
        return real_run(key, compute)

    monkeypatch.setattr(bundle_mod.RANGE_PROFILE_GUARD, "run", spy_run)

    # 파일이 하나도 없으면 가드 진입 전에 빈 프로파일로 단락되므로,
    # 최소 1개의 실제 parquet가 있어야 가드 경유를 관찰할 수 있다.
    import duckdb

    d = tmp_path / "20260701" / "005930" / "kis_live"
    d.mkdir(parents=True)
    con = duckdb.connect()
    con.execute(
        "COPY (SELECT 1000 AS price, 10 AS qty, 1 AS side, 90000000 AS ts_ms) "
        f"TO '{d / 'trades.parquet'}' (FORMAT PARQUET)"
    )

    class FakeEngine:
        conn = con

        def parquet_dir(self, date, code, source):
            return tmp_path / date / code / source

    profile = bundle_mod.build_volume_profile_range(
        FakeEngine(),
        code="005930",
        dates_with_sources=[("20260701", "kis_live")],
    )
    assert profile.bin_count == 24
    assert len(calls) == 1
    assert calls[0][0] == "vp_range"
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_vp_range_guard.py -v`
Expected: FAIL — `AttributeError: module 'hoga.api.bundle' has no attribute 'RANGE_PROFILE_GUARD'` (또는 `calls == []`)

- [ ] **Step 3: 구현**

`hoga/api/bundle.py:52`의 import를 확장:

```python
from hoga.api.peak_slice_guard import GUARD as PEAK_SLICE_GUARD, RANGE_PROFILE_GUARD
```

`build_volume_profile_range`(bundle.py:525)의 직접 호출을 가드 경유 + perf 로그로 교체:

```python
    t0 = perf_debug.now()
    binning = RANGE_PROFILE_GUARD.run(
        ("vp_range", code, tuple(paths), vp_bins),
        lambda: trades_tbl.query_volume_profile_range(engine.conn, paths=paths, vp_bins=vp_bins),
    )
    if perf_debug.enabled():
        log.warning(
            "hoga_perf vp_range status=ok code=%s dates=%d vp_bins=%d duration_ms=%.1f",
            code, len(paths), vp_bins, perf_debug.elapsed_ms(t0),
        )
```

docstring(bundle.py:497-504)에 한 줄 추가:

```python
    2026-07-07 기준 mode=full은 프론트엔드가 호출하지 않는 dead path지만 공개 API로
    남아 있어, RANGE_PROFILE_GUARD(동시성 1 + single-flight)로 스캔 점유를 격리한다.
```

- [ ] **Step 4: 통과 + 회귀 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_vp_range_guard.py tests/test_api_range.py tests/hoga/api/test_bundle.py -v`
Expected: PASS (full 모드 기본값 테스트 36곳 포함 결과 바이트 불변)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/unit/api/test_vp_range_guard.py
git commit -m "fix(api): 범위 볼륨 프로파일을 RANGE_PROFILE_GUARD 뒤로 봉인 (dead path 스캔 격리)"
```

---

### Task 3: 전체 백엔드 회귀 + 마무리

- [ ] **Step 1: 전체 백엔드 테스트**

Run: `uv run --extra dev pytest -q`
Expected: 기존 대비 신규 실패 0 (peak-wall 테스트 red 14건 등 기존 이슈는 이 플랜 범위 밖 — 실행 시점 기준 pre-existing 실패 목록을 먼저 채집해 비교)

- [ ] **Step 2: Commit (남은 변경이 있으면)**

```bash
git status --porcelain  # 깨끗해야 정상 — 남은 변경 없음 확인용
```
