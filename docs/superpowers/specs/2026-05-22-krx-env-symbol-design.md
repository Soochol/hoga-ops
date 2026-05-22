# KRX Credentials via `.env` + Symbol Master Recovery UX

**Status:** Draft (awaiting user review)
**Date:** 2026-05-22
**Spec owner:** blessp@naver.com
**Related:**
- `CONTEXT.md` — domain language. This spec uses **Symbol Master** (the `(Code, name, market)` catalog sourced from pykrx) and **Code** (the 6-digit KRX ticker, e.g., `005930`). Per `CONTEXT.md`, bare "symbol" is _Avoid_'d in prose; only sanctioned compounds (`Symbol Master`, `SymbolHit`, `SymbolsAllResponse`, `SymbolSearch`, `useSymbols`) appear here.
- `docs/adr/0008-env-discovery-worktree-fallback.md` — decision record for the worktree-aware `.env` discovery (§5.1).
- `docs/adr/0009-upstream-code-separate-enum.md` — decision record for the `UpstreamCode` enum (§5.4, §5.8). Same string values appear on cache-style envelopes (`reason` field) and on HTTP error responses (`code` field); the field name signals response shape, the enum value signals the upstream condition.
- `DESIGN.md` — design system tokens. **Source of truth for any visual question this spec does not answer.**
- `hoga/api/symbols.py` — existing pykrx-backed symbol master cache (Tier 1 warm prefetch / Tier 2 lazy GET / Tier 3 stale fallback). Modified, not replaced.
- `hoga/config.py` — existing env-var/`.cookie` resolution for `HOGAPLAY_COOKIE`. Behavior preserved.
- `frontend/src/capture/SymbolSearch.tsx:119` — current "종목 목록 미가용" empty-state message that this spec replaces with a reason-aware hint + Refresh affordance.
- `pyproject.toml:14` — `python-dotenv>=1.0` already declared. Currently unused.

**Authority order if these disagree:** This spec (WHAT and WHY) → `DESIGN.md` (visual tokens) → existing code (current behavior).

---

## 1. Goal

Make the **pykrx-backed Symbol Master** actually work for end users by giving them a documented, low-friction way to provide their **KRX login credentials** (`KRX_ID`, `KRX_PW`), and turn the current silent failure mode ("종목 목록 미가용" with no explanation) into an **actionable recovery flow**.

Today the backend logs `KRX 로그인 실패: KRX_ID 또는 KRX_PW 환경 변수가 설정되지 않았습니다`, and the frontend shows a generic empty-state message that does not mention credentials. Users cannot self-recover.

This spec covers three intertwined changes:

1. A small repo-root `.env` loader (`hoga/env.py`) that injects `KRX_ID`, `KRX_PW`, and `HOGAPLAY_COOKIE` into `os.environ` at CLI startup and on `POST /api/symbols/refresh`. Worktree-aware discovery per ADR-0008.
2. A failure-reason field threaded from `hoga/api/symbols.py` through the `SymbolsAllResponse` model into the frontend, plus a Refresh affordance in the empty-state UI.
3. Mirrored failure-reason handling in the second pykrx call site (`hoga/api/calendar.py`) — fail-soft on the calendar read path (banner + best-effort cell rendering) and fail-fast on the range-capture enqueue path (HTTP 503 with reason).

## 2. Non-goals

- **Generalized config-file system.** Operational settings (`HOGA_DATA_DIR`, `HOGA_MAX_CONCURRENT`, `WEB_CONCURRENCY`, `HOGA_ENABLE_TEST_ENDPOINTS`) stay in shell env. `.env` is reserved for **external-service secrets**. This keeps the surface small and the threat model clear.
- **Automatic `.env` file watching.** A `watchdog`-based hot-reload was considered and rejected: ROI is low (users rarely re-edit `.env` mid-session) and it adds a moving part. Refresh-endpoint re-load (override=True) covers the common case.
- **Username/password → cookie auto-login for hogaplay.** Out of scope. `HOGAPLAY_COOKIE` is still a session cookie string copied from a logged-in browser, as today.
- **Migrating away from the legacy `.cookie` file.** It continues to work as a fallback for `HOGAPLAY_COOKIE`. No user is forced to move.
- **Validating credential format inside `load_env()`.** Validation happens at point of use (pykrx, hogaplay client), and the failure reason is surfaced via the existing `status="unavailable"` path.
- **Networked tests against the real KRX endpoint.** Test strategy uses monkeypatched fetchers; live E2E against KRX is a manual checklist item.
- **Holiday accuracy on calendar fail-soft.** When KRX is unavailable, every weekday is treated as a trading day. Public holidays mis-classify as "none" rather than "holiday". This is acceptable for v1 because the user is shown a banner. Surveying every recent KRX holiday from a local list is out of scope.

## 3. Stack & Conventions

- Backend: Python 3.11+ (FastAPI, pykrx). `python-dotenv>=1.0` already in `pyproject.toml`.
- Frontend: React + TypeScript + Vite. React Query manages the `useSymbols()` cache (`frontend/src/capture/useSymbols.ts`).
- ADR-0006 single-module pattern is honored: state (`_last_failure_reason`) lives alongside the existing module-level state in `hoga/api/symbols.py`.

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  User writes KRX_ID, KRX_PW, HOGAPLAY_COOKIE to repo .env   │
└─────────────────────────────────────────────────────────────┘
              │
              ▼  (called at CLI boot + at refresh)
┌─────────────────────────────────────────────────────────────┐
│  hoga/env.py — load_env(override: bool = False) -> Path|None│
│    • Locates repo-root .env relative to this file           │
│    • Delegates to python-dotenv's load_dotenv()             │
│    • Returns the loaded path, or None if absent             │
└─────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
   hoga/cli.py serve()             hoga/api/symbols.py
   load_env()  ← once             refresh path:
                                    load_env(override=True)
                                    → re-fetch from pykrx
              │
              ▼
   pykrx reads KRX_ID/KRX_PW from os.environ;
   hoga/config.py:Config.cookie() reads HOGAPLAY_COOKIE
   from os.environ (with .cookie file as legacy fallback).
```

**Precedence:** shell env > `.env` > `.cookie` file (`HOGAPLAY_COOKIE` only).

This is what `python-dotenv`'s `override=False` (default) already enforces — values already present in `os.environ` are preserved. Only the `refresh` endpoint calls with `override=True`, because at that point the user has just edited `.env` and expects the new values to win.

## 5. Backend Components

### 5.1 `hoga/env.py` (new, ~50 lines)

**Worktree-aware discovery** (see ADR-0008): when the working tree is a git worktree, a missing local `.env` falls back to the main repo's `.env`. In a normal checkout, behavior is identical to a flat repo-root lookup.

```python
"""Repo-root .env loader for hoga-ops secrets.

Discovery order (see ADR-0008):
    1. <working-tree>/.env (resolved relative to this file).
    2. <main-repo-root>/.env via `git rev-parse --git-common-dir` —
       used only when (1) is absent AND we are inside a git worktree.
       In a normal checkout, (1) and (2) point to the same path.

Loaded keys (all optional — missing keys fall back to other sources):
    KRX_ID, KRX_PW         pykrx login (Symbol Master fetch)
    HOGAPLAY_COOKIE        hogaplay session cookie

Precedence: shell env > .env > .cookie file (legacy, for HOGAPLAY_COOKIE only).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from dotenv import load_dotenv

_WORKING_TREE = Path(__file__).resolve().parent.parent


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
    """Return the .env path to load, or None if none exists."""
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
    - ``override=True``: .env wins over shell env. Use after the user has edited
      .env and explicitly triggered a refresh.
    """
    dotenv_path = _discover_env_file()
    if dotenv_path is None:
        return None
    load_dotenv(dotenv_path=dotenv_path, override=override)
    return dotenv_path
```

### 5.2 `hoga/cli.py` (1 line added)

In the `serve()` function body, before `uvicorn.run(...)`:

```python
from hoga.env import load_env
load_env()
```

Other subcommands (`parse`, `ls`, etc.) do **not** call `load_env()` — they don't need KRX or hogaplay credentials. Deliberate scope: `.env` is only relevant when serving the API.

### 5.3 `hoga/api/symbols.py` (~15 lines)

**Two-axis state model.** The existing module already tracks `_status` ("can we serve data right now?") with values `"loading" | "fresh" | "stale" | "unavailable"` (per `hoga/api/symbols.py:25` and mirrored in `frontend/src/api/types.ts:189` as `SymbolsCacheStatus`). This spec adds an **orthogonal** axis `_last_failure_reason` ("if the last fetch failed, why?"). Both fields surface in the API response; meaningful combinations:

| `_status` | `_last_failure_reason` | Meaning | Frontend behavior |
|---|---|---|---|
| `"fresh"` | `null` | All good | Normal autocomplete; no hint, no Refresh button |
| `"loading"` | `null` (or previous value) | First fetch in flight | Spinner state; the frontend already handles this |
| `"stale"` | `"krx_fetch_failed"` | Cache has data but last refresh failed | Autocomplete works against stale cache; Refresh button visible; no hint banner |
| `"unavailable"` | `"krx_credentials_missing"` | No cache, `KRX_ID` and/or `KRX_PW` not set | Hint: configure `.env`; Refresh button visible |
| `"unavailable"` | `"krx_fetch_failed"` | No cache, creds set but pykrx call failed (rejected by KRX, network error, etc.) | Hint: verify creds + try Refresh; Refresh button visible |

The reason enum is intentionally only two values. A more granular split (login_failed vs network_error vs upstream_500) was rejected: distinguishing them reliably requires parsing pykrx's internal exception strings, which break silently across pykrx versions. The user-facing remediation for `krx_fetch_failed` ("verify creds, try Refresh") is the same regardless of root cause, so the extra enum values would not change UX behavior.

Add module-level state alongside the existing `_cache`, `_fetched_at_ms`, `_status`, `_inflight`:

```python
from hoga.api.error_codes import UpstreamCode

_last_failure_reason: UpstreamCode | None = None
```

Modify `_do_fetch_and_populate()` (`hoga/api/symbols.py:134`) to **pre-check credentials before calling pykrx**, and treat any post-call exception as a generic fetch failure:

```python
async def _do_fetch_and_populate(data_dir: Path) -> None:
    """Inner helper — runs under in-flight Future protection."""
    global _cache, _fetched_at_ms, _status, _last_failure_reason  # noqa: PLW0603

    # Pre-check: deterministically classify "missing credentials" without
    # depending on pykrx's exception message format (which can change
    # across versions). Also saves the network round-trip when creds absent.
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

    # ... existing breakdown-build + cache assignment unchanged ...
    _last_failure_reason = None  # clear on success
    _status = "fresh"
```

The `global` declaration adds `_last_failure_reason` to the existing pattern. The empty/whitespace string check (`os.environ.get(...)` returns `None` for unset; truthiness check also catches `""`). No new `_classify_failure` helper — the pre-check inlines all the classification logic that is reliable, and everything after the pykrx call is collapsed into one reason.

**Imports.** `os` is not currently imported in `hoga/api/symbols.py` (verified at `hoga/api/symbols.py:13-16`). This spec adds `import os` to the module's import block — the only new top-level dependency for this file.

Modify the existing `refresh()` function (`hoga/api/symbols.py:199`) to call `load_env(override=True)` **inside the existing lock**, paired with the `_fetched_at_ms = None` reset:

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

**Concurrency model:**

| Scenario | Behavior |
|---|---|
| Single Refresh click | lock → load_env → reset → release → get_all initiates fetch |
| N rapid Refresh clicks | Each caller serializes through `_lock` for load_env + reset; only one new `_do_fetch_and_populate` Future runs (existing `_inflight` dedupe); subsequent callers `await` the same Future |
| `.env` edited mid-fetch | The in-flight fetch uses the `os.environ` snapshot from when its `load_env` ran. A second Refresh after the fetch completes picks up the latest `.env`. This is the documented contract — a single Refresh advances to the latest `.env`, but it does not retroactively re-run an in-flight fetch |
| Boot path (`ensure_cache_warm` → `get_all`) | Does NOT call `load_env` — startup already loaded `.env` with `override=False` from `cli.py`. Re-loading during boot would unnecessarily override shell env. |

The `/api/symbols/all` and `/api/symbols/refresh` response builders (both go through `get_all()` at `hoga/api/symbols.py:164`) populate `reason=_last_failure_reason` on the response. The field is meaningful on `status="unavailable"` (no cache, hint UX kicks in) and `status="stale"` (cache exists, surfaced for telemetry). On `status="fresh"` the field is `None` because success clears it; on `status="loading"` it carries whatever the previous attempt left.

Update `reset_state_for_tests()` (existing at `hoga/api/symbols.py:31`) to also reset `_last_failure_reason` — adds it to the `global` declaration and the tuple assignment.

### 5.4 `hoga/api/models.py` (2 fields, typed via `UpstreamCode`)

Both `SymbolsAllResponse` and `CalendarResponse` gain an optional `reason` field typed as `UpstreamCode | None` (see §5.8 for the enum). The field is `None` on success or on first load; on degradation it carries the canonical upstream-failure reason.

```python
from hoga.api.error_codes import UpstreamCode

class SymbolsAllResponse(BaseModel):
    # ... existing fields ...
    reason: UpstreamCode | None = None

class CalendarResponse(BaseModel):
    # ... existing fields ...
    reason: UpstreamCode | None = None
```

Both optional, default `None`, so existing clients are unaffected.

### 5.5 `hoga/env.py` — shared KRX-creds helper

Add a stateless predicate next to `load_env()` so both `symbols.py` and `calendar.py` use one source of truth:

```python
def krx_creds_present() -> bool:
    """True iff KRX_ID and KRX_PW are set to non-empty strings in os.environ."""
    return bool(os.environ.get("KRX_ID")) and bool(os.environ.get("KRX_PW"))
```

`symbols.py`'s pre-check (§5.3) is rewritten to call `krx_creds_present()` instead of inlining the `os.environ.get` checks — keeps the rule in one place.

### 5.6 `hoga/api/calendar.py` (~30 lines, fail-soft on read, fail-fast on enqueue)

`calendar.py` is the second pykrx call site in the codebase (`stock.get_market_ohlcv(...)` at `hoga/api/calendar.py:42`). The same env-loading at `hoga serve` startup automatically makes pykrx work when `.env` is configured (positive side effect of §5.2). The remaining task is **graceful handling when KRX data is unavailable**, mirrored from the Symbol Master approach but with two distinct failure surfaces.

**Module-level state** (alongside `_month_cache` at `hoga/api/calendar.py:29`):

```python
from hoga.api.error_codes import UpstreamCode

_last_failure_reason: UpstreamCode | None = None
```

**`_trading_days_for()` rewrite** — return `None` sentinel on failure instead of raising; record reason:

```python
def _trading_days_for(year: int, month: int) -> set[str] | None:
    """Return trading days, or None when KRX data is unavailable.

    Callers decide between fail-soft (assume all weekdays trade) and
    fail-fast (surface error to user). The most recent failure reason is
    available via :func:`last_failure_reason`.
    """
    global _last_failure_reason  # noqa: PLW0603
    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached
    if not krx_creds_present():
        _last_failure_reason = UpstreamCode.KRX_CREDENTIALS_MISSING
        return None
    try:
        from pykrx import stock
        df = stock.get_market_ohlcv(
            f"{year:04d}{month:02d}01",
            f"{year:04d}{month:02d}{stdlib_calendar.monthrange(year, month)[1]:02d}",
            "005930",
        )
    except Exception:  # noqa: BLE001
        _last_failure_reason = UpstreamCode.KRX_FETCH_FAILED
        return None
    result = {d.strftime("%Y%m%d") for d in df.index}
    _month_cache[key] = result
    _last_failure_reason = None
    return result


def last_failure_reason() -> UpstreamCode | None:
    """Public accessor for the most recent KRX-availability failure."""
    return _last_failure_reason
```

**`get_month_map()` — fail-soft** (calendar UI keeps rendering):

```python
def get_month_map(*, data_dir, code, year, month) -> CalendarResponse:
    now = _now_kst()
    trading_days = _trading_days_for(year, month)
    reason = last_failure_reason() if trading_days is None else None
    # Fallback: when KRX unavailable, treat all weekdays as trading days.
    # Holidays mis-classify as "none" (not "holiday"), but the user sees the
    # `reason` banner and knows holiday accuracy is off.
    effective_trading_days = trading_days if trading_days is not None else _all_weekdays_in_month(year, month)
    # ... existing cell-building loop, unchanged ...
    return CalendarResponse(cells=cells, as_of_ms=..., reason=reason)
```

The new helper `_all_weekdays_in_month(year, month)` enumerates YYYYMMDD strings for Mon–Fri in the month — a 5-line utility using `stdlib_calendar`.

**`trading_days_in_range()` — fail-fast** (capture enqueue must not proceed with wrong day list):

```python
class KrxUnavailableError(RuntimeError):
    """KRX trading-day data unavailable. Carries an UpstreamCode for HTTP surfacing."""
    def __init__(self, code: UpstreamCode) -> None:
        super().__init__(f"KRX unavailable: {code.value}")
        self.code = code


def trading_days_in_range(start: str, end: str) -> list[str]:
    # ... existing parsing of start/end into dates ...
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        if days is None:
            raise KrxUnavailableError(last_failure_reason() or UpstreamCode.KRX_FETCH_FAILED)
        # ... existing append-into-out logic ...
```

**`captures.py` enqueue route** — catch the new exception and surface as HTTP 503 using the project's `code`/`message` envelope pattern (mirrors `TODAY_TOO_EARLY` handling at `hoga/api/captures.py:700`):

```python
# Inside the enqueue route handler (POST /api/captures/items at line 676).
# `_expand_to_trading_days(...)` at line 690 is the call site that raises.
from hoga.api.calendar import KrxUnavailableError, trading_days_in_range
try:
    candidate_dates = _expand_to_trading_days(req.start_date, req.end_date)
except KrxUnavailableError as e:
    raise HTTPException(
        status_code=503,
        detail={"code": e.code, "message": "KRX trading-day list unavailable. Configure KRX_ID/KRX_PW in .env."},
    ) from e
```

The `code` field carries an `UpstreamCode` value (FastAPI serializes the `StrEnum` to its string value automatically), matching the existing `code: CaptureErrorCode` pattern. The frontend's HTTP-error consumer reads `error.detail.code` and branches via the shared hint map (§6).

Reset helpers: `reset_cache_for_tests()` (`hoga/api/calendar.py:76`) gains a `_last_failure_reason = None` clear.

### 5.7 `hoga/api/error_codes.py` — new `UpstreamCode` enum + cookie/hogaplay migration (ADR-0009)

Two changes to the enum module, executed together:

**(1) `UpstreamCode` enum (new)** — all upstream-dependency availability codes live here:

```python
class UpstreamCode(StrEnum):
    """Upstream-dependency availability codes.

    Used for both:
      • cache-style envelopes (HTTP 200) as ``reason: UpstreamCode | None`` —
        the data is still served (possibly stale or empty), and the code
        explains the most recent upstream condition.
      • HTTP error responses (5xx) as ``detail.code: UpstreamCode`` —
        the request could not proceed because an upstream dependency
        is unavailable.
      • Per-item SSE failure codes on ``capture_finished.error.code`` —
        the captured item's pipeline hit an upstream issue.

    The string values are stable across all surfaces; the field name
    (``reason`` vs ``code``) signals the response shape. See ADR-0009.
    """

    # KRX (pykrx symbol-master, calendar trading-days)
    KRX_CREDENTIALS_MISSING = "krx_credentials_missing"
    KRX_FETCH_FAILED = "krx_fetch_failed"

    # hogaplay (capture pipeline). Migrated from CaptureErrorCode in 2026-05-22.
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
```

**(2) `CaptureErrorCode` trimmed** — removes the three migrated values; only captures-domain non-upstream codes remain:

```python
class CaptureErrorCode(StrEnum):
    """Captures-domain non-upstream codes: request gating + lifecycle states."""
    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"
```

**Why migrate now instead of deferring**

The three cookie/hogaplay codes are conceptually upstream-availability — same category as the new KRX codes. The original "they trigger lifecycle, KRX doesn't" framing doesn't survive code inspection: `HOGAPLAY_HTTP_ERROR` is upstream and lifecycle-neutral (same as KRX codes), and `COOKIE_EXPIRED`'s queue-pause behavior is tied to the string value (handled in `_handle_cookie_expired`), not to the enum it lives in. Leaving them in `CaptureErrorCode` creates permanent mixed-category debt; migrating now is mechanical because the wire-contract string values stay stable.

**Backend call-site updates** (mechanical, 4 lines in `hoga/api/captures.py`):

- `captures.py:68` `CaptureErrorCode.COOKIE_MISSING` → `UpstreamCode.COOKIE_MISSING`
- `captures.py:70` `CaptureErrorCode.COOKIE_EXPIRED` → `UpstreamCode.COOKIE_EXPIRED`
- `captures.py:72` `CaptureErrorCode.HOGAPLAY_HTTP_ERROR` → `UpstreamCode.HOGAPLAY_HTTP_ERROR`
- `captures.py:576` `CaptureErrorCode.COOKIE_EXPIRED` → `UpstreamCode.COOKIE_EXPIRED`

`_exception_to_error_code()` return type widens from `CaptureErrorCode | None` to `CaptureErrorCode | UpstreamCode | None`. The string values produced are unchanged.

**Frontend mirror updates** (`frontend/src/api/types.ts`):

```ts
/** Mirrors hoga/api/error_codes.py::CaptureErrorCode (captures-domain). See ADR-0009. */
export type CaptureErrorCode =
  | 'today_too_early'
  | 'missing_range'
  | 'terminal'
  | 'not_found'
  | 'internal_error';

/** Mirrors hoga/api/error_codes.py::UpstreamCode. See ADR-0009. */
export type UpstreamCode =
  | 'krx_credentials_missing'
  | 'krx_fetch_failed'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error';

/** Union used wherever an error code can be either domain — currently
 *  CaptureError.code on the per-item SSE capture_finished payload. */
export type CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode;
```

`CaptureError.code: CaptureErrorCode` becomes `CaptureError.code: CaptureFinishedErrorCode`. The wire shape is unchanged — only the TypeScript type widens.

**Non-impact: `capture_queue_paused.reason`** (`types.ts:164`) — this field is typed as the bare literal `'cookie_expired'`, not as `CaptureErrorCode`. Migration leaves it untouched.

**Test updates** — any backend/frontend test that imports `CaptureErrorCode.COOKIE_*` or `CaptureErrorCode.HOGAPLAY_HTTP_ERROR` is updated to import from `UpstreamCode`. Mechanical find/replace.

The module docstring of `error_codes.py` is rewritten to describe the two-enum split.

### 5.8 `.gitignore` (1 line) and `.env.example` (new, committed)

`.gitignore` already excludes `.cookie`; add `.env` on a new line.

`.env.example`:

```
# Copy this file to .env and fill in your values.
# .env is gitignored; do not commit secrets.

# KRX login (data.krx.co.kr). Required for pykrx Symbol Master fetch
# (used by GET /api/symbols/all). Sign up at https://data.krx.co.kr/.
KRX_ID=your-krx-id
KRX_PW=your-krx-password

# Hogaplay session cookie. Copy from a logged-in browser session,
# format: "k_=...; n_=...". Optional if you keep using the legacy
# .cookie file at the repo root.
HOGAPLAY_COOKIE=
```

## 6. Frontend Components

### 6.1 `frontend/src/api/types.ts` and `frontend/src/api/upstream-hints.ts`

**Type additions** (`types.ts`):

1. New union mirroring `UpstreamCode` (ADR-0009 / ADR-0004 mirror discipline):
   ```ts
   /** Mirrors hoga/api/error_codes.py::UpstreamCode. See ADR-0009. */
   export type UpstreamCode =
     | 'krx_credentials_missing'
     | 'krx_fetch_failed'
     | 'cookie_expired'
     | 'cookie_missing'
     | 'hogaplay_http_error';
   ```
2. `CaptureErrorCode` shrinks to remove the migrated values (cookie/hogaplay). New alias `CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode` for the `CaptureError.code` field.
3. Extend `SymbolsAllResponse` and `CalendarResponse` (existing at `types.ts:192` and `:216`) with optional `reason?: UpstreamCode | null`.

**New module `frontend/src/api/upstream-hints.ts`** — the single home for user-facing hint copy keyed by `UpstreamCode`. Per-surface maps, each typed as `Record<UpstreamCode, ReactNode>` so TypeScript's exhaustive checking guarantees that every new `UpstreamCode` value gets explicit copy at every consumer:

```ts
import type { ReactNode } from 'react';
import type { UpstreamCode } from './types';

/** Empty-state hint for SymbolSearch (cache unavailable). */
export const symbolSearchHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>KRX 자격증명이 없습니다 — repo 루트 <code>.env</code>에 <code>KRX_ID</code>, <code>KRX_PW</code>를 설정한 뒤 아래 <strong>Refresh</strong> 버튼을 누르세요.</>,
  krx_fetch_failed: <>KRX에서 종목 목록을 가져오지 못했습니다 — <code>.env</code>의 자격증명을 확인하고 잠시 후 Refresh를 시도하세요.</>,
  cookie_expired: <>hogaplay 쿠키가 만료되어 종목 목록을 가져올 수 없습니다 — 쿠키를 갱신하세요.</>,
  cookie_missing: <>hogaplay 쿠키가 없습니다 — <code>.env</code> 또는 <code>.cookie</code> 파일에 설정하세요.</>,
  hogaplay_http_error: <>hogaplay에서 오류가 반환되었습니다 — 잠시 후 Refresh를 시도하세요.</>,
};

/** Banner above the calendar grid (data still renders; banner is informational). */
export const calendarHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>KRX 자격증명이 없어 휴일 표시가 정확하지 않을 수 있습니다 — <code>.env</code>에 <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.</>,
  krx_fetch_failed: <>KRX에서 거래일 데이터를 가져오지 못해 휴일 표시가 정확하지 않을 수 있습니다.</>,
  cookie_expired: <>hogaplay 쿠키 만료 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  cookie_missing: <>hogaplay 쿠키 미설정 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
  hogaplay_http_error: <>hogaplay 일시 오류 — 캡처 가능 여부가 정확하지 않을 수 있습니다.</>,
};

/** Inline error in the range-capture form when enqueue returns HTTP 503. */
export const enqueueErrorHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>범위 캡처 시작 실패 — KRX 자격증명이 필요합니다. <code>.env</code>에 <code>KRX_ID</code>, <code>KRX_PW</code>를 설정하세요.</>,
  krx_fetch_failed: <>범위 캡처 시작 실패 — KRX 거래일 데이터를 가져올 수 없습니다. 잠시 후 재시도하세요.</>,
  cookie_expired: <>범위 캡처 시작 실패 — hogaplay 쿠키 만료. 쿠키를 갱신하세요.</>,
  cookie_missing: <>범위 캡처 시작 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>범위 캡처 시작 실패 — hogaplay 응답 오류. 잠시 후 재시도하세요.</>,
};

/** Per-item failure toast/inline display from capture_finished SSE event. */
export const captureFinishedHints: Record<UpstreamCode, ReactNode> = {
  krx_credentials_missing: <>캡처 실패 — KRX 자격증명 필요.</>,
  krx_fetch_failed: <>캡처 실패 — KRX 응답 오류.</>,
  cookie_expired: <>캡처 실패 — hogaplay 쿠키 만료. 큐 일시중지됨.</>,
  cookie_missing: <>캡처 실패 — hogaplay 쿠키 미설정.</>,
  hogaplay_http_error: <>캡처 실패 — hogaplay 응답 오류.</>,
};
```

`capture_queue_paused.reason` (existing SSE event, typed independently as the bare literal `'cookie_expired'`) keeps its current copy and is **not** wired into this map — that field's type is not `UpstreamCode` and its surface is distinct (a sticky banner across the whole queue, not a per-item or per-request message). This is intentional: the migration does not consolidate the queue-pause banner.

**Consumers:**
- §6.2 SymbolSearch → `symbolSearchHints`
- §6.3 calendar banner → `calendarHints`
- §6.4 range-capture inline error → `enqueueErrorHints`
- (existing) per-item capture-finished toast → `captureFinishedHints` (this spec rewires the existing inline `code === 'cookie_expired' ? '...' : ...` to consume the map; cookie/hogaplay copy is preserved verbatim from current behavior)

**Exhaustive-check guarantee:** Adding a new `UpstreamCode` value to the type triggers a TypeScript error in every map that lacks the new key. The compiler enforces that all four surfaces have explicit copy before the change ships. This is the structural payoff of (B).

### 6.2 `frontend/src/capture/SymbolSearch.tsx` (~30 lines)

Replace the line 119 fallback with a **reason-aware hint + Refresh button**:

- Import `symbolSearchHints` from `frontend/src/api/upstream-hints.ts` and look up the hint by `data.reason`.
- Fallback to the existing "종목 목록 미가용 — 6자리 코드 입력 후 Enter 로 확정." when `data.reason` is null or undefined (i.e., the backend didn't classify a reason).

**Visibility rules (deliberately split, mapped to the two-axis state model in §5.3):**
- **Hint** renders only when `data.status === "unavailable"` (the Symbol Master is empty — there are no entries to autocomplete against). Reason-aware copy when `data.reason` is non-null; fallback copy otherwise.
- **Refresh button** renders whenever `data.status === "unavailable" || data.status === "stale"`. On stale, the user still sees the cached Symbol Master entries AND a Refresh button, with no hint banner.
- `"loading"` and `"fresh"` show neither hint nor Refresh button. (`"loading"` only appears during the first cold fetch; subsequent refreshes keep the prior status until the new fetch lands.)

The button calls `refreshSymbols()` (already exported from `frontend/src/api/symbols.ts:12`) and invalidates the React Query `symbols-all` cache so `useSymbols()` re-fetches.

Visual treatment uses existing button/code/kbd styles from `DESIGN.md`. No new tokens.

### 6.3 Calendar UI banner

In the calendar component (the consumer of `useCalendar`, `frontend/src/capture/useCalendar.ts:59`), when `data.reason` is non-null, render a single-line banner **above** the month grid. Copy comes from `calendarHints` (§6.1).

The grid itself still renders — every weekday is treated as a trading day, so capture-state coloring keeps working. The banner is informational, not a blocking error.

### 6.4 Range capture enqueue — HTTP 503 surfacing

When `POST /api/captures/items` (range form) returns HTTP 503 with `{"code": UpstreamCode, "message": ...}`, the capture form reads `error.detail.code` and shows an inline error message from `enqueueErrorHints` (§6.1). The fetch helper (`apiCall`) already surfaces error bodies for `CaptureErrorCode` handling — the new path reuses that machinery, only the keyed code values differ.

### 6.5 Capture-finished error toast — migration to map-driven copy

The existing per-item failure UI consumes `capture_finished.error.code` (now typed `CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode`). Any code that previously did `error.code === 'cookie_expired'` inline string comparisons remains correct (string values stable) but should be migrated to look up the hint via `captureFinishedHints` when the code is an `UpstreamCode`. `CaptureErrorCode` values keep their existing per-code copy. Copy for `cookie_expired`, `cookie_missing`, `hogaplay_http_error` is preserved verbatim from current behavior.

### 6.6 No changes

- `useSymbols.ts`, `filterSymbols`, `searchSymbols` — `reason` is additive and unused by these paths.
- Normal happy-path autocomplete behavior is unchanged.
- Single-date capture enqueue is unaffected (no `trading_days_in_range` call).
- `capture_queue_paused.reason` event handler — keeps its current narrow type and copy; outside this migration's scope.
- **Search route (`GET /api/symbols?q=...`) return shape is unchanged.** It returns `list[SymbolHit]` (no envelope, no `reason`). Failure-reason surfacing happens via `/all`, which the frontend uses exclusively (`useSymbols()` → `getAllSymbols()` → local `filterSymbols()` in-memory filter). If a future external consumer of the search route needs reason awareness, it can be added later as an optional envelope field without breaking current callers.

## 7. Data Flow

### 7.1 Cold boot, no `.env`

1. `hoga serve` → `load_env()` returns `None` silently.
2. App startup spawns `ensure_cache_warm(data_dir)` (`hoga/api/app.py:60`).
3. `_fetch_from_pykrx()` raises (KRX_ID/PW missing).
4. Pre-check inside `_do_fetch_and_populate()` sees `KRX_ID`/`KRX_PW` unset → sets `_last_failure_reason = "krx_credentials_missing"`, `_status = "unavailable"`, returns without calling pykrx.
5. `GET /api/symbols/all` → `{symbols: [], status: "unavailable", fetched_at_ms: null, reason: "krx_credentials_missing"}`.
6. Frontend renders the credentials hint + Refresh button.

### 7.2 Recovery after user edits `.env`

1. User writes `KRX_ID=…` and `KRX_PW=…` to repo-root `.env`.
2. User clicks **Refresh** in the SymbolSearch empty state.
3. `POST /api/symbols/refresh` handler calls `load_env(override=True)` → `os.environ` updated.
4. Existing refresh logic runs `_fetch_from_pykrx()` under `_fetch_lock` → succeeds.
5. Response: `{symbols: [...~6000], status: "fresh", fetched_at_ms: <ms>, reason: null}`.
6. React Query receives the new payload; autocomplete works.

### 7.3 KRX transient outage

1. pykrx call raises something unrelated to credentials.
2. `except Exception` catches it → `_last_failure_reason = "krx_fetch_failed"`.
3. If `_cache` is non-empty from a prior success: existing Tier 3 logic returns `status="stale"` with the old data; `reason` is still populated for telemetry but the UI shows the data, not the hint.
4. If `_cache` is empty: `status="unavailable"`, hint advises Refresh.

## 8. Edge Cases

| Case | Behavior |
|---|---|
| No `.env` anywhere | `load_env()` returns `None`. No error. Shell env still consulted. |
| Worktree has no `.env`, main repo has one | Main repo's `.env` loaded automatically (ADR-0008). |
| Both worktree `.env` and main repo `.env` exist | Worktree wins — its `.env` loaded, main repo's ignored. |
| Not inside a git repo (tarball install) | `git rev-parse` fails → fallback skipped → behavior reduces to flat working-tree-only lookup. |
| `git` binary not on `PATH` | `FileNotFoundError` caught → no fallback. Local `.env` still works. |
| `.env` present but only `KRX_ID` set | Pre-check sees missing `KRX_PW` → `krx_credentials_missing` reason, no pykrx call attempted. |
| `KRX_ID`/`KRX_PW` set to empty string | Truthiness check treats `""` as unset → `krx_credentials_missing`. |
| `KRX_ID/KRX_PW` syntactically valid but rejected by KRX | pykrx raises → `krx_fetch_failed` reason. |
| Calendar viewed with KRX creds missing | `_trading_days_for` returns `None`; `get_month_map` falls back to all-weekdays-trade; `CalendarResponse.reason="krx_credentials_missing"` → frontend banner. Grid still renders. |
| Calendar viewed after KRX fetch fails mid-month | Cache from prior month-success persists for that key; new months hit pykrx, fail → `krx_fetch_failed`. Mixed-reason scenarios: each month is independent, `last_failure_reason()` reflects the most-recent attempt. |
| Range capture enqueue with KRX creds missing | `trading_days_in_range` raises `KrxUnavailableError(UpstreamCode.KRX_CREDENTIALS_MISSING)` → enqueue route returns HTTP 503 `{"code": "krx_credentials_missing", "message": "..."}`. Frontend shows code-aware inline error. |
| Single-date capture enqueue with KRX creds missing | Unaffected — single-date path does not call `trading_days_in_range`. |
| `.cookie` file and `.env` HOGAPLAY_COOKIE both present | `.env` wins on shell-env injection; `Config.cookie()` reads env first. Existing precedence preserved. |
| Concurrent `POST /api/symbols/refresh` calls | Existing `_fetch_lock` (asyncio.Lock) serializes — unchanged. |
| `override=True` overwrites legitimate shell env | Intentional: the user just edited `.env` and explicitly triggered refresh; their latest edit is the truth. Boot path uses `override=False`, so shell-env-only deployments are unaffected. |
| `.env` contains malformed lines | python-dotenv tolerates and logs warnings; partial keys still loaded. No crash. |
| User runs `hoga parse` instead of `hoga serve` | `load_env()` is not called. `parse` does not need KRX credentials. Intentional. |

## 9. Testing Strategy

### 9.1 Backend unit tests

**New: `tests/test_env_loader.py`**

- Returns `None` when no `.env` present (using `monkeypatch` to point `_WORKING_TREE` at a `tmp_path`).
- Loads keys from a `.env` into `os.environ`.
- `override=False` preserves existing `os.environ` values.
- `override=True` overwrites existing `os.environ` values.
- **Worktree fallback (ADR-0008):**
  - Stub `_main_repo_root()` to return a `tmp_path` containing `.env`; `_WORKING_TREE` points to a sibling dir without `.env` → fallback loads main's `.env`.
  - Local `.env` and main `.env` both present → local wins (assert path returned).
  - `_main_repo_root()` returns `None` (simulate non-git) → fallback skipped; returns `None` when local also absent.
  - `subprocess.run` raises `FileNotFoundError` (simulate missing `git` binary) → `_main_repo_root()` returns `None` without raising.

**Extend: `hoga/api/test_routes.py` and/or `tests/api/test_symbols.py`** (whichever already covers `/api/symbols/*`)

- With `KRX_ID`/`KRX_PW` unset in `os.environ` (use `monkeypatch.delenv`) → assert response `reason == "krx_credentials_missing"`, `status == "unavailable"`, and that `_fetch_from_pykrx` was **not** called.
- With `KRX_ID`/`KRX_PW` set to empty strings → same as above (truthiness check).
- With creds set + `_fetch_from_pykrx` monkeypatched to raise any exception → assert `reason == "krx_fetch_failed"`, `status == "unavailable"` (empty cache) or `"stale"` (pre-populated cache).
- With creds set + successful fetch → assert `reason is None`, `status == "fresh"`.
- Assert `reset_state_for_tests()` clears `_last_failure_reason`.

**New/extend: `tests/api/test_calendar.py`** (whichever covers `/api/inventory/calendar` today)

- With creds unset, `_trading_days_for(2026, 5)` returns `None` and `last_failure_reason() == "krx_credentials_missing"`.
- With creds set + pykrx monkeypatched to raise, returns `None` and `last_failure_reason() == "krx_fetch_failed"`.
- `get_month_map(...)` with creds unset → `CalendarResponse.reason == "krx_credentials_missing"`; all weekday cells appear in `cells` (not silently dropped); status of each weekday cell is `"none"` (not `"holiday"`) absent disk state.
- `trading_days_in_range("20260501", "20260531")` raises `KrxUnavailableError(code=UpstreamCode.KRX_CREDENTIALS_MISSING)` when creds missing.
- Enqueue route integration: `POST /api/captures/items` with range and creds missing → 503 with body `{"code": "krx_credentials_missing", "message": "..."}`.
- Assert `reset_cache_for_tests()` clears `_last_failure_reason`.

### 9.2 Frontend unit tests

**Extend: `frontend/src/capture/useSymbols.test.tsx`** (or co-locate a `SymbolSearch.test.tsx`)

- For each `reason` value, render with mocked `useSymbols()` data and assert the matching hint text appears (RTL `getByText` with a partial regex on the localized strings).
- Assert the Refresh button is present when `status` is `"unavailable"` or `"stale"`, and absent when `status` is `"fresh"` or `"loading"`.
- Assert clicking Refresh calls `refreshSymbols()` (mock the module).

### 9.3 Manual verification checklist (release gate)

1. Worktree root: create `.env` with valid `KRX_ID`/`KRX_PW`.
2. `uv run hoga serve` (restart).
3. Frontend: type "삼성" in `SymbolSearch` → autocomplete resolves to a **Code** and shows results.
4. Replace `.env` with an empty file; click **Refresh** in the empty state → "KRX 자격증명이 없습니다" hint appears.
5. Restore `.env`; click **Refresh** → autocomplete recovers without server restart.

### 9.4 Manual verification — calendar + range capture

6. With creds unset, open the calendar in the capture UI → banner appears above the grid; cells render as weekdays/weekends without holiday classification.
7. Submit a range capture (multi-day) with creds unset → inline error message keyed to `krx_credentials_missing`; no 500 toast.
8. Set creds + refresh → banner disappears within one calendar fetch cycle; range capture proceeds.

## 10. Migration & Compatibility

- **No breaking changes.** Existing deployments that set `KRX_ID`/`KRX_PW`/`HOGAPLAY_COOKIE` via shell env continue to work; `.env` is purely additive.
- **`.cookie` file path is preserved** as a fallback for `HOGAPLAY_COOKIE`. Users may switch at their own pace.
- **No schema migration.** `reason` is an optional new field on both `SymbolsAllResponse` and `CalendarResponse`; older frontend builds that ignore it continue to work against the new backend.
- **Range capture enqueue may now return HTTP 503.** Previously it raised an unhandled exception (effective HTTP 500) when KRX creds were missing. This is a more correct status code but technically a behavior change for any client that special-cases 500 vs 503. The local frontend is the only known client.
- **`CaptureErrorCode.COOKIE_*` / `HOGAPLAY_HTTP_ERROR` migrated to `UpstreamCode`.** The on-wire string values are unchanged (`"cookie_expired"`, `"cookie_missing"`, `"hogaplay_http_error"`). Any external code that imports the Python enum needs to update the import path; any frontend code that pattern-matches against the literal strings keeps working. No external clients are known; the local frontend is updated in the same PR.

## 11. Security Notes

- `.env` is gitignored. `.env.example` (committed) contains only placeholder strings.
- The spec author's KRX credentials must not appear in chat logs, commits, memory, or this document. Credential rotation is recommended given the pre-spec disclosure.
- `python-dotenv` writes to `os.environ` only; values are not logged. Existing backend logs do not include cookie or KRX_PW contents.
- The Refresh endpoint is unauthenticated (mirrors the rest of the local-only API). The server binds to `127.0.0.1` (`hoga/cli.py:88`), so this is acceptable for a single-user local tool. Do not expose the API to non-loopback interfaces without adding auth.

## 12. Out of Scope (future work)

- Username/password → cookie auto-login for hogaplay (would obviate manual cookie capture).
- A general settings UI for env management.
- File-watcher-based hot-reload of `.env`.
- Per-environment `.env.local`, `.env.dev` overlays.
- Encryption-at-rest for `.env` (e.g., `sops`, `age`).
