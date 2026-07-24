# Backend Measurement Harness Unblocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최종 재리뷰에서 확인된 LiveBuffer resource guard, Range 격리, evidence eligibility, full-suite 안정성 차단 문제를 제거해 성능 측정 브랜치를 안전하게 병합 가능한 상태로 만든다.

**Architecture:** LiveBuffer runner는 실제 process cgroup mount를 `/proc/self/mountinfo`로 해석하고 모든 child를 기존 제한보다 강한 RLIMIT 안에서만 실행한다. Range runner는 resolved immutable fixture의 sibling reflink clone과 clone-local DuckDB spill만 사용하며 cold/warm cache 상태를 gate에 반영한다. Manifest별 예상 slice를 명시적으로 계산해 endpoint evidence와 profiler evidence의 적격성을 검증하고, 마지막 단계에서 동시성 테스트를 시간 경계와 무관하게 만든 뒤 전체 suite를 검증한다.

**Tech Stack:** Python 3.14, pytest, argparse, resource/RLIMIT_AS, Linux procfs/cgroup v1·v2, DuckDB, FastAPI/ASGI, Pydantic, existing Ruff configuration.

## Global Constraints

- 프로덕션·사용자·저장소 기본 데이터, KIS, credentials, WebSocket, 외부 서비스에 접근하지 않는다.
- 실제 800-code benchmark와 실제 Range fixture benchmark를 실행하지 않는다.
- 기존 `live-buffer.jsonl`과 `range.jsonl` raw row를 변경하지 않는다.
- 여섯 성능 decision은 모두 기존 `NEEDS_*` 상태를 유지한다.
- source fixture는 resolve 후 immutable로 취급하고 삭제·정리·쓰기·full-copy fallback을 금지한다.
- 안전 상태를 증명할 수 없으면 실행하지 않는 fail-closed 정책을 사용한다.
- 각 Task는 RED→GREEN TDD, 변경 파일 Ruff, 독립 커밋과 리뷰를 거친다.
- 마지막 전체 suite가 green이 아니면 병합 또는 PR 단계로 진행하지 않는다.

---

## File Structure

- Modify `tools/run_live_buffer_scales.py`: mount-aware cgroup headroom, monotonic RLIMIT, safe bootstrap.
- Modify `tests/tools/test_run_live_buffer_scales.py`: v1/v2 mount mapping, malformed membership, RLIMIT, bootstrap regressions.
- Modify `hoga/duck.py`: explicit bounded DuckDB temp-directory validation remains centralized.
- Modify `hoga/api/queries.py`: optional explicit QueryEngine temp directory.
- Modify `tools/run_range_measurements.py`: resolved clone placement, clone-local spill, cache eligibility, warm semantics, streamed failure evidence.
- Modify `tests/tools/test_run_range_measurements.py`: hermeticity, cache, path, warm, failure-output regressions.
- Modify `tools/range_request_manifest.py`: expected profiler-function contract derived from manifest.
- Modify `tools/profile_live_range.py`: emit expected-function contract and production-path slice timing evidence.
- Modify `tests/tools/test_profile_live_range.py`: real bundle-condition volume-distribution coverage.
- Modify `tests/unit/live/test_stream.py`: deterministic minute-boundary concurrency test.
- Modify `docs/superpowers/measurements/2026-07-24-backend-performance/README.md`: corrected safe reproduction contract.
- Modify `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`: eligibility wording only; decision states remain unchanged.

---

### Task 1: Make LiveBuffer Resource Guard Fail Closed

**Files:**
- Modify: `tools/run_live_buffer_scales.py`
- Modify: `tests/tools/test_run_live_buffer_scales.py`

**Interfaces:**
- Consumes: `/proc/self/cgroup`, `/proc/self/mountinfo`, host `MemAvailable`, cgroup controller files, inherited `RLIMIT_AS`.
- Produces:
  - `CgroupMount(version, root, mount_point, controllers)`
  - `read_memory_headroom(...) -> MemoryHeadroom`
  - `resolve_reliable_memory_limit(requested_bytes: int) -> int | None`
  - fail-closed `run_scale_matrix(...)`

- [ ] **Step 1: Add failing mount-root mapping tests**

Add fixtures with a v2 mountinfo row whose mount root is `/docker/parent` and mount point is `/sys/fs/cgroup`, plus membership `0::/docker/parent/child`.

```python
def test_v2_membership_is_mapped_relative_to_mount_root(tmp_path: Path) -> None:
    proc_root, cgroup_root = _write_proc_and_cgroup(
        tmp_path,
        membership="0::/docker/parent/child\n",
        mountinfo=(
            "36 25 0:32 /docker/parent /sys/fs/cgroup rw - "
            "cgroup2 cgroup rw\n"
        ),
    )
    _write_v2_limit(cgroup_root / "child", limit=1_000, current=400)
    headroom = read_memory_headroom(
        proc_root=proc_root,
        cgroup_root=cgroup_root,
    )
    assert headroom.cgroup_remaining_bytes == 600
```

Also add:

- malformed readable membership → `MemoryProbeError`
- empty membership → `MemoryProbeError`
- hybrid v1 memory mount mapped through its mount root
- declared membership outside the mount root → `MemoryProbeError`

- [ ] **Step 2: Run the new cgroup tests and confirm RED**

```bash
uv run --extra dev pytest \
  tests/tools/test_run_live_buffer_scales.py \
  -k 'mount_root or malformed_membership or empty_membership or hybrid_v1' -q
```

Expected: current direct concatenation or host fallback fails the assertions.

- [ ] **Step 3: Parse process cgroup mounts explicitly**

Implement a strict mountinfo parser. Split each row at `" - "`, parse the pre-separator root/mount-point fields and post-separator filesystem/options fields, and accept only:

```text
cgroup2
cgroup with memory in super options
```

Map process membership to a controller directory only when the membership path is equal to or below the mount root. Resolve relative path components without allowing `..`. When no membership line can be mapped to a discovered memory mount, raise `MemoryProbeError`; do not probe controller-root files as a fallback.

- [ ] **Step 4: Add failing RLIMIT monotonicity and bootstrap tests**

```python
def test_apply_limit_never_raises_inherited_soft_limit(monkeypatch) -> None:
    monkeypatch.setattr(resource, "getrlimit", lambda _: (128, 512))
    seen = []
    monkeypatch.setattr(resource, "setrlimit", lambda _, value: seen.append(value))
    _apply_address_space_limit(256)
    assert seen == [(128, 512)]


def test_matrix_rejects_arbitrary_unprojected_first_scale() -> None:
    with pytest.raises(ValueError, match="first scale must be 1"):
        run_scale_matrix(
            scales=(800,),
            ticks_per_code=1_000,
            levels=10,
            retention_ms=1_000_000_000,
            output=io.StringIO(),
        )
```

Add a first-scale test proving scale `1` still receives a finite child limit before execution.

- [ ] **Step 5: Make RLIMIT and bootstrap fail closed**

`resolve_reliable_memory_limit` must return:

```python
min(requested_bytes, inherited_soft)
```

when inherited soft is finite and positive. `_apply_address_space_limit` must leave the hard limit unchanged and set the soft limit to no more than both the requested and inherited soft values. It must never increase soft or hard limits.

Require `scales[0] == 1`. Scale 1 may run without a sample-based projection only because it still receives the verified `25%` headroom RLIMIT; any other first scale is rejected before child launch.

- [ ] **Step 6: Run Task 1 verification**

```bash
uv run --extra dev pytest tests/tools/test_run_live_buffer_scales.py -q
uv run --extra dev ruff check \
  tools/run_live_buffer_scales.py \
  tests/tools/test_run_live_buffer_scales.py
git diff --check
```

Expected: all tests and Ruff pass.

- [ ] **Step 7: Commit**

```bash
git add tools/run_live_buffer_scales.py tests/tools/test_run_live_buffer_scales.py
git commit -m "fix: make live buffer resource guard fail closed"
```

---

### Task 2: Make Every Range Leg Hermetic to Its Clone

**Files:**
- Modify: `hoga/duck.py`
- Modify: `hoga/api/queries.py`
- Modify: `tools/run_range_measurements.py`
- Modify: `tests/tools/test_run_range_measurements.py`

**Interfaces:**
- `QueryEngine(data_dir: Path, *, temp_directory: Path | None = None)`
- `_run_child_command` supplies `clone_path / ".measurement" / "duckdb-tmp"`.
- `run_measurement_matrix(..., output: TextIO) -> None` streams each completed or failed row immediately.

- [ ] **Step 1: Add failing explicit DuckDB temp-directory tests**

```python
def test_query_engine_uses_explicit_clone_local_temp_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[Path | None] = []
    monkeypatch.setattr(
        queries,
        "connect_bounded",
        lambda *, temp_directory=None, **_: seen.append(temp_directory) or _fake_conn(),
    )
    engine = QueryEngine(
        tmp_path / "fixture",
        temp_directory=tmp_path / "fixture" / ".measurement" / "duckdb-tmp",
    )
    engine.close()
    assert seen == [tmp_path / "fixture" / ".measurement" / "duckdb-tmp"]
```

Add child-command tests that patch `resolve_data_dir` to raise and prove profiler, identity, and gzip legs never call it.

- [ ] **Step 2: Run the temp-directory tests and confirm RED**

```bash
uv run --extra dev pytest \
  tests/tools/test_run_range_measurements.py \
  -k 'clone_local_temp or never_resolves_default_data' -q
```

Expected: `QueryEngine` does not yet accept the explicit option or child legs reach the default resolver.

- [ ] **Step 3: Add the explicit QueryEngine seam**

Store an optional `temp_directory` on `QueryEngine` and call:

```python
self._conn = connect_bounded(temp_directory=temp_directory)
```

Keep the default `None` behavior unchanged for production call sites. In every Range measurement child, create only:

```text
clone_path / ".measurement" / "duckdb-tmp"
```

and pass it explicitly to `QueryEngine`.

- [ ] **Step 4: Add failing resolved-path and cache-state tests**

Cover:

- source argument `"."` is resolved before choosing its parent
- source argument containing lexical `..` cannot make the temp root a descendant of source
- source and nested symlinks remain rejected
- cold source with `kis-past-indicators` files yields `gate_eligible=false` and issue `cold_cache_not_empty`
- absent/empty cache remains eligible

Use only temporary synthetic directories and mocked reflink/child functions.

- [ ] **Step 5: Resolve source and enforce cache eligibility**

At entry:

```python
source_fixture = source_fixture.resolve(strict=True)
```

Create sibling temp directories using the resolved `source_fixture.parent`. Before cloning, assert the temp root is neither the source nor below it. Record the source cache state before the trial and each clone state after clone.

For a cold trial, any populated source or clone indicator cache appends `cold_cache_not_empty` to gate issues. Do not delete the cache.

- [ ] **Step 6: Add failing warm and failure-stream tests**

Warm tests must prove one warm-up invocation precedes the measured invocation inside the same child process and clone. Failure tests must pass a real `io.StringIO` output, fail the second leg, and assert the first success row plus the `CHILD_FAILED` row are already present before `ChildMeasurementError`.

- [ ] **Step 7: Implement real warm semantics and streamed output**

Change `run_measurement_matrix` to accept `output: TextIO` and print/flush each evidence row directly. On a child failure, print/flush `CHILD_FAILED`, then raise without converting the already-written evidence into an argparse-only error.

For warm trials, child code performs one unmeasured warm-up call followed by the measured call in the same process/clone and emits `warmup_runs=1`. Cold children emit `warmup_runs=0`.

- [ ] **Step 8: Run Task 2 verification**

```bash
uv run --extra dev pytest \
  tests/tools/test_run_range_measurements.py \
  tests/tools/test_profile_live_range.py -q
uv run --extra dev ruff check \
  hoga/duck.py \
  hoga/api/queries.py \
  tools/run_range_measurements.py \
  tests/tools/test_run_range_measurements.py
git diff --check
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add \
  hoga/duck.py \
  hoga/api/queries.py \
  tools/run_range_measurements.py \
  tests/tools/test_run_range_measurements.py
git commit -m "fix: isolate range measurements inside fixture clones"
```

---

### Task 3: Make Range Gate Eligibility Manifest-Aware

**Files:**
- Modify: `tools/range_request_manifest.py`
- Modify: `tools/profile_live_range.py`
- Modify: `tools/run_range_measurements.py`
- Modify: `tests/tools/test_profile_live_range.py`
- Modify: `tests/tools/test_run_range_measurements.py`
- Modify: `docs/superpowers/measurements/2026-07-24-backend-performance/README.md`
- Modify: `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`

**Interfaces:**
- `RangeRequestManifest.expected_profile_functions() -> frozenset[str]`
- profiler output field `expected_profile_functions: list[str]`
- gate issues use `f"missing_profile_function:{function_name}"` and permit an empty function map only when the expected set is empty.

- [ ] **Step 1: Add failing expected-function contract tests**

```python
def test_default_manifest_expects_no_optional_profile_functions() -> None:
    manifest = load_request_manifest(DEFAULT_MANIFEST).manifest
    assert manifest.expected_profile_functions() == frozenset()


def test_volume_manifest_requires_volume_distribution_timing() -> None:
    manifest = load_request_manifest(VOLUME_MANIFEST).manifest
    assert manifest.expected_profile_functions() == frozenset({
        "build_volume_distribution_slice",
    })
```

Add analogous assertions for ask/bid peaks, program trade, trade-volume POC, broker late entries, depth heatmap, and depth delta.

- [ ] **Step 2: Run manifest contract tests and confirm RED**

```bash
uv run --extra dev pytest \
  tests/tools/test_profile_live_range.py \
  -k expected_profile_functions -q
```

Expected: method missing.

- [ ] **Step 3: Implement the manifest-to-function mapping**

Map only enabled work:

```text
broker_late_entries_enabled -> build_broker_late_entries_slice
volume_distribution_bins != None -> build_volume_distribution_slice
trade_volume_poc_enabled -> build_trade_volume_poc_slice
ask_peaks_enabled or bid_peaks_enabled -> build_ask_bid_peak_slices
program_trade_enabled -> build_program_trade_series
depth_heatmap_enabled -> build_depth_heatmap_slice
depth_delta_enabled -> build_depth_delta_slice
```

Emit the sorted expected set in profiler and joined evidence.

- [ ] **Step 4: Replace the mocked-bundle volume test with a production-condition test**

Do not patch `build_range_bundle`. Use a synthetic `QueryEngine`/fixture seam that makes `orderflow_ok` true, patch only `build_volume_distribution_slice` with a counting wrapper around the real callable, execute the real `build_range_bundle`, and assert:

```python
assert result["functions"]["build_volume_distribution_slice"]["calls"] == 1
```

Also add a negative case where required source data is absent and assert the row is ineligible with `missing_profile_function:build_volume_distribution_slice`.

- [ ] **Step 5: Make eligibility exact**

Update `_profile_evidence_issues`:

- expected set empty + function map empty is valid
- every expected function must exist with positive calls
- unexpected timed functions are recorded but do not substitute for missing expected functions
- volume-enabled evidence cannot be gate-eligible unless the real volume function was timed

- [ ] **Step 6: Update measurement documentation**

README must state:

- frontend-default may legitimately have zero optional slice timings
- volume-enabled is eligible only with real `build_volume_distribution_slice` timing
- populated cold cache invalidates cold evidence
- all spill files stay inside the clone
- warm rows never count toward the three-cold-run gate

DECISION thresholds and all six `NEEDS_*` decisions remain unchanged.

- [ ] **Step 7: Run Task 3 verification**

```bash
uv run --extra dev pytest \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_run_range_measurements.py -q
uv run --extra dev ruff check \
  tools/range_request_manifest.py \
  tools/profile_live_range.py \
  tools/run_range_measurements.py \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_run_range_measurements.py
rg -n 'NEEDS_' \
  docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md
git diff --check
```

Expected: tests/Ruff pass and the six pending decision rows remain pending.

- [ ] **Step 8: Commit**

```bash
git add \
  tools/range_request_manifest.py \
  tools/profile_live_range.py \
  tools/run_range_measurements.py \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_run_range_measurements.py \
  docs/superpowers/measurements/2026-07-24-backend-performance/README.md \
  docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md
git commit -m "fix: enforce manifest-aware range evidence gates"
```

---

### Task 4: Stabilize Regression Test and Re-verify the Branch

**Files:**
- Modify: `tests/unit/live/test_stream.py`
- Modify: `docs/superpowers/measurements/2026-07-24-backend-performance/README.md`
- Verify: every Python and documentation file changed by Tasks 1-3.

**Interfaces:**
- Consumes: completed Task 1-3 commits.
- Produces: deterministic concurrency regression, green focused/full suites, final verification record.

- [ ] **Step 1: Make the minute-boundary failure reproducible**

Add a RED regression demonstrating that the current test clock can cross a minute boundary and invoke the patched append twice. The test must not change `LiveStream` production behavior.

- [ ] **Step 2: Pin the concurrency test to a non-boundary timestamp**

Replace wall-clock derivation in `test_flush_preserves_tick_arriving_during_append` with:

```python
now = 1_780_617_600_000
```

Ensure the chosen timestamp and the `+20_000ms` flush remain within one minute-candle interval for the test's configured date. Make `slow_append` inject only for the fill append being tested:

```python
if any(snapshot.kind == SnapshotKind.FILL for snapshot in snaps):
    await stream.on_tick(_trade_tick(now + 5_000, qty=3, side=1))
```

Assert the second flush records exactly one preserved `buy_qty == 3`.

- [ ] **Step 3: Run focused verification**

```bash
uv run --extra dev pytest \
  tests/tools/test_run_live_buffer_scales.py \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_run_range_measurements.py \
  tests/unit/api/test_request_timing.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py \
  tests/unit/live/test_stream.py::test_flush_preserves_tick_arriving_during_append \
  -q
```

Expected: all pass.

- [ ] **Step 4: Run changed-file Ruff**

```bash
uv run --extra dev ruff check \
  tools/run_live_buffer_scales.py \
  tools/range_request_manifest.py \
  tools/profile_live_range.py \
  tools/run_range_measurements.py \
  hoga/duck.py \
  hoga/api/queries.py \
  tests/tools/test_run_live_buffer_scales.py \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_run_range_measurements.py \
  tests/unit/live/test_stream.py
```

Expected: pass.

- [ ] **Step 5: Run the full backend suite once**

```bash
uv run --extra dev pytest -q
```

Expected: all collected tests pass with only the existing non-failing warning baseline.

- [ ] **Step 6: Audit artifacts and claims**

```bash
jq -e -c '.' \
  docs/superpowers/measurements/2026-07-24-backend-performance/live-buffer.jsonl \
  docs/superpowers/measurements/2026-07-24-backend-performance/range.jsonl
git diff --exit-code fffd3715 -- \
  docs/superpowers/measurements/2026-07-24-backend-performance/live-buffer.jsonl \
  docs/superpowers/measurements/2026-07-24-backend-performance/range.jsonl
rg -n 'KIS_APP|KIS_SECRET|Authorization|Bearer|/home/|Cookie' \
  docs/superpowers/measurements/2026-07-24-backend-performance
git diff --check
git status --short
```

Expected: JSON parses, raw rows are unchanged, no secrets/absolute user paths, no whitespace or temporary files.

- [ ] **Step 7: Update final verification record**

Append the new commit-under-test, focused/full counts, Ruff result, raw-row preservation, and six pending decisions to README. Do not claim a latency, throughput, or user-visible improvement.

- [ ] **Step 8: Commit**

```bash
git add \
  tests/unit/live/test_stream.py \
  docs/superpowers/measurements/2026-07-24-backend-performance/README.md
git commit -m "test: finalize backend harness safety verification"
```

---

## Completion Criteria

- LiveBuffer never uses an unverified cgroup root, never raises inherited RLIMIT, and never starts an arbitrary unprojected first scale.
- Range cold evidence uses only resolved sibling reflink clones, clone-local DuckDB spill, empty initial indicator cache, and fresh processes.
- Warm evidence performs an actual warm-up and cannot enter the cold gate.
- Child failures remain visible as JSONL even when the CLI exits nonzero.
- Default manifest with no optional work is eligible without fake timings.
- Volume-enabled evidence is ineligible unless the production execution path times `build_volume_distribution_slice`.
- Raw measurements and all six `NEEDS_*` decisions remain unchanged.
- Focused tests, changed-file Ruff, and the full backend suite are green.
