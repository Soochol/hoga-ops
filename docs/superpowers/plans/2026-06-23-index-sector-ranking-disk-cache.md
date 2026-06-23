# Index Sector Ranking Disk Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/live` index sector rankings fast across server restarts by adding an input-fingerprint-based disk cache for heatmap-derived sector/stock ranking responses.

**Architecture:** Keep the existing in-memory LRU cache as the first layer, then add a disk cache layer under the data directory. Cache entries are keyed by requested date plus fingerprints of `heatmap.json` and `screener/daily_adjusted.parquet`, so current heatmap/daily inputs get fast reuse while changed inputs naturally create new cache files.

**Tech Stack:** Python 3.14, Pydantic models, Polars parquet reads, existing FastAPI route, pytest, React Query client unchanged.

## Global Constraints

- Do not persist user-intent snapshots by plain date; this is a speed cache, not historical audit storage.
- Cache key must include `basis_date`, heatmap fingerprint, and daily corpus fingerprint.
- Memory cache remains the fastest path.
- Disk cache must be safe to read after process restart.
- Corrupt disk cache files must be ignored and recomputed, not returned to the client.
- Existing API response shape must not change.
- Frontend should not need a new API contract for this phase.

---

## File Structure

- Modify: `hoga/live/index_sector_rankings.py`
  - Owns cache key construction, disk read/write helpers, and integration with `build_index_sector_rankings`.
- Modify: `tests/unit/live/test_index_sector_rankings.py`
  - Adds tests for disk cache hit, input invalidation, corrupt cache recovery, and memory warm-from-disk behavior.
- Optional later docs/release task:
  - Modify `CHANGELOG.md` and `VERSION` only when shipping the implementation PR.

---

### Task 1: Add Disk Cache Path And Fingerprint Helpers

**Files:**
- Modify: `hoga/live/index_sector_rankings.py`
- Test: `tests/unit/live/test_index_sector_rankings.py`

**Interfaces:**
- Produces: `_ranking_disk_cache_path(data_dir: Path, basis_date: str, heatmap_mtime_ns: int, corpus_mtime_ns: int) -> Path`
- Produces: cache files under `data_dir / "cache" / "index_sector_rankings"`

- [ ] **Step 1: Write failing unit test for deterministic cache path**

Add to `tests/unit/live/test_index_sector_rankings.py`:

```python
def test_index_sector_ranking_disk_cache_path_uses_input_fingerprint(tmp_path: Path) -> None:
    path = rankings._ranking_disk_cache_path(
        tmp_path,
        "20260619",
        heatmap_mtime_ns=111,
        corpus_mtime_ns=222,
    )

    assert path.parent == tmp_path / "cache" / "index_sector_rankings"
    assert path.name == "20260619-heatmap_111-daily_222.json"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_index_sector_ranking_disk_cache_path_uses_input_fingerprint -q
```

Expected: FAIL with `AttributeError: module 'hoga.live.index_sector_rankings' has no attribute '_ranking_disk_cache_path'`.

- [ ] **Step 3: Implement path helper**

Add in `hoga/live/index_sector_rankings.py` near `_mtime_ns`:

```python
def _ranking_disk_cache_path(
    data_dir: Path,
    basis_date: str,
    *,
    heatmap_mtime_ns: int,
    corpus_mtime_ns: int,
) -> Path:
    filename = f"{basis_date}-heatmap_{heatmap_mtime_ns}-daily_{corpus_mtime_ns}.json"
    return data_dir / "cache" / "index_sector_rankings" / filename
```

- [ ] **Step 4: Run test to verify it passes**

Run the same pytest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/index_sector_rankings.py tests/unit/live/test_index_sector_rankings.py
git commit -m "test: define index sector ranking disk cache key"
```

---

### Task 2: Read Valid Disk Cache Before Parquet Calculation

**Files:**
- Modify: `hoga/live/index_sector_rankings.py`
- Test: `tests/unit/live/test_index_sector_rankings.py`

**Interfaces:**
- Consumes: `_ranking_disk_cache_path(...) -> Path`
- Produces: `_read_disk_cache(path: Path) -> IndexSectorRankingResponse | None`
- Behavior: memory miss + disk hit returns cached response and warms memory cache.

- [ ] **Step 1: Write failing disk-hit test**

Add:

```python
def test_build_index_sector_rankings_reads_valid_disk_cache_on_memory_miss(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    first = build_index_sector_rankings(tmp_path, "20260619")
    rankings._ranking_cache.clear()

    def fail_load_daily_rows(path, codes, basis):
        raise AssertionError("disk cache hit should not scan parquet")

    monkeypatch.setattr(rankings, "_load_daily_rows", fail_load_daily_rows)

    second = build_index_sector_rankings(tmp_path, "20260619")

    assert second == first
    assert second.source == "daily_adjusted"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_reads_valid_disk_cache_on_memory_miss -q
```

Expected: FAIL because no disk cache exists yet and the monkeypatched parquet loader raises.

- [ ] **Step 3: Implement read helper and read path**

Add imports:

```python
import json
```

Add helpers:

```python
def _read_disk_cache(path: Path) -> IndexSectorRankingResponse | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return IndexSectorRankingResponse.model_validate(raw)
    except (OSError, ValueError):
        return None
```

In `build_index_sector_rankings`, after memory cache miss and before `load_document(data_dir)`:

```python
disk_cache_path = _ranking_disk_cache_path(
    data_dir,
    basis_date,
    heatmap_mtime_ns=cache_key[2],
    corpus_mtime_ns=cache_key[3],
)
disk_cached = _read_disk_cache(disk_cache_path)
if disk_cached is not None:
    return _cache_put(cache_key, disk_cached)
```

- [ ] **Step 4: Run test**

Expected: still FAIL until Task 3 writes cache files. This is acceptable within the same task only if Task 3 immediately follows; otherwise merge Task 2 and Task 3 into one commit.

---

### Task 3: Write Successful Ranking Responses To Disk

**Files:**
- Modify: `hoga/live/index_sector_rankings.py`
- Test: `tests/unit/live/test_index_sector_rankings.py`

**Interfaces:**
- Consumes: `_ranking_disk_cache_path(...)`
- Produces: `_write_disk_cache(path: Path, value: IndexSectorRankingResponse) -> None`
- Behavior: successful computed `daily_adjusted` and `unavailable` responses are written atomically enough for local cache use.

- [ ] **Step 1: Write failing disk-file creation test**

Add:

```python
def test_build_index_sector_rankings_writes_disk_cache(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert result.source == "daily_adjusted"
    assert len(cache_files) == 1
    cached = rankings._read_disk_cache(cache_files[0])
    assert cached == result
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest \
  tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_writes_disk_cache \
  tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_reads_valid_disk_cache_on_memory_miss \
  -q
```

Expected: first test FAIL because no file is written; second still FAIL.

- [ ] **Step 3: Implement write helper**

Add:

```python
def _write_disk_cache(path: Path, value: IndexSectorRankingResponse) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(value.model_dump_json(), encoding="utf-8")
        tmp_path.replace(path)
    except OSError:
        return
```

Add helper to write + memory cache together:

```python
def _cache_put_with_disk(
    key: tuple[str, str, int, int],
    disk_path: Path,
    value: IndexSectorRankingResponse,
) -> IndexSectorRankingResponse:
    _write_disk_cache(disk_path, value)
    return _cache_put(key, value)
```

Replace final return:

```python
return _cache_put_with_disk(cache_key, disk_cache_path, IndexSectorRankingResponse(
    date=basis_date,
    source="daily_adjusted",
    sectors=_sort_sectors(sectors),
))
```

For unavailable returns after `disk_cache_path` exists, use:

```python
return _cache_put_with_disk(cache_key, disk_cache_path, _unavailable(basis_date, "daily_corpus_invalid"))
```

Do not write cache before `disk_cache_path` is defined; missing corpus can still use the path because corpus mtime is `0`.

- [ ] **Step 4: Run disk cache tests**

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/index_sector_rankings.py tests/unit/live/test_index_sector_rankings.py
git commit -m "feat: persist index sector ranking cache"
```

---

### Task 4: Ignore Corrupt Disk Cache And Recompute

**Files:**
- Modify: `tests/unit/live/test_index_sector_rankings.py`
- Modify: `hoga/live/index_sector_rankings.py` only if the test exposes a missed exception type.

**Interfaces:**
- Consumes: `_read_disk_cache(path)`
- Behavior: invalid JSON or invalid response schema returns `None`, then normal computation proceeds.

- [ ] **Step 1: Write corrupt cache test**

Add:

```python
def test_build_index_sector_rankings_ignores_corrupt_disk_cache(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    heatmap_path = tmp_path / "heatmap.json"
    corpus_path = tmp_path / "screener" / "daily_adjusted.parquet"
    cache_path = rankings._ranking_disk_cache_path(
        tmp_path,
        "20260619",
        heatmap_mtime_ns=heatmap_path.stat().st_mtime_ns,
        corpus_mtime_ns=corpus_path.stat().st_mtime_ns,
    )
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("{not json", encoding="utf-8")

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "daily_adjusted"
    assert result.sectors[0].change_pct == 7.5
    assert rankings._read_disk_cache(cache_path) == result
```

- [ ] **Step 2: Run test**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_ignores_corrupt_disk_cache -q
```

Expected: PASS if Task 3 helper catches JSON/schema errors. If it fails with `ValidationError`, update `_read_disk_cache` to catch `pydantic.ValidationError`.

- [ ] **Step 3: Commit**

```bash
git add hoga/live/index_sector_rankings.py tests/unit/live/test_index_sector_rankings.py
git commit -m "test: recover corrupt index sector ranking disk cache"
```

---

### Task 5: Prove Input Changes Create New Cache Files

**Files:**
- Modify: `tests/unit/live/test_index_sector_rankings.py`

**Interfaces:**
- Consumes: mtime-based fingerprint in `_ranking_disk_cache_path`.
- Behavior: changing heatmap membership creates a different cache file and returns current heatmap basis.

- [ ] **Step 1: Write heatmap invalidation test**

Add:

```python
def test_build_index_sector_rankings_uses_new_disk_cache_after_heatmap_changes(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)
    first = build_index_sector_rankings(tmp_path, "20260619")

    moved_id = "f_00000003"
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder.model_construct(id=moved_id, name="이동후", order=0)],
            entries=[HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=moved_id, order=0)],
        ),
    )
    second = build_index_sector_rankings(tmp_path, "20260619")
    cache_files = list((tmp_path / "cache" / "index_sector_rankings").glob("20260619-*.json"))

    assert first.sectors[0].folder_name == "반도체"
    assert second.sectors[0].folder_name == "이동후"
    assert len(cache_files) == 2
```

- [ ] **Step 2: Run test**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_uses_new_disk_cache_after_heatmap_changes -q
```

Expected: PASS. If filesystem mtime resolution is flaky, update `_ranking_disk_cache_path` to use a short content hash instead of mtime.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/live/test_index_sector_rankings.py
git commit -m "test: invalidate ranking disk cache on heatmap changes"
```

---

### Task 6: Final Verification And Release Metadata

**Files:**
- Modify: `VERSION`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: release entry for the disk cache.

- [ ] **Step 1: Update version**

If current `VERSION` is `0.9.1.3`, change it to:

```text
0.9.1.4
```

- [ ] **Step 2: Add changelog entry**

Insert after the changelog header:

```markdown
## [0.9.1.4] - 2026-06-23

### Added
- **/live 지수 섹터 랭킹 디스크 캐시 추가**: 서버 재시작 후에도 같은 날짜와 같은 히트맵/일봉 입력 기준의 섹터·종목 랭킹을 빠르게 다시 열 수 있게 했다.

### Fixed
- 깨진 섹터 랭킹 캐시 파일은 무시하고 다시 계산해, 캐시 손상으로 API 응답이 실패하지 않게 했다.
```

- [ ] **Step 3: Run full relevant verification**

Run:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py tests/api/test_index_sector_rankings_route.py -q
cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/live/IndexSectorRankingPane.test.tsx src/api/indexSectorRankings.test.tsx
cd frontend && npm run build
git diff --check
```

Expected:
- Backend targeted tests PASS.
- Frontend targeted tests PASS.
- Build PASS.
- `git diff --check` prints no output.

- [ ] **Step 4: Commit**

```bash
git add VERSION CHANGELOG.md hoga/live/index_sector_rankings.py tests/unit/live/test_index_sector_rankings.py
git commit -m "chore: release index sector ranking disk cache"
```

---

## Self-Review

**Spec coverage:**  
- Fast repeated lookup across server restart: Tasks 2 and 3.  
- Current heatmap/daily correctness after input changes: Task 5.  
- Corrupt cache safety: Task 4.  
- Existing API shape preserved: no model/route response fields added.  
- Hover/click speed: memory hit remains first, disk hit becomes second, parquet scan only on miss.

**Placeholder scan:** No `TBD`, `TODO`, or unspecified “add tests” steps remain.

**Type consistency:** Helper signatures are consistent across tasks:
- `_ranking_disk_cache_path(data_dir, basis_date, heatmap_mtime_ns=..., corpus_mtime_ns=...)`
- `_read_disk_cache(path)`
- `_write_disk_cache(path, value)`
- `_cache_put_with_disk(key, disk_path, value)`

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-index-sector-ranking-disk-cache.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
