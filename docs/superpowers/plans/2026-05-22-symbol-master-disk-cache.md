# Symbol Master Disk Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple pykrx from the boot/GET paths by persisting the Symbol Master catalog to `~/.local/share/hoga-ops/symbol-master.json`, making `POST /api/symbols/refresh` the sole pykrx entry point.

**Architecture:** Backend `hoga/api/symbols.py` gains private disk I/O helpers (`_load_from_disk` / `_write_to_disk` with atomic temp→rename), a new `load_disk_state()` boot entry point, and a simplified `get_all()` that is pure in-memory read. The `ensure_cache_warm` lifespan path and 24h TTL are deleted. Frontend adds a Settings page section + an empty-result staleness nudge in SymbolSearch.

**Tech Stack:**
- Backend: Python 3.11+, FastAPI, pytest, pykrx 1.2.8
- Frontend: React + TypeScript + Vite, React Query, vitest
- Storage: JSON at `~/.local/share/hoga-ops/symbol-master.json` (XDG)
- Domain: ADR-0006 single-module pattern, ADR-0009 UpstreamCode mirror discipline, ADR-0015 (this feature's structural decisions)

**Spec:** `docs/superpowers/specs/2026-05-22-symbol-master-disk-cache-design.md`

---

## File Structure

**Backend (modified):**
- `hoga/api/error_codes.py` — add `UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED`
- `hoga/api/models.py` — add `SymbolMasterInfo` model
- `hoga/config.py` — add `resolve_symbol_master_path()`
- `hoga/api/symbols.py` — major restructure: disk I/O helpers, `load_disk_state()`, simplified `get_all()`, `refresh()` + `_do_refresh()`, pykrx 1.2.8 fix, `/info` route, delete `ensure_cache_warm`/TTL
- `hoga/api/app.py` — lifespan wires `load_disk_state` instead of `ensure_cache_warm`

**Backend (tests):**
- `tests/api/test_symbols.py` — extended with disk I/O round-trip, atomic write, schema validation, lifecycle, concurrency
- `tests/test_config.py` — extended (or created) for `resolve_symbol_master_path`

**Frontend (modified):**
- `frontend/src/api/types.ts` — add `SymbolMasterInfo` + `UpstreamCode` new value
- `frontend/src/api/symbols.ts` — add `getSymbolMasterInfo`
- `frontend/src/api/upstream-hints.ts` — add new key to 4 existing maps + new `symbolMasterSettingsHints` map
- `frontend/src/pages/Settings.tsx` — add `SymbolMasterSection`
- `frontend/src/capture/SymbolSearch.tsx` — add 7-day empty-result staleness nudge

**Frontend (tests):**
- `frontend/src/pages/Settings.test.tsx` — new
- `frontend/src/capture/SymbolSearch.test.tsx` — new or extended

---

## Conventions

- **Korean comments only when explaining WHY**, never WHAT (CLAUDE.md guidance).
- **TDD strict**: every task that adds behavior writes a failing test first.
- **Atomic commits**: one commit per task. Commit message format follows recent history: `feat(symbols): ...`, `refactor(symbols): ...`, `fix(symbols): ...`.
- **Test reset**: `tests/conftest.py` already has autouse fixture calling `reset_state_for_tests()` (see commit history). New tasks update `reset_state_for_tests` to clear all module-level state.
- **DRY**: hint maps share the same `UpstreamCode` keys via TypeScript exhaustive checking.
- **YAGNI**: no env-vars beyond `HOGA_DATA_DIR` (existing), no `symbol_store.py` extraction, no SSE-driven breakdown updates.

---

## Pre-flight

### Task 0: Close incomplete `TabSelection.timeframe` + `Draft.timeframe` call-sites; cast Workarea bundle

**Why this task exists:** `plan-eng-review` surfaced pre-existing TypeScript errors unrelated to Symbol Master:
- 1 `SessionBundle → RangeBundle` mismatch (`Workarea.tsx:46`) — ADR-0013 migration's tail (state/tabs.ts:29 comment: "Tasks 15-17 update Workarea/Panes"). The full migration touches 6+ chart components, so it's out of scope for this PR (D6 decision). A temporary `as unknown as RangeBundle` cast keeps the build green while ADR-0013's full migration ships in its own PR.
- `@testing-library/jest-dom` matchers (`toBeInTheDocument`, `toHaveAttribute`, `toBeEmptyDOMElement`) work at runtime via `tests/setup.ts` import but are not in `tsconfig.app.json`'s `types`, so `tsc -b` rejects 7+ assertions across `RangeAdjustmentNotice.test.tsx`, `TimeframeSelector.test.tsx`, `Toolbar.test.tsx`. Our own T15/T16 test files use the same matchers — without this fix our tests cannot type-check.

(Earlier 3 `timeframe` errors in Toolbar/Inventory were already fixed in commit `308af95` "fix(state/toolbarDraft): setDraft accepts Partial<Draft>". No work needed there.)

Without this task, `npx tsc -b` is permanently red, and our T12 mirror-discipline exhaustive check cannot distinguish our new errors from the pre-existing baseline.

**Files:**
- Modify: `frontend/src/replay/Workarea.tsx:46`
- Modify: `frontend/tsconfig.app.json` (add jest-dom to `types`)

- [ ] **Step 1: Confirm the baseline is broken**

Run: `cd frontend && npx tsc -b 2>&1`
Expected error categories: (a) `RangeAdjustmentNotice.test.tsx`, `TimeframeSelector.test.tsx`, `Toolbar.test.tsx` complaining about `toBeInTheDocument` / `toHaveAttribute` / `toBeEmptyDOMElement` (jest-dom matcher types missing); (b) `Workarea.tsx:46` SessionBundle → RangeBundle. If fewer errors appear, the baseline may have shifted — review the new error list before continuing.

- [ ] **Step 2: Add jest-dom to TypeScript types**

Edit `frontend/tsconfig.app.json`. Find the `"types"` field (currently `["vite/client"]`) and add `@testing-library/jest-dom`:

```json
"types": ["vite/client", "@testing-library/jest-dom"],
```

This brings the matcher type declarations into `tsc -b`'s view. Runtime registration is already handled by `tests/setup.ts` (`import '@testing-library/jest-dom/vitest'`); this is purely a compile-time fix.

- [ ] **Step 3: Add the temporary cast for Workarea**

Edit `frontend/src/replay/Workarea.tsx:46`. Replace:

```tsx
useTabsStore.getState().putBundle(tab.id, date, session);
```

with:

```tsx
// TODO(ADR-0013): Workarea still consumes useSession (SessionBundle); the
// store + chart pipeline now type bundles as RangeBundle. Runtime fields
// overlap (both expose `candles`, `quote_ratio`, etc.) so the cast is safe
// at runtime, but a follow-up PR must replace useSession with useRange and
// migrate ChartStage Props to RangeBundle. Remove this cast then.
useTabsStore.getState().putBundle(tab.id, date, session as unknown as RangeBundle);
```

Add the import at the top of the file (next to the existing `useSession` import):

```tsx
import type { RangeBundle } from '../api/types';
```

- [ ] **Step 4: Verify the build is clean**

Run: `cd frontend && rm -rf node_modules/.tmp && npx tsc -b 2>&1; echo "EXIT:$?"`
Expected: no error lines, `EXIT:0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/tsconfig.app.json frontend/src/replay/Workarea.tsx
git commit -m "fix(frontend): jest-dom types + Workarea ADR-0013 cast (pre-flight baseline)"
```

Commit message scope intentionally uses `fix(frontend)` not `feat(symbols)` — this task is hygiene unrelated to Symbol Master.

---

## Backend Tasks

### Task 1: Add `UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED`

**Files:**
- Modify: `hoga/api/error_codes.py`
- Test: `tests/api/test_error_codes.py` (create if missing) or inline import test

- [ ] **Step 1: Write the failing test**

Create or extend `tests/api/test_error_codes.py`:

```python
from hoga.api.error_codes import UpstreamCode


def test_symbol_master_not_initialized_value():
    assert UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED.value == "symbol_master_not_initialized"


def test_symbol_master_not_initialized_in_upstream_code():
    assert "symbol_master_not_initialized" in {v.value for v in UpstreamCode}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_error_codes.py -v`
Expected: FAIL with `AttributeError: SYMBOL_MASTER_NOT_INITIALIZED`

- [ ] **Step 3: Add the enum value**

Edit `hoga/api/error_codes.py`. Find the `class UpstreamCode(StrEnum):` block (existing) and add the new value at the end:

```python
class UpstreamCode(StrEnum):
    # ... existing values ...
    SYMBOL_MASTER_NOT_INITIALIZED = "symbol_master_not_initialized"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_error_codes.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/error_codes.py tests/api/test_error_codes.py
git commit -m "feat(error_codes): add UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED (ADR-0015)"
```

---

### Task 2: Add `SymbolMasterInfo` model

**Files:**
- Modify: `hoga/api/models.py`
- Test: `tests/api/test_models.py` (create if missing)

- [ ] **Step 1: Write the failing test**

```python
from hoga.api.models import SymbolMasterInfo
from hoga.api.error_codes import UpstreamCode


def test_symbol_master_info_minimal():
    info = SymbolMasterInfo(count=0, fetched_at_ms=None, status="unavailable", reason=None)
    assert info.count == 0
    assert info.fetched_at_ms is None
    assert info.status == "unavailable"
    assert info.reason is None


def test_symbol_master_info_with_reason():
    info = SymbolMasterInfo(
        count=0,
        fetched_at_ms=None,
        status="unavailable",
        reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED,
    )
    assert info.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_symbol_master_info_populated():
    info = SymbolMasterInfo(count=6012, fetched_at_ms=1747900000000, status="fresh", reason=None)
    assert info.count == 6012
    assert info.status == "fresh"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_models.py -v`
Expected: FAIL with `ImportError: cannot import name 'SymbolMasterInfo'`

- [ ] **Step 3: Add the model**

Edit `hoga/api/models.py`. After the existing `SymbolsAllResponse` definition, add:

```python
class SymbolMasterInfo(BaseModel):
    """Lightweight metadata for the Settings page — no entries payload."""
    count: int
    fetched_at_ms: int | None
    status: Literal["loading", "fresh", "stale", "unavailable"]
    reason: UpstreamCode | None = None
```

Verify `UpstreamCode` and `Literal` are already imported at the top of the file; if not, add the imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_models.py
git commit -m "feat(models): add SymbolMasterInfo for /api/symbols/info (ADR-0015)"
```

---

### Task 3: Add `resolve_symbol_master_path()` to `hoga/config.py`

**Files:**
- Modify: `hoga/config.py`
- Test: `tests/test_config.py` (create or extend)

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path
from hoga.config import resolve_symbol_master_path


def test_xdg_data_home_set(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    result = resolve_symbol_master_path()
    assert result == tmp_path / "hoga-ops" / "symbol-master.json"


def test_xdg_data_home_unset(monkeypatch):
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    result = resolve_symbol_master_path()
    assert result == Path.home() / ".local" / "share" / "hoga-ops" / "symbol-master.json"


def test_hoga_data_dir_does_not_affect_symbol_master_path(monkeypatch, tmp_path):
    """HOGA_DATA_DIR is for capture data only — Symbol Master path is sibling, not child."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path / "sandbox"))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    result = resolve_symbol_master_path()
    assert "sandbox" not in str(result)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/test_config.py::test_xdg_data_home_set -v`
Expected: FAIL with `ImportError: cannot import name 'resolve_symbol_master_path'`

- [ ] **Step 3: Implement the function**

Edit `hoga/config.py`. Add below the existing `resolve_data_dir()` function:

```python
def resolve_symbol_master_path() -> Path:
    """Return the canonical path for the persisted Symbol Master JSON.

    Resolution order:
      1. ``$XDG_DATA_HOME/hoga-ops/symbol-master.json`` if XDG_DATA_HOME is set.
      2. ``~/.local/share/hoga-ops/symbol-master.json`` — XDG default.

    Sibling of resolve_data_dir() but NOT inside data/. HOGA_DATA_DIR overrides
    do not apply — the Symbol Master is a machine-global KRX catalog, not
    capture data. Tests sandbox via monkeypatch on this function directly.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hoga-ops" / "symbol-master.json"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/test_config.py -v`
Expected: PASS (all three)

- [ ] **Step 5: Commit**

```bash
git add hoga/config.py tests/test_config.py
git commit -m "feat(config): add resolve_symbol_master_path() (XDG, machine-global, ADR-0015)"
```

---

### Task 4: Add disk I/O helpers (`SCHEMA_VERSION`, `_load_from_disk`, `_write_to_disk`)

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/api/test_symbols.py`

- [ ] **Step 1: Write the failing tests for round-trip**

Add to `tests/api/test_symbols.py`:

```python
import json
from pathlib import Path

from hoga.api import symbols as symbols_module
from hoga.api.models import SymbolHit


def _make_hit(code: str, name: str, market: str = "KOSPI") -> SymbolHit:
    return SymbolHit(
        code=code,
        name=name,
        market=market,  # type: ignore[arg-type]
        captured_count=0,
        captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
    )


def test_disk_round_trip(tmp_path):
    path = tmp_path / "symbol-master.json"
    entries = [_make_hit("005930", "삼성전자"), _make_hit("000660", "SK하이닉스")]
    symbols_module._write_to_disk(path, entries, fetched_at_ms=1747900000000)

    result = symbols_module._load_from_disk(path)
    assert result is not None
    loaded, fetched_at_ms = result
    assert fetched_at_ms == 1747900000000
    assert [(h.code, h.name, h.market) for h in loaded] == [
        ("005930", "삼성전자", "KOSPI"),
        ("000660", "SK하이닉스", "KOSPI"),
    ]


def test_load_missing_file_returns_none(tmp_path):
    assert symbols_module._load_from_disk(tmp_path / "absent.json") is None


def test_load_corrupt_json_returns_none(tmp_path):
    path = tmp_path / "corrupt.json"
    path.write_text("{ this is not valid json", encoding="utf-8")
    assert symbols_module._load_from_disk(path) is None


def test_load_wrong_schema_version_returns_none(tmp_path):
    path = tmp_path / "wrong-version.json"
    path.write_text(
        json.dumps({"schema_version": 999, "fetched_at_ms": 1, "entries": []}),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_load_missing_entries_array_returns_none(tmp_path):
    path = tmp_path / "no-entries.json"
    path.write_text(
        json.dumps({"schema_version": 1, "fetched_at_ms": 1}),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_load_malformed_entry_returns_none(tmp_path):
    path = tmp_path / "bad-entry.json"
    path.write_text(
        json.dumps({
            "schema_version": 1,
            "fetched_at_ms": 1,
            "entries": [{"code": "005930"}],  # missing name and market
        }),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_write_strips_captured_breakdown(tmp_path):
    path = tmp_path / "sm.json"
    hit = _make_hit("005930", "삼성전자")
    hit.captured_count = 99
    hit.captured_breakdown = {"complete": 99, "source_partial": 0, "client_incomplete": 0}
    symbols_module._write_to_disk(path, [hit], fetched_at_ms=1)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert "captured_count" not in payload["entries"][0]
    assert "captured_breakdown" not in payload["entries"][0]
    assert set(payload["entries"][0].keys()) == {"code", "name", "market"}


def test_write_creates_parent_dir(tmp_path):
    path = tmp_path / "nested" / "deeper" / "sm.json"
    symbols_module._write_to_disk(path, [_make_hit("005930", "삼성전자")], fetched_at_ms=1)
    assert path.exists()


def test_atomic_write_rollback_on_replace_failure(tmp_path, monkeypatch):
    path = tmp_path / "sm.json"
    symbols_module._write_to_disk(path, [_make_hit("005930", "기존")], fetched_at_ms=1)
    original_content = path.read_text(encoding="utf-8")

    def fail_replace(_src, _dst):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("os.replace", fail_replace)
    try:
        symbols_module._write_to_disk(path, [_make_hit("000660", "신규")], fetched_at_ms=2)
    except OSError:
        pass

    assert path.read_text(encoding="utf-8") == original_content
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/api/test_symbols.py -v -k "disk or load_missing or corrupt or schema or malformed or write or atomic"`
Expected: FAIL with `AttributeError: module 'hoga.api.symbols' has no attribute '_load_from_disk'`

- [ ] **Step 3: Implement the helpers**

Edit `hoga/api/symbols.py`. Add imports at the top (if not present):

```python
import json
import logging
import os
import tempfile

logger = logging.getLogger(__name__)
```

Add new module-level constant near the existing `_CACHE_TTL_MS` (will be removed in Task 5):

```python
SCHEMA_VERSION = 1
```

Add the two helper functions below the existing `reset_state_for_tests` block. Note: every `None` return path emits a `logger.warning` so developers can diagnose disk-corruption events (ADR-0015 explicitly states corruption is surfaced via server logs):

```python
def _load_from_disk(path: Path) -> tuple[list[SymbolHit], int] | None:
    """Read the Symbol Master file. Return (entries, fetched_at_ms) or None.

    Returns None when:
      - the file does not exist (no log; this is the first-boot normal path),
      - the JSON cannot be parsed,
      - schema_version is missing or != SCHEMA_VERSION,
      - the entries array is missing or malformed.

    Every failure path other than "file absent" emits a logger.warning so
    developers can diagnose disk-corruption events without user reporting.
    Per ADR-0015 (consequences): "corruption is diagnosed via server logs."

    captured_breakdown is NOT populated here — load_disk_state fills it from
    the data_dir walk.
    """
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Symbol Master disk file unreadable at %s: %s", path, e)
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        logger.warning(
            "Symbol Master disk file schema mismatch at %s (got %r, expected %d)",
            path, payload.get("schema_version") if isinstance(payload, dict) else None, SCHEMA_VERSION,
        )
        return None
    raw_entries = payload.get("entries")
    fetched_at_ms = payload.get("fetched_at_ms")
    if not isinstance(raw_entries, list) or not isinstance(fetched_at_ms, int):
        logger.warning(
            "Symbol Master disk file missing/malformed entries or fetched_at_ms at %s",
            path,
        )
        return None
    try:
        entries = [
            SymbolHit(
                code=e["code"],
                name=e["name"],
                market=e["market"],
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
            )
            for e in raw_entries
        ]
    except (KeyError, TypeError) as e:
        logger.warning(
            "Symbol Master disk file has malformed entry at %s: %s", path, e,
        )
        return None
    return entries, fetched_at_ms


def _write_to_disk(path: Path, entries: list[SymbolHit], fetched_at_ms: int) -> None:
    """Atomically persist the catalog. Creates parent dir if needed.

    Atomicity: temp file in target's parent + os.replace. captured_breakdown
    fields are stripped — disk file holds KRX-side data only.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "fetched_at_ms": fetched_at_ms,
        "source": "pykrx",
        "entries": [
            {"code": e.code, "name": e.name, "market": e.market}
            for e in entries
        ],
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)
```

- [ ] **Step 4: Run disk-I/O tests to verify they pass**

Run: `uv run --extra dev pytest tests/api/test_symbols.py -v -k "disk or load_missing or corrupt or schema or malformed or write or atomic"`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "feat(symbols): private disk I/O helpers + schema v1 (ADR-0015)"
```

---

### Task 5: Delete TTL machinery and `ensure_cache_warm`

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/api/test_symbols.py` (existing tests for `_is_fresh`, `invalidate_cache_for_tests`, `ensure_cache_warm` must go)

This is a destructive task — it removes machinery the next tasks replace. Tests that reference the deleted symbols must be removed in this commit too, otherwise the test suite breaks.

- [ ] **Step 1: Find all test references to deleted symbols**

Run: `grep -rn "ensure_cache_warm\|_is_fresh\|_CACHE_TTL_MS\|invalidate_cache_for_tests" tests/ hoga/`
Expected: a handful of references in `tests/api/test_symbols.py` and `hoga/api/app.py`.

- [ ] **Step 2: Delete the four symbols from `hoga/api/symbols.py`**

Remove these declarations entirely:

```python
_CACHE_TTL_MS = 24 * 60 * 60 * 1000  # delete this line
```

```python
def invalidate_cache_for_tests() -> None:  # delete this entire function
    ...
```

```python
def _is_fresh() -> bool:  # delete this entire function
    ...
```

```python
async def ensure_cache_warm(data_dir: Path) -> None:  # delete this entire function
    ...
```

Also remove the `_is_fresh()` calls inside `get_all()` (those calls will be replaced in Task 7).

- [ ] **Step 3: Delete corresponding tests in `tests/api/test_symbols.py`**

Remove any test functions that call `ensure_cache_warm`, `invalidate_cache_for_tests`, `_is_fresh`, or reference `_CACHE_TTL_MS`. Use grep output from Step 1 as the checklist.

- [ ] **Step 4: Verify the suite still collects (will not pass yet — `get_all` is half-broken)**

Run: `uv run --extra dev pytest tests/api/test_symbols.py --collect-only 2>&1 | head -30`
Expected: collection succeeds (no `AttributeError` on imports). Some tests may now fail at runtime because `get_all()` references `_is_fresh` — that is expected and fixed in Task 7. Do **not** run the full suite yet.

- [ ] **Step 5: Commit (intentional broken-state checkpoint)**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "refactor(symbols): delete TTL + ensure_cache_warm (precursor to disk cache)"
```

Note: this commit intentionally leaves `get_all()` broken (it still references `_is_fresh`). Task 6 and Task 7 follow in the same PR and the suite is green again at the end of Task 7. This is acceptable because PRs are reviewed as a unit; mid-PR commits are not required to pass tests.

---

### Task 6: Add `load_disk_state()` boot entry point

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/api/test_symbols.py`

- [ ] **Step 1: Update `reset_state_for_tests`**

Edit `reset_state_for_tests()` in `hoga/api/symbols.py` to also clear `_fetched_at_ms` if it wasn't already (verify the existing implementation — current version at line 70 does clear it). No code change if already correct; verify and move on.

- [ ] **Step 2: Write the failing tests**

Add to `tests/api/test_symbols.py`:

```python
import json

from hoga.api import symbols as symbols_module
from hoga.api.error_codes import UpstreamCode


def test_load_disk_state_no_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "absent.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert symbols_module._cache == []
    assert symbols_module._fetched_at_ms is None
    assert symbols_module._state.status == "unavailable"
    assert symbols_module._state.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_load_disk_state_corrupt_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "corrupt.json"
    path.write_text("not json", encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert symbols_module._state.status == "unavailable"
    assert symbols_module._state.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_load_disk_state_valid_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "sm.json"
    path.write_text(
        json.dumps({
            "schema_version": 1,
            "fetched_at_ms": 1747900000000,
            "source": "pykrx",
            "entries": [
                {"code": "005930", "name": "삼성전자", "market": "KOSPI"},
                {"code": "000660", "name": "SK하이닉스", "market": "KOSPI"},
            ],
        }),
        encoding="utf-8",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert len(symbols_module._cache) == 2
    assert symbols_module._cache[0].code == "005930"
    assert symbols_module._cache[0].name == "삼성전자"
    assert symbols_module._fetched_at_ms == 1747900000000
    assert symbols_module._state.status == "fresh"
    assert symbols_module._state.reason is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/api/test_symbols.py::test_load_disk_state_no_file tests/api/test_symbols.py::test_load_disk_state_corrupt_file tests/api/test_symbols.py::test_load_disk_state_valid_file -v`
Expected: FAIL with `AttributeError: module 'hoga.api.symbols' has no attribute 'load_disk_state'`

- [ ] **Step 4: Implement `load_disk_state`**

Add to `hoga/api/symbols.py` (below the disk helpers added in Task 4):

```python
def load_disk_state(*, path: Path, data_dir: Path) -> None:
    """Boot-time entry: populate in-memory state from disk + data_dir walk.

    No pykrx, no network — pure disk read. Called once from lifespan startup.
    """
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    result = _load_from_disk(path)
    if result is None:
        _cache = []
        _fetched_at_ms = None
        _state = SymbolCacheState.unavailable(reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED)
        return
    entries, fetched_at_ms = result
    breakdowns = _build_all_captured_breakdowns(data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in entries:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = entries
    _fetched_at_ms = fetched_at_ms
    _state = SymbolCacheState.fresh()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/api/test_symbols.py::test_load_disk_state_no_file tests/api/test_symbols.py::test_load_disk_state_corrupt_file tests/api/test_symbols.py::test_load_disk_state_valid_file -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "feat(symbols): load_disk_state boot entry (replaces ensure_cache_warm)"
```

---

### Task 7: Simplify `get_all()` to a pure memory read

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/api/test_symbols.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_symbols.py`:

```python
import pytest


async def _patch_fetch_to_raise(monkeypatch):
    async def _boom():
        raise AssertionError("get_all() must not trigger pykrx fetch")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _boom)


@pytest.mark.asyncio
async def test_get_all_does_not_trigger_fetch_when_empty(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    await _patch_fetch_to_raise(monkeypatch)
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.get_all(data_dir=data_dir)

    assert resp.symbols == []
    assert resp.status == "unavailable"
    assert resp.fetched_at_ms is None


@pytest.mark.asyncio
async def test_get_all_returns_cached_entries(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    await _patch_fetch_to_raise(monkeypatch)
    # Pre-populate state via load_disk_state with a valid file.
    path = tmp_path / "sm.json"
    path.write_text(
        json.dumps({
            "schema_version": 1,
            "fetched_at_ms": 99,
            "source": "pykrx",
            "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
        }),
        encoding="utf-8",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    resp = await symbols_module.get_all(data_dir=data_dir)

    assert len(resp.symbols) == 1
    assert resp.status == "fresh"
    assert resp.fetched_at_ms == 99
```

- [ ] **Step 2: Run tests to verify they fail (or error on _is_fresh reference)**

Run: `uv run --extra dev pytest tests/api/test_symbols.py::test_get_all_does_not_trigger_fetch_when_empty tests/api/test_symbols.py::test_get_all_returns_cached_entries -v`
Expected: FAIL with `AttributeError: module 'hoga.api.symbols' has no attribute '_is_fresh'` (since Task 5 deleted it).

- [ ] **Step 3: Replace `get_all()` body**

In `hoga/api/symbols.py`, replace the entire body of `get_all()` with a pure read:

```python
async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    """Return the in-memory Symbol Master.

    Pure read — no fetching, no locking, no Future. Boot already populated
    _cache via load_disk_state(); explicit refresh via POST /api/symbols/refresh
    is the only mutation entry point.

    data_dir is preserved in the signature for backwards-compat with existing
    route wiring; it is unused on the read path.
    """
    del data_dir  # unused — kept for route-handler signature compatibility
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/api/test_symbols.py -v`
Expected: all PASS (or at minimum the get_all tests pass; refresh tests may be next).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "refactor(symbols): get_all is now a pure memory read (no fetch trigger)"
```

---

### Task 8: Restructure `refresh()` + add `_do_refresh()`

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/api/test_symbols.py`

- [ ] **Step 1: Write the failing tests (happy-path + concurrent dedupe + failure)**

Add to `tests/api/test_symbols.py`:

```python
@pytest.mark.asyncio
async def test_refresh_happy_path(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")

    async def _fake_fetch():
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _fake_fetch)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert path.exists(), "disk file must be written on success"
    assert len(resp.symbols) == 1
    assert resp.status == "fresh"
    assert resp.reason is None
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert len(payload["entries"]) == 1


@pytest.mark.asyncio
async def test_refresh_missing_creds(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    async def _must_not_call():
        raise AssertionError("pykrx must not be called when creds missing")

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _must_not_call)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    assert resp.status == "unavailable"
    assert not path.exists(), "no disk write when creds missing"


@pytest.mark.asyncio
async def test_refresh_pykrx_failure_preserves_disk(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    # First successful refresh creates a disk file.
    async def _ok():
        return [_make_hit("005930", "삼성전자")]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)
    await symbols_module.refresh(path=path, data_dir=data_dir)
    original_content = path.read_text(encoding="utf-8")

    # Second refresh fails — disk must be unchanged.
    async def _boom():
        raise RuntimeError("KRX down")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _boom)
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED
    assert resp.status == "stale", "cache populated → state is stale, not unavailable"
    assert path.read_text(encoding="utf-8") == original_content


@pytest.mark.asyncio
async def test_refresh_concurrent_dedupe(tmp_path, monkeypatch):
    """Two simultaneous refresh calls collapse to one pykrx fetch."""
    import asyncio

    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")
    call_count = 0

    async def _slow():
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.05)
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _slow)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    results = await asyncio.gather(
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
    )

    assert call_count == 1, "concurrent refreshes must dedupe to one fetch"
    for r in results:
        assert r.status == "fresh"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/api/test_symbols.py -v -k refresh`
Expected: FAIL — current `refresh()` signature does not accept `path=`, and the old `_do_fetch_and_populate` doesn't write to disk.

- [ ] **Step 3: Replace `refresh()` and add `_do_refresh()`**

In `hoga/api/symbols.py`, remove the existing `_do_fetch_and_populate` and `refresh` functions. Replace with:

```python
async def refresh(*, path: Path, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — the only pykrx entry point.

    Concurrency: _lock + _inflight Future dedupe concurrent refresh clicks
    (Settings + SymbolSearch may fire together). load_env(override=True) and
    the disk write share the lock so .env hot-reload, fetch result, and disk
    file all align.

    Failure semantics: pykrx exception → disk file unchanged, memory state
    stale (if cache populated) or unavailable.
    """
    global _state, _inflight  # noqa: PLW0603
    async with _lock:
        if _inflight is not None:
            fut = _inflight
        else:
            load_env(override=True)
            if not krx_creds_present():
                _state = (
                    SymbolCacheState.stale(reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
                    if _cache
                    else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
                )
                return SymbolsAllResponse(
                    symbols=list(_cache),
                    status=_state.status,
                    fetched_at_ms=_fetched_at_ms,
                    reason=_state.reason,
                )
            _state = SymbolCacheState.loading()
            loop = asyncio.get_running_loop()
            _inflight = loop.create_future()
            fetch_task = asyncio.create_task(_do_refresh(path=path, data_dir=data_dir))

            def _signal(_t: asyncio.Task) -> None:
                if _inflight is not None and not _inflight.done():
                    _inflight.set_result(None)

            fetch_task.add_done_callback(_signal)
            fut = _inflight
    await fut
    async with _lock:
        _inflight = None
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )


async def _do_refresh(*, path: Path, data_dir: Path) -> None:
    """Inner refresh routine — runs under in-flight Future protection."""
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    try:
        entries = await _fetch_from_pykrx()
    except Exception:  # noqa: BLE001 — pykrx failure path
        _state = (
            SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
            if _cache
            else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_FETCH_FAILED)
        )
        return
    now_ms = int(time.time() * 1000)
    try:
        _write_to_disk(path, entries, now_ms)
    except OSError:
        _state = (
            SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
            if _cache
            else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_FETCH_FAILED)
        )
        return
    loop = asyncio.get_running_loop()
    breakdowns = await loop.run_in_executor(None, _build_all_captured_breakdowns, data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in entries:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = entries
    _fetched_at_ms = now_ms
    _state = SymbolCacheState.fresh()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/api/test_symbols.py -v -k refresh`
Expected: PASS (all four)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "feat(symbols): refresh writes disk + dedupes concurrent clicks (ADR-0015)"
```

---

### Task 9: Fix `_fetch_from_pykrx` for pykrx 1.2.8

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: manual smoke (no unit test for pykrx itself — network dependency)

Investigate pykrx 1.2.8's actual function signatures first; the spec leaves the exact function choice to this task.

- [ ] **Step 1: Verify pykrx 1.2.8 column shapes via REPL**

Run (requires KRX_ID/KRX_PW in env):

```bash
uv run python -c "
from pykrx import stock
import time
today = time.strftime('%Y%m%d')
df = stock.get_market_cap(today, market='KOSPI')
print('get_market_cap columns:', list(df.columns))
print('sample index:', df.index[:3].tolist())

# Try alternative function that might include 종목명
try:
    df2 = stock.get_market_fundamental(today, market='KOSPI')
    print('get_market_fundamental columns:', list(df2.columns))
except Exception as e:
    print('fundamental failed:', e)

names = [stock.get_market_ticker_name(c) for c in df.index[:5]]
print('ticker names sample:', names)
"
```

Note the output. Decision rule:
- If any single-call DataFrame returns both `(code, name)` together → use that function.
- Otherwise → fall back to `get_market_ticker_list` + per-code `get_market_ticker_name` via `ThreadPoolExecutor`.

- [ ] **Step 2: Replace `_fetch_from_pykrx` based on Step 1's findings**

Two implementation variants — pick based on Step 1. Write the one that matches:

**Variant A** (single-call DataFrame has both columns; e.g., if `get_market_fundamental` returns `종목명`):

```python
async def _fetch_from_pykrx() -> list[SymbolHit]:
    """Verified against pykrx 1.2.8 in Task 9 Step 1.

    Returns one SymbolHit per KOSPI + KOSDAQ listing. All-or-nothing:
    any per-market failure raises and aborts the entire fetch.
    """
    from pykrx import stock
    loop = asyncio.get_running_loop()
    today = time.strftime("%Y%m%d")

    def _scrape() -> list[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for market in ("KOSPI", "KOSDAQ"):
            df = stock.get_market_fundamental(today, market=market)  # column verified in Step 1
            for code in df.index:
                name = str(df.loc[code, "종목명"])
                rows.append((str(code), name, market))
        return rows

    rows = await loop.run_in_executor(None, _scrape)
    return [
        SymbolHit(
            code=c,
            name=n,
            market=m,  # type: ignore[arg-type]
            captured_count=0,
            captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
        )
        for c, n, m in rows
    ]
```

**Variant B** (no single-call source; use ticker_list + parallel ticker_name):

```python
async def _fetch_from_pykrx() -> list[SymbolHit]:
    """Verified against pykrx 1.2.8 in Task 9 Step 1.

    ThreadPoolExecutor batches per-code get_market_ticker_name calls.
    ~30-120s for ~6000 codes; acceptable because pykrx is called only on
    explicit user trigger (ADR-0015). All-or-nothing: any per-market or
    per-code failure raises and aborts.
    """
    from concurrent.futures import ThreadPoolExecutor
    from pykrx import stock

    loop = asyncio.get_running_loop()
    today = time.strftime("%Y%m%d")

    def _scrape() -> list[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for market in ("KOSPI", "KOSDAQ"):
            codes = stock.get_market_ticker_list(today, market=market)
            with ThreadPoolExecutor(max_workers=8) as pool:
                names = list(pool.map(stock.get_market_ticker_name, codes))
            for code, name in zip(codes, names, strict=True):
                rows.append((str(code), str(name), market))
        return rows

    rows = await loop.run_in_executor(None, _scrape)
    return [
        SymbolHit(
            code=c,
            name=n,
            market=m,  # type: ignore[arg-type]
            captured_count=0,
            captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
        )
        for c, n, m in rows
    ]
```

- [ ] **Step 3: Smoke-test against real KRX**

Start the server: `uv run hoga serve --port 8000`. In another shell:

```bash
curl -sX POST http://127.0.0.1:8000/api/symbols/refresh | head -c 200
ls -la ~/.local/share/hoga-ops/symbol-master.json
jq '.entries | length' ~/.local/share/hoga-ops/symbol-master.json
jq '.entries[0]' ~/.local/share/hoga-ops/symbol-master.json
```

Expected: HTTP 200, response with `status: "fresh"`, file exists, ~6000 entries, first entry has `{code, name, market}` keys with non-empty values.

If this fails, return to Step 1 to investigate further. KRX rate-limits aggressively — wait 5+ minutes between attempts on failure.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/symbols.py
git commit -m "fix(symbols): pykrx 1.2.8-compatible Symbol Master fetch (Variant <A/B>)"
```

Note in the commit message which variant was chosen.

---

### Task 10: Add `GET /api/symbols/info` route

**Files:**
- Modify: `hoga/api/symbols.py` (route definition)
- Test: `tests/api/test_symbols.py`

- [ ] **Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from hoga.api.app import create_app


def test_symbols_info_endpoint_empty(tmp_path):
    symbols_module.reset_state_for_tests()
    app = create_app()  # adjust if create_app signature requires args
    client = TestClient(app)

    resp = client.get("/api/symbols/info")

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 0
    assert body["status"] == "unavailable"
    assert body["fetched_at_ms"] is None
    assert body["reason"] == "symbol_master_not_initialized"
```

Note: `create_app` may not be the actual factory name — check `hoga/api/app.py` for the actual entry point and adjust. If lifespan startup requires a `data_dir`, pass `monkeypatch.chdir(tmp_path)` or whatever the existing test pattern uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_symbols.py::test_symbols_info_endpoint_empty -v`
Expected: FAIL with 404 (route does not exist).

- [ ] **Step 3: Add the route inside `build_router`**

In `hoga/api/symbols.py`, find `build_router(*, data_dir: Path)` and add:

```python
@router.get("/info")
async def info_route() -> SymbolMasterInfo:
    return SymbolMasterInfo(
        count=len(_cache),
        fetched_at_ms=_fetched_at_ms,
        status=_state.status,
        reason=_state.reason,
    )
```

Also update the `/refresh` route to pass the new `path` argument:

```python
@router.post("/refresh")
async def refresh_route() -> SymbolsAllResponse:
    from hoga.config import resolve_symbol_master_path
    return await refresh(path=resolve_symbol_master_path(), data_dir=data_dir)
```

Add `SymbolMasterInfo` to the import block at the top of `symbols.py`:

```python
from hoga.api.models import SymbolHit, SymbolMasterInfo, SymbolsAllResponse
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_symbols.py::test_symbols_info_endpoint_empty -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/symbols.py tests/api/test_symbols.py
git commit -m "feat(symbols): add GET /api/symbols/info endpoint (ADR-0015)"
```

---

### Task 11: Wire `load_disk_state` into lifespan, remove `ensure_cache_warm` call

**Files:**
- Modify: `hoga/api/app.py`
- Test: existing API integration tests (no new test — coverage from Tasks 6/7)

- [ ] **Step 1: Find the lifespan call site**

Run: `grep -n "ensure_cache_warm\|lifespan" hoga/api/app.py`
Expected: a line like `asyncio.create_task(_symbols_module.ensure_cache_warm(data_dir))` around line 60.

- [ ] **Step 2: Replace the call**

Edit `hoga/api/app.py`. Find:

```python
asyncio.create_task(_symbols_module.ensure_cache_warm(data_dir))
```

Replace with:

```python
from hoga.config import resolve_symbol_master_path
_symbols_module.load_disk_state(
    path=resolve_symbol_master_path(),
    data_dir=data_dir,
)
```

The call becomes synchronous (no `create_task`, no `await`) — disk read + data_dir walk is sub-100ms typical.

- [ ] **Step 3: Run the full backend test suite**

Run: `uv run --extra dev pytest tests/ -x -v 2>&1 | tail -40`
Expected: all tests pass. If `tests/api/test_app.py` or similar tests fail because they referenced `ensure_cache_warm`, update them to use `load_disk_state` with a monkeypatched path.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/app.py tests/
git commit -m "refactor(app): lifespan reads disk instead of warming pykrx (ADR-0015)"
```

---

## Frontend Tasks

### Task 12: Mirror `SymbolMasterInfo` + new `UpstreamCode` value in TypeScript

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Add the new types**

Edit `frontend/src/api/types.ts`. Find the `UpstreamCode` union and add the new key:

```ts
export type UpstreamCode =
  | 'krx_credentials_missing'
  | 'krx_fetch_failed'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error'
  | 'symbol_master_not_initialized';
```

After `SymbolsAllResponse`, add:

```ts
/** Mirrors hoga/api/models.py::SymbolMasterInfo. See ADR-0004 (mirror discipline). */
export interface SymbolMasterInfo {
  count: number;
  fetched_at_ms: number | null;
  status: SymbolsCacheStatus;
  reason: UpstreamCode | null;
}
```

- [ ] **Step 2: Run TypeScript build (will fail in hint maps — that's Task 14)**

Run: `cd frontend && npx tsc -b 2>&1 | head -30`
Expected: FAIL — TypeScript exhaustive check on `Record<UpstreamCode, ReactNode>` maps in `upstream-hints.ts` will complain about missing `symbol_master_not_initialized` keys. This is the intended mirror-discipline signal — fixed in Task 14.

Use `tsc -b` (project build mode), not `tsc --noEmit` — only `-b` resolves the project references in `tsconfig.json` and surfaces errors across the whole graph. `--noEmit` silently passes errors in referenced configs.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend/types): mirror SymbolMasterInfo + new UpstreamCode (ADR-0015)"
```

Note: this commit intentionally leaves the build broken; Task 14 fixes the hint maps. Same justification as Task 5 — PRs are reviewed as a unit.

---

### Task 13: Add `getSymbolMasterInfo()` to frontend API

**Files:**
- Modify: `frontend/src/api/symbols.ts`

- [ ] **Step 1: Add the function**

Edit `frontend/src/api/symbols.ts`. Add a new import + function:

```ts
import { apiCall } from './client';
import type { SymbolHit, SymbolMasterInfo, SymbolsAllResponse } from './types';

// ... existing functions ...

export function getSymbolMasterInfo(): Promise<SymbolMasterInfo> {
  return apiCall<SymbolMasterInfo>('/api/symbols/info');
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api/symbols.ts
git commit -m "feat(frontend/api): getSymbolMasterInfo()"
```

---

### Task 14: Add `symbol_master_not_initialized` to all 4 hint maps + new Settings map

**Files:**
- Modify: `frontend/src/api/upstream-hints.ts`

- [ ] **Step 1: Add the new key to each existing map**

Open `frontend/src/api/upstream-hints.ts`. For each of the four existing `Record<UpstreamCode, ReactNode>` maps (`symbolSearchHints`, `calendarHints`, `enqueueErrorHints`, `captureFinishedHints`), add a `symbol_master_not_initialized` entry. Copy per surface:

```tsx
// In symbolSearchHints:
symbol_master_not_initialized: (
  <>
    종목 목록이 아직 다운로드되지 않았습니다 —{' '}
    <strong>설정 → Symbol Master → Update Now</strong>를 누르거나, 6자리 코드를 직접 입력해 진행할 수 있습니다.
  </>
),

// In calendarHints:
symbol_master_not_initialized: (
  <>
    종목 목록이 아직 다운로드되지 않았습니다 — 휴일 표시는 정상이지만 종목 검색 기능을 사용하려면 설정에서 Update하세요.
  </>
),

// In enqueueErrorHints:
symbol_master_not_initialized: (
  <>
    범위 캡처 시작에는 종목 목록이 필요합니다 — 설정에서 Update Symbol Master 후 재시도하세요.
  </>
),

// In captureFinishedHints:
symbol_master_not_initialized: (
  <>캡처 실패 — Symbol Master 미초기화. 설정에서 Update.</>
),
```

- [ ] **Step 2: Add the new `symbolMasterSettingsHints` map**

Append:

```tsx
/** Settings page → Symbol Master section. Longer-form copy than inline hints. */
export const symbolMasterSettingsHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없어 갱신할 수 없습니다 — repo 루트 <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정한 뒤 다시 시도하세요.
    </>
  ),
  krx_fetch_failed: (
    <>
      KRX에서 종목 목록을 가져오지 못했습니다 — 자격증명 또는 네트워크를 확인하고 잠시 후 다시 시도하세요. 디스크 파일은 보존되었습니다.
    </>
  ),
  cookie_expired: (
    <>hogaplay 쿠키가 만료되어 종목 목록 갱신에 영향이 있을 수 있습니다 — 쿠키를 갱신하세요.</>
  ),
  cookie_missing: (
    <>hogaplay 쿠키가 설정되지 않았습니다 — 종목 목록 자체에는 영향 없지만 캡처 기능에는 필요합니다.</>
  ),
  hogaplay_http_error: (
    <>hogaplay 응답 오류 — 종목 목록 갱신과 무관할 수 있으나, 캡처 시 영향이 있습니다.</>
  ),
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 — 아래 <strong>Update Now</strong> 버튼을 누르면 ~30~120초가 소요됩니다.
    </>
  ),
};
```

- [ ] **Step 3: Verify TypeScript build passes**

Run: `cd frontend && npx tsc -b`
Expected: no errors. The exhaustive check is now satisfied across all maps.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/upstream-hints.ts
git commit -m "feat(frontend/hints): symbol_master_not_initialized + Settings map (ADR-0015)"
```

---

### Task 15: Settings page `SymbolMasterSection`

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`
- Test: `frontend/src/pages/Settings.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/Settings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import * as symbolsApi from '../api/symbols';

vi.mock('../config', () => ({
  loadConfig: () => Promise.resolve({ api_url: 'http://test' }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('Settings — Symbol Master section', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders unavailable state with hint', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'unavailable',
      reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.getByText('0')).toBeInTheDocument(); // count
    expect(screen.getByText(/아직 다운로드되지 않았습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders fresh state', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: Date.now() - 3600_000, // 1 hour ago
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('fresh')).toBeInTheDocument();
  });

  it('clicking Update Now calls refreshSymbols and invalidates', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
    const refreshSpy = vi
      .spyOn(symbolsApi, 'refreshSymbols')
      .mockResolvedValue({ symbols: [], status: 'fresh', fetched_at_ms: Date.now(), reason: null });

    renderWithQuery(<Settings />);
    const btn = await screen.findByRole('button', { name: /Update Now/i });
    btn.click();

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledOnce();
    });
  });

  it('renders loading state (Update in flight): button disabled with Updating… label', async () => {
    // Backend reports status='loading' when a refresh is in-flight (rare snapshot — the more
    // common loading signal is the local `updating` state set by handleUpdate). This test
    // covers the case where a different client triggered the refresh and our useQuery picks
    // up the loading state from the server.
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'loading',
      reason: null,
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
    // Local updating state is false (no click yet), so button still shows Update Now —
    // this asserts the wire-status='loading' does NOT auto-disable the button. If product
    // decides differently later, this test will catch the change.
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders stale state: cache preserved, reason hint visible, button still actionable', async () => {
    const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,  // pre-existing cache preserved across refresh failure
      fetched_at_ms: TWO_HOURS_AGO,
      status: 'stale',
      reason: 'krx_fetch_failed',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      // Existing entries count is preserved across the failed refresh.
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('stale')).toBeInTheDocument();
    // Reason hint must appear (from symbolMasterSettingsHints[krx_fetch_failed]).
    expect(screen.getByText(/KRX에서 종목 목록을 가져오지 못했습니다/)).toBeInTheDocument();
    // Update remains the user's recovery path.
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/Settings.test.tsx --reporter=basic`
Expected: FAIL — Settings page does not render a Symbol Master section yet.

- [ ] **Step 3: Implement the section**

Replace `frontend/src/pages/Settings.tsx` body:

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';

const VERSION = 'v0.1.0';
const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;

function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hour ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-8 max-w-2xl space-y-4 text-sm">
      <h2 className="text-md font-semibold">Settings</h2>
      <Row label="API URL" value={config?.api_url ?? '…'} />
      <Row label="Version" value={VERSION} />
      <SymbolMasterSection />
      <p className="text-xs text-fg-dimmer pt-4">
        편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
      </p>
    </div>
  );
}

function SymbolMasterSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: SYMBOLS_INFO_QUERY_KEY,
    queryFn: getSymbolMasterInfo,
    refetchOnWindowFocus: false,
  });
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await refreshSymbols();
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_INFO_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="space-y-2 pt-4 border-t border-border">
      <h3 className="text-sm font-semibold">Symbol Master</h3>
      <Row label="Items" value={data ? data.count.toLocaleString() : (isLoading ? '…' : '0')} />
      <Row label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <Row label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-down">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <button
        type="button"
        onClick={handleUpdate}
        disabled={updating || isLoading}
        className="mt-2 bg-bg-input border border-border rounded-md px-sm py-xs text-fg hover:text-fg cursor-pointer font-[inherit] text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </button>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
      <span className="text-xs uppercase tracking-wider text-fg-dimmer">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/Settings.test.tsx --reporter=basic`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.test.tsx
git commit -m "feat(frontend/Settings): Symbol Master section with Update Now (ADR-0015)"
```

---

### Task 16: SymbolSearch empty-result staleness nudge

**Files:**
- Modify: `frontend/src/capture/SymbolSearch.tsx`
- Test: `frontend/src/capture/SymbolSearch.test.tsx` (new or extend)

- [ ] **Step 1: Write the failing test**

Create or extend `frontend/src/capture/SymbolSearch.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';
import * as useSymbolsModule from './useSymbols';

function renderWith(data: useSymbolsModule.UseSymbolsData) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(useSymbolsModule, 'useSymbols').mockReturnValue({ data } as never);
  vi.spyOn(useSymbolsModule, 'useSymbolSearch').mockReturnValue([] as never);
  return render(
    <QueryClientProvider client={qc}>
      <SymbolSearch value={null} onChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('SymbolSearch — empty-result staleness nudge', () => {
  it('renders nudge when catalog is older than 7 days and search has no hits', () => {
    const TEN_DAYS_AGO = Date.now() - 10 * 24 * 60 * 60 * 1000;
    renderWith({
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0, captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
      status: 'fresh',
      fetched_at_ms: TEN_DAYS_AGO,
      reason: null,
    });
    const input = screen.getByPlaceholderText(/종목명/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonexistent-name' } });

    expect(screen.getByText(/검색 결과가 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/Symbol Master.*업데이트되었습니다/)).toBeInTheDocument();
  });

  it('does NOT render nudge when catalog is younger than 7 days', () => {
    const ONE_DAY_AGO = Date.now() - 24 * 60 * 60 * 1000;
    renderWith({
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0, captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
      status: 'fresh',
      fetched_at_ms: ONE_DAY_AGO,
      reason: null,
    });
    const input = screen.getByPlaceholderText(/종목명/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonexistent-name' } });

    expect(screen.getByText(/검색 결과가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/Symbol Master.*업데이트되었습니다/)).not.toBeInTheDocument();
  });
});
```

If `useSymbolsModule` does not export `UseSymbolsData`, define it inline in the test from `SymbolsAllResponse | undefined`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/capture/SymbolSearch.test.tsx --reporter=basic`
Expected: FAIL — no nudge text rendered.

- [ ] **Step 3: Add the nudge to `SymbolSearch.tsx`**

Edit `frontend/src/capture/SymbolSearch.tsx`. Add a constant near the top:

```tsx
const STALE_NUDGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
```

Inside the component, after the existing `const reason = data?.reason ?? null;` line, add:

```tsx
const fetchedAtMs = data?.fetched_at_ms ?? null;
const isStaleByAge =
  fetchedAtMs !== null && Date.now() - fetchedAtMs > STALE_NUDGE_THRESHOLD_MS;

function formatRelativeShort(ms: number): string {
  const delta = Date.now() - ms;
  const days = Math.floor(delta / 86_400_000);
  if (days < 1) return '오늘';
  return `${days}일 전`;
}
```

In the existing empty-state JSX (around line 151-155, the `isEmpty` branch inside the dropdown), replace:

```tsx
<div className="py-md px-sm font-normal text-sm text-fg-dim">
  검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
</div>
```

with:

```tsx
<div className="py-md px-sm font-normal text-sm text-fg-dim">
  검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
  {isStaleByAge && fetchedAtMs !== null && (
    <div className="mt-2 text-xs text-fg-dimmer">
      Symbol Master가 {formatRelativeShort(fetchedAtMs)} 업데이트되었습니다 —
      신규 상장 종목이 누락되었을 수 있습니다.{' '}
      <a href="/settings" className="underline">설정에서 Update</a>
    </div>
  )}
</div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/capture/SymbolSearch.test.tsx --reporter=basic`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/SymbolSearch.tsx frontend/src/capture/SymbolSearch.test.tsx
git commit -m "feat(frontend/SymbolSearch): 7-day empty-result staleness nudge (ADR-0015)"
```

---

## Verification

### Task 17: End-to-end manual verification

This is a release-gate checklist, not a test. Run it after all 16 implementation tasks are complete and the full backend + frontend test suites pass.

- [ ] **Step 1: Run the full suites once more**

```bash
uv run --extra dev pytest tests/ -v 2>&1 | tail -10
cd frontend && npx vitest run --reporter=basic 2>&1 | tail -10
```

Expected: all green on both.

- [ ] **Step 2: Cold-boot scenario (no disk file)**

```bash
rm -f ~/.local/share/hoga-ops/symbol-master.json
uv run hoga serve --port 8000 &
sleep 2
curl -s http://127.0.0.1:8000/api/symbols/info | jq
```

Expected response:
```json
{
  "count": 0,
  "fetched_at_ms": null,
  "status": "unavailable",
  "reason": "symbol_master_not_initialized"
}
```

- [ ] **Step 3: Frontend cold-boot UI**

Open `http://localhost:5173`. Confirm:
- Settings page shows "Items: 0", "Last fetched: Never", "Status: unavailable", + hint about not initialized
- SymbolSearch shows the "아직 다운로드되지 않았습니다" hint + Refresh button
- Typing a 6-digit code (e.g., `005930`) and pressing Enter still works (promoteUnverifiedCode preserved)

- [ ] **Step 4: First Update from Settings**

Click [Update Now] in Settings. Wait ~30-120s. Confirm:
- Button label changes to "Updating… (~30-120s)" during fetch
- After completion: "Items: ~6000", "Last fetched: just now", "Status: fresh"
- `ls -la ~/.local/share/hoga-ops/symbol-master.json` shows a real file
- `jq '.schema_version' ~/.local/share/hoga-ops/symbol-master.json` returns `1`
- SymbolSearch autocomplete now works for "삼성"

- [ ] **Step 5: Restart preserves state**

Kill and restart the server. Within 2 seconds of restart:
- Settings still shows fresh state (no Update click needed)
- `curl /api/symbols/info` shows `status: "fresh"` immediately
- No log entries indicating a pykrx call at startup (check server logs)

- [ ] **Step 6: Bad creds → disk preserved**

Edit repo-root `.env` to have an invalid `KRX_PW`. Click [Update Now]. Confirm:
- Settings shows reason hint mentioning `krx_fetch_failed`
- `ls -la ~/.local/share/hoga-ops/symbol-master.json` — file timestamp unchanged from Step 4
- `jq '.entries | length'` still returns the previous count

- [ ] **Step 7: Disk corruption recovery**

```bash
echo "{ garbage" > ~/.local/share/hoga-ops/symbol-master.json
```

Restart server. Confirm:
- Settings reverts to "Status: unavailable"
- `[Update Now]` recovers the catalog

- [ ] **Step 8: Concurrent Update dedupe**

Open Settings in two browser tabs. Click [Update Now] in both within 1 second. Confirm via server logs: only one `_fetch_from_pykrx` invocation. Both tabs eventually show the same fresh state.

- [ ] **Step 9: 7-day nudge (manual time skew)**

Inject a fake old `fetched_at_ms` directly into the disk file:

```bash
jq '.fetched_at_ms = (now * 1000 - 10 * 86400000 | floor)' ~/.local/share/hoga-ops/symbol-master.json > /tmp/sm.json
mv /tmp/sm.json ~/.local/share/hoga-ops/symbol-master.json
```

Restart server. In SymbolSearch, type a name that has no hits (e.g., "ZZZ존재하지않는종목ZZZ"). Confirm the staleness nudge "Symbol Master가 10일 전 업데이트되었습니다" appears below the empty-state.

- [ ] **Step 10: Commit any test/doc tweaks discovered during verification**

If the verification surfaced any small adjustments (e.g., a hint copy that didn't read right, a missing `aria-label`), commit them now with descriptive messages.

```bash
git add ...
git commit -m "fix(...): post-verification polish"
```

---

## Completion Criteria

- All 16 implementation tasks committed.
- Backend test suite green: `uv run --extra dev pytest tests/`.
- Frontend test suite green: `cd frontend && npx vitest run`.
- TypeScript build clean: `cd frontend && npx tsc -b`.
- All 10 verification steps in Task 17 pass.
- ADR-0015 and CONTEXT.md updates already in place from the brainstorming session (no additional commit needed unless verification surfaced doc issues).

---

## Notes for Implementers

- **Tasks 5/7/12 leave intermediate broken states.** This is deliberate — each prepares the next, and the PR is reviewed as a unit. Do not paper over with shims; trust the sequence.
- **Task 9 (pykrx fix)** is the only task that touches a real external dependency. If you hit a KRX rate-limit during Step 1's REPL probe, wait 5+ minutes before retrying. Do not test refresh against real KRX more than necessary.
- **Atomic write tests** (Task 4 Step 1, `test_atomic_write_rollback_on_replace_failure`) assert the *file* is preserved, not the *temp file*. The `tempfile.NamedTemporaryFile(delete=False)` leaves an orphaned temp file when `os.replace` fails — that's acceptable (next successful write replaces it with a fresh temp; user can clean up manually if needed). Do not add cleanup-on-error logic — it complicates the happy path for no real benefit.
- **The 7-day threshold is a constant**, not a config knob. If user feedback says 7 days is wrong, change the constant — do not introduce a settings UI for it (YAGNI per ADR-0015 §F-equivalent reasoning).
- **`UseSymbolsData` type** in Task 16's test: if not exported from `useSymbols.ts`, the test should import `SymbolsAllResponse` from `../api/types` and cast: `vi.spyOn(...).mockReturnValue({ data } as { data: SymbolsAllResponse | undefined } as never)`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 2 issues found, both fixed inline (corruption log, Settings state coverage); T0 pre-flight added to clear pre-existing TypeScript baseline |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Findings absorbed inline:**
- **D2 (Code Quality)**: `_load_from_disk` corruption paths emit `logger.warning` per ADR-0015 (plan T4 Step 3).
- **D3 (Test Coverage)**: Settings.test.tsx covers 'loading' + 'stale' branches alongside unavailable/fresh (plan T15 Step 1).
- **D4/D5/D6 (Build Baseline)**: pre-flight T0 closes 4 pre-existing `tsc -b` errors (TabSelection.timeframe in Toolbar/Inventory, Draft.timeframe in Toolbar, SessionBundle→RangeBundle cast in Workarea). ADR-0013 full migration deferred to its own PR per D6.

**Architecture analysis:** `_lock` + `_inflight: Future` concurrency model verified race-free for two-tab concurrent Update scenario. lifespan blocking on `load_disk_state` (~100ms) accepted — boot is faster than the pykrx-warm predecessor.

**Test coverage diagram:** all production code paths covered by unit tests (T1-T16); `_fetch_from_pykrx` is intentionally manual-smoke only (T9 Step 3) due to network/credential dependency. Manual E2E checklist (T17) covers 10 scenarios end-to-end.

**UNRESOLVED:** 0
**NOT IN SCOPE (deferred to follow-up PRs):**
- ADR-0013 full migration (Workarea + 6 chart panes from SessionBundle → RangeBundle). Workarea cast in T0 is temporary; D6 decision.
- Generic atomic-write helper extraction (`_progress.json`, `meta.json`, `symbol-master.json` all use the same pattern inline). ADR-0015 "When to revisit" entry.
- SSE-driven `captured_breakdown` incremental update. ADR-0015 §F-equivalent reasoning.

**VERDICT:** ENG CLEARED — ready to implement via subagent-driven-development.
