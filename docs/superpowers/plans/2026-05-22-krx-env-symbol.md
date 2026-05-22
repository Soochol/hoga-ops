# KRX Credentials via `.env` + Symbol Master Recovery UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire repo-root `.env` loading for KRX/hogaplay credentials and turn silent pykrx failures into a recoverable, reason-aware UX for the Symbol Master and Calendar.

**Architecture:** A small `hoga/env.py` injects `KRX_ID`/`KRX_PW`/`HOGAPLAY_COOKIE` into `os.environ` at CLI boot and on `POST /api/symbols/refresh`. Two pykrx call sites (`symbols.py`, `calendar.py`) gain pre-check + reason propagation. A new `UpstreamCode` enum (sibling to `CaptureErrorCode`, ADR-0009) carries the reason on cache envelopes, HTTP 503s, and per-item SSE failures. Frontend reads `reason`/`code`, renders surface-specific hints from `upstream-hints.ts` (`Record<UpstreamCode, ReactNode>` per surface, TS-enforced exhaustive).

**Tech Stack:** Python 3.11+, FastAPI, pykrx, python-dotenv (already in deps), React + TypeScript + Vite + React Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md`
**ADRs:** `docs/adr/0008-env-discovery-worktree-fallback.md`, `docs/adr/0009-upstream-code-separate-enum.md`
**Glossary:** **Symbol Master**, **Code** — see `CONTEXT.md`.

---

## File Structure

### New files
| Path | Purpose |
|---|---|
| `hoga/env.py` | `.env` loader with worktree → main-repo fallback + `krx_creds_present()` helper |
| `tests/test_env.py` | Unit tests for env loader + fallback discovery |
| `.env.example` | Committed template; `.env` itself gitignored |
| `frontend/src/api/upstream-hints.ts` | Per-surface `Record<UpstreamCode, ReactNode>` maps |
| `frontend/src/api/upstream-hints.test.tsx` | Smoke tests verifying every `UpstreamCode` key is present in every map |

### Modified files
| Path | Change |
|---|---|
| `hoga/api/error_codes.py` | Add `UpstreamCode` enum; remove `COOKIE_*`, `HOGAPLAY_HTTP_ERROR` from `CaptureErrorCode` |
| `hoga/api/models.py` | Add `reason: UpstreamCode \| None = None` to `SymbolsAllResponse` and `CalendarResponse` |
| `hoga/api/symbols.py` | Add `_last_failure_reason`; pre-check + reason classification; `refresh()` calls `load_env(override=True)` inside `_lock` |
| `hoga/api/calendar.py` | Add `_last_failure_reason`; `_trading_days_for` returns `None` on failure; add `KrxUnavailableError`; `get_month_map` fail-soft; `last_failure_reason()` accessor |
| `hoga/api/captures.py` | Update enum imports for migrated codes; enqueue route catches `KrxUnavailableError` → HTTP 503 |
| `hoga/cli.py` | `serve()` calls `load_env()` (no override) at startup |
| `.gitignore` | Add `.env` |
| `frontend/src/api/types.ts` | `UpstreamCode` union; trim `CaptureErrorCode`; `CaptureFinishedErrorCode` alias; `reason?: UpstreamCode \| null` on Symbols/Calendar responses |
| `frontend/src/capture/SymbolSearch.tsx` | Reason-aware hint via `symbolSearchHints` + Refresh button visible when `status !== 'fresh'` and `!== 'loading'` |
| `frontend/src/capture/DateRangePicker.tsx` | Banner above grid when either month's `data.reason` is set, via `calendarHints` |
| `frontend/src/capture/CaptureForm.tsx` | Read HTTP 503 `error.detail.code`, render `enqueueErrorHints` inline |
| `frontend/src/capture/CaptureRowDetail.tsx` | Look up `captureFinishedHints[code]` when `code` is `UpstreamCode`; otherwise keep generic display |

### Test files extended (no new files)
- `tests/test_api_symbols.py` — reason classification cases
- `tests/test_api_calendar.py` — fail-soft + `KrxUnavailableError`
- `tests/test_api_captures_queue.py` — enqueue HTTP 503 case
- `frontend/src/capture/SymbolSearch.test.tsx` — hint + Refresh button visibility
- `frontend/src/capture/DateRangePicker.test.tsx` — banner
- `frontend/src/capture/CaptureForm.test.tsx` — 503 inline error

---

## Task 1: Add `UpstreamCode` enum (additive — does not remove anything yet)

**Files:**
- Modify: `hoga/api/error_codes.py`
- Test: `tests/test_error_codes.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_error_codes.py`:

```python
"""UpstreamCode enum + CaptureErrorCode shape tests (ADR-0009)."""
from __future__ import annotations

from hoga.api.error_codes import CaptureErrorCode, UpstreamCode


def test_upstream_code_values() -> None:
    """All five UpstreamCode values are present with stable string values."""
    assert UpstreamCode.KRX_CREDENTIALS_MISSING.value == "krx_credentials_missing"
    assert UpstreamCode.KRX_FETCH_FAILED.value == "krx_fetch_failed"
    assert UpstreamCode.COOKIE_EXPIRED.value == "cookie_expired"
    assert UpstreamCode.COOKIE_MISSING.value == "cookie_missing"
    assert UpstreamCode.HOGAPLAY_HTTP_ERROR.value == "hogaplay_http_error"


def test_upstream_code_is_str_enum() -> None:
    """StrEnum so FastAPI serializes to the bare string on the wire."""
    assert isinstance(UpstreamCode.KRX_CREDENTIALS_MISSING, str)
    assert UpstreamCode.KRX_CREDENTIALS_MISSING == "krx_credentials_missing"


def test_capture_error_code_retains_non_upstream_values() -> None:
    """CaptureErrorCode keeps captures-domain non-upstream codes."""
    assert CaptureErrorCode.TODAY_TOO_EARLY.value == "today_too_early"
    assert CaptureErrorCode.MISSING_RANGE.value == "missing_range"
    assert CaptureErrorCode.TERMINAL.value == "terminal"
    assert CaptureErrorCode.NOT_FOUND.value == "not_found"
    assert CaptureErrorCode.INTERNAL_ERROR.value == "internal_error"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_error_codes.py -v`
Expected: FAIL with `ImportError` or `AttributeError: UpstreamCode`.

- [ ] **Step 3: Implement `UpstreamCode` (additive — keep `CaptureErrorCode` cookie/hogaplay values for now)**

Edit `hoga/api/error_codes.py` to append the new enum after the existing `CaptureErrorCode`:

```python
"""Single source of truth for backend-emitted error code strings.

Every `code` field that crosses the API surface — both REST responses
(``HTTPException(detail={"code": ..., "message": ...})``) and the per-item
``CaptureError.code`` field carried on SSE ``capture_finished`` events —
draws from one of these enums.

There are two enums, split by category (see ADR-0009):

* :class:`CaptureErrorCode` — captures-domain non-upstream codes
  (request gating, lifecycle states, internal-error fallback).

* :class:`UpstreamCode` — upstream-dependency availability codes
  (KRX login state, hogaplay cookie state, hogaplay HTTP errors).
  Used as ``reason: UpstreamCode | None`` on cache envelopes
  (``SymbolsAllResponse``, ``CalendarResponse``), as
  ``detail.code: UpstreamCode`` on HTTP 5xx error responses, and as
  ``CaptureError.code`` on per-item SSE failures.

The frontend mirrors both enums verbatim as literal unions in
``frontend/src/api/types.ts`` (ADR-0004 mirror discipline: codes are
part of the wire contract, not an internal implementation detail).
Adding a new value here means adding the same string to the
corresponding frontend union in the same commit.
"""
from __future__ import annotations

from enum import StrEnum


class CaptureErrorCode(StrEnum):
    """Closed set of error codes emitted by the captures router.

    Categories (informal — both flow through the same wire field):
    - REST request gating: TODAY_TOO_EARLY, MISSING_RANGE, TERMINAL, NOT_FOUND
    - Per-item failure classification (CaptureError.code on capture_finished):
      COOKIE_EXPIRED, COOKIE_MISSING, HOGAPLAY_HTTP_ERROR
    - Fallback: INTERNAL_ERROR
    """

    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"


class UpstreamCode(StrEnum):
    """Upstream-dependency availability codes (ADR-0009).

    Used for:
      • cache-style envelopes (HTTP 200) as ``reason: UpstreamCode | None``
      • HTTP error responses (5xx) as ``detail.code: UpstreamCode``
      • SSE per-item failure ``CaptureError.code`` (alongside CaptureErrorCode)

    String values are stable across surfaces; the field name (``reason``
    vs ``code``) signals the response shape.
    """

    KRX_CREDENTIALS_MISSING = "krx_credentials_missing"
    KRX_FETCH_FAILED = "krx_fetch_failed"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
```

NOTE: This task only adds `UpstreamCode`. The `test_capture_error_code_retains_non_upstream_values` test currently passes because we haven't trimmed `CaptureErrorCode` yet. Task 2 will trim it; the test was written for the post-trim state but passes incidentally now (extra enum values don't break the assertions because they're positive-only).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_error_codes.py -v`
Expected: 3 passed.

- [ ] **Step 5: Run existing test suite to verify no regression**

Run: `uv run pytest tests/ -x --ignore=tests/test_collector_client.py 2>&1 | tail -15`
Expected: All passing (the `--ignore` is only because the collector tests may need live cookies; check your local setup).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/error_codes.py tests/test_error_codes.py
git commit -m "feat(error-codes): add UpstreamCode enum (ADR-0009, additive)"
```

---

## Task 2: Migrate cookie/hogaplay codes to `UpstreamCode`

Move `COOKIE_EXPIRED`, `COOKIE_MISSING`, `HOGAPLAY_HTTP_ERROR` out of `CaptureErrorCode` and update the four call sites in `captures.py` (lines 68, 70, 72, 576). The string values stay stable, so wire-contract behavior is unchanged.

**Files:**
- Modify: `hoga/api/error_codes.py`
- Modify: `hoga/api/captures.py:67-72, 576`
- Test: `tests/test_error_codes.py`, `tests/test_api_captures_queue.py` (existing)

- [ ] **Step 1: Extend the existing test with negative assertions**

Add to `tests/test_error_codes.py` (after the existing tests):

```python
import pytest


def test_capture_error_code_no_longer_has_upstream_values() -> None:
    """After migration, cookie/hogaplay codes live in UpstreamCode only."""
    for name in ("COOKIE_EXPIRED", "COOKIE_MISSING", "HOGAPLAY_HTTP_ERROR"):
        assert not hasattr(CaptureErrorCode, name), (
            f"CaptureErrorCode.{name} still exists — should have moved to UpstreamCode"
        )


def test_exception_to_error_code_returns_upstream_for_cookie() -> None:
    """captures.py:_exception_to_error_code maps cookie/hogaplay exceptions to UpstreamCode."""
    from hoga.api.captures import _exception_to_error_code
    from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
    from hoga.config import CookieMissingError

    assert _exception_to_error_code(CookieMissingError("no cookie")) == UpstreamCode.COOKIE_MISSING
    assert _exception_to_error_code(CookieExpiredError(401, "url", "")) == UpstreamCode.COOKIE_EXPIRED
    assert _exception_to_error_code(HogaplayHTTPError(500, "url", "")) == UpstreamCode.HOGAPLAY_HTTP_ERROR
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `uv run pytest tests/test_error_codes.py -v`
Expected: 2 new tests FAIL — `CaptureErrorCode.COOKIE_EXPIRED` still exists, mapping function still returns `CaptureErrorCode` values.

- [ ] **Step 3: Trim `CaptureErrorCode`**

Edit `hoga/api/error_codes.py`, replace the `CaptureErrorCode` class body with:

```python
class CaptureErrorCode(StrEnum):
    """Captures-domain non-upstream codes (ADR-0009).

    Migrated 2026-05-22: cookie/hogaplay codes moved to UpstreamCode.
    """

    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"
```

- [ ] **Step 4: Update `hoga/api/captures.py` call sites**

In `hoga/api/captures.py`, find the existing imports and add `UpstreamCode`:

```python
from hoga.api.error_codes import CaptureErrorCode, UpstreamCode
```

Update `_exception_to_error_code()` (around line 60):

```python
def _exception_to_error_code(exc: BaseException) -> CaptureErrorCode | UpstreamCode | None:
    """Map a Python exception class to the API `code` field.

    Returns None for CaptureCancelled — that produces a `cancelled` phase,
    not a `failed` one.
    """
    if isinstance(exc, TodayTooEarlyRefused):
        return CaptureErrorCode.TODAY_TOO_EARLY
    if isinstance(exc, CookieMissingError):
        return UpstreamCode.COOKIE_MISSING
    if isinstance(exc, CookieExpiredError):
        return UpstreamCode.COOKIE_EXPIRED
    if isinstance(exc, HogaplayHTTPError):
        return UpstreamCode.HOGAPLAY_HTTP_ERROR
    if isinstance(exc, CaptureCancelled):
        return None
    return CaptureErrorCode.INTERNAL_ERROR
```

Update line 576 (search for `CaptureErrorCode.COOKIE_EXPIRED` — there should be one occurrence around the `_handle_cookie_expired` callsite area):

```python
# Before:
#     code=CaptureErrorCode.COOKIE_EXPIRED,
# After:
              code=UpstreamCode.COOKIE_EXPIRED,
```

- [ ] **Step 5: Run targeted tests**

Run: `uv run pytest tests/test_error_codes.py tests/test_api_captures_queue.py -v`
Expected: All passing. If `test_api_captures_queue.py` references the moved enum values, update its imports (find `CaptureErrorCode.COOKIE_` and change to `UpstreamCode.COOKIE_`).

- [ ] **Step 6: Run full test suite**

Run: `uv run pytest tests/ -x 2>&1 | tail -10`
Expected: All passing.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/error_codes.py hoga/api/captures.py tests/test_error_codes.py
# Add any test files that needed import updates:
git add -u tests/
git commit -m "refactor(error-codes): migrate cookie/hogaplay codes to UpstreamCode (ADR-0009)"
```

---

## Task 3: Add `reason` field to `SymbolsAllResponse` and `CalendarResponse`

**Files:**
- Modify: `hoga/api/models.py:286-289, 304-307`
- Test: `tests/test_api_models_capture_queue.py` or add to `tests/test_api_symbols.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_api_symbols.py` (or create `tests/test_api_models_reason.py`):

```python
def test_symbols_all_response_accepts_reason() -> None:
    """SymbolsAllResponse.reason is optional and accepts UpstreamCode values."""
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import SymbolsAllResponse

    resp = SymbolsAllResponse(symbols=[], status="unavailable", fetched_at_ms=None,
                              reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
    assert resp.reason == "krx_credentials_missing"

    # Default is None for backward compat.
    resp_default = SymbolsAllResponse(symbols=[], status="fresh", fetched_at_ms=123)
    assert resp_default.reason is None


def test_calendar_response_accepts_reason() -> None:
    """CalendarResponse.reason is optional and accepts UpstreamCode values."""
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import CalendarResponse

    resp = CalendarResponse(cells=[], as_of_ms=123,
                            reason=UpstreamCode.KRX_FETCH_FAILED)
    assert resp.reason == "krx_fetch_failed"

    resp_default = CalendarResponse(cells=[], as_of_ms=123)
    assert resp_default.reason is None
```

- [ ] **Step 2: Run test to verify failure**

Run: `uv run pytest tests/test_api_symbols.py::test_symbols_all_response_accepts_reason tests/test_api_symbols.py::test_calendar_response_accepts_reason -v`
Expected: FAIL with `ValidationError` or unknown field error.

- [ ] **Step 3: Modify the two models**

Edit `hoga/api/models.py`. Find `SymbolsAllResponse` (around line 286) and `CalendarResponse` (around line 304). Add the import and field:

```python
# At the top of the file, with other imports:
from hoga.api.error_codes import UpstreamCode

# Replace the SymbolsAllResponse class body (around line 286):
class SymbolsAllResponse(BaseModel):
    symbols: list[SymbolHit]
    status: Literal["fresh", "loading", "stale", "unavailable"]
    fetched_at_ms: int | None
    reason: UpstreamCode | None = None

# Replace the CalendarResponse class body (around line 304):
class CalendarResponse(BaseModel):
    cells: list[CalendarCell]
    as_of_ms: int
    reason: UpstreamCode | None = None
```

- [ ] **Step 4: Run tests to verify pass**

Run: `uv run pytest tests/test_api_symbols.py -v -k "reason"`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_api_symbols.py
git commit -m "feat(models): add optional reason field to SymbolsAllResponse and CalendarResponse"
```

---

## Task 4: Create `hoga/env.py` with worktree-aware `.env` discovery

**Files:**
- Create: `hoga/env.py`
- Create: `tests/test_env.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_env.py`:

```python
"""Tests for hoga/env.py — .env loader with worktree → main-repo fallback (ADR-0008)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


def _purge_keys(monkeypatch: pytest.MonkeyPatch, *keys: str) -> None:
    for k in keys:
        monkeypatch.delenv(k, raising=False)


@pytest.fixture(autouse=True)
def _reset_env_discovery():
    """Reset the cached discovery between tests (D2/A1 — cache is per-process).

    Tests monkeypatch `_WORKING_TREE` and `_main_repo_root`, but the
    discovery cache persists across tests. Without this reset, test 2
    would see test 1's cached Path.
    """
    import hoga.env as env_module
    env_module.reset_discovery_for_tests()
    yield
    env_module.reset_discovery_for_tests()


def test_returns_none_when_no_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: None)
    assert env_module.load_env() is None


def test_loads_env_file_into_os_environ(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=u\nKRX_PW=p\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    _purge_keys(monkeypatch, "KRX_ID", "KRX_PW")

    loaded = env_module.load_env()
    assert loaded == tmp_path / ".env"
    assert os.environ["KRX_ID"] == "u"
    assert os.environ["KRX_PW"] == "p"


def test_override_false_preserves_existing_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=fromfile\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setenv("KRX_ID", "fromshell")

    env_module.load_env(override=False)
    assert os.environ["KRX_ID"] == "fromshell"


def test_override_true_overwrites_existing_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=fromfile\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setenv("KRX_ID", "fromshell")

    env_module.load_env(override=True)
    assert os.environ["KRX_ID"] == "fromfile"


def test_worktree_fallback_to_main_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ADR-0008: worktree has no .env → main repo .env is loaded."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (main_repo / ".env").write_text("KRX_ID=fromMain\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: main_repo)
    _purge_keys(monkeypatch, "KRX_ID")

    loaded = env_module.load_env()
    assert loaded == main_repo / ".env"
    assert os.environ["KRX_ID"] == "fromMain"


def test_worktree_env_wins_over_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When both exist, the worktree-local .env wins."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (worktree / ".env").write_text("KRX_ID=fromWorktree\n", encoding="utf-8")
    (main_repo / ".env").write_text("KRX_ID=fromMain\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: main_repo)
    _purge_keys(monkeypatch, "KRX_ID")

    loaded = env_module.load_env()
    assert loaded == worktree / ".env"
    assert os.environ["KRX_ID"] == "fromWorktree"


def test_main_repo_root_returns_none_when_git_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    def _raise(*args, **kwargs):
        raise FileNotFoundError("git binary missing")

    monkeypatch.setattr(env_module.subprocess, "run", _raise)
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    assert env_module._main_repo_root() is None


def test_discovery_is_cached_across_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """D2/A1: subprocess git call should run at most once per process.

    Verifies that calling load_env() N times triggers _main_repo_root() at most once.
    """
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=u\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)

    call_count = {"n": 0}
    def _spy() -> None:
        call_count["n"] += 1
        return None
    monkeypatch.setattr(env_module, "_main_repo_root", _spy)

    env_module.load_env()
    env_module.load_env(override=True)
    env_module.load_env()
    # _main_repo_root is only consulted when the local .env is absent,
    # so with a local .env present it should be called 0 times. With local
    # .env absent it would be called exactly once across N load_env calls.
    assert call_count["n"] == 0, "local .env present should short-circuit before calling _main_repo_root"


def test_discovery_cache_only_one_subprocess_when_falling_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D2/A1: fallback path also caches — subprocess runs once."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (main_repo / ".env").write_text("KRX_ID=u\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    call_count = {"n": 0}
    def _spy() -> Path:
        call_count["n"] += 1
        return main_repo
    monkeypatch.setattr(env_module, "_main_repo_root", _spy)

    env_module.load_env()
    env_module.load_env(override=True)
    env_module.load_env()
    assert call_count["n"] == 1, "_main_repo_root should be called exactly once across N load_env calls"


def test_krx_creds_present_truthiness(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    assert env_module.krx_creds_present() is False

    monkeypatch.setenv("KRX_ID", "u")
    assert env_module.krx_creds_present() is False  # PW still missing

    monkeypatch.setenv("KRX_PW", "")
    assert env_module.krx_creds_present() is False  # empty string is falsy

    monkeypatch.setenv("KRX_PW", "p")
    assert env_module.krx_creds_present() is True
```

- [ ] **Step 2: Run tests to verify failure**

Run: `uv run pytest tests/test_env.py -v`
Expected: All FAIL — `hoga.env` module doesn't exist.

- [ ] **Step 3: Create `hoga/env.py`**

Create file. Per D2 (plan review A1), discovery result is cached in a module-level sentinel — the subprocess git call runs at most once per process. `reset_discovery_for_tests()` is exported so test fixtures can re-trigger discovery between tmp_path setups.

```python
"""Repo-root .env loader for hoga-ops secrets (ADR-0008).

Discovery order:
    1. <working-tree>/.env (resolved relative to this file).
    2. <main-repo-root>/.env via `git rev-parse --git-common-dir` —
       used only when (1) is absent AND we're inside a git worktree.
       In a normal checkout, (1) and (2) point to the same path.

The discovery result is cached at module level — the subprocess git call
runs at most once per process. ``load_env`` itself can be safely called
under the asyncio Lock in symbols.refresh() without blocking the event
loop on subprocess I/O.

Loaded keys (all optional — missing keys fall back to other sources):
    KRX_ID, KRX_PW         pykrx login (Symbol Master fetch)
    HOGAPLAY_COOKIE        hogaplay session cookie

Precedence: shell env > .env > .cookie file (legacy, for HOGAPLAY_COOKIE only).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

_WORKING_TREE: Path = Path(__file__).resolve().parent.parent

# Sentinel distinct from None so we can tell "not yet discovered" from
# "discovered, no .env exists". Reset between tests via reset_discovery_for_tests().
_NOT_DISCOVERED: Any = object()
_discovered: Any = _NOT_DISCOVERED  # Path | None | _NOT_DISCOVERED


def _main_repo_root() -> Path | None:
    """Return the main repo root via `git rev-parse --git-common-dir`.

    In a worktree the common dir is the main repo's `.git` directory;
    its parent is the main repo root. Returns None when git is unavailable
    or we're not inside a repo.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=_WORKING_TREE,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    common = Path(out)
    if not common.is_absolute():
        common = (_WORKING_TREE / common).resolve()
    if common.name != ".git":
        return None
    return common.parent


def _discover_env_file() -> Path | None:
    """Return the .env path to load, or None if none exists.

    Called at most once per process (cached in ``_discovered``). Reset
    between tests via :func:`reset_discovery_for_tests`.
    """
    local = _WORKING_TREE / ".env"
    if local.exists():
        return local
    main = _main_repo_root()
    if main is not None and main != _WORKING_TREE:
        candidate = main / ".env"
        if candidate.exists():
            return candidate
    return None


def load_env(*, override: bool = False) -> Path | None:
    """Load discovered .env into os.environ. Returns path loaded, or None.

    - ``override=False`` (default): shell env wins over .env. Use at startup.
    - ``override=True``: .env wins over shell env. Use after the user has
      edited .env and explicitly triggered a refresh.

    Safe to call under an asyncio Lock — the subprocess git call only runs
    on the first invocation per process; subsequent calls hit the in-memory
    cache and only re-read the .env file content via python-dotenv.
    """
    global _discovered  # noqa: PLW0603
    if _discovered is _NOT_DISCOVERED:
        _discovered = _discover_env_file()
    if _discovered is None:
        return None
    load_dotenv(dotenv_path=_discovered, override=override)
    return _discovered  # type: ignore[no-any-return]


def reset_discovery_for_tests() -> None:
    """Test helper — clear the cached discovery result so the next
    ``load_env()`` re-runs ``_discover_env_file()``. Needed because tests
    monkeypatch ``_WORKING_TREE`` and ``_main_repo_root`` per test.
    """
    global _discovered  # noqa: PLW0603
    _discovered = _NOT_DISCOVERED


def krx_creds_present() -> bool:
    """True iff KRX_ID and KRX_PW are set to non-empty strings in os.environ."""
    return bool(os.environ.get("KRX_ID")) and bool(os.environ.get("KRX_PW"))
```

- [ ] **Step 4: Run tests to verify pass**

Run: `uv run pytest tests/test_env.py -v`
Expected: All 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add hoga/env.py tests/test_env.py
git commit -m "feat(env): add .env loader with worktree → main-repo fallback (ADR-0008)"
```

---

## Task 5: Wire `load_env()` into `hoga/cli.py serve()`, add `.gitignore` + `.env.example`

**Files:**
- Modify: `hoga/cli.py:82-91`
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Modify `hoga/cli.py`**

Edit `hoga/cli.py`. Find the `serve()` function and add the import + call:

```python
# Add to the imports at the top:
from hoga.env import load_env

# Modify the serve function body (the existing function is at line 82):
@app.command()
def serve(port: int = typer.Option(8000, "--port")) -> None:
    """Start the FastAPI server."""
    load_env()  # ADR-0008: discover and load .env (no override at startup)
    uvicorn.run(
        "hoga.api.app:default_app",
        factory=True,
        host="127.0.0.1",
        port=port,
        reload=False,
    )
```

- [ ] **Step 2: Update `.gitignore`**

Add `.env` to `.gitignore`. The file already exists; append:

```
.env
```

Verify with:

```bash
grep -E "^\.env$" .gitignore
```

Expected: prints `.env`.

- [ ] **Step 3: Create `.env.example`**

Create file `.env.example` at the repo root:

```
# Copy this file to .env and fill in your values.
# .env is gitignored; do not commit secrets.

# KRX login (data.krx.co.kr). Required for pykrx Symbol Master fetch
# (GET /api/symbols/all) and the calendar trading-day list. Sign up at
# https://data.krx.co.kr/ if you don't have an account.
KRX_ID=your-krx-id
KRX_PW=your-krx-password

# Hogaplay session cookie. Copy from a logged-in browser session,
# format: "k_=...; n_=...". Optional if you keep using the legacy
# .cookie file at the repo root.
HOGAPLAY_COOKIE=
```

- [ ] **Step 4: Manual smoke check — start the server**

Run: `uv run hoga serve --port 8000 &` then `curl -s http://127.0.0.1:8000/api/symbols/all | head -c 200` and kill the server.
Expected: server starts without error. If `.env` doesn't exist, the response is the same `{"symbols":[],"status":"unavailable",...}` as before (we haven't added reason classification yet — that's Task 6).

- [ ] **Step 5: Commit**

```bash
git add hoga/cli.py .gitignore .env.example
git commit -m "feat(cli): load .env at serve startup; add .env.example and gitignore"
```

---

## Task 6: Symbols.py — `_last_failure_reason`, pre-check, reason in response, refresh hot-reload

This task bundles four related changes to `hoga/api/symbols.py` because they share state (`_last_failure_reason`) and would create a half-broken intermediate state if split.

**Files:**
- Modify: `hoga/api/symbols.py`
- Test: `tests/test_api_symbols.py` (extend)

- [ ] **Step 1: Write failing tests**

Add to `tests/test_api_symbols.py` (figure out the existing fixtures by skimming the file first):

```python
import pytest
from pathlib import Path

from hoga.api import symbols as symbols_module
from hoga.api.error_codes import UpstreamCode


@pytest.fixture(autouse=True)
def _reset_symbols_state():
    """Each test starts with a clean module state."""
    symbols_module.reset_state_for_tests()
    yield
    symbols_module.reset_state_for_tests()


@pytest.mark.asyncio
async def test_get_all_unavailable_when_creds_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No creds → pre-check sets reason; pykrx is NOT called."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    call_log = []
    async def _spy() -> list:
        call_log.append("pykrx-called")
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    resp = await symbols_module.get_all(data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    assert call_log == [], "pykrx should not be called when creds are missing"


@pytest.mark.asyncio
async def test_get_all_empty_creds_treated_as_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KRX_ID", "")
    monkeypatch.setenv("KRX_PW", "")

    async def _spy():
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    resp = await symbols_module.get_all(data_dir=tmp_path)
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING


@pytest.mark.asyncio
async def test_get_all_fetch_failed_when_creds_set_but_pykrx_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    async def _raise():
        raise RuntimeError("pykrx exploded")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise)

    resp = await symbols_module.get_all(data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED


@pytest.mark.asyncio
async def test_get_all_stale_path_carries_reason(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D4/T1: spec §5.3 2-axis matrix — status='stale' + reason='krx_fetch_failed'.

    Scenario: a prior successful fetch warmed the cache. A subsequent refresh
    fails (KRX outage / 401). The endpoint should serve the stale cache AND
    surface reason so the frontend can show a Refresh button + telemetry.
    """
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    from hoga.api.models import SymbolHit

    # First call: succeed, prime the cache.
    async def _ok() -> list[SymbolHit]:
        return [SymbolHit(code="005930", name="삼성전자", market="KOSPI",
                          captured_count=0,
                          captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)
    resp1 = await symbols_module.get_all(data_dir=tmp_path)
    assert resp1.status == "fresh"
    assert len(resp1.symbols) == 1

    # Force cache to look stale, then make pykrx fail.
    symbols_module.invalidate_cache_for_tests()
    async def _raise() -> list[SymbolHit]:
        raise RuntimeError("pykrx exploded mid-session")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise)

    resp2 = await symbols_module.get_all(data_dir=tmp_path)
    assert resp2.status == "stale", "cache exists → status should downgrade to stale, not unavailable"
    assert resp2.reason == UpstreamCode.KRX_FETCH_FAILED
    assert len(resp2.symbols) == 1, "stale cache should still be served"


@pytest.mark.asyncio
async def test_get_all_reason_cleared_on_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    from hoga.api.models import SymbolHit

    async def _ok():
        return [SymbolHit(code="005930", name="삼성전자", market="KOSPI",
                          captured_count=0,
                          captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)

    resp = await symbols_module.get_all(data_dir=tmp_path)
    assert resp.status == "fresh"
    assert resp.reason is None
    assert len(resp.symbols) == 1


@pytest.mark.asyncio
async def test_refresh_calls_load_env_with_override_true(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Calling refresh() invokes load_env(override=True) under the lock."""
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    calls: list[bool] = []
    def _spy(*, override: bool) -> None:
        calls.append(override)
        return None
    monkeypatch.setattr(symbols_module, "load_env", _spy)

    async def _ok():
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)

    await symbols_module.refresh(data_dir=tmp_path)
    assert calls == [True], "refresh should call load_env(override=True) exactly once"


def test_reset_state_for_tests_clears_reason() -> None:
    """Make sure reset_state_for_tests handles the new state."""
    symbols_module._last_failure_reason = UpstreamCode.KRX_FETCH_FAILED  # type: ignore[attr-defined]
    symbols_module.reset_state_for_tests()
    assert symbols_module._last_failure_reason is None  # type: ignore[attr-defined]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_symbols.py -v -k "missing or fetch_failed or load_env or reset_state_for_tests_clears or reason_cleared"`
Expected: All FAIL — `_last_failure_reason` doesn't exist, response has no `reason` field populated, refresh doesn't call load_env.

- [ ] **Step 3: Modify `hoga/api/symbols.py`**

Apply this diff conceptually (the file is at ~245 lines; edits are localized):

(a) Add to the imports block (after `from hoga.api.disk_state import ...`):

```python
import os
from hoga.api.error_codes import UpstreamCode
from hoga.env import krx_creds_present, load_env
```

(b) Add to the module-level state declarations (next to `_cache`, `_fetched_at_ms`, `_status`, around line 25):

```python
_last_failure_reason: UpstreamCode | None = None
```

(c) Update `reset_state_for_tests()` (line 31):

```python
def reset_state_for_tests() -> None:
    global _cache, _fetched_at_ms, _status, _inflight, _last_failure_reason  # noqa: PLW0603
    _cache, _fetched_at_ms, _status, _inflight = [], None, "loading", None
    _last_failure_reason = None
```

(d) Replace `_do_fetch_and_populate()` (lines 134-154) entirely:

```python
async def _do_fetch_and_populate(data_dir: Path) -> None:
    """Inner helper — runs under in-flight Future protection."""
    global _cache, _fetched_at_ms, _status, _last_failure_reason  # noqa: PLW0603

    # Pre-check: deterministically classify "missing credentials" without
    # depending on pykrx's exception-message format (which can drift across
    # versions). Also saves the network round-trip when creds are absent.
    if not krx_creds_present():
        _last_failure_reason = UpstreamCode.KRX_CREDENTIALS_MISSING
        _status = "stale" if _cache else "unavailable"
        return

    try:
        hits = await _fetch_from_pykrx()
    except Exception:  # noqa: BLE001 — pykrx failure path (preserved)
        _last_failure_reason = UpstreamCode.KRX_FETCH_FAILED
        _status = "stale" if _cache else "unavailable"
        return

    # Single-pass walk → {code: breakdown}; assign per symbol.
    loop = asyncio.get_running_loop()
    breakdowns = await loop.run_in_executor(None, _build_all_captured_breakdowns, data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in hits:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = hits
    _fetched_at_ms = int(time.time() * 1000)
    _status = "fresh"
    _last_failure_reason = None
```

(e) Update `get_all()` (lines 164-196) — only the two `return SymbolsAllResponse(...)` builders need updating to include `reason=_last_failure_reason`:

```python
async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    """Tier 2: GET-time lock + Future dedupe.

    N concurrent calls share one underlying fetch.
    """
    global _inflight, _status  # noqa: PLW0603
    async with _lock:
        if _is_fresh():
            return SymbolsAllResponse(
                symbols=list(_cache),
                status="fresh",
                fetched_at_ms=_fetched_at_ms,
                reason=_last_failure_reason,
            )
        if _inflight is None:
            _status = "loading" if not _cache else _status
            loop = asyncio.get_running_loop()
            _inflight = loop.create_future()
            fetch_task = asyncio.create_task(_do_fetch_and_populate(data_dir))

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
        status=_status,  # type: ignore[arg-type]
        fetched_at_ms=_fetched_at_ms,
        reason=_last_failure_reason,
    )
```

(f) Update `refresh()` (line 199) to call `load_env(override=True)` inside the lock:

```python
async def refresh(*, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — force a synchronous re-fetch.

    load_env(override=True) runs under _lock so the os.environ mutation
    and the _fetched_at_ms reset share one critical section. The inflight
    Future dedupe inside get_all() collapses concurrent refresh storms to
    one pykrx call.
    """
    global _fetched_at_ms  # noqa: PLW0603
    async with _lock:
        load_env(override=True)
        _fetched_at_ms = None
    return await get_all(data_dir=data_dir)
```

- [ ] **Step 4: Run targeted tests**

Run: `uv run pytest tests/test_api_symbols.py -v`
Expected: All passing (new tests + existing symbols tests).

- [ ] **Step 5: Run full backend test suite**

Run: `uv run pytest tests/ -x 2>&1 | tail -10`
Expected: All passing.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/symbols.py tests/test_api_symbols.py
git commit -m "feat(symbols): pre-check + reason field + refresh hot-reload of .env"
```

---

## Task 7: Calendar.py — `_trading_days_for` returns None on failure, `KrxUnavailableError`, fail-soft `get_month_map`

**Files:**
- Modify: `hoga/api/calendar.py`
- Test: `tests/test_api_calendar.py` (extend)

- [ ] **Step 1: Write failing tests**

Add to `tests/test_api_calendar.py`:

```python
import pytest
from pathlib import Path

from hoga.api import calendar as calendar_module
from hoga.api.calendar import KrxUnavailableError
from hoga.api.error_codes import UpstreamCode


@pytest.fixture(autouse=True)
def _reset_calendar_state():
    calendar_module.reset_cache_for_tests()
    yield
    calendar_module.reset_cache_for_tests()


def test_trading_days_for_returns_none_when_creds_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KRX_CREDENTIALS_MISSING


def test_trading_days_for_returns_none_when_pykrx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    # Monkeypatch pykrx.stock at import time
    class _FakeStock:
        @staticmethod
        def get_market_ohlcv(*args, **kwargs):
            raise RuntimeError("pykrx exploded")

    # The function does `from pykrx import stock` — patch the import path.
    import sys
    fake_pykrx = type(sys)("pykrx")
    fake_pykrx.stock = _FakeStock
    monkeypatch.setitem(sys.modules, "pykrx", fake_pykrx)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KRX_FETCH_FAILED


def test_get_month_map_fail_soft_when_creds_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Calendar UI still renders every weekday; banner reason is set."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    resp = calendar_module.get_month_map(data_dir=tmp_path, code="005930", year=2026, month=5)
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    # May 2026 has 31 days; all are present as cells (none silently dropped).
    assert len(resp.cells) == 31
    # All weekdays render with status "none" (no capture yet), not "holiday".
    import datetime as dt
    weekday_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() < 5]
    weekend_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() >= 5]
    assert all(c.status in ("none", "future", "today_locked") for c in weekday_cells), \
        "weekdays should not be misclassified as holiday when KRX is unavailable"
    assert all(c.status == "weekend" for c in weekend_cells)


def test_trading_days_in_range_raises_when_creds_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    with pytest.raises(KrxUnavailableError) as exc_info:
        calendar_module.trading_days_in_range("20260501", "20260531")
    assert exc_info.value.code == UpstreamCode.KRX_CREDENTIALS_MISSING


def test_reset_cache_clears_last_failure_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    calendar_module._trading_days_for(2026, 5)
    assert calendar_module.last_failure_reason() is not None
    calendar_module.reset_cache_for_tests()
    assert calendar_module.last_failure_reason() is None
```

- [ ] **Step 2: Run tests to verify failure**

Run: `uv run pytest tests/test_api_calendar.py -v -k "missing or raises or fail_soft or reset"`
Expected: All FAIL — `last_failure_reason` doesn't exist, `KrxUnavailableError` not importable, no `reason` on response.

- [ ] **Step 3: Modify `hoga/api/calendar.py`**

(a) Add imports near the top of the file:

```python
import os

from hoga.api.error_codes import UpstreamCode
from hoga.env import krx_creds_present
```

(b) Add module-level state and accessor next to `_month_cache` (around line 29):

```python
_month_cache: dict[tuple[int, int], set[str]] = {}
_last_failure_reason: UpstreamCode | None = None


def last_failure_reason() -> UpstreamCode | None:
    """Public accessor for the most recent KRX-availability failure."""
    return _last_failure_reason


class KrxUnavailableError(RuntimeError):
    """KRX trading-day data unavailable. Carries an UpstreamCode for HTTP surfacing."""
    def __init__(self, code: UpstreamCode) -> None:
        super().__init__(f"KRX unavailable: {code.value}")
        self.code = code
```

(c) Replace `_trading_days_for()` (around line 32):

```python
def _trading_days_for(year: int, month: int) -> set[str] | None:
    """Return YYYYMMDD strings for KRX trading days in (year, month).

    Returns None when KRX data cannot be obtained (no creds, or pykrx failed).
    The most recent failure reason is exposed via :func:`last_failure_reason`.
    Cached results from earlier successful fetches stay valid.
    """
    global _last_failure_reason  # noqa: PLW0603

    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached

    if not krx_creds_present():
        _last_failure_reason = UpstreamCode.KRX_CREDENTIALS_MISSING
        return None

    start = f"{year:04d}{month:02d}01"
    last_day = stdlib_calendar.monthrange(year, month)[1]
    end = f"{year:04d}{month:02d}{last_day:02d}"
    try:
        from pykrx import stock
        df = stock.get_market_ohlcv(start, end, "005930")
    except Exception:  # noqa: BLE001
        _last_failure_reason = UpstreamCode.KRX_FETCH_FAILED
        return None

    result = {d.strftime("%Y%m%d") for d in df.index}
    _month_cache[key] = result
    _last_failure_reason = None
    return result
```

(d) Update `trading_days_in_range()` (around line 48):

```python
def trading_days_in_range(start: str, end: str) -> list[str]:
    """Public helper used by captures.py Task 7. Returns YYYYMMDD trading days
    in [start, end] inclusive, sorted. Composes _trading_days_for across all
    months the range spans, so multi-month ranges only hit pykrx once per month.

    Raises KrxUnavailableError when KRX data is unavailable for any month
    spanned by the range — fail-fast on the enqueue path so the user can't
    proceed with a guessed day list.

    Tests should monkeypatch this function (or pre-populate ``_month_cache``)
    rather than rely on live KRX access — KRX endpoints require KRX_ID / KRX_PW
    env vars.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    out: list[str] = []
    cur = dt.date(start_d.year, start_d.month, 1)
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        if days is None:
            raise KrxUnavailableError(last_failure_reason() or UpstreamCode.KRX_FETCH_FAILED)
        for d in sorted(days):
            if start <= d <= end:
                out.append(d)
        if cur.month == 12:
            cur = dt.date(cur.year + 1, 1, 1)
        else:
            cur = dt.date(cur.year, cur.month + 1, 1)
    return out
```

(e) Update `reset_cache_for_tests()` (around line 76):

```python
def reset_cache_for_tests() -> None:
    """Test helper — clears the trading-day cache between tests."""
    global _last_failure_reason  # noqa: PLW0603
    _month_cache.clear()
    _last_failure_reason = None
```

(f) Add helper for fail-soft behavior (near the other private helpers):

```python
def _all_weekdays_in_month(year: int, month: int) -> set[str]:
    """Fallback when KRX data is unavailable: treat every Mon–Fri as trading day.

    Holidays mis-classify as ``status="none"`` rather than ``"holiday"``, but the
    user sees the banner from ``CalendarResponse.reason`` and knows holiday
    accuracy is off.
    """
    last_day = stdlib_calendar.monthrange(year, month)[1]
    out: set[str] = set()
    for day in range(1, last_day + 1):
        d = dt.date(year, month, day)
        if d.weekday() < 5:
            out.add(f"{year:04d}{month:02d}{day:02d}")
    return out
```

(g) Update `get_month_map()` (around line 119):

```python
def get_month_map(*, data_dir: Path, code: str, year: int, month: int) -> CalendarResponse:
    """Build the month status map. Pure read-side. Fail-soft on KRX outage."""
    now = _now_kst()
    trading_days = _trading_days_for(year, month)
    if trading_days is None:
        reason = last_failure_reason()
        effective_trading_days = _all_weekdays_in_month(year, month)
    else:
        reason = None
        effective_trading_days = trading_days
    last_day = stdlib_calendar.monthrange(year, month)[1]
    cells: list[CalendarCell] = []
    for day in range(1, last_day + 1):
        date_str = f"{year:04d}{month:02d}{day:02d}"
        status = _cell_status_for(date_str, now, effective_trading_days, data_dir, code)
        captured_ms = (_captured_at_ms(data_dir, code, date_str)
                       if status in ("complete", "source_partial", "client_incomplete")
                       else None)
        cells.append(CalendarCell(date=date_str, status=status,  # type: ignore[arg-type]
                                  captured_at_ms=captured_ms))
    return CalendarResponse(cells=cells, as_of_ms=int(time.time() * 1000), reason=reason)
```

- [ ] **Step 4: Run targeted tests**

Run: `uv run pytest tests/test_api_calendar.py -v`
Expected: All passing.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/calendar.py tests/test_api_calendar.py
git commit -m "feat(calendar): fail-soft on read, fail-fast on enqueue; reason field"
```

---

## Task 8: Captures.py — catch `KrxUnavailableError` in enqueue route, return HTTP 503

**Files:**
- Modify: `hoga/api/captures.py:676-695` (enqueue route)
- Test: `tests/test_api_captures_queue.py` (extend)

- [ ] **Step 1: Write failing test**

Add to `tests/test_api_captures_queue.py`:

```python
import pytest


@pytest.mark.asyncio
async def test_enqueue_range_returns_503_when_krx_creds_missing(
    monkeypatch: pytest.MonkeyPatch,
    # ... use existing fixtures that build the FastAPI app/client
):
    """When KRX is unavailable, range-based enqueue returns HTTP 503 with code."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    # Reset calendar cache so the pre-check kicks in
    from hoga.api import calendar as calendar_module
    calendar_module.reset_cache_for_tests()

    # Use whatever HTTP client fixture this test file already uses; example:
    response = await client.post("/api/captures/items", json={
        "code": "005930",
        "start_date": "20260501",
        "end_date": "20260531",
        "force_retry": False,
    })
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "krx_credentials_missing"
    assert "krx" in detail["message"].lower() or "KRX" in detail["message"]
```

NOTE: read the top of `tests/test_api_captures_queue.py` first to understand the existing fixtures (TestClient or `httpx.AsyncClient`) and use the same pattern.

- [ ] **Step 2: Run test to verify failure**

Run: `uv run pytest tests/test_api_captures_queue.py -v -k "503"`
Expected: FAIL — currently the exception propagates as 500, or some other behavior.

- [ ] **Step 3: Modify `hoga/api/captures.py` enqueue route**

Find the enqueue route around line 676. The current code at line 690 calls `candidate_dates = _expand_to_trading_days(req.start_date, req.end_date)`. Wrap this and the `KrxUnavailableError` import:

```python
# At the top of captures.py, add to the imports:
from hoga.api.calendar import KrxUnavailableError
```

```python
# Inside the enqueue_items route handler (around line 676-695):
@router.post("/items", status_code=201)
async def enqueue_items(req: EnqueueRequest) -> EnqueueResponse:
    """Enqueue items for one (code, range or dates) request.

    Q14 guard: any date in the request equal to today_kst with
    now.hour < 18 → 400 today_too_early.
    Q15 Layer 1: per-(code, date) dedupe against
    _queue ∪ _active ∪ _inflight_paths and within-request duplicates.
    Returns the dedupe list in the response.

    KRX unavailability on the range path → 503 krx_credentials_missing /
    krx_fetch_failed (see ADR-0009, spec §5.6).
    """
    # 1. Expand to a flat list of candidate dates.
    if req.dates is not None:
        candidate_dates = list(req.dates)
    elif req.start_date and req.end_date:
        try:
            candidate_dates = _expand_to_trading_days(req.start_date, req.end_date)
        except KrxUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": (
                    "KRX trading-day list unavailable. Configure KRX_ID / KRX_PW "
                    "in repo-root .env and try again."
                ),
            }) from e
    else:
        raise HTTPException(status_code=400, detail={
            "code": CaptureErrorCode.MISSING_RANGE,
            "message": "Provide either dates=[...] or start_date+end_date.",
        })

    # ... rest of the existing function body unchanged ...
```

- [ ] **Step 4: Run targeted test**

Run: `uv run pytest tests/test_api_captures_queue.py -v -k "503"`
Expected: PASS.

- [ ] **Step 5: Run full backend suite**

Run: `uv run pytest tests/ -x 2>&1 | tail -10`
Expected: All passing.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): enqueue route returns HTTP 503 on KRX unavailability"
```

---

## Task 9: Frontend — update `types.ts` (UpstreamCode union, trim CaptureErrorCode, alias, reason fields)

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Apply the type changes**

Edit `frontend/src/api/types.ts`. Locate the existing `CaptureErrorCode` union (line 111) and the `SymbolsAllResponse` / `CalendarResponse` interfaces (lines 192, 216).

Replace the `CaptureErrorCode` block (lines 106-119) with:

```ts
/** Mirrors hoga/api/error_codes.py::CaptureErrorCode verbatim — captures-domain
 *  non-upstream codes. Per ADR-0009 cookie/hogaplay codes moved to UpstreamCode.
 *  Per ADR-0004 mirror discipline: adding a value to the Python enum requires
 *  adding the same string here. */
export type CaptureErrorCode =
  | 'today_too_early'
  | 'missing_range'
  | 'terminal'
  | 'not_found'
  | 'internal_error';

/** Mirrors hoga/api/error_codes.py::UpstreamCode verbatim (ADR-0009). Used as
 *  `reason: UpstreamCode | null` on cache envelopes (SymbolsAllResponse,
 *  CalendarResponse), as `detail.code: UpstreamCode` on HTTP 5xx error
 *  bodies, and as `CaptureError.code` on per-item SSE failures (via the
 *  `CaptureFinishedErrorCode` alias below). */
export type UpstreamCode =
  | 'krx_credentials_missing'
  | 'krx_fetch_failed'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error';

/** Wire type for fields that can carry either category. Currently:
 *  `CaptureError.code` on capture_finished SSE events. */
export type CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode;
```

Update `CaptureError.code` typing (line 122):

```ts
export interface CaptureError {
  code: CaptureFinishedErrorCode;
  message: string;
  at_page?: number | null;
}
```

Update `SymbolsAllResponse` (line 192):

```ts
/** Mirrors hoga/api/models.py::SymbolsAllResponse. */
export interface SymbolsAllResponse {
  symbols: SymbolHit[];
  status: SymbolsCacheStatus;
  fetched_at_ms: number | null;
  reason?: UpstreamCode | null;
}
```

Update `CalendarResponse` (line 216):

```ts
/** Mirrors hoga/api/models.py::CalendarResponse. */
export interface CalendarResponse {
  cells: CalendarCell[];
  as_of_ms: number;
  reason?: UpstreamCode | null;
}
```

- [ ] **Step 2: Run frontend type-check and tests**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: TypeScript compiles. Some test files may have TypeScript errors if they constructed `CaptureError` literals with `code: 'cookie_expired'` — the string is still valid (it's now in `UpstreamCode`, and `CaptureError.code` is `CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode`), so existing literals keep type-checking. If anything breaks, the build log will tell you which file.

- [ ] **Step 3: Run frontend tests**

```bash
cd frontend && npx vitest run --reporter=basic 2>&1 | tail -20
```

Expected: All passing. The existing SSE event tests with `'cookie_expired'` literals still match because the literal types are preserved.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend/types): mirror UpstreamCode + reason fields (ADR-0009)"
```

---

## Task 10: Frontend — create `upstream-hints.ts` with 4 per-surface hint maps

**Files:**
- Create: `frontend/src/api/upstream-hints.ts`
- Create: `frontend/src/api/upstream-hints.test.tsx`

- [ ] **Step 1: Write the smoke test first**

Create `frontend/src/api/upstream-hints.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import {
  symbolSearchHints,
  calendarHints,
  enqueueErrorHints,
  captureFinishedHints,
} from './upstream-hints';
import type { UpstreamCode } from './types';

const ALL_CODES: UpstreamCode[] = [
  'krx_credentials_missing',
  'krx_fetch_failed',
  'cookie_expired',
  'cookie_missing',
  'hogaplay_http_error',
];

describe('upstream-hints maps', () => {
  it.each(ALL_CODES)('symbolSearchHints has copy for %s', (code) => {
    expect(symbolSearchHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('calendarHints has copy for %s', (code) => {
    expect(calendarHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('enqueueErrorHints has copy for %s', (code) => {
    expect(enqueueErrorHints[code]).toBeDefined();
  });
  it.each(ALL_CODES)('captureFinishedHints has copy for %s', (code) => {
    expect(captureFinishedHints[code]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd frontend && npx vitest run upstream-hints --reporter=basic
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `frontend/src/api/upstream-hints.ts`**

```tsx
/** Per-surface user-facing copy keyed by UpstreamCode (ADR-0009 / Q7).
 *
 *  Adding a new UpstreamCode value to types.ts will trigger TypeScript errors
 *  in every map below that lacks the new key — that's the structural payoff.
 */
import type { ReactNode } from 'react';
import type { UpstreamCode } from './types';

/** Empty-state hint shown in SymbolSearch when the Symbol Master is empty. */
export const symbolSearchHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없습니다 — repo 루트 <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정한 뒤 아래{' '}
      <strong>Refresh</strong> 버튼을 누르세요.
    </>
  ),
  krx_fetch_failed: (
    <>
      KRX에서 종목 목록을 가져오지 못했습니다 — <code>.env</code>의 자격증명을
      확인하고 잠시 후 Refresh를 시도하세요.
    </>
  ),
  cookie_expired: (
    <>hogaplay 쿠키가 만료되어 종목 목록을 가져올 수 없습니다 — 쿠키를 갱신하세요.</>
  ),
  cookie_missing: (
    <>
      hogaplay 쿠키가 없습니다 — <code>.env</code> 또는 <code>.cookie</code>{' '}
      파일에 설정하세요.
    </>
  ),
  hogaplay_http_error: (
    <>hogaplay에서 오류가 반환되었습니다 — 잠시 후 Refresh를 시도하세요.</>
  ),
};

/** Banner above the calendar grid (informational; data still renders). */
export const calendarHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      KRX 자격증명이 없어 휴일 표시가 정확하지 않을 수 있습니다 —{' '}
      <code>.env</code>에 <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.
    </>
  ),
  krx_fetch_failed: (
    <>KRX에서 거래일 데이터를 가져오지 못해 휴일 표시가 정확하지 않을 수 있습니다.</>
  ),
  cookie_expired: <>hogaplay 쿠키 만료 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  cookie_missing: <>hogaplay 쿠키 미설정 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  hogaplay_http_error: <>hogaplay 일시 오류 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
};

/** Inline error in the range-capture form when enqueue returns HTTP 503. */
export const enqueueErrorHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: (
    <>
      범위 캡처 시작 실패 — KRX 자격증명이 필요합니다. <code>.env</code>에{' '}
      <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.
    </>
  ),
  krx_fetch_failed: (
    <>범위 캡처 시작 실패 — KRX 거래일 데이터를 가져올 수 없습니다. 잠시 후 재시도하세요.</>
  ),
  cookie_expired: <>범위 캡처 시작 실패 — hogaplay 쿠키 만료. 쿠키를 갱신하세요.</>,
  cookie_missing: <>범위 캡처 시작 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>범위 캡처 시작 실패 — hogaplay 응답 오류. 잠시 후 재시도하세요.</>,
};

/** Per-item failure display from the capture_finished SSE event. */
export const captureFinishedHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>캡처 실패 — KRX 자격증명 필요.</>,
  krx_fetch_failed: <>캡처 실패 — KRX 응답 오류.</>,
  cookie_expired: <>캡처 실패 — hogaplay 쿠키 만료. 큐 일시중지됨.</>,
  cookie_missing: <>캡처 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>캡처 실패 — hogaplay 응답 오류.</>,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd frontend && npx vitest run upstream-hints --reporter=basic
```

Expected: All 20 tests passing (5 codes × 4 maps).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/upstream-hints.ts frontend/src/api/upstream-hints.test.tsx
git commit -m "feat(frontend/hints): per-surface hint maps keyed by UpstreamCode"
```

---

## Task 11: Frontend — SymbolSearch reason-aware hint + Refresh button

**Files:**
- Modify: `frontend/src/capture/SymbolSearch.tsx`
- Modify: `frontend/src/capture/useSymbols.ts` (add invalidation helper)
- Test: `frontend/src/capture/SymbolSearch.test.tsx` (extend)

- [ ] **Step 1: Read existing component**

Open `frontend/src/capture/SymbolSearch.tsx`. Skim it to understand the current empty-state rendering at line 119 (where the existing "종목 목록 미가용" message lives).

- [ ] **Step 2: Write failing tests**

Add to `frontend/src/capture/SymbolSearch.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';

function wrap(ui: React.ReactNode, initialData: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['symbols-all'], initialData);
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('SymbolSearch reason-aware empty state', () => {
  it('shows krx_credentials_missing hint when reason is set', () => {
    render(wrap(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: 'krx_credentials_missing' },
    ));
    expect(screen.getByText(/KRX 자격증명이 없습니다/)).toBeTruthy();
  });

  it('shows Refresh button when status is unavailable', () => {
    render(wrap(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: 'krx_credentials_missing' },
    ));
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
  });

  it('does NOT show Refresh button when status is fresh', () => {
    render(wrap(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0, captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
        status: 'fresh', fetched_at_ms: 0 },
    ));
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('falls back to default empty-state copy when reason is null', () => {
    render(wrap(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: null },
    ));
    expect(screen.getByText(/종목 목록 미가용/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
cd frontend && npx vitest run SymbolSearch --reporter=basic
```

Expected: New tests FAIL.

- [ ] **Step 4: Modify `SymbolSearch.tsx`**

Add imports at the top:

```tsx
import { symbolSearchHints } from '../api/upstream-hints';
import { refreshSymbols } from '../api/symbols';
import { useQueryClient } from '@tanstack/react-query';
```

Within the component, replace the empty-state block (around line 119):

```tsx
// Inside the component body, where the empty-state hint is rendered:
const queryClient = useQueryClient();
const reason = data?.reason ?? null;
const status = data?.status ?? 'loading';
const showRefresh = status === 'unavailable' || status === 'stale';

const hint = reason && symbolSearchHints[reason]
  ? symbolSearchHints[reason]
  : (
      <>
        종목 목록 미가용 — 6자리 코드 입력 후{' '}
        <kbd style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px', fontFamily: 'inherit' }}>
          Enter
        </kbd>{' '}
        로 확정.
      </>
    );

const handleRefresh = async () => {
  await refreshSymbols();
  await queryClient.invalidateQueries({ queryKey: ['symbols-all'] });
};

// In the JSX where the old hint used to be:
{(symbols.length === 0) && (
  <div style={{ /* match existing empty-state container styling */ }}>
    <p>{hint}</p>
    {showRefresh && (
      <button onClick={handleRefresh} style={{ /* match existing button styling in this codebase */ }}>
        Refresh
      </button>
    )}
  </div>
)}
```

NOTE: the exact JSX structure depends on the current `SymbolSearch.tsx` shape — preserve the existing wrapper, only change the copy and add the button.

- [ ] **Step 5: Run tests to verify pass**

```bash
cd frontend && npx vitest run SymbolSearch --reporter=basic
```

Expected: All passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/capture/SymbolSearch.tsx frontend/src/capture/SymbolSearch.test.tsx
git commit -m "feat(frontend/SymbolSearch): reason-aware hint + Refresh button"
```

---

## Task 12: Frontend — DateRangePicker calendar banner

**Files:**
- Modify: `frontend/src/capture/DateRangePicker.tsx`
- Test: `frontend/src/capture/DateRangePicker.test.tsx` (extend)

- [ ] **Step 1: Write failing test**

Add to `frontend/src/capture/DateRangePicker.test.tsx`:

```tsx
it('shows banner when left month reason is krx_credentials_missing', () => {
  // Use the existing test setup pattern in this file. If it uses MSW or a
  // QueryClient prepopulated with calendar data, set `reason` on that payload.
  // Pseudo-code (adapt to the file's existing fixtures):
  setupCalendarData({ reason: 'krx_credentials_missing', cells: [...] });
  render(<DateRangePicker code="005930" /* ... */ />);
  expect(screen.getByText(/KRX 자격증명이 없어 휴일 표시가/)).toBeTruthy();
});

it('hides banner when both months have null reason', () => {
  setupCalendarData({ reason: null, cells: [...] });
  render(<DateRangePicker code="005930" /* ... */ />);
  expect(screen.queryByText(/휴일 표시가/)).toBeNull();
});
```

NOTE: read the top of `DateRangePicker.test.tsx` to mirror the existing setup helpers exactly. The fake function name (`setupCalendarData`) is illustrative.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd frontend && npx vitest run DateRangePicker --reporter=basic
```

Expected: New tests FAIL.

- [ ] **Step 3: Modify `DateRangePicker.tsx`**

Add import:

```tsx
import { calendarHints } from '../api/upstream-hints';
```

The component already calls `useCalendar` twice (lines 99-100). After those calls, derive the banner reason — left month takes priority, fall back to right month:

```tsx
const left = useCalendar(code, displayYear, displayMonth);
const right = useCalendar(code, nextYear, nextMonth);

const bannerReason = left.data?.reason ?? right.data?.reason ?? null;
const bannerCopy = bannerReason ? calendarHints[bannerReason] : null;
```

Render the banner above the existing grid JSX — find the first wrapping element in the return statement and prepend:

```tsx
return (
  <div /* existing wrapper */>
    {bannerCopy && (
      <div
        role="status"
        style={{
          padding: '8px 12px',
          marginBottom: 8,
          background: 'var(--bg-warning, #fffbe6)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: '0.875rem',
        }}
      >
        {bannerCopy}
      </div>
    )}
    {/* existing grid content */}
  </div>
);
```

Adapt the styling tokens to match `DESIGN.md` if the project has a specific banner pattern already.

- [ ] **Step 4: Run tests to verify pass**

```bash
cd frontend && npx vitest run DateRangePicker --reporter=basic
```

Expected: All passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/DateRangePicker.tsx frontend/src/capture/DateRangePicker.test.tsx
git commit -m "feat(frontend/calendar): reason-aware banner above the date range grid"
```

---

## Task 13: Frontend — CaptureForm 503 inline error

**Files:**
- Modify: `frontend/src/capture/CaptureForm.tsx`
- Test: `frontend/src/capture/CaptureForm.test.tsx` (extend)

- [ ] **Step 1: Write failing test**

Add to `CaptureForm.test.tsx`:

```tsx
it('shows enqueueErrorHints copy when enqueue returns 503 krx_credentials_missing', async () => {
  // Mock the fetch call to return 503. Use the same mocking style the file
  // already uses (probably a vi.spyOn(fetch) or a request handler).
  mockFetch({
    status: 503,
    body: { detail: { code: 'krx_credentials_missing', message: 'KRX trading-day list unavailable.' } },
  });

  render(<CaptureForm /* existing props */ />);
  // Trigger the submit; the form must already have a code+range selected
  // before submit is clickable. Replicate from existing tests in this file.
  fireEvent.click(screen.getByRole('button', { name: /capture/i }));
  expect(await screen.findByText(/범위 캡처 시작 실패 — KRX 자격증명/)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd frontend && npx vitest run CaptureForm --reporter=basic
```

Expected: New test FAILS.

- [ ] **Step 3: Modify `CaptureForm.tsx`**

Add imports:

```tsx
import { useState } from 'react';
import { enqueueErrorHints } from '../api/upstream-hints';
import type { ApiError } from '../api/client';
import type { UpstreamCode } from '../api/types';
```

Add state and update the submit handler. Per D3 (plan review C1): `apiCall` from `frontend/src/api/client.ts:15` throws `ApiError { code?: string; status?: number }`. Use that typed interface — do NOT use `as any` or dig into `.detail` manually (the wrapper already extracts it).

```tsx
const [inlineError, setInlineError] = useState<React.ReactNode>(null);

const submit = async () => {
  setInlineError(null);
  try {
    await apiCall('/api/captures/items', {
      method: 'POST',
      body: JSON.stringify({
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        force_retry: false,
      }),
    });
    // existing success handling (clear form, etc.)
  } catch (e) {
    const err = e as ApiError;
    const code = err.code;
    if (code && code in enqueueErrorHints) {
      setInlineError(enqueueErrorHints[code as UpstreamCode]);
      return;
    }
    // Fall through to generic error display
    setInlineError(<>{err.message ?? '캡처 시작 실패'}</>);
  }
};

// In the JSX, render the inline error block near the submit button:
{inlineError && (
  <div role="alert" style={{ /* match DESIGN.md error-message styling */ }}>
    {inlineError}
  </div>
)}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd frontend && npx vitest run CaptureForm --reporter=basic
```

Expected: All passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.test.tsx
git commit -m "feat(frontend/CaptureForm): inline error from 503 UpstreamCode"
```

---

## Task 14: Frontend — CaptureRowDetail map-driven copy for UpstreamCode

**Files:**
- Modify: `frontend/src/capture/CaptureRowDetail.tsx`
- Test: `frontend/src/capture/CaptureRowDetail.test.tsx` (extend)

- [ ] **Step 1: Write failing test**

Add to `CaptureRowDetail.test.tsx`:

```tsx
it('shows captureFinishedHints copy for UpstreamCode error', () => {
  render(
    <CaptureRowDetail
      item={{
        ...base,
        phase: 'failed',
        error: {
          code: 'cookie_expired',
          message: 'cookie missing on page 5',
          at_page: 5,
        },
      }}
    />,
  );
  expect(screen.getByText(/캡처 실패 — hogaplay 쿠키 만료/)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd frontend && npx vitest run CaptureRowDetail --reporter=basic
```

Expected: New test FAILS — current display only shows the raw `code: message`.

- [ ] **Step 3: Modify `CaptureRowDetail.tsx`**

Add imports:

```tsx
import { captureFinishedHints } from '../api/upstream-hints';
import type { UpstreamCode } from '../api/types';
```

The current display (line ~43) is `{item.error.code}: {item.error.message}`. Replace it with a map-aware version:

```tsx
{item.error && (() => {
  const code = item.error.code;
  const knownHint = (code in captureFinishedHints)
    ? captureFinishedHints[code as UpstreamCode]
    : null;
  return (
    <div /* keep the existing error wrapper styling */>
      {knownHint ?? <>{code}: {item.error.message}</>}
      {/* Optionally still show the raw message for debugging context: */}
      {knownHint && (
        <div style={{ fontSize: '0.85em', opacity: 0.8, marginTop: 4 }}>
          {item.error.message}
        </div>
      )}
    </div>
  );
})()}
```

The existing test at line 23-26 expects the message string to appear (`cookie missing on page 5`). The new code preserves that under the friendlier copy.

- [ ] **Step 4: Run tests to verify pass**

```bash
cd frontend && npx vitest run CaptureRowDetail --reporter=basic
```

Expected: All passing (both the new test and the existing one).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/CaptureRowDetail.tsx frontend/src/capture/CaptureRowDetail.test.tsx
git commit -m "feat(frontend/CaptureRowDetail): map-driven copy for UpstreamCode failures"
```

---

## Task 15: Manual verification end-to-end

This task is run by a human; no commit.

- [ ] **Step 1: Start clean**

```bash
# In the worktree root (the working tree):
rm -f .env
# Stop any running backend; start fresh:
uv run hoga serve --port 8000 &
cd frontend && npm run dev &
```

- [ ] **Step 2: Verify "no creds" UX in the browser**

Open `http://localhost:5173` and navigate to the capture page.

- Symbol search → empty state shows: "KRX 자격증명이 없습니다 — repo 루트 `.env`에 ... Refresh 버튼을 누르세요."
- Refresh button is visible.
- Click around in the date range picker → banner appears: "KRX 자격증명이 없어 휴일 표시가 정확하지 않을 수 있습니다 — ..."
- The grid still renders; weekdays are clickable.

- [ ] **Step 3: Verify range capture surfaces 503**

In the capture form, pick any code (type a 6-digit code if symbols list is empty) and select a date range spanning multiple weekdays, then submit.

- Expected: inline error message "범위 캡처 시작 실패 — KRX 자격증명이 필요합니다. ..."
- Network tab: `POST /api/captures/items` returns 503 with body `{"detail":{"code":"krx_credentials_missing","message":"..."}}`.

- [ ] **Step 4: Write a real `.env` and recover via Refresh**

Create `.env` at the repo root with valid KRX credentials. Do NOT restart the server.

- Click the Refresh button in SymbolSearch's empty state.
- Expected: symbol list populates (~6000 symbols across KOSPI/KOSDAQ), autocomplete works on "삼성".
- Calendar banner disappears within one calendar refetch.
- Range capture submit no longer 503s; the request proceeds.

- [ ] **Step 5: Verify worktree fallback (ADR-0008)**

If you have a main repo checkout AND this worktree, place `.env` only in the **main repo** (delete this worktree's `.env`). Restart the server with `uv run hoga serve`. Verify symbol list still loads — proving the git common-dir fallback worked.

- [ ] **Step 6: Tear down**

```bash
# Stop both processes (or kill backgrounded jobs)
kill %1 %2 2>/dev/null
```

---

## Self-review summary

This plan implements the spec sections:

| Spec section | Task(s) |
|---|---|
| §5.1 `hoga/env.py` + worktree fallback | Task 4 |
| §5.2 `cli.py` load_env | Task 5 |
| §5.3 `symbols.py` (state, pre-check, refresh hot-reload) | Task 6 |
| §5.4 models reason fields | Task 3 |
| §5.5 `krx_creds_present()` shared helper | Task 4 |
| §5.6 calendar.py + KrxUnavailableError + captures.py 503 | Tasks 7, 8 |
| §5.7 `UpstreamCode` enum + cookie/hogaplay migration | Tasks 1, 2 |
| §5.8 .gitignore + .env.example | Task 5 |
| §6.1 frontend types | Task 9 |
| §6.1 upstream-hints.ts | Task 10 |
| §6.2 SymbolSearch hint + Refresh | Task 11 |
| §6.3 calendar banner | Task 12 |
| §6.4 enqueue 503 inline error | Task 13 |
| §6.5 capture_finished map | Task 14 |
| §9.3, §9.4 manual verification | Task 15 |

No placeholders remain. Type names and string values are consistent across tasks. Function names (`load_env`, `krx_creds_present`, `reset_discovery_for_tests`, `_trading_days_for`, `KrxUnavailableError`, `last_failure_reason`, `_last_failure_reason`, `reset_state_for_tests`, `reset_cache_for_tests`) are stable end-to-end.

---

## NOT in scope

- **Renaming `CaptureErrorCode`** / merging the two enums (ADR-0009 §D).
- **Holiday accuracy on calendar fail-soft** — banner informs, full holiday list is future work.
- **File-watcher-based `.env` hot-reload** — refresh-endpoint reload covers common case.
- **`HOGAPLAY_COOKIE` auto-login** (username/password → cookie). Spec §12.
- **Per-environment `.env.local` / encryption-at-rest**. Spec §12.
- **`/api/symbols?q=...` search envelope migration** — Q9 kept current shape.
- **General settings UI for env management**. Spec §12.

## What already exists

- `python-dotenv>=1.0` in `pyproject.toml:14` — no dep change.
- `Config.cookie()` at `hoga/config.py:43` — plan plugs into existing env→`.cookie` chain.
- `hoga/api/symbols.py` 3-tier cache — plan extends existing module-level pattern.
- `hoga/api/calendar.py:_month_cache` — plan adds `_last_failure_reason` next to it.
- `hoga/api/error_codes.py::CaptureErrorCode` — plan splits per ADR-0009.
- `frontend/src/api/client.ts::ApiError` — Task 13 reuses (D3 fix).
- All target frontend components exist — plan modifies, doesn't build parallel UI.
- Existing test modules being extended; no new test-infra files.

## Failure modes

| Codepath | Failure scenario | Test? | Handling? | Silent? |
|---|---|---|---|---|
| `_main_repo_root()` git subprocess | git binary missing | ✓ | ✓ FileNotFoundError → None | No |
| `_main_repo_root()` git subprocess | rev-parse timeout | ✗ low ROI | ✓ 2s timeout → None | No |
| `_discover_env_file()` cached | Worktree moved at runtime | ✗ | Soft (cache stale, but worktrees don't move during process life) | Soft |
| `_do_fetch_and_populate` pre-check | KRX_PW empty string | ✓ | ✓ truthiness | No |
| `_do_fetch_and_populate` pykrx call | pykrx raises | ✓ | ✓ broad except → reason | No |
| `_do_fetch_and_populate` stale path | Warm cache + pykrx fails | ✓ T1 added | ✓ status="stale" + reason | No |
| `refresh()` load_env under lock | `.env` deleted between calls | ✗ | ✓ python-dotenv silent | Soft |
| `_trading_days_for` pykrx call | pykrx raises | ✓ | ✓ returns None, reason set | No |
| `trading_days_in_range` mid-range | Pykrx fails on month 2 | ✗ derivative | ✓ KrxUnavailableError | No |
| Captures enqueue 503 | KrxUnavailableError propagation | ✓ | ✓ HTTPException 503 with code | No |
| Frontend `ApiError.code` | 503 body without detail.code | ✗ apiCall wraps | ✓ fall through to generic | Soft |

**No critical gaps.**

## Worktree parallelization

Sequential T1→T15 for solo dev. Subagent-driven approach naturally parallelizes by spawning fresh agents per task with no shared state. After T1 (UpstreamCode enum), T4 (env.py) can run in parallel with T2/T3 (migration + reason fields) — disjoint modules. T11–T14 all depend on T9 + T10 but can themselves run in parallel.

## Implementation Tasks (review-driven, applied inline to plan)

- [x] **T_A1 (P1)** — `hoga/env.py` cache discovery (D2). APPLIED to plan Task 4: sentinel `_NOT_DISCOVERED`, `reset_discovery_for_tests()`, two new caching tests.
- [x] **T_C1 (P2)** — `frontend/src/capture/CaptureForm.tsx` `ApiError` typing (D3). APPLIED to plan Task 13.
- [x] **T_T1 (P2)** — `tests/test_api_symbols.py` stale-path test (D4). APPLIED to plan Task 6: `test_get_all_stale_path_carries_reason`.

All review-driven tasks absorbed into existing plan tasks. No new freestanding tasks.

## Completion Summary

- Step 0 Scope Challenge: full scope accepted (17 files, deliberate per Q5/Q6/Q7)
- Architecture Review: 1 issue (A1 P1) — resolved via cache
- Code Quality Review: 1 issue (C1 P2) — resolved via typed `ApiError` access
- Test Review: 86% coverage, ★★★ on key paths, 1 gap (T1) — resolved via new stale-path test
- Performance Review: covered by A1, no additional findings
- NOT in scope: 7 items written
- What already exists: 8 items written
- TODOS.md updates: 0
- Failure modes: 11 codepaths, 0 critical gaps
- Outside voice: skipped (user → option 1 execution)
- Parallelization: lanes mapped; sequential for solo dev
- Lake Score: 3/3 chose complete option

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (scope decided via brainstorming + grilling) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run (user → implementation) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 issues (1 P1, 2 P2), all resolved inline; 86% coverage with ★★★ key paths |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (changes follow existing DESIGN.md tokens) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run (internal recovery UX, not API surface) |

**UNRESOLVED:** 0
**VERDICT:** ENG CLEARED — ready to implement.

