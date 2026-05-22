# Symbol Master Disk Persistence + Explicit-Trigger Refresh

**Status:** Draft (awaiting user review)
**Date:** 2026-05-22
**Spec owner:** blessp@naver.com
**Related:**
- `CONTEXT.md` — domain language. This spec uses **Symbol Master** (the `(Code, name, market)` catalog sourced from pykrx) and **Code** (the 6-digit KRX ticker). Per `CONTEXT.md`, bare "symbol" is _Avoid_'d; sanctioned compounds (`Symbol Master`, `SymbolHit`, `SymbolsAllResponse`, `SymbolSearch`, `useSymbols`) appear here.
- `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md` — direct predecessor. This spec extends the env-loader/recovery-UX work with disk persistence and removes pykrx from boot/GET paths.
- `docs/adr/0008-env-discovery-worktree-fallback.md` — `.env` discovery (preserved as-is; this spec does not touch).
- `docs/adr/0009-upstream-code-separate-enum.md` — `UpstreamCode` enum. This spec adds one new value, `SYMBOL_MASTER_NOT_INITIALIZED`.
- `docs/adr/0006-captures-as-single-module.md` — single-module pattern. `hoga/api/symbols.py` keeps the full Symbol Master surface (state, lifecycle, routes, disk I/O) in one file. Disk I/O functions live alongside the cache lifecycle, not in a separate helper module.
- `docs/adr/0015-symbol-master-disk-persistence.md` — decision record for this spec's core architectural shift (written alongside this spec).
- `DESIGN.md` — design system tokens. Settings page uses existing `Row` pattern and existing button/text tokens. No new tokens.
- `hoga/api/symbols.py` — current Tier 1/2/3 in-memory cache. Significantly simplified by this spec.
- `hoga/config.py` — `resolve_data_dir()` XDG pattern. This spec adds a sibling `resolve_symbol_master_path()`.
- `hoga/api/models.py` — `SymbolsAllResponse` (existing, unchanged). New `SymbolMasterInfo` model added.
- `frontend/src/pages/Settings.tsx` — currently a near-empty placeholder. This spec adds a "Symbol Master" section as its first populated content.
- `frontend/src/capture/SymbolSearch.tsx` — **unchanged**. The new architecture preserves wire-contract semantics so the existing `unavailable`/`stale` branches keep working.

**Authority order if these disagree:** This spec (WHAT and WHY) → `DESIGN.md` (visual tokens) → existing code (current behavior).

---

## 1. Goal

Decouple pykrx from the boot and read paths by persisting the **Symbol Master** to disk and making `POST /api/symbols/refresh` the *only* pykrx entry point. The server starts without network dependencies; KRX is contacted only when a user explicitly requests an update.

Today, the predecessor spec leaves pykrx as a boot-time fire-and-forget warm (`ensure_cache_warm`) and a GET-time lazy fetch. T15 happy-path validation surfaced a pykrx 1.2.8 column drift (`get_market_cap` no longer returns `종목명`), but the deeper issue is that any pykrx fragility (rate-limit, login failure, schema change) cascades into broken first-time UX. Disk persistence removes the dependency from the critical paths.

This spec covers:

1. A new disk file `~/.local/share/hoga-ops/symbol-master.json` (schema_version=1, JSON, atomic write) that survives server restarts.
2. Restructuring `hoga/api/symbols.py` so boot reads from disk and `GET /api/symbols/*` never triggers a fetch.
3. Surfacing the catalog in a Settings page section with explicit `[Update Now]` action, complementing the existing `SymbolSearch` Refresh button. Both call the same `POST /api/symbols/refresh`.
4. A new `UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED` value with mirror-discipline updates across `types.ts` and the four `upstream-hints.ts` maps.

## 2. Non-goals

- **Automatic background refresh.** No TTL-based auto-refetch, no scheduled task, no SSE-triggered refresh. The only way to re-fetch is a user click. This is deliberate — the whole point of disk persistence is to eliminate background KRX dependencies.
- **Schema migration for v2.** `schema_version: 1` is the only version this spec ships. A migration hook (`load_v1` dispatch) is left as YAGNI; a future ADR will add it when v2 is needed.
- **Partial-market persistence.** If KOSPI succeeds and KOSDAQ fails (or vice versa), the disk file is **not written**. All-or-nothing. Half-catalog persistence would cause silent gaps — the anti-pattern this whole feature is trying to remove.
- **Storing `captured_breakdown` on disk.** The disk file holds KRX-side data only (`code, name, market`). The capture breakdown is computed at boot from `data_dir` and updated by the capture lifecycle.
- **DuckDB / Parquet storage for the catalog.** Considered and rejected; see §10. JSON is consistent with `meta.json` / `_progress.json` patterns and avoids pulling pyarrow schema machinery for a 6000-row flat catalog.
- **Rewriting `SymbolSearch.tsx`.** Wire-contract semantics (`status`, `reason`) are preserved, so existing UI branches (`promoteUnverifiedCode`, Refresh button visibility, reason-aware hint) keep working unmodified.
- **Migrating away from `ensure_cache_warm` callers other than `lifespan`.** The function is deleted; if any test currently calls it, the test is updated, not preserved with a shim.
- **Cancellable refresh.** A long fetch (~30–120s) cannot be cancelled mid-flight. The `_inflight` Future dedupe collapses concurrent triggers; the user waits or reloads.

## 3. Stack & Conventions

- Backend: Python 3.11+ (FastAPI, pykrx, pydantic).
- Frontend: React + TypeScript + Vite. React Query manages the new `symbols-info` cache.
- ADR-0006 single-module pattern preserved: `hoga/api/symbols.py` holds state, lifecycle, routes, **and** disk I/O. A `symbol_store.py` extraction was considered and rejected — the I/O does not vary across consumers, and `_fetch_from_pykrx` monkeypatching (existing pattern) lets disk-schema tests run without pulling pykrx into the test surface. ADR-0006's "introduce a seam only when something actually varies across it" applies.
- ADR-0004 mirror discipline: every backend wire-contract type change is mirrored in `frontend/src/api/types.ts` in the same commit.
- ADR-0009 `UpstreamCode`: new values added with full hint-map mirror (4 surfaces × every new value).
- Atomic file writes follow the pattern from `hoga/collector/orchestrator.py:184` (`_progress.json` write): temp file in same dir + `os.replace`. Reuse the helper if extractable; otherwise inline the pattern.

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Disk (XDG, machine-global, gitignored from repo)                   │
│  ~/.local/share/hoga-ops/symbol-master.json                         │
│  { schema_version: 1, fetched_at_ms, source: "pykrx",               │
│    entries: [ {code, name, market}, ... ~6000 ] }                   │
└─────────────────────────────────────────────────────────────────────┘
        ▲ atomic write (.tmp → os.replace)            │ read on boot
        │                                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│  hoga/api/symbols.py — module-level state (ADR-0006)                  │
│  • _cache: list[SymbolHit]        ← from disk on boot                 │
│  • _fetched_at_ms                 ← from disk metadata                │
│  • _state: SymbolCacheState                                            │
│  • _lock + _inflight (refresh dedupe; boot/GET never touch them)      │
└───────────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ POST /api/symbols/refresh                    │ GET /api/symbols/all
        │   (only pykrx entry point)                   │ GET /api/symbols?q=…
        │                                              │ GET /api/symbols/info (NEW)
        │                                              │
┌───────┴──────────────────────────┐     ┌────────────┴────────────────┐
│  Settings page (NEW section)     │     │  SymbolSearch (minimal Δ)   │
│  [Symbol Master]                 │     │  • file present → dropdown  │
│  • count, fetched_at, status     │     │  • file absent → promoted   │
│  • reason (if any)               │     │    6-digit code (BUG-001)   │
│  • [Update Now] button           │     │  • Refresh button preserved │
│                                  │     │  • empty-result nudge if    │
│                                  │     │    catalog ≥ 7 days old     │
└──────────────────────────────────┘     └─────────────────────────────┘
```

**Key structural changes vs. predecessor spec:**

1. `ensure_cache_warm()` is deleted. Lifespan calls `load_disk_state(path, data_dir)` instead — disk read + `data_dir` walk for `captured_breakdown`, both synchronous and fast.
2. `GET /api/symbols/all` and `GET /api/symbols?q=…` never trigger fetches. If `_cache` is empty (file absent or corrupt), they return `{symbols: [], status: 'unavailable', reason: 'symbol_master_not_initialized', fetched_at_ms: null}`.
3. `POST /api/symbols/refresh` is the only entry point that calls pykrx. Two UI triggers (Settings, SymbolSearch) feed the same endpoint.
4. TTL is removed. `_is_fresh()`, `_CACHE_TTL_MS`, `invalidate_cache_for_tests()` are deleted.

## 5. Backend Components

### 5.1 `hoga/config.py` (~10 lines added)

New helper:

```python
def resolve_symbol_master_path() -> Path:
    """Return the canonical path for the persisted Symbol Master JSON.

    Resolution order:
      1. ``$XDG_DATA_HOME/hoga-ops/symbol-master.json`` if XDG_DATA_HOME is set.
      2. ``~/.local/share/hoga-ops/symbol-master.json`` — XDG default.

    Sibling of resolve_data_dir() but NOT inside data/. The Symbol Master
    is a machine-global KRX catalog, not capture data; HOGA_DATA_DIR overrides
    do NOT apply.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hoga-ops" / "symbol-master.json"
```

**No `HOGA_SYMBOL_MASTER_PATH` env-var.** A test-only env-var would be a hypothetical seam (ADR-0006's "introduce a seam only when something actually varies across it" applies). Tests sandbox the path via `monkeypatch.setattr(hoga.config, 'resolve_symbol_master_path', lambda: tmp_path / 'symbol-master.json')` — a one-line pattern that keeps the production surface free of test-only knobs. If a future prod use case appears (e.g., a multi-instance deployment that needs separate catalogs per instance), adding the env-var is a reversible one-liner.

### 5.2 `hoga/api/symbols.py` (significant simplification + disk I/O folded in)

**New module-level constants and private helpers** (added alongside the existing state per ADR-0006):

```python
SCHEMA_VERSION = 1


def _load_from_disk(path: Path) -> tuple[list[SymbolHit], int] | None:
    """Read the Symbol Master file. Return (entries, fetched_at_ms) or None.

    Returns None when:
      - the file does not exist,
      - the JSON cannot be parsed,
      - schema_version is missing or != SCHEMA_VERSION,
      - the `entries` array is missing or malformed.

    Caller treats None as "unavailable; needs fresh fetch". captured_breakdown
    is NOT populated here — it is filled by load_disk_state from the data_dir walk.
    """
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return None
    raw_entries = payload.get("entries")
    fetched_at_ms = payload.get("fetched_at_ms")
    if not isinstance(raw_entries, list) or not isinstance(fetched_at_ms, int):
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
    except (KeyError, TypeError):
        return None
    return entries, fetched_at_ms


def _write_to_disk(path: Path, entries: list[SymbolHit], fetched_at_ms: int) -> None:
    """Atomically persist the catalog. Creates parent dir if needed.

    Atomicity: write to a temp file in the target's parent directory,
    then ``os.replace`` over the destination. ``os.replace`` is atomic on
    POSIX when source and destination share a filesystem; same-parent
    temp guarantees this.

    captured_breakdown fields are stripped — the disk file holds KRX-side
    data only (breakdown is a runtime view of data_dir).
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

Both helpers are module-private (underscore prefix) — they're implementation details of the Symbol Master cache lifecycle, not a reusable I/O library. If a future spec needs the same atomic-write pattern elsewhere (`_progress.json`, `meta.json`), the right move is a follow-up ADR to *generalize* the helper into a shared util, not to pre-extract now.

**Deletions:**
- `ensure_cache_warm()` — entire function removed.
- `_CACHE_TTL_MS`, `_is_fresh()`, `invalidate_cache_for_tests()` — TTL concept removed.
- Lazy-fetch behavior in `get_all()` — the function becomes a pure memory read.

**Modifications to `_state` semantics:**

| Trigger | Resulting `_state` |
|---|---|
| Boot, disk file present, valid | `SymbolCacheState.fresh()` |
| Boot, disk file absent | `SymbolCacheState.unavailable(reason=SYMBOL_MASTER_NOT_INITIALIZED)` |
| Boot, disk file corrupt | `SymbolCacheState.unavailable(reason=SYMBOL_MASTER_NOT_INITIALIZED)` — corruption surfaced as "not initialized" since the user remediation is identical. |
| Refresh in progress | `SymbolCacheState.loading()` |
| Refresh success | `SymbolCacheState.fresh()` |
| Refresh failure, `_cache` populated | `SymbolCacheState.stale(reason=...)` |
| Refresh failure, `_cache` empty | `SymbolCacheState.unavailable(reason=...)` |

**New: `load_disk_state(*, path: Path, data_dir: Path) -> None`**

Called once from lifespan startup. Pure disk read + data_dir walk, no network:

```python
def load_disk_state(*, path: Path, data_dir: Path) -> None:
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

**Modified `get_all()`** — pure memory read, no lock, no Future:

```python
async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    return SymbolsAllResponse(
        symbols=list(_cache),
        status=_state.status,
        fetched_at_ms=_fetched_at_ms,
        reason=_state.reason,
    )
```

The `data_dir` parameter remains in the signature for now to minimize call-site churn; a follow-up cleanup may drop it once tests are updated.

**Modified `refresh()`** — atomic critical section + disk write:

```python
async def refresh(*, path: Path, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — the only pykrx entry point.

    Concurrency:
      • _lock + _inflight Future dedupes concurrent refresh clicks
        (Settings + SymbolSearch may fire together).
      • load_env(override=True) and the disk write share the lock so
        os.environ mutation, fetch result, and disk file all align.

    Failure semantics:
      • pykrx exception → disk file unchanged, memory state stale (if cache) or unavailable.
      • All-or-nothing: if pykrx fails, the previous disk file remains the source of truth.
    """
    global _cache, _fetched_at_ms, _state, _inflight  # noqa: PLW0603
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
            fetch_task.add_done_callback(_signal_inflight)
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
    global _cache, _fetched_at_ms, _state  # noqa: PLW0603
    try:
        entries = await _fetch_from_pykrx()
    except Exception:  # noqa: BLE001
        _state = (
            SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
            if _cache
            else SymbolCacheState.unavailable(reason=UpstreamCode.KRX_FETCH_FAILED)
        )
        return
    now_ms = int(time.time() * 1000)
    _write_to_disk(path, entries, now_ms)
    breakdowns = _build_all_captured_breakdowns(data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in entries:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = entries
    _fetched_at_ms = now_ms
    _state = SymbolCacheState.fresh()
```

**`_fetch_from_pykrx()` correctness fix.** The current implementation reads `df.loc[code, "종목명"]` from `stock.get_market_cap(...)`. In pykrx 1.2.8 that column no longer exists, causing a `KeyError` that is silently caught as `KRX_FETCH_FAILED`. The fix is delegated to the implementation phase — the spec only requires that the function returns `list[SymbolHit]` with valid `(code, name, market)` triples in the order the catalog should appear. Candidate approaches:

- `stock.get_market_ticker_list(date, market=...)` + `stock.get_market_ticker_name(code)` per ticker via `ThreadPoolExecutor` — known to work, slow (~30–120s for ~6000 codes), KRX rate-limit risk to verify.
- Alternative pykrx function that returns code+name in one DataFrame call (e.g., `get_market_fundamental`) — verify column shape in 1.2.8 before adopting.

The implementation phase must benchmark against KRX and document the chosen approach in the corresponding plan task.

### 5.3 `hoga/api/symbols.py` route changes

```python
@router.get("/info")
async def info_route() -> SymbolMasterInfo:
    return SymbolMasterInfo(
        count=len(_cache),
        fetched_at_ms=_fetched_at_ms,
        status=_state.status,
        reason=_state.reason,
    )

@router.post("/refresh")
async def refresh_route() -> SymbolsAllResponse:
    return await refresh(
        path=resolve_symbol_master_path(),
        data_dir=data_dir,
    )
```

`GET /api/symbols/all` and `GET /api/symbols?q=…` route handlers remain but no longer trigger fetches when `_cache` is empty — they return the empty/unavailable response directly.

### 5.4 `hoga/api/models.py`

```python
class SymbolMasterInfo(BaseModel):
    """Lightweight metadata for the Settings page — no entries payload."""
    count: int
    fetched_at_ms: int | None
    status: Literal["loading", "fresh", "stale", "unavailable"]
    reason: UpstreamCode | None = None
```

`SymbolsAllResponse` unchanged.

### 5.5 `hoga/api/error_codes.py` — new `UpstreamCode` value

```python
class UpstreamCode(StrEnum):
    # ... existing values ...
    KRX_CREDENTIALS_MISSING = "krx_credentials_missing"
    KRX_FETCH_FAILED = "krx_fetch_failed"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
    SYMBOL_MASTER_NOT_INITIALIZED = "symbol_master_not_initialized"  # NEW
```

Per ADR-0009 mirror discipline, this addition cascades to `frontend/src/api/types.ts` and to **every** map in `frontend/src/api/upstream-hints.ts`. TypeScript's exhaustive checking enforces this in the same commit.

### 5.6 Lifespan wiring (`hoga/api/app.py` or wherever lifespan is defined)

Replace the `ensure_cache_warm` fire-and-forget call with a synchronous `load_disk_state` call:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... existing setup ...
    symbols.load_disk_state(
        path=resolve_symbol_master_path(),
        data_dir=data_dir,
    )
    yield
    # ... existing teardown ...
```

No background task, no awaiting an HTTP call. Sub-100ms typical.

## 6. Frontend Components

### 6.1 `frontend/src/api/types.ts` (mirror)

```ts
/** Mirrors hoga/api/error_codes.py::UpstreamCode. See ADR-0009. */
export type UpstreamCode =
  | 'krx_credentials_missing'
  | 'krx_fetch_failed'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error'
  | 'symbol_master_not_initialized';  // NEW

/** Mirrors hoga/api/models.py::SymbolMasterInfo. See ADR-0004. */
export interface SymbolMasterInfo {
  count: number;
  fetched_at_ms: number | null;
  status: SymbolsCacheStatus;
  reason: UpstreamCode | null;
}
```

### 6.2 `frontend/src/api/symbols.ts` (extend)

```ts
export async function getSymbolMasterInfo(): Promise<SymbolMasterInfo> {
  return apiCall<SymbolMasterInfo>('/api/symbols/info');
}
```

Existing `getAllSymbols()` and `refreshSymbols()` unchanged.

### 6.3 `frontend/src/api/upstream-hints.ts` (extend all 4 maps)

For each of `symbolSearchHints`, `calendarHints`, `enqueueErrorHints`, `captureFinishedHints`, add the new key. Calendar/enqueue/capture-finished maps render copy that explains the value is irrelevant in that surface (e.g., "Symbol Master 미초기화 — 종목 정보가 부정확할 수 있습니다"), but TypeScript's exhaustive check forces explicit copy in all four:

```ts
export const symbolSearchHints: Record<UpstreamCode, ReactNode> = {
  // ... existing entries ...
  symbol_master_not_initialized: (
    <>
      종목 목록이 아직 다운로드되지 않았습니다 — <strong>Settings → Symbol Master → Update Now</strong>를
      누르거나, 6자리 코드를 직접 입력해 진행할 수 있습니다.
    </>
  ),
};
```

### 6.4 `frontend/src/pages/Settings.tsx` — "Symbol Master" 섹션

The page currently shows two placeholder rows (`API URL`, `Version`). Add a new section below them:

```tsx
function SymbolMasterSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['symbols-info'],
    queryFn: getSymbolMasterInfo,
    refetchOnWindowFocus: false,
  });
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await refreshSymbols();
      await queryClient.invalidateQueries({ queryKey: ['symbols-info'] });
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="space-y-2 pt-4">
      <h3 className="text-sm font-semibold">Symbol Master</h3>
      <Row label="Items" value={data ? data.count.toLocaleString() : '…'} />
      <Row label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <Row label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-down">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <button
        onClick={handleUpdate}
        disabled={updating}
        className="..."  // existing button tokens from DESIGN.md
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </button>
    </section>
  );
}
```

`formatRelative(fetched_at_ms)` returns "Never" (null), "just now" (<1m), "2 hours ago", "3 days ago", etc. — a thin helper, not a new dependency.

A new `symbolMasterSettingsHints: Record<UpstreamCode, ReactNode>` map is added to `upstream-hints.ts` for this surface — Settings copy is more detailed than the inline `SymbolSearch` hint.

### 6.5 `frontend/src/capture/SymbolSearch.tsx` — minimal change (empty-result staleness nudge)

**Preserved (no code changes needed):**
- File absent → backend returns `status='unavailable', reason='symbol_master_not_initialized'`.
- `cacheStatus === 'unavailable'` branch already renders hint + Refresh button + activates `promoteUnverifiedCode`.
- `symbolSearchHints['symbol_master_not_initialized']` (added in §6.3) renders the appropriate copy via the existing hint-map lookup. This is the structural payoff of the predecessor spec's map-driven copy decision.

**Added: empty-result staleness nudge** (~6 lines). With TTL removed, `status='fresh'` no longer carries any "recently fetched" guarantee — a six-month-old disk file is reported as `fresh`. A user whose only entry point is `SymbolSearch` has no way to learn that the catalog is stale until a search for a newly-listed Code returns zero hits. The existing empty-state at `SymbolSearch.tsx:151-155` is the precise moment to surface this:

```tsx
const STALE_NUDGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const fetchedAtMs = data?.fetched_at_ms ?? null;
const isStaleByAge =
  fetchedAtMs !== null && Date.now() - fetchedAtMs > STALE_NUDGE_THRESHOLD_MS;

// inside the isEmpty branch (line 152-154):
<div className="py-md px-sm font-normal text-sm text-fg-dim">
  검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
  {isStaleByAge && (
    <div className="mt-2 text-xs text-fg-dimmer">
      Symbol Master가 {formatRelative(fetchedAtMs)} 업데이트되었습니다 —
      신규 상장 종목이 누락되었을 수 있습니다.{' '}
      <a href="/settings">설정에서 Update</a>
    </div>
  )}
</div>
```

The threshold (7 days) is chosen against KRX's typical new-listing cadence (~1–2 codes per week). A shorter threshold creates noise; a longer one risks several silent misses. The constant lives at the top of `SymbolSearch.tsx` (one-call-site rule — no shared util needed yet).

`isStaleByAge` is **not** a wire-contract field. The backend's `status` remains `fresh` regardless of age — this is a pure frontend-derived presentation signal from `fetched_at_ms`. The TTL-removal decision (§5.3) is preserved: backend never auto-refreshes; this nudge merely informs the user when their *manual* refresh is overdue.

## 7. Data Flow

### 7.1 Cold boot, disk file absent (first use)

1. `hoga serve` → `load_env()` reads `.env` (or doesn't, harmless).
2. Lifespan calls `symbols.load_disk_state(path=…/symbol-master.json, data_dir=…)`.
3. `_load_from_disk(path)` returns `None` (file absent).
4. `_state = SymbolCacheState.unavailable(reason=SYMBOL_MASTER_NOT_INITIALIZED)`, `_cache=[]`, `_fetched_at_ms=None`.
5. Server is up. `GET /api/symbols/all` returns `{symbols:[], status:'unavailable', reason:'symbol_master_not_initialized', fetched_at_ms:null}` instantly.
6. Settings page renders "Items: 0, Last fetched: Never, Status: unavailable" + reason hint + [Update Now] button.
7. SymbolSearch shows the new "종목 목록이 아직 다운로드되지 않았습니다…" hint + Refresh button. 6-digit code entry still works via `promoteUnverifiedCode`.

### 7.2 Cold boot, disk file present (steady state)

1. Lifespan calls `load_disk_state`.
2. `_load_from_disk(path)` returns `(entries, fetched_at_ms)` (~5–15ms parse).
3. `_build_all_captured_breakdowns(data_dir)` walks `data/parquet` + `data/raw` once (~10ms typical).
4. Per-entry `captured_breakdown` populated.
5. `_state = SymbolCacheState.fresh()`. Server up.
6. UI: normal autocomplete in SymbolSearch; Settings shows "Items: 6,012, Last fetched: 2 days ago, Status: fresh".

### 7.3 User clicks [Update Now] in Settings

1. `refreshSymbols()` → `POST /api/symbols/refresh`.
2. Backend `refresh(path=…, data_dir=…)`:
   - Acquires `_lock`.
   - `load_env(override=True)` — hot-reloads `.env`.
   - Creds check: if missing → return immediately with `KRX_CREDENTIALS_MISSING`.
   - Otherwise sets `_state = loading()`, creates `_inflight` Future, schedules `_do_refresh` task, releases lock, awaits Future.
3. `_do_refresh`:
   - Calls `_fetch_from_pykrx()` (~30–120s).
   - On success: `_write_to_disk(path, entries, now_ms)` (atomic temp→rename), rebuilds `captured_breakdown`, populates `_cache`, sets state to `fresh()`.
   - On failure: `_state.stale(reason=KRX_FETCH_FAILED)` if cache exists, else `unavailable(reason=KRX_FETCH_FAILED)`. Disk file unchanged.
4. Future signals; route returns final response.
5. Frontend invalidates `symbols-info` + `symbols-all`. UI updates to fresh.

### 7.4 User clicks Refresh in SymbolSearch (same endpoint, different entry)

Identical flow to §7.3. The `_lock`+`_inflight` Future dedupes concurrent clicks from both UI entry points — only one pykrx call regardless of how many times either button is pressed within the fetch window.

### 7.5 Update with credentials missing

Pre-check inside `refresh()` (after `load_env(override=True)`) sees `krx_creds_present()=False`. Returns immediately with `reason=KRX_CREDENTIALS_MISSING`. No pykrx call, no disk write. Frontend shows the existing creds-missing hint copy.

### 7.6 Update with KRX rejecting login

pykrx call raises. `_do_refresh` catches → `reason=KRX_FETCH_FAILED`. Disk file untouched. If a prior successful fetch had populated the disk file, the in-memory cache and disk persistence both remain valid (state goes to `stale`, not `unavailable`). The user fixes credentials and clicks Update again.

### 7.7 Server restart mid-Update

If the process is killed during `_do_refresh`:
- Disk file: either untouched (kill before `write_to_disk`) or the previous-good version (kill after `os.replace` completed) — never a partial file thanks to the atomic write.
- Memory state: lost; on restart `load_disk_state` reads whichever version is on disk (previous good if any, else triggers "not initialized").

### 7.8 Capture completion → `captured_breakdown` update

The disk file holds KRX-side data only; `captured_breakdown` lives in memory and is rebuilt at exactly two moments:

- **Boot** — `load_disk_state` calls `_build_all_captured_breakdowns(data_dir)` once.
- **Successful refresh** — `_do_refresh` rebuilds breakdowns after the pykrx fetch lands.

**No SSE-driven update.** `capture_finished` events do NOT trigger backend breakdown recomputation, nor do they invalidate `SYMBOLS_QUERY_KEY` on the frontend (`sse.ts:79-81` invalidates only `STOCK_DATES_QUERY_KEY`, unchanged by this spec). The dropdown `captured_count` badge can therefore be stale relative to the live capture state — it reflects whichever rebuild moment came last (boot or Refresh).

**Trade-off accepted (regression from current behavior).** Today, 24h TTL expiry forces a fetch that incidentally refreshes breakdowns. Removing TTL (§5.3) removes that incidental refresh. The replacement story:

- Authoritative live capture state remains accurate on `Inventory` and `CaptureQueue` — both invalidate on `capture_finished` SSE via `STOCK_DATES_QUERY_KEY`.
- SymbolSearch's `captured_count` is a *secondary* visual cue (helps users decide which Code to capture next), not a source of truth. A stale badge does not block any workflow.
- Users who want fresh counts in SymbolSearch click [Update Now] or the SymbolSearch Refresh button — both rebuild the breakdown.

**Why not add a backend capture-lifecycle hook.** Wiring `hoga/api/symbols.py` to subscribe to `capture_finished` would require: (a) a `O(parquet/raw dirs for that code)` re-walk per event, (b) module coupling between `symbols.py` and `captures.py`/`sse.py` that doesn't exist today, (c) a new test surface for the hook timing. The user-facing cost (slightly stale badge that resets on Refresh) is small; the structural cost is real. YAGNI until a concrete user complaint surfaces — at which point a follow-up spec adds the hook.

## 8. Edge Cases

| Case | Behavior |
|---|---|
| Disk file absent | `status='unavailable'`, `reason='symbol_master_not_initialized'`. Update button visible everywhere. |
| Disk file corrupt (JSON parse fail) | `load_from_disk` returns `None`. Same handling as absent. `reason='symbol_master_not_initialized'` (corruption surfaced as "not initialized" since user remediation is identical). |
| `schema_version != 1` | Treated as corrupt — `None` returned. Future migration ADR will add dispatch. |
| Disk write `PermissionError` | `_do_refresh` lets the exception propagate to the broad `except`. Treated as `KRX_FETCH_FAILED` (overload of meaning, but the user action — check creds, retry — is the same; permission issues on `~/.local/share` are rare in single-user local deployments). Logs preserve the precise exception. |
| Disk directory missing (`~/.local/share/hoga-ops/`) | `write_to_disk` does `mkdir(parents=True, exist_ok=True)` before writing. |
| Partial fetch (KOSPI ok, KOSDAQ fails) | `_fetch_from_pykrx` is responsible for raising on any partial failure. All-or-nothing: no half-catalog persisted. |
| Disk file unknown extra fields | `load_from_disk` reads only the known keys; extras are ignored. Forward-compatible. |
| Very old disk file (months) | `status='fresh'` (TTL removed). Settings' "Last fetched: N days ago" surfaces staleness implicitly. User clicks Update when needed. |
| Concurrent Update from Settings + SymbolSearch | `_lock` + `_inflight` Future dedupe to one pykrx call. Both callers receive the same final response. |
| `.env` edited mid-fetch | The in-flight refresh used the `os.environ` snapshot from when its `load_env` ran. A second Update after the first completes picks up the latest `.env`. |
| Refresh during boot before `load_disk_state` finishes | Lifespan is synchronous; the API doesn't accept requests until lifespan startup returns. Cannot occur. |
| Test isolation (sandbox path) | `monkeypatch.setattr(hoga.config, 'resolve_symbol_master_path', lambda: tmp_path / 'symbol-master.json')`. No env-var introduced — see §5.1. |
| `XDG_DATA_HOME` unset | Falls back to `~/.local/share/hoga-ops/symbol-master.json`. Standard XDG behavior. |
| Empty `_cache` + Refresh fails | `_state = unavailable(reason=...)`. Hint + Refresh button visible. Predecessor spec's recovery UX kicks in unchanged. |
| Symbol search `?q=…` against empty cache | Returns `[]`. Frontend renders empty-state in dropdown. Existing behavior preserved. |

## 9. Testing Strategy

### 9.1 Backend unit tests

**Extend: `tests/api/test_symbols.py` — disk I/O coverage folded in**

Disk helpers (`_load_from_disk`, `_write_to_disk`) are private to `symbols.py`; tests address them via the module attribute (`from hoga.api import symbols; symbols._load_from_disk(path)`). No separate test file — same single-module locality rule as ADR-0006.

- `_write_to_disk` → `_load_from_disk` round-trip: entries (code, name, market) + `fetched_at_ms` preserved.
- `captured_breakdown` fields stripped on write (verify written JSON has no breakdown keys).
- Atomic write: monkeypatch `os.replace` to raise after the temp file is written → assert target file unchanged.
- Schema validation: `schema_version=0` → `None`; `schema_version=2` → `None`; missing `schema_version` → `None`.
- JSON parse failure (write garbage to file) → `None`.
- Missing `entries` array → `None`.
- Malformed entry (missing `code`) → `None`.
- `mkdir` parents: write to a path whose parent doesn't exist → parent created, file written.

**Extend: `tests/api/test_symbols.py` — cache lifecycle coverage**

- `load_disk_state(no file)` → `_state.status == 'unavailable'`, `reason == SYMBOL_MASTER_NOT_INITIALIZED`, `_cache == []`.
- `load_disk_state(valid file)` → `_state.status == 'fresh'`, `_cache != []`, `_fetched_at_ms` restored from disk.
- `load_disk_state(corrupt file)` → same as no file.
- `load_disk_state` populates `captured_breakdown` from `data_dir` walk (use existing parquet/raw fixture).
- `get_all()` is now a pure memory read: monkeypatch `_fetch_from_pykrx` to raise → `get_all` does NOT call it (call count == 0).
- `refresh()` happy path (monkeypatch `_fetch_from_pykrx`) → disk file written, `_state.status == 'fresh'`, `_cache` populated.
- `refresh()` pykrx exception → disk file unchanged, `_state.status == 'stale'` (cache pre-populated) or `'unavailable'` (empty cache).
- `refresh()` credentials missing → no `_fetch_from_pykrx` call, `reason == KRX_CREDENTIALS_MISSING`.
- `refresh()` concurrent calls dedupe → `_fetch_from_pykrx` called once for N concurrent triggers.
- `reset_state_for_tests()` resets `_fetched_at_ms`, `_state`, `_inflight`.
- Removed tests: anything that called `ensure_cache_warm` directly is rewritten to call `load_disk_state` with a temp-dir fixture.

**New: `tests/api/test_symbol_master_info_route.py`**

- `GET /api/symbols/info` shape: `{count, fetched_at_ms, status, reason}`.
- Empty cache → `count == 0`, `status == 'unavailable'`.
- Populated cache → `count > 0`, `status == 'fresh'`, `fetched_at_ms` matches loaded value.

### 9.2 Frontend unit tests

**New/extend: `frontend/src/pages/Settings.test.tsx`**

- Mock `useQuery(symbols-info)` for each status → assert correct row values render.
- `reason` non-null → assert hint copy appears.
- [Update Now] click → `refreshSymbols()` called, query invalidations fired.
- Updating state → button label changes to "Updating…", disabled.

**Extend: `frontend/src/capture/useSymbols.test.tsx`** (existing, if present)

- `reason='symbol_master_not_initialized'` → assert `symbolSearchHints` copy appears.
- Refresh button visibility unchanged for `unavailable`/`stale` (regression guard).

### 9.3 Manual verification (release gate)

1. **Cold boot, no disk file.** `rm ~/.local/share/hoga-ops/symbol-master.json` → restart server → Settings shows "Items: 0, Status: unavailable" + reason hint; SymbolSearch shows new hint; 6-digit code entry still works.
2. **First Update.** Click [Update Now] in Settings → button reads "Updating…" → after fetch completes, "Items: ~6000, Last fetched: just now, Status: fresh"; SymbolSearch autocomplete works for "삼성".
3. **Restart preserves state.** Stop and restart server → Settings still shows fresh state, no fetch occurs (verify via logs or with KRX_ID/PW unset before restart — fetch would fail, but boot succeeds).
4. **Update with bad creds.** Edit `.env` with invalid `KRX_PW` → click Update → reason='krx_fetch_failed' surfaces in Settings; existing data preserved (disk file untouched).
5. **Disk corruption.** Write garbage to `~/.local/share/hoga-ops/symbol-master.json` → restart server → Settings reverts to "Items: 0, Status: unavailable"; Update recovers.
6. **Concurrent Update.** Open Settings in two browser tabs, click Update simultaneously → only one fetch round-trip visible in server logs.

## 10. Storage Format Decision Rationale

**Considered**: JSON, Parquet, DuckDB (persistent DB file).

**Project's storage conventions** (verified against `hoga/` codebase):

| Data category | Format | Examples |
|---|---|---|
| Time-series capture data | Parquet (DuckDB read via `:memory:` connection) | `data/parquet/{date}/{code}/{table}.parquet` |
| Stock-Date metadata | JSON | `meta.json` (queries.py:57, parser/__init__.py:148) |
| In-flight progress state | JSON | `_progress.json` (orchestrator.py:184) |
| KRX header data | TSV | `info.tsv` |

**Crucially: no persistent DuckDB DB file exists in the project.** All DuckDB usage is `:memory:` for querying external parquet files (`hoga/api/queries.py:30`).

**Why JSON for Symbol Master:**

- The Symbol Master is a flat catalog, not a time series; it's queried by in-memory substring scan, not SQL JOIN.
- It belongs to the *metadata* category alongside `meta.json` and `_progress.json` — JSON is the conventional choice.
- `schema_version: 1` field is explicit, easier than parquet schema evolution rules.
- Human-readable: `cat`/`grep` works during debugging.
- The hot path (`search()`) operates on the in-memory `_cache` list, so on-disk format has zero effect on search latency. Disk read happens only at boot (~5–15ms) and after Update (write ~5–10ms).

**Why not Parquet:**

- Pulls pyarrow schema + writer machinery into a module that doesn't need column storage.
- Compression gain (~280KB → ~50KB) is meaningless for a once-per-boot read.
- Forward-compatibility via parquet schema evolution is more restrictive than JSON `schema_version` bumps.

**Why not a persistent DuckDB file:**

- No precedent in the project. Existing DuckDB usage is read-only `:memory:` over external parquet.
- 6000 flat rows do not justify a SQL engine for storage.

If a future use case requires SQL JOIN of the Symbol Master with capture inventory (e.g., "top N codes with zero captures this month"), the `schema_version: 1` field is the migration entry point: a follow-up ADR can introduce parquet storage in parallel and `load_from_disk` can dispatch on version. YAGNI for now.

## 11. Migration & Compatibility

- **No wire-contract breaks.** `SymbolsAllResponse` shape unchanged; new `SymbolMasterInfo` is additive. Old frontends ignoring `reason` continue to work.
- **No persisted state migration required.** Disk file did not exist before this spec; first boot post-merge sees no file and starts in `unavailable` state. User clicks Update once to initialize. This is the explicit-trigger UX, intentional.
- **`ensure_cache_warm` removal.** The predecessor spec called this from lifespan; any other callers (if found during implementation) are updated to `load_disk_state`. No backwards-compat shim.
- **TTL removal.** `_CACHE_TTL_MS` and `_is_fresh()` are deleted. Any test that simulated TTL expiry is rewritten to test the explicit refresh path instead.
- **`UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED` mirror.** Mechanical TypeScript update; all hint maps must include the new key (compiler-enforced).
- **No new env vars.** This spec introduces no environment variables. Test isolation uses `monkeypatch` on `resolve_symbol_master_path` directly (§5.1). `.env.example` unchanged.

## 12. Security Notes

- `~/.local/share/hoga-ops/symbol-master.json` contains **public KRX data only** (codes, names, markets). No credentials, no user data. No threat-model implications.
- The `Update Now` endpoint (`POST /api/symbols/refresh`) is unauthenticated — same as the rest of the local-only API. Server binds to `127.0.0.1` per `hoga/cli.py:88`. Do not expose the API to non-loopback interfaces without adding auth.
- Atomic write via `tempfile.NamedTemporaryFile(delete=False)` + `os.replace`. The temp file is created in the same directory as the target and uses POSIX permissions defaulting to `0600` (NamedTemporaryFile default). No race window for content disclosure.

## 13. Out of Scope (future work)

- Automatic background refresh (TTL or scheduled).
- Cancellable refresh.
- Schema v2 migration.
- Partial-market persistence.
- DuckDB / Parquet storage migration.
- SQL JOIN capability for Symbol Master with capture inventory.
- Multi-market beyond KOSPI/KOSDAQ (e.g., KONEX).
- Per-Code metadata beyond `(name, market)` (e.g., sector, industry, listing date).
- A general "data sources management" Settings panel.
