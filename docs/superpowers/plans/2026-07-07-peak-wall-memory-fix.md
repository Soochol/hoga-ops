# Peak Wall 분류 메모리 폭주 근본 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 페이지가 유발하는 백엔드 OOM(uvicorn 워커 RSS ~90GB → 커널 kill)을 근본 제거한다 — 피크 월(peak wall) 분류 쿼리의 조인 폭발을 O((N+M) log M) 스위프 알고리즘으로 대체하고, 모든 DuckDB 연결에 리소스 상한 안전망을 깐다.

**Architecture:** `hoga/tables/snapshots.py`의 `query_day_ask_bid_peak_dual()`은 공개 계약(시그니처·반환 dataclass·64개 기존 테스트)을 그대로 유지한 채 내부만 교체한다. 무거운 단일 SQL(비등가 조인 `t.price >= p.price` + UNBOUNDED 윈도우 ×4세트)을 (a) 선형 SQL 스캔 2개(레벨 이벤트 스트림 + 터치 스트림)와 (b) 파이썬 정렬 스위프 + Fenwick max-tree 분류기로 대체한다. 별도로 `hoga/duck.py` 중앙 연결 팩토리가 `memory_limit`/`temp_directory`/`max_temp_directory_size`를 모든 `duckdb.connect()`에 강제한다.

**Tech Stack:** Python 3.12, DuckDB(Python API), FastAPI, pytest (`uv run --extra dev pytest`), 프론트는 React + @tanstack/react-query + vitest.

---

## PIVOT (2026-07-07, 실측 후 — 사용자 승인: "동시성 차단 먼저, 재작성 후속")

Tasks 1-3 완료 후 실데이터로 현재 `query_day_ask_bid_peak_dual`을 측정한 결과가 플랜의 우선순위를 바꿨다:

- **삼성 최다거래일**(스냅샷 6.4만 × 거래 51만): 8GiB 상한에서 RSS **3.56GB**, 스필 0, **15.7초**.
- **최악의 날 20260623/000660**(비등가 조인 상한 4.4억 = distinct 803 × 거래 55만): 8GiB 상한에서 RSS **17.16GB**, 스필 0, **155.56초**.
- **결론 1**: `memory_limit`은 **soft** — 비등가 조인이 8GiB를 뚫고 17GB까지 감. 즉 Task 2 안전망만으로는 단일 최악 쿼리를 못 가둔다.
- **결론 2**: `QueryEngine.conn`은 접근마다 `self._conn.cursor()`(독립 커서, 하나의 :memory: DB 공유)를 반환하고 `/api/range`는 sync `def`(스레드풀) → **쿼리가 진짜 병렬 실행**되며 memory_limit은 **공유 soft 예산**. N개 병렬 → 집합적으로 초과. 87GB OOM ≈ 17GB × 5 동시.
- **결론 3**: 356GB/OOM의 실동인은 단일 쿼리가 아니라 **캐시 미적용 '오늘' 경로의 동시 재계산**(과거 날짜는 `PastIndicatorsCache` 디스크 캐시, 오늘은 ADR-0043로 캐시 안 함 → sidecar 폴링·focus/reconnect 버스트마다 17GB 재계산 병렬 누적).

### 새 우선순위

1. **Task A (신규, 최우선)** — 동시성 가드: 무거운 dual-peak 쿼리에 **글로벌 세마포어 + 키별 single-flight**. OOM의 실동인(N-병렬)을 즉시 제거. staleness 0(single-flight는 in-flight 중복만 합침). **TTL 메모는 제외**(ADR-0043 "오늘 캐시 안 함" 계약 위반 + staleness, 재작성이 무효화하므로 불필요).
2. **Task B (신규)** — 프론트 refetch 버스트 차단(구 Task 8을 앞당김): `refetchOnWindowFocus/Reconnect=false`. 버스트를 소스에서 차단, 명백한 동시성 작업.
3. **Task 4-6 (재작성)** — Fenwick 스위프로 155초/17GB 단일 쿼리 비용 자체를 제거. 가드가 "N-병렬 OOM 안 남"을 보장하지만, soft-limit이라 **미래의 000660보다 나쁜 날은 단일 쿼리로도 위험** → 재작성이 이를 불가능으로 만든다. **재작성의 진짜 안전망은 64개 유닛테스트가 아니라 old-vs-new 차등(differential) 테스트**(medium 날들에서 구 SQL과 신 스위프 출력 동일 assert 후 구 SQL 삭제).

### 실행 상태 (2026-07-07)

- ✅ **Task 1** — 356GB 스필 삭제(디스크 148→503GB), `.tmp/` gitignore. 커밋 `4ced89c0`.
- ✅ **Task 2** — `hoga/duck.py` 팩토리(4 테스트). 커밋 `550fce04`.
- ✅ **Task 3** — 6개 `duckdb.connect()` → `connect_bounded()`. 커밋 `92387794`.
- ✅ **Task A** — `hoga/api/peak_slice_guard.py`(세마포어 K=2 + single-flight) + `build_ask_bid_peak_slices` 배선 + 유닛 5개. 커밋 `edc8c38d`. **게이트 통과**: 삼성 20260619 8-병렬 unguarded peak RSS 28.34GB → guarded(K=2) **6.81GB**. 최악의 날 외삽: unguarded ~85-136GB(OOM) → guarded ~34GB(생존).
- ✅ **Task B** — `main.tsx` refetchOnWindowFocus/Reconnect=false. 커밋 `eec19783`. tsc·eslint green.
- ⬜ **Task 4-6 (재작성)** — 후속. old-vs-new 차등 테스트를 안전망으로.

### 정직한 보증 범위

가드(Task A)는 **강력한 인터림 완화지 보증이 아니다**. 동시 repro가 "N-병렬 OOM 안 남"을 증명하면 그게 인터림 승리다. "OOM 완전 해결"은 재작성(Task 4-6) 후에만 주장한다.

### Task 6 게이트 정정 (중요)

분기점 `f56347be`(=main)에 이미 **14개 실패**가 존재한다(peak-wall 미완성 배포): `test_api_range.py` 11개(테스트 스텁 `_build_range_bundle_stub` kwarg 드리프트), `tests/hoga/api/test_bundle.py` 2개(`untraded_peaks`가 가격별 dedup 안 되길 기대 vs 현 SQL은 dedup), `tests/unit/live/test_stream.py` 1개. `tests/test_tables_snapshots.py`의 64개는 전부 green. 따라서 재작성 후 목표 상태는 **"64개 green + 14개 실패가 바이트 동일하게 유지"** — 전체 green이 되면 오히려 동작을 바꾼 것. `untraded_peaks` dedup 불일치는 제품 의도가 필요한 별건이므로 ADR에 **알려진 이월(deferred) 이슈**로 기록하고 이번 스코프에서 건드리지 않는다.

---

## 배경: 확정된 근본 원인 (2026-07-07 조사)

- 커널 OOM 로그: 7/7 하루에만 uvicorn 워커 3회 kill (01:25, 10:38, 12:41, anon-rss 87~90GB / 램 91GB).
- 물증: 메인 체크아웃 `.tmp/`에 DuckDB 스필 파일 **356GB** (7/5 14:55~15:01 생성 — 이벤트 기반 피크 SQL 커밋 `ee53a711` 배포 4시간 후).
- 폭발 지점: `hoga/tables/snapshots.py:1132-1137`의 비등가 조인
  `JOIN {side}_{src}_lifecycle_prices p ON t.price {>=|<=} p.price`
  → (당일 전체 거래 틱) × (분류된 가격 레벨) 부분 카르테시안 곱, ask/bid × rep/cont **4세트**.
  추가로 `snapshots.py:1097-1104`의 `ROWS BETWEEN UNBOUNDED PRECEDING ...` 윈도우가 스냅샷×10레벨+거래 합류 스트림을 전량 정렬.
- 증폭 요인: DuckDB 연결(`hoga/api/queries.py:64` 등 6곳)에 `memory_limit` 미설정 → 기본값 = 램의 80%(~73GB). `temp_directory` 기본값 = cwd의 `.tmp` → 스필이 repo에 쌓이고 gitignore도 안 되어 있어 git 도구가 356GB를 해싱(CPU 폭주 부수 피해).
- 반복 트리거: `/api/range?mode=sidecar` (ask/bid peaks) — 과거 날짜는 `PastIndicatorsCache`에 캐시되지만 **오늘 날짜(`date == today_kst`)는 캐시 대상 외**라 sidecar 폴링마다 재계산 (`hoga/api/bundle.py:816-831`).
- 역사적 주의: 7/5에 파이썬 분류기(`_classify_peak_wall_events`)가 시도됐다가 `6239f67a`("keep historical peak query on fast SQL path")로 기각됨. 그 구현은 **터치마다 활성 가격 dict 전체를 선형 스캔하는 O(touches × prices) 루프**여서 느렸던 것 — 파이썬 자체의 문제가 아니다. 이번 재구현은 반드시 스위프+Fenwick(O((N+M) log M))로 그 함정을 피한다. 참고 원본: `git show 6239f67a~1:hoga/tables/snapshots.py` (라인 592~734).

## 현재 SQL의 의미론 (재구현이 보존해야 할 계약)

64개 테스트(`tests/test_tables_snapshots.py`)가 검증하는 의미론을 SQL에서 읽어낸 정확한 정의:

1. **입력 스트림**
   - `cont` = 당일 deep-book 스냅샷 전체 + `bucket_id = intra_ms // bucket_ms` + 버킷별 `ROW_NUMBER() ... ORDER BY ts_ms DESC, seq DESC`.
   - `rep` = 각 버킷의 rn=1 (버킷 대표 스냅샷).
   - 레벨 이벤트 = rep/cont 각 행의 호가 10레벨을 (price, qty)로 언피벗, `qty > 0`만.
   - `touch_ticks` = trades에서 `side IN (1,-1) AND price > 0`, `touch_ord = ROW_NUMBER() OVER (ORDER BY ts_ms ASC, seq ASC, price ASC)`.
2. **is_touched 분류** (`classified_levels`): 이벤트 e가 touched ⇔ `(t.ts_ms, t.seq) >= (e.ts_ms, e.seq)`인 터치 중 (ask면) `max(price) >= e.price`, (bid면) `min(price) <= e.price`. **같은 (ts_ms, seq)의 터치는 포함**(윈도우 `is_touch DESC` 타이브레이크), 같은 ms의 더 이른 seq 터치는 미포함.
3. **lifecycle 세그먼트** (`lifecycle_levels`): 이벤트 e(가격 p)의 `lifecycle_id` = `(t.ts_ms, t.seq) < (e.ts_ms, e.seq)` (**strictly earlier** — 같은 (ts,seq) 터치는 제외, `is_touch ASC` 타이브레이크)이고 (ask) `t.price >= p` / (bid) `t.price <= p`인 터치들의 **max touch_ord**, 없으면 0.
4. **랭킹 키**: 모든 best/랭킹은 `(qty DESC, intra_ms ASC, seq ASC, price ASC)`.
5. **집계 산출** (side별):
   - `all_close` = rep classified 전체 best 1개, `all_max` = cont classified 전체 best 1개. **이 둘이 없으면 해당 side row는 None.**
   - lifecycle_distinct = (price, lifecycle_id)별 best → 다시 (price, is_touched)별 best.
   - `traded_close/max` = rep/cont lifecycle_distinct 중 `is_touched` best 1개 (없으면 None 필드), `untraded_close/max` = `NOT is_touched` best 1개.
   - `traded_peaks`/`traded_max_peaks`/`untraded_peaks`/`untraded_max_peaks` = 각 조건 **top 3** 배열.
   - `all_peaks`(rep)/`all_max_peaks`(cont) = classified를 (price, bucket_id)별 best로 dedup 후 랭킹한 **전체 목록** (top-3 제한 없음 — 현재 SQL의 `{side}_all_peaks` CTE에 `WHERE ord <= 3`이 없다).
6. **반환**: `AskPeakDualRow`/`BidPeakDualRow` 조립은 현재 `snapshots.py:1371-1466` 파싱과 동일한 None 규칙.

---

## File Structure

| 파일 | 역할 |
|---|---|
| Create: `hoga/duck.py` | 중앙 DuckDB 연결 팩토리 (memory_limit / temp_directory / max_temp_directory_size) |
| Create: `tests/test_duck.py` | 팩토리 설정 적용 검증 |
| Modify: `hoga/api/queries.py:64` | `QueryEngine` 연결을 팩토리로 교체 |
| Modify: `hoga/api/screener_store.py:28,52,168` | 팩토리로 교체 |
| Modify: `hoga/api/screener_scan.py:123` | 팩토리로 교체 |
| Modify: `hoga/live/quote_change_resolver.py:183` | 팩토리로 교체 |
| Modify: `hoga/tables/snapshots.py` | `query_day_ask_bid_peak_dual` 내부 교체: 선형 스캔 리더 + 스위프 분류기, 죽은 SQL 헬퍼 삭제 |
| Modify: `tests/test_tables_snapshots.py` | 성능 가드레일 테스트 + 스위프 분류기 유닛 테스트 추가 (기존 64개는 무수정 그린 유지) |
| Modify: `frontend/src/main.tsx:25` | QueryClient `refetchOnWindowFocus/refetchOnReconnect` 비활성화 |
| Modify: `.gitignore` (repo 루트) | `.tmp/` 추가 |
| Create: `docs/adr/NNNN-duckdb-resource-bounds-and-peak-sweep.md` | 설계 결정 기록 |

---

### Task 1: 스필 잔해 정리 + `.tmp/` gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 356GB를 해싱 중인 git 프로세스 종료**

```bash
pkill -f 'git .* hash-object .*duckdb_temp_storage' || true
ps aux | grep 'hash-object' | grep -v grep   # 결과 없어야 함
```

- [ ] **Step 2: 메인 체크아웃의 DuckDB 스필 파일 삭제**

죽은 프로세스의 임시 파일이므로 안전하게 삭제 가능. 삭제 전 대상만 확인:

```bash
ls -lah /home/dev/code/hoga-ops/.tmp/duckdb_temp_storage_*.tmp | head -3
rm -f /home/dev/code/hoga-ops/.tmp/duckdb_temp_storage_*.tmp
df -h / | tail -1   # Avail이 ~500G 근처로 회복되어야 함 (기존 148G)
```

- [ ] **Step 3: `.gitignore`에 `.tmp/` 추가**

워크트리의 `.gitignore` 끝에 추가:

```
.tmp/
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore .tmp/ (duckdb spill files)"
```

---

### Task 2: `hoga/duck.py` — 리소스 상한 DuckDB 연결 팩토리 (TDD)

**Files:**
- Create: `hoga/duck.py`
- Test: `tests/test_duck.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
# tests/test_duck.py
from pathlib import Path

from hoga.duck import connect_bounded


def test_connect_bounded_applies_memory_limit(tmp_path: Path) -> None:
    con = connect_bounded(memory_limit="1.0 GiB", temp_directory=tmp_path / "duck-tmp")
    assert con.execute("SELECT current_setting('memory_limit')").fetchone()[0] == "1.0 GiB"


def test_connect_bounded_sets_temp_directory(tmp_path: Path) -> None:
    tmp = tmp_path / "duck-tmp"
    con = connect_bounded(memory_limit="1.0 GiB", temp_directory=tmp)
    assert con.execute("SELECT current_setting('temp_directory')").fetchone()[0] == str(tmp)
    assert tmp.is_dir()


def test_connect_bounded_env_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_DUCKDB_MEMORY_LIMIT", "2.0 GiB")
    con = connect_bounded(temp_directory=tmp_path / "duck-tmp")
    assert con.execute("SELECT current_setting('memory_limit')").fetchone()[0] == "2.0 GiB"


def test_connect_bounded_defaults_land_in_data_dir(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path / "data"))
    con = connect_bounded(memory_limit="1.0 GiB")
    got = con.execute("SELECT current_setting('temp_directory')").fetchone()[0]
    assert got == str(tmp_path / "data" / "duckdb-tmp")
```

- [ ] **Step 2: 실패 확인**

```bash
uv run --extra dev pytest tests/test_duck.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.duck'`

- [ ] **Step 3: 최소 구현**

```python
# hoga/duck.py
"""Central DuckDB connection factory.

Every in-process DuckDB connection must come from here so that a single
runaway query can never take the whole server down: the default
``memory_limit`` for an in-memory DuckDB is 80% of physical RAM and its
default ``temp_directory`` is ``<cwd>/.tmp`` — both caused the 2026-07-05
356GB spill / repeated uvicorn OOM kills (see ADR referenced in this plan).
"""
from __future__ import annotations

import os
from pathlib import Path

import duckdb

from hoga.config import resolve_data_dir

DEFAULT_MEMORY_LIMIT = "8.0 GiB"
DEFAULT_MAX_TEMP_SIZE = "50.0 GiB"


def connect_bounded(
    *,
    memory_limit: str | None = None,
    temp_directory: Path | None = None,
    max_temp_directory_size: str | None = None,
) -> duckdb.DuckDBPyConnection:
    limit = memory_limit or os.environ.get("HOGA_DUCKDB_MEMORY_LIMIT", DEFAULT_MEMORY_LIMIT)
    tmp = temp_directory or resolve_data_dir() / "duckdb-tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    max_tmp = max_temp_directory_size or os.environ.get(
        "HOGA_DUCKDB_MAX_TEMP_SIZE", DEFAULT_MAX_TEMP_SIZE
    )
    con = duckdb.connect(database=":memory:", read_only=False)
    con.execute(f"SET memory_limit='{limit}'")
    con.execute(f"SET temp_directory='{tmp}'")
    con.execute(f"SET max_temp_directory_size='{max_tmp}'")
    return con
```

- [ ] **Step 4: 통과 확인**

```bash
uv run --extra dev pytest tests/test_duck.py -q
```
Expected: 4 passed

주의: `current_setting('memory_limit')`가 `'1.0 GiB'` 형식 그대로를 반환하지 않는 DuckDB 버전이면(예: 바이트 수 반환) 테스트의 기대값을 실제 반환 형식에 맞춰 조정한다 — 검증 목적은 "기본값 80%가 아니라 지정값이 적용됐다"이다.

- [ ] **Step 5: Commit**

```bash
git add hoga/duck.py tests/test_duck.py
git commit -m "feat: bounded duckdb connection factory"
```

---

### Task 3: 6개 `duckdb.connect()` 지점을 팩토리로 교체

**Files:**
- Modify: `hoga/api/queries.py:64`
- Modify: `hoga/api/screener_store.py:28,52,168`
- Modify: `hoga/api/screener_scan.py:123`
- Modify: `hoga/live/quote_change_resolver.py:183`

- [ ] **Step 1: `queries.py` 교체**

`hoga/api/queries.py`에 `from hoga.duck import connect_bounded` import를 추가하고, 64행을:

```python
# 변경 전
self._conn = duckdb.connect(database=":memory:", read_only=False)
# 변경 후
self._conn = connect_bounded()
```

- [ ] **Step 2: `screener_store.py` 3곳 교체**

`from hoga.duck import connect_bounded` import 추가 후, 28행·52행의 `con = duckdb.connect(":memory:")` → `con = connect_bounded()`, 168행의 `r = duckdb.connect(":memory:").execute(` → `r = connect_bounded().execute(`.

- [ ] **Step 3: `screener_scan.py:123`, `quote_change_resolver.py:183` 교체**

동일 패턴: import 추가 + `duckdb.connect(":memory:")` → `connect_bounded()`. (`with duckdb.connect(":memory:") as con:`은 `with connect_bounded() as con:`으로.)

각 파일에서 `import duckdb`가 다른 용도로 더 쓰이지 않으면 제거한다 (타입 힌트 `duckdb.DuckDBPyConnection` 사용처는 유지).

- [ ] **Step 4: 백엔드 전체 테스트로 회귀 확인**

```bash
uv run --extra dev pytest tests -q
```
Expected: 전체 그린 (기존 통과 수와 동일)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/queries.py hoga/api/screener_store.py hoga/api/screener_scan.py hoga/live/quote_change_resolver.py
git commit -m "fix: route all duckdb connections through bounded factory"
```

---

### Task 4: 성능 가드레일 테스트 (red — 현 SQL 구현이 느림을 고정)

**Files:**
- Test: `tests/test_tables_snapshots.py` (파일 끝에 추가)

- [ ] **Step 1: 병리적 데이터 생성 헬퍼 + 가드레일 테스트 작성**

기존 픽스처 헬퍼(`_ob_ap`, `_trade`, `write_parquet`, `write_trades`, `_con_for` — 파일 상단에 이미 존재)를 재사용한다. 조인 폭발을 유발하는 구조: 가격이 넓게 퍼진 레벨 + 모든 레벨을 지배하는 고가 터치 다수.

```python
def test_query_day_ask_bid_peak_dual_perf_guardrail(tmp_path: Path) -> None:
    """2026-07-05 356GB 스필 회귀 방지: 넓은 가격 분포 × 다수 터치에서
    비등가 조인이 폭발하지 않고 수 초 안에 완료되어야 한다."""
    import time

    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    n = 4000  # Step 2에서 현 구현이 5초를 넘도록 보정
    obs = []
    for i in range(n):
        ts = 100000000 + i * 1000  # 10:00:00.000 부터 1초 간격
        base = 50000 + (i % 400) * 10
        obs.append(_ob_ap(ts, [100 + i % 50] * 10, ask_p=[base + j * 10 for j in range(10)]))
    write_parquet(obs, snapshots_path)
    trades = [
        _trade(100000500 + i * 1000, 54000, seq=i + 1)  # 모든 ask 레벨을 지배하는 고가 터치
        for i in range(n)
    ]
    write_trades(trades, trades_path)

    started = time.monotonic()
    ask, bid = query_day_ask_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    elapsed = time.monotonic() - started
    assert ask is not None
    assert elapsed < 5.0, f"peak dual query took {elapsed:.1f}s"
```

주의: `_ob_ap`/`_trade`의 실제 시그니처는 테스트 파일 상단 정의를 따른다 (`_trade`는 `seq` 키워드를 받는다 — `tests/test_tables_snapshots.py`의 기존 정의 확인). ts 인자는 HHMMSSmmm 인코딩이므로 위처럼 초 단위 증가는 `+ i * 1000`이 아니라 헬퍼가 기대하는 형식에 맞춘다 — 기존 테스트가 `100000000`(10:00:00.000), `102000000`(10:20:00.000)을 쓰는 것을 참고해 분·초 자리올림이 유효한 값만 생성하도록 `ts = int(f"{10 + i // 3600:02d}{(i // 60) % 60:02d}{i % 60:02d}000")` 형태로 구성한다.

- [ ] **Step 2: red 확인 + 크기 보정**

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py::test_query_day_ask_bid_peak_dual_perf_guardrail -q --timeout=120
```
Expected: FAIL (`elapsed >= 5.0`). n=4000에서 5초 미만이면 n을 8000, 16000으로 올려 **현 구현이 확실히 5초를 넘는 최소 크기**를 찾아 고정한다. 120초 안에 안 끝나면 n을 낮춘다 (red 확인이 목적이지 고문이 목적이 아님).

- [ ] **Step 3: Commit (xfail 마커로 임시 고정)**

Task 6에서 구현이 바뀔 때까지 CI가 죽지 않도록 임시 xfail을 단다:

```python
@pytest.mark.xfail(reason="quadratic SQL path — removed in peak sweep rewrite", strict=True)
```

```bash
git add tests/test_tables_snapshots.py
git commit -m "test: add peak dual perf guardrail (xfail on quadratic sql path)"
```

---

### Task 5: 스위프 분류기 구현 (TDD)

**Files:**
- Modify: `hoga/tables/snapshots.py` (새 내부 함수들 추가 — 기존 SQL 경로는 아직 유지)
- Test: `tests/test_tables_snapshots.py`

- [ ] **Step 1: 분류기 유닛 테스트 작성 (red)**

SQL 의미론의 핵심 경계(같은-ms seq 터치 규칙, lifecycle 재관측)를 분류기 수준에서 직접 고정한다:

```python
from hoga.tables.snapshots import _classify_wall_stream, _WallEvent, _Touch


def _ev(ts: int, seq: int, price: int, qty: int, bucket: int = 0) -> _WallEvent:
    return _WallEvent(ts_ms=ts, seq=seq, price=price, qty=qty, intra_ms=ts, bucket_id=bucket)


def test_sweep_same_key_touch_counts_as_touched() -> None:
    events = [_ev(1000, 5, 50000, 10)]
    touches = [_Touch(ts_ms=1000, seq=5, price=50000)]
    classified, _distinct = _classify_wall_stream(events, touches, side="ask")
    assert classified[0][1] is True  # 같은 (ts,seq) 터치는 touched


def test_sweep_same_ms_earlier_seq_does_not_touch() -> None:
    events = [_ev(1000, 5, 50000, 10)]
    touches = [_Touch(ts_ms=1000, seq=4, price=50000)]
    classified, _distinct = _classify_wall_stream(events, touches, side="ask")
    assert classified[0][1] is False


def test_sweep_lifecycle_reopens_after_touch() -> None:
    # 벽 관측 → 지배 터치 → 같은 가격 재관측: 재관측은 새 lifecycle이라
    # (price, is_touched=False) best로 남아야 한다 (untraded).
    events = [_ev(1000, 1, 50000, 100), _ev(3000, 3, 50000, 40)]
    touches = [_Touch(ts_ms=2000, seq=2, price=50000)]
    _classified, distinct = _classify_wall_stream(events, touches, side="ask")
    assert distinct[(50000, True)].qty == 100   # 터치 전 lifecycle의 best
    assert distinct[(50000, False)].qty == 40   # 터치 후 새 lifecycle


def test_sweep_bid_side_uses_lower_or_equal_domination() -> None:
    events = [_ev(1000, 1, 50000, 10)]
    touches = [_Touch(ts_ms=2000, seq=2, price=50100)]  # bid에선 지배 아님
    classified, _distinct = _classify_wall_stream(events, touches, side="bid")
    assert classified[0][1] is False
```

- [ ] **Step 2: red 확인**

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py -k sweep -q
```
Expected: FAIL — `ImportError: cannot import name '_classify_wall_stream'`

- [ ] **Step 3: 구현 — `hoga/tables/snapshots.py`에 추가**

`AskPeakCandidateRow` dataclass 정의 근처(≈534행)에 다음을 추가한다:

```python
from bisect import bisect_left, bisect_right


@dataclass(frozen=True)
class _WallEvent:
    ts_ms: int
    seq: int
    price: int
    qty: int
    intra_ms: int
    bucket_id: int


@dataclass(frozen=True)
class _Touch:
    ts_ms: int
    seq: int
    price: int


def _event_rank_key(e: _WallEvent) -> tuple[int, int, int, int]:
    # SQL 공통 랭킹: qty DESC, intra_ms ASC, seq ASC, price ASC
    return (-e.qty, e.intra_ms, e.seq, e.price)


class _MaxFenwick:
    """1-based prefix-max Fenwick tree (values are positive touch ordinals)."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._tree = [0] * (size + 1)

    def update(self, i: int, value: int) -> None:
        while i <= self._size:
            if self._tree[i] < value:
                self._tree[i] = value
            i += i & (-i)

    def prefix_max(self, i: int) -> int:
        best = 0
        while i > 0:
            if self._tree[i] > best:
                best = self._tree[i]
            i -= i & (-i)
        return best


def _classify_wall_stream(
    events: list[_WallEvent],
    touches: list[_Touch],
    *,
    side: str,
) -> tuple[list[tuple[_WallEvent, bool]], dict[tuple[int, bool], _WallEvent]]:
    """Sweep replacement for the quadratic lifecycle SQL (2026-07-05 356GB spill).

    Returns (classified, distinct_best):
      classified    — (event, is_touched) in (ts_ms, seq) ascending order.
      distinct_best — best event per (price, is_touched) after per-(price,
                      lifecycle) dedup; mirrors `{side}_{src}_lifecycle_distinct`.
    Semantics contract (must match the former SQL exactly):
      is_touched:  touches with (ts, seq) >= event's, dominating price-wise.
      lifecycle:   segmented by strictly-earlier dominating touches.
    """
    is_ask = side == "ask"
    events_sorted = sorted(events, key=lambda e: (e.ts_ms, e.seq))
    touches_sorted = sorted(touches, key=lambda t: (t.ts_ms, t.seq, t.price))

    # ── pass 1 (reverse): is_touched via running future extreme ──────────
    classified: list[tuple[_WallEvent, bool] | None] = [None] * len(events_sorted)
    ti = len(touches_sorted) - 1
    future_extreme: int | None = None
    for ei in range(len(events_sorted) - 1, -1, -1):
        e = events_sorted[ei]
        while ti >= 0 and (touches_sorted[ti].ts_ms, touches_sorted[ti].seq) >= (e.ts_ms, e.seq):
            tp = touches_sorted[ti].price
            if future_extreme is None or (tp > future_extreme if is_ask else tp < future_extreme):
                future_extreme = tp
            ti -= 1
        touched = future_extreme is not None and (
            future_extreme >= e.price if is_ask else future_extreme <= e.price
        )
        classified[ei] = (e, touched)

    # ── pass 2 (forward): lifecycle ids via Fenwick over touch prices ────
    uniq = sorted({t.price for t in touches_sorted})
    fen = _MaxFenwick(len(uniq))

    if is_ask:
        def _touch_idx(price: int) -> int:      # rank from the top (>= queries)
            return len(uniq) - bisect_left(uniq, price)
        _query_idx = _touch_idx
    else:
        def _touch_idx(price: int) -> int:      # rank from the bottom (<= queries)
            return bisect_left(uniq, price) + 1
        def _query_idx(price: int) -> int:
            return bisect_right(uniq, price)

    lifecycle_best: dict[tuple[int, int], tuple[_WallEvent, bool]] = {}
    ti = 0
    for pair in classified:
        assert pair is not None
        e, touched = pair
        while ti < len(touches_sorted) and (
            (touches_sorted[ti].ts_ms, touches_sorted[ti].seq) < (e.ts_ms, e.seq)
        ):
            fen.update(_touch_idx(touches_sorted[ti].price), ti + 1)
            ti += 1
        lifecycle_id = fen.prefix_max(_query_idx(e.price))
        key = (e.price, lifecycle_id)
        cur = lifecycle_best.get(key)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur[0]):
            lifecycle_best[key] = (e, touched)

    distinct_best: dict[tuple[int, bool], _WallEvent] = {}
    for (price, _lid), (e, touched) in lifecycle_best.items():
        key2 = (price, touched)
        cur2 = distinct_best.get(key2)
        if cur2 is None or _event_rank_key(e) < _event_rank_key(cur2):
            distinct_best[key2] = e

    return [p for p in classified if p is not None], distinct_best
```

- [ ] **Step 4: green 확인**

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py -k sweep -q
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "feat: linear sweep peak wall classifier (fenwick lifecycle ids)"
```

---

### Task 6: `query_day_ask_bid_peak_dual` 내부 교체 + 죽은 SQL 삭제

**Files:**
- Modify: `hoga/tables/snapshots.py:1059-1466`

- [ ] **Step 1: 선형 스트림 리더 작성**

`query_day_ask_bid_peak_dual` 바로 위에 추가. 기존 함수의 `cont`/`rep` CTE와 level 언피벗은 선형이므로 그대로 재사용하되, 결과를 파이썬으로 가져온다:

```python
def _read_peak_wall_streams(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    where: str,
    intra: str,
    trade_seq_expr: str,
) -> tuple[dict[str, list[_WallEvent]], list[_Touch]]:
    level_selects: list[str] = []
    for source, table_expr in (("cont", "cont"), ("rep", "rep")):
        for side, price_prefix, qty_prefix in (("ask", "ask_p", "ask_q"), ("bid", "bid_p", "bid_q")):
            for i in range(1, ORDERBOOK_LEVELS + 1):
                level_selects.append(
                    f"SELECT '{side}' AS side, '{source}' AS source, ts_ms, seq, "
                    f"{price_prefix}{i} AS price, {qty_prefix}{i} AS qty, "
                    f"{intra} AS intra_ms, bucket_id "
                    f"FROM {table_expr} WHERE {qty_prefix}{i} > 0"
                )
    rows = con.execute(
        f"""
        WITH cont AS (
          SELECT *,
                 ({intra} // {int(bucket_ms)}) AS bucket_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra} // {int(bucket_ms)})
                   ORDER BY ts_ms DESC, seq DESC
                 ) AS rn
          FROM read_parquet(?) WHERE {where}
        ),
        rep AS (SELECT * FROM cont WHERE rn = 1)
        {" UNION ALL ".join(level_selects)}
        """,
        [str(path)],
    ).fetchall()
    touch_rows = con.execute(
        f"""
        SELECT ts_ms, {trade_seq_expr} AS seq, price
        FROM read_parquet(?)
        WHERE side IN (1, -1) AND price > 0
        """,
        [str(trades_path)],
    ).fetchall()

    streams: dict[str, list[_WallEvent]] = {
        "ask_rep": [], "ask_cont": [], "bid_rep": [], "bid_cont": [],
    }
    for side, source, ts_ms, seq, price, qty, intra_ms, bucket_id in rows:
        streams[f"{side}_{source}"].append(_WallEvent(
            ts_ms=int(ts_ms), seq=int(seq or 0), price=int(price), qty=int(qty),
            intra_ms=int(intra_ms), bucket_id=int(bucket_id),
        ))
    touches = [
        _Touch(ts_ms=int(ts_ms), seq=int(seq or 0), price=int(price))
        for ts_ms, seq, price in touch_rows
    ]
    return streams, touches
```

- [ ] **Step 2: side별 산출 조립 헬퍼 작성**

```python
def _candidates(rows: list[_WallEvent], limit: int | None) -> tuple[AskPeakCandidateRow, ...]:
    ranked = sorted(rows, key=_event_rank_key)
    if limit is not None:
        ranked = ranked[:limit]
    return tuple(AskPeakCandidateRow(price=e.price, qty=e.qty, intra_ms=e.intra_ms) for e in ranked)


def _bucket_dedup(classified: list[tuple[_WallEvent, bool]]) -> list[_WallEvent]:
    best: dict[tuple[int, int], _WallEvent] = {}
    for e, _touched in classified:
        key = (e.price, e.bucket_id)
        cur = best.get(key)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            best[key] = e
    return list(best.values())


def _scalar(rows: list[_WallEvent]) -> tuple[int, int, int] | None:
    if not rows:
        return None
    e = min(rows, key=_event_rank_key)
    return (e.price, e.qty, e.intra_ms)
```

- [ ] **Step 3: `query_day_ask_bid_peak_dual` 본문 교체**

시그니처·docstring·`intra`/`trade_seq_expr`/`where` 준비부(1059~1076행)는 유지하고, `level_union`부터 `.fetchall()` 및 파싱까지(1078~1466행)를 다음으로 교체한다:

```python
    streams, touches = _read_peak_wall_streams(
        con, path=path, trades_path=trades_path, bucket_ms=bucket_ms,
        where=where, intra=intra, trade_seq_expr=trade_seq_expr,
    )

    def _side_row(side: str):
        rep_classified, rep_distinct = _classify_wall_stream(streams[f"{side}_rep"], touches, side=side)
        cont_classified, cont_distinct = _classify_wall_stream(streams[f"{side}_cont"], touches, side=side)

        all_close = _scalar([e for e, _t in rep_classified])
        all_max = _scalar([e for e, _t in cont_classified])
        if all_close is None or all_max is None:
            return None

        rep_traded = [e for (p, t), e in rep_distinct.items() if t]
        rep_untraded = [e for (p, t), e in rep_distinct.items() if not t]
        cont_traded = [e for (p, t), e in cont_distinct.items() if t]
        cont_untraded = [e for (p, t), e in cont_distinct.items() if not t]

        return {
            "traded_close": _scalar(rep_traded),
            "traded_max": _scalar(cont_traded),
            "untraded_close": _scalar(rep_untraded),
            "untraded_max": _scalar(cont_untraded),
            "traded_peaks": _candidates(rep_traded, 3),
            "traded_max_peaks": _candidates(cont_traded, 3),
            "untraded_peaks": _candidates(rep_untraded, 3),
            "untraded_max_peaks": _candidates(cont_untraded, 3),
            "all_peaks": _candidates(_bucket_dedup(rep_classified), None),
            "all_max_peaks": _candidates(_bucket_dedup(cont_classified), None),
            "all_close": all_close,
            "all_max": all_max,
        }

    ask = _side_row("ask")
    bid = _side_row("bid")

    ask_row: AskPeakDualRow | None = None
    if ask is not None:
        tc, tm, uc, um = ask["traded_close"], ask["traded_max"], ask["untraded_close"], ask["untraded_max"]
        ask_row = AskPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=ask["traded_peaks"], traded_max_peaks=ask["traded_max_peaks"],
            all_price=ask["all_close"][0], all_qty=ask["all_close"][1], all_intra_ms=ask["all_close"][2],
            all_max_price=ask["all_max"][0], all_max_qty=ask["all_max"][1], all_max_intra_ms=ask["all_max"][2],
            all_peaks=ask["all_peaks"], all_max_peaks=ask["all_max_peaks"],
            untraded_price=uc[0] if uc else None, untraded_qty=uc[1] if uc else None,
            untraded_intra_ms=uc[2] if uc else None,
            untraded_max_price=um[0] if um else None, untraded_max_qty=um[1] if um else None,
            untraded_max_intra_ms=um[2] if um else None,
            untraded_peaks=ask["untraded_peaks"], untraded_max_peaks=ask["untraded_max_peaks"],
        )

    bid_row: BidPeakDualRow | None = None
    if bid is not None:
        tc, tm, uc, um = bid["traded_close"], bid["traded_max"], bid["untraded_close"], bid["untraded_max"]
        bid_row = BidPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=bid["traded_peaks"], traded_max_peaks=bid["traded_max_peaks"],
            all_price=bid["all_close"][0], all_qty=bid["all_close"][1], all_intra_ms=bid["all_close"][2],
            all_max_price=bid["all_max"][0], all_max_qty=bid["all_max"][1], all_max_intra_ms=bid["all_max"][2],
            all_peaks=bid["all_peaks"], all_max_peaks=bid["all_max_peaks"],
            untraded_price=uc[0] if uc else None, untraded_qty=uc[1] if uc else None,
            untraded_intra_ms=uc[2] if uc else None,
            untraded_max_price=um[0] if um else None, untraded_max_qty=um[1] if um else None,
            untraded_max_intra_ms=um[2] if um else None,
            untraded_peaks=bid["untraded_peaks"], untraded_max_peaks=bid["untraded_max_peaks"],
        )
    return ask_row, bid_row
```

이때 더 이상 쓰이지 않는 내부 헬퍼(`level_union`, `classified_levels`, `lifecycle_levels`, `scalar_and_array_ctes`)와 거대 SQL 문자열은 **모두 삭제**한다.

- [ ] **Step 4: 기존 64개 테스트로 의미론 보존 확인**

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py -q
```
Expected: 전체 PASS (기존 64 + sweep 4 + 가드레일). 실패하는 기존 테스트가 있으면 **테스트를 고치지 말고** 스위프 의미론(같은-key 포함/제외 규칙, 랭킹 타이브레이크)을 SQL 정의와 다시 대조한다 — 특히 `seq`가 `None`인 스냅샷 행의 `int(seq or 0)` 강제와 터치 정렬 키 `(ts, seq, price)`.

- [ ] **Step 5: 가드레일 xfail 제거 → 정식 green**

Task 4에서 단 `@pytest.mark.xfail(...)` 데코레이터를 삭제하고:

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py::test_query_day_ask_bid_peak_dual_perf_guardrail -q
```
Expected: PASS, 5초 미만 (스위프 구현은 n=4000~16000에서 1초 미만이어야 정상)

- [ ] **Step 6: 백엔드 전체 테스트**

```bash
uv run --extra dev pytest tests -q
```
Expected: 전체 그린

- [ ] **Step 7: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "fix: replace quadratic peak wall SQL with linear sweep (356GB spill root fix)"
```

---

### Task 7: 실데이터 검증 (무거운 실거래일 대상)

**Files:** 없음 (검증 전용 — 스크립트는 스크래치패드에)

- [ ] **Step 1: 가장 무거운 실데이터 날짜로 신구 동작 확인**

`~/.local/share/hoga-ops/data/parquet/` 아래에서 snapshots.parquet가 가장 큰 (code, date)를 찾아 새 구현을 직접 실행한다:

```bash
find ~/.local/share/hoga-ops/data/parquet -name 'snapshots.parquet' -size +50M | head -5
```

스크래치패드 스크립트(형식 예):

```python
import time
from pathlib import Path
from hoga.duck import connect_bounded
from hoga.tables.snapshots import query_day_ask_bid_peak_dual

d = Path("<위에서 고른 디렉터리>")
con = connect_bounded()
t0 = time.monotonic()
ask, bid = query_day_ask_bid_peak_dual(
    con, path=d / "snapshots.parquet", trades_path=d / "trades.parquet", bucket_ms=60_000,
)
print(f"elapsed={time.monotonic() - t0:.2f}s ask={ask is not None} bid={bid is not None}")
```

```bash
uv run python /tmp/claude-1000/.../scratchpad/bench_peak.py
```
Expected: 수 초 이내 완료, 실행 중 `ps -o rss= -p <pid>`가 수 GB 이내. 결과 수치를 PR 본문에 기록한다.

- [ ] **Step 2: 서버 기동 스모크**

백엔드를 띄우고 `/api/range?mode=sidecar` 실호출 1회(과거 날짜 + 오늘 날짜)로 응답 확인. 이 세션의 dev 서버가 이미 떠 있으면 재사용한다.

---

### Task 8: 프론트 refetch 버스트 완화

**Files:**
- Modify: `frontend/src/main.tsx:25`

- [ ] **Step 1: QueryClient 기본 옵션 추가**

```typescript
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
```

- [ ] **Step 2: 프론트 게이트 실행**

```bash
cd frontend && npx vitest run && npx tsc -b
```
Expected: 전체 그린 (eslint 전역 실행은 기존 부채로 실패하므로 게이트가 아님 — 변경 파일에만 eslint를 돌려 0 에러 확인)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "fix(live): disable focus/reconnect refetch bursts"
```

---

### Task 9: ADR 작성 — 설계 재검토 기록

**Files:**
- Create: `docs/adr/NNNN-duckdb-resource-bounds-and-peak-sweep.md` (NNNN = `ls docs/adr | tail -1` 다음 번호)

- [ ] **Step 1: ADR 작성**

기존 ADR 형식(`docs/adr/` 최근 파일 참조)을 따르되 다음 결정을 기록:

1. **DuckDB 리소스 정책**: 모든 in-process 연결은 `hoga.duck.connect_bounded()` 경유. 기본 memory_limit 8 GiB(`HOGA_DUCKDB_MEMORY_LIMIT` 오버라이드), temp는 `<data_dir>/duckdb-tmp`, max_temp_directory_size 50 GiB. 근거: 2026-07-05 356GB 스필 + 2026-07-07 uvicorn OOM kill 3회.
2. **피크 월 분류 아키텍처**: 비등가 조인 SQL → 선형 SQL 스캔 + 파이썬 스위프(Fenwick lifecycle). 2026-07-05의 파이썬 기각(`6239f67a`)은 O(touches×prices) 구현 문제였음을 명시 (같은 실수 반복 방지).
3. **알려진 잔여 리스크 / 후속 과제**:
   - 오늘 날짜 피크는 `PastIndicatorsCache` 대상 외 → sidecar 폴링마다 재계산 (신규 구현으로 회당 수 초 이내라 수용; 필요 시 parquet mtime 키 메모이제이션 후속).
   - `useLiveBundle`의 종목당 최대 9개 useQuery 팬아웃은 별도 트랙(2026-07-06 sidecar delta 플랜 계열)에서 축소 진행 중.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/
git commit -m "docs: adr for duckdb resource bounds and peak sweep rewrite"
```

---

## Self-Review 체크 결과

- **커버리지**: 근본 수정(Task 5-6), 안전망(Task 2-3), 재발 물증 정리(Task 1), 성능 회귀 가드(Task 4), 실데이터 검증(Task 7), 프론트 버스트(Task 8), 설계 기록(Task 9) — 조사에서 확인된 원인 전부에 대응 태스크 존재.
- **의미론 위험**: 가장 큰 리스크는 스위프가 SQL 윈도우의 타이브레이크를 어긋나게 재현하는 것. 방어: (1) 같은-key 규칙을 유닛 테스트로 직접 고정(Task 5), (2) 기존 64개 테스트 무수정 그린(Task 6 Step 4), (3) 실데이터 스모크(Task 7).
- **성능 위험**: `cont` 스트림은 스냅샷×10레벨이라 실거래일 기준 수십만~백만 이벤트. fetchall+파이썬 스위프로 회당 1~3초 예상 — Task 7에서 실측하고, 과도하면 `fetchnumpy()` 전환이 후속 최적화 경로(플랜 범위 밖).
- **플레이스홀더 스캔**: 코드 블록 전부 실코드. Task 7 스크립트의 경로 `<...>`는 실행 시 결정되는 값으로 명령이 함께 제공됨.

## 실행 노트

- 이 워크트리(`claude/loving-antonelli-6eb884`)에서 실행. 다른 에이전트와 워크트리 공유 금지 (memory: git index race).
- 테스트는 반드시 `uv run --extra dev pytest ...` (bare pytest는 모듈 미탐).
- 커밋은 `git add <정확한 경로> && git commit` (`--only` 금지 — 훅 차단).
