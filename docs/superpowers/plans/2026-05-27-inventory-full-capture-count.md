# Inventory Full Capture Count Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

scope: both

**Goal:** Add a `full_capture_count` counter persisted in meta.json (incremented on each successful capture) and surface it as a `×N` column in the `/inventory` detail table, next to the State column.

**Architecture:** The parser performs a read-modify-write on `meta.json` at write time to increment the counter (existing serial dedup in the capture queue makes this race-safe). The counter ships through the existing `StockDate` wire model (additive optional field, ADR-0004 mirror discipline) and the frontend renders `null → "—"`, `1 → blank`, `≥2 → "×N"`. No backfill — legacy Stock-Dates show `—` until they are Retry'd.

**Tech Stack:** Python 3.11+ (Pydantic v2, pytest), TypeScript (React + Vite + Vitest + React Testing Library), Tailwind design tokens.

**Spec:** [docs/superpowers/specs/2026-05-27-inventory-capture-count-design.md](docs/superpowers/specs/2026-05-27-inventory-capture-count-design.md)

**Glossary:** [CONTEXT.md "Full Capture Count"](CONTEXT.md) — the canonical domain definition. Read it before starting.

---

## File touchlist

| Path | Action |
|---|---|
| [hoga/api/models.py](hoga/api/models.py) | Modify — add `full_capture_count: int \| None = None` field on `StockDate` |
| [hoga/api/queries.py](hoga/api/queries.py) | Modify — pass `meta.get("full_capture_count")` through in `_compute_stock_date` |
| [hoga/parser/__init__.py](hoga/parser/__init__.py) | Modify — read-modify-write at meta.json write site |
| [tests/test_parser_e2e.py](tests/test_parser_e2e.py) | Modify — new tests for counter init / increment / legacy |
| [tests/test_api_stock_dates.py](tests/test_api_stock_dates.py) | Modify — assert counter passes through wire |
| [frontend/src/api/types.ts](frontend/src/api/types.ts) | Modify — add `full_capture_count: number \| null` to `StockDate` TS type |
| [frontend/src/inventory/sortDates.ts](frontend/src/inventory/sortDates.ts) | Modify — add `fullCaptureCount` SortKey + null-last comparator branch |
| [frontend/src/inventory/sortDates.test.ts](frontend/src/inventory/sortDates.test.ts) | Modify — new tests for the SortKey |
| [frontend/src/inventory/StockDateGroupDetail.tsx](frontend/src/inventory/StockDateGroupDetail.tsx) | Modify — new `×N` column between State and Date |
| [frontend/src/inventory/StockDateGroupDetail.test.tsx](frontend/src/inventory/StockDateGroupDetail.test.tsx) | Modify — assert three render branches |

---

## Task 1: Backend model — add optional field

**Files:**
- Modify: `hoga/api/models.py` (the `StockDate` class around line 17–50)
- Test: extend an existing `StockDate` instantiation test if any, OR rely on round-trip behavior from Task 2

- [ ] **Step 1: Add the field**

Edit `hoga/api/models.py`. Find the `class StockDate(BaseModel):` block and add the field after `disk_state: str = "complete"`:

```python
    full_capture_count: int | None = None
    """Number of successful Full Captures for this Stock-Date (initial + Retry-driven
    overwrites of meta.json). Null on legacy meta files written before this counter
    was introduced. See CONTEXT.md "Full Capture Count" and ADR-0031 for the
    distinction from QueueItem.attempt."""
```

- [ ] **Step 2: Verify the model still imports**

Run: `uv run python -c "from hoga.api.models import StockDate; print(StockDate.model_fields['full_capture_count'])"`
Expected: prints a `FieldInfo` line; no import error.

- [ ] **Step 3: Commit**

```bash
git add hoga/api/models.py
git commit -m "feat(models): add StockDate.full_capture_count optional field"
```

---

## Task 2: Backend queries — pass counter through

**Files:**
- Modify: `hoga/api/queries.py` (function `_compute_stock_date` around line 118–208)
- Test: `tests/test_api_stock_dates.py`

- [ ] **Step 1: Write the failing test**

Open `tests/test_api_stock_dates.py` and add at the bottom:

```python
def test_stock_date_full_capture_count_passes_through(tmp_path):
    """meta.json with full_capture_count=5 → StockDate.full_capture_count == 5."""
    import json
    from hoga.api.queries import QueryEngine
    code_dir = tmp_path / "parquet" / "20260519" / "005930"
    code_dir.mkdir(parents=True)
    meta = {
        "code": "005930", "name": "삼성전자",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        "pages_collected": 1, "total_unique_events": 0,
        "today_open": 70_000, "today_high": 71_000, "today_low": 69_000, "today_close": 70_500,
        "parser_version": "0", "collection_complete": True, "is_partial": False,
        "full_capture_count": 5,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    engine = QueryEngine(data_dir=tmp_path)
    rows = engine.list_stock_dates()
    assert len(rows) == 1
    assert rows[0].full_capture_count == 5


def test_stock_date_full_capture_count_null_for_legacy(tmp_path):
    """meta.json without the field → StockDate.full_capture_count is None."""
    import json
    from hoga.api.queries import QueryEngine
    code_dir = tmp_path / "parquet" / "20260519" / "005930"
    code_dir.mkdir(parents=True)
    meta = {
        "code": "005930", "name": "삼성전자",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        "pages_collected": 1, "total_unique_events": 0,
        "today_open": 70_000, "today_high": 71_000, "today_low": 69_000, "today_close": 70_500,
        "parser_version": "0", "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    engine = QueryEngine(data_dir=tmp_path)
    rows = engine.list_stock_dates()
    assert len(rows) == 1
    assert rows[0].full_capture_count is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_stock_dates.py::test_stock_date_full_capture_count_passes_through tests/test_api_stock_dates.py::test_stock_date_full_capture_count_null_for_legacy -v`
Expected: FAIL — `AttributeError: 'StockDate' object has no attribute 'full_capture_count'` OR `AssertionError` because field stays as default None unset by the query.

(Step 1 of Task 1 already added the field to the model, so `AttributeError` may not appear; instead the second assertion may pass while the first fails because the query doesn't read from meta yet — that is the intended failure mode.)

- [ ] **Step 3: Pass the field through in `_compute_stock_date`**

In `hoga/api/queries.py`, in the `return StockDate(...)` call at the end of `_compute_stock_date` (around line 177–208), add a new argument right before `disk_state=_state.value,`:

```python
            full_capture_count=meta.get("full_capture_count"),
            disk_state=_state.value,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_stock_dates.py::test_stock_date_full_capture_count_passes_through tests/test_api_stock_dates.py::test_stock_date_full_capture_count_null_for_legacy -v`
Expected: PASS for both.

- [ ] **Step 5: Run full stock-dates test file to ensure no regression**

Run: `uv run pytest tests/test_api_stock_dates.py tests/test_api_stock_dates_cache.py tests/test_api_stock_dates_completeness.py -v`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/queries.py tests/test_api_stock_dates.py
git commit -m "feat(queries): surface meta.full_capture_count on StockDate"
```

---

## Task 3: Backend parser — read-modify-write counter

**Files:**
- Modify: `hoga/parser/__init__.py` (around line 140–168, just before `(out_dir / "meta.json").write_text(...)`)
- Test: `tests/test_parser_e2e.py`

- [ ] **Step 1: Write failing tests**

Open `tests/test_parser_e2e.py` and add at the bottom (after the existing `staged_raw` fixture-using tests):

```python
def test_parser_writes_full_capture_count_one_on_first_capture(staged_raw: Path) -> None:
    """First successful Full Capture writes full_capture_count=1."""
    out_dir = parse_stock_date(
        code="003490", date="20260519", data_dir=staged_raw / "data",
    )
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 1


def test_parser_increments_full_capture_count_on_recapture(staged_raw: Path) -> None:
    """Second successful Full Capture overwrites meta.json with prior + 1."""
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    # First call → 1. Re-run the parser; same raw, same out dir → second meta write.
    parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 2


def test_parser_increments_full_capture_count_from_legacy_meta(staged_raw: Path) -> None:
    """Legacy meta.json without the field → after Retry, full_capture_count == 1."""
    # Pre-stage a "legacy" meta.json (no full_capture_count) in the out_dir so the
    # parser's read-modify-write sees it. We craft a minimally valid meta then
    # let parse_stock_date overwrite.
    out_dir = staged_raw / "data" / "parquet" / "20260519" / "003490"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(json.dumps({"legacy": True}), encoding="utf-8")
    parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_e2e.py::test_parser_writes_full_capture_count_one_on_first_capture tests/test_parser_e2e.py::test_parser_increments_full_capture_count_on_recapture tests/test_parser_e2e.py::test_parser_increments_full_capture_count_from_legacy_meta -v`
Expected: FAIL with `KeyError: 'full_capture_count'` (the parser doesn't write the field yet).

- [ ] **Step 3: Implement read-modify-write in the parser**

In `hoga/parser/__init__.py`, locate the block at line 163–168:

```python
    if _all_violations:
        meta["invariant_violations"] = [v.as_dict() for v in _all_violations]

    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out_dir
```

Insert the counter logic *before* the `write_text` call (after the violations block):

```python
    if _all_violations:
        meta["invariant_violations"] = [v.as_dict() for v in _all_violations]

    # Full Capture Count (CONTEXT.md): read prior meta and increment.
    # Race-safe because the capture queue dedups same-(code,date) jobs
    # (see hoga/api/captures.py::_dedup_against_in_flight) — sequential
    # write guarantees no lost update under expected operating conditions.
    prior_path = out_dir / "meta.json"
    prior_count = 0
    if prior_path.exists():
        try:
            prior_meta = json.loads(prior_path.read_text(encoding="utf-8"))
            prior_value = prior_meta.get("full_capture_count")
            if isinstance(prior_value, int) and prior_value > 0:
                prior_count = prior_value
        except (OSError, json.JSONDecodeError):
            # Corrupt prior meta is treated as legacy/absent — start at 1.
            prior_count = 0
    meta["full_capture_count"] = prior_count + 1

    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out_dir
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_parser_e2e.py -v`
Expected: ALL tests in the file PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add hoga/parser/__init__.py tests/test_parser_e2e.py
git commit -m "feat(parser): write & increment meta.full_capture_count on every Full Capture"
```

---

## Task 4: Frontend type mirror

**Files:**
- Modify: `frontend/src/api/types.ts` (the `StockDate` type around line 7–15)
- Test: relies on TypeScript compile-checking + downstream component tests

- [ ] **Step 1: Add the field to the TS mirror**

Edit `frontend/src/api/types.ts`. Find the `StockDate` type and add `full_capture_count`:

```ts
export type StockDate = {
  date: string; code: string; name: string;
  regular_session_open_ms: number; regular_session_close_ms: number;
  data_window_first_ms: number; data_window_last_ms: number;
  price_min: number; price_max: number; captured_at: number;
  total_volume: number; pages_collected: number; file_size_bytes: number;
  today_open: number; today_high: number; today_low: number; today_close: number;
  disk_state: DiskStateValue;
  /** ADR-0004 mirror of hoga/api/models.py::StockDate.full_capture_count.
   *  Null on legacy meta.json files written before the counter existed.
   *  See CONTEXT.md "Full Capture Count". */
  full_capture_count: number | null;
};
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `cd frontend && npm run build`
Expected: build succeeds (some test fixtures may fail typecheck temporarily — that's fine, they will be fixed in Task 5/6). If `npm run build` only typechecks `src/` and not tests, this should pass. If not, proceed to Task 5/6 immediately.

If the build fails *only* with errors like `Property 'full_capture_count' is missing in type ...` in test files, that's the expected forcing function for the next tasks. Note the error count and continue.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(types): mirror StockDate.full_capture_count (ADR-0004)"
```

---

## Task 5: Frontend sortDates — add SortKey

**Files:**
- Modify: `frontend/src/inventory/sortDates.ts`
- Test: `frontend/src/inventory/sortDates.test.ts`

- [ ] **Step 1: Write failing tests**

In `frontend/src/inventory/sortDates.test.ts`, update the `row(...)` helper at the top to include the new field with a default of `null`:

```ts
const row = (
  date: string,
  overrides: Partial<StockDate> = {},
): StockDate => ({
  // ... existing fields ...
  disk_state: 'complete',
  full_capture_count: null,
  ...overrides,
});
```

Then append a new `describe` block at the end of the file:

```ts
describe('sortDates fullCaptureCount', () => {
  const rows: StockDate[] = [
    row('20260520', { full_capture_count: 3 }),
    row('20260521', { full_capture_count: null }),
    row('20260522', { full_capture_count: 1 }),
  ];

  it('sorts by fullCaptureCount desc, putting nulls last', () => {
    const out = sortDates(rows, { key: 'fullCaptureCount', dir: 'desc' });
    expect(out.map(r => r.full_capture_count)).toEqual([3, 1, null]);
  });

  it('sorts by fullCaptureCount asc, still keeping nulls last', () => {
    const out = sortDates(rows, { key: 'fullCaptureCount', dir: 'asc' });
    expect(out.map(r => r.full_capture_count)).toEqual([1, 3, null]);
  });
});

describe('nextSortState includes fullCaptureCount', () => {
  it('null + click(fullCaptureCount) goes to desc', () => {
    expect(nextSortState(null, 'fullCaptureCount')).toEqual({ key: 'fullCaptureCount', dir: 'desc' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/inventory/sortDates.test.ts`
Expected: FAIL — TypeScript error on `'fullCaptureCount'` not being a valid `SortKey`, OR runtime failure if TS errors are silenced.

- [ ] **Step 3: Add the SortKey + null-last comparator**

Edit `frontend/src/inventory/sortDates.ts`:

```ts
export type SortKey =
  | 'state' | 'date' | 'captured' | 'volume' | 'pages' | 'size' | 'ohlc'
  | 'fullCaptureCount';
```

`fullCaptureCount` is special: its values include `null`, which must always sort to the end regardless of direction. Add a dedicated branch *inside* `sortDates` rather than complicating `keyOf`:

```ts
export function sortDates(dates: StockDate[], sort: SortState): StockDate[] {
  if (sort === null) return dates;
  const copy = [...dates];
  const mult = sort.dir === 'asc' ? 1 : -1;
  copy.sort((a, b) => {
    // Null-last special case: fullCaptureCount nulls always go to the end.
    if (sort.key === 'fullCaptureCount') {
      const av = a.full_capture_count;
      const bv = b.full_capture_count;
      if (av === null && bv === null) return compare(b.date, a.date);
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = compare(av, bv);
      if (cmp !== 0) return cmp * mult;
      return compare(b.date, a.date);
    }
    const cmp = compare(keyOf(a, sort.key), keyOf(b, sort.key));
    if (cmp !== 0) return cmp * mult;
    if (sort.key === 'date') return 0;
    return compare(b.date, a.date);
  });
  return copy;
}
```

Note: `keyOf`'s switch is exhaustive over the union but doesn't need a `fullCaptureCount` branch because the null-last branch short-circuits before reaching it. Add an explicit `case 'fullCaptureCount':` that throws for defensive belt-and-suspenders:

```ts
function keyOf(row: StockDate, key: SortKey): Comparable {
  switch (key) {
    case 'state':    return STATE_SEVERITY[row.disk_state];
    case 'date':     return row.date;
    case 'captured': return row.captured_at;
    case 'volume':   return row.total_volume;
    case 'pages':    return row.pages_collected;
    case 'size':     return row.file_size_bytes;
    case 'ohlc':     return row.today_close;
    case 'fullCaptureCount':
      // Handled by the null-last branch in sortDates(); unreachable here.
      throw new Error('fullCaptureCount handled separately');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/inventory/sortDates.test.ts`
Expected: ALL PASS (existing 18 + new 3).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/inventory/sortDates.ts frontend/src/inventory/sortDates.test.ts
git commit -m "feat(sortDates): add fullCaptureCount SortKey, nulls always last"
```

---

## Task 6: Frontend column — render `×N` cell

**Files:**
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx` (header row at line 117–122, body row at line 148)
- Test: `frontend/src/inventory/StockDateGroupDetail.test.tsx`

- [ ] **Step 1: Update test fixture to include the new field**

Edit `frontend/src/inventory/StockDateGroupDetail.test.tsx`. Update the `row(...)` helper around line 21–31 — add the field with a default of `null`:

```tsx
const row = (code: string, name: string, date: string,
             disk_state: StockDate['disk_state'] = 'complete'): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: 1000,
  total_volume: 52_100_000, pages_collected: 1240, file_size_bytes: 13_200_000,
  today_open: 70_000, today_high: 73_000, today_low: 69_000, today_close: 72_400,
  disk_state,
  full_capture_count: null,
});
```

- [ ] **Step 2: Add failing tests for the three render branches**

Append to `frontend/src/inventory/StockDateGroupDetail.test.tsx`:

```tsx
describe('StockDateGroupDetail full_capture_count column', () => {
  beforeEach(() => { setupFetch(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders "—" when full_capture_count is null', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: null };
    renderDetail([r], '005930', new QueryClient());
    await waitFor(() => expect(screen.getByText('20260522'.slice(0, 4))).toBeTruthy());
    // The cell next to State (and before Date) should contain an em-dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders empty cell when full_capture_count is 1', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: 1 };
    renderDetail([r], '005930', new QueryClient());
    await waitFor(() => expect(screen.getByText('20260522'.slice(0, 4))).toBeTruthy());
    // No "×1" text should appear, no em-dash for THIS cell (other cells may have dashes).
    expect(screen.queryByText('×1')).toBeNull();
  });

  it('renders "×3" when full_capture_count is 3', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: 3 };
    renderDetail([r], '005930', new QueryClient());
    await waitFor(() => expect(screen.getByText('×3')).toBeTruthy());
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx`
Expected: FAIL on the new 3 tests (no `×3` text rendered, etc.).

- [ ] **Step 4: Add the new column to the header**

Edit `frontend/src/inventory/StockDateGroupDetail.tsx`. Find the `<thead>` block (around line 114–125):

```tsx
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <th className="px-2 py-2 border-b w-8" aria-label="re-capture" />
              <SortableTh column="state"    sort={sort} onSort={onSort}>State</SortableTh>
              <SortableTh column="fullCaptureCount" sort={sort} onSort={onSort} title="Full Capture 누적 횟수">×N</SortableTh>
              <SortableTh column="date"     sort={sort} onSort={onSort}>Date</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>Captured</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>Volume</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>Pages</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>Size</SortableTh>
              <SortableTh column="ohlc"     sort={sort} onSort={onSort} right title="종가 기준 정렬">OHLC</SortableTh>
            </tr>
          </thead>
```

- [ ] **Step 5: Add the body cell**

In the same file, find the `<tr>` body (around line 132–155). After the State `<td>` and before the Date `<td>`, insert:

```tsx
                  <td className="px-3 py-1.5 text-center font-mono tabular-nums">
                    {renderFullCaptureCount(r.full_capture_count)}
                  </td>
```

Then add the helper at the bottom of the file (next to the `RowRecaptureButton` helper):

```tsx
function renderFullCaptureCount(n: number | null): React.ReactNode {
  if (n === null) return <span className="text-fg-dimmer">—</span>;
  if (n <= 1) return null;
  return <span className="text-fg-dim" title={`Full Capture ${n}회`}>×{n}</span>;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx`
Expected: ALL PASS (existing + new 3).

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: ALL PASS. If any other test files referenced a `StockDate` fixture without `full_capture_count`, fix them to add `full_capture_count: null` (the type now requires it).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/inventory/StockDateGroupDetail.tsx frontend/src/inventory/StockDateGroupDetail.test.tsx
git commit -m "feat(inventory): render ×N Full Capture Count column next to State"
```

---

## Task 7: Cross-check — fix any other TS fixtures that need the new field

**Files:** any test or fixture file that constructs a literal `StockDate` and now fails typecheck.

- [ ] **Step 1: Find all StockDate constructions**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -40`
Expected: either no errors, or errors of the form `Property 'full_capture_count' is missing in type ...`. If clean, skip to Step 3.

- [ ] **Step 2: Add the field to each failing fixture**

For each file flagged, add `full_capture_count: null,` to the `StockDate` literal. Common candidates:
- `frontend/src/inventory/useStockDateGroups.test.ts`
- `frontend/src/inventory/StockDateGroupList.test.tsx`
- `frontend/src/inventory/groupByCode.test.ts`
- `frontend/src/inventory/StockDateGroupListItem.test.tsx`
- `frontend/src/inventory/format.test.ts`

Re-run `npx tsc --noEmit` and iterate until clean.

- [ ] **Step 3: Run full frontend test suite + build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: ALL PASS, build succeeds.

- [ ] **Step 4: Commit (if any changes)**

```bash
git add frontend/src
git commit -m "test(inventory): backfill full_capture_count: null in StockDate fixtures"
```

(If no changes were needed, skip this commit.)

---

## Task 8: Manual UI smoke test

**Files:** none. Browser verification per CLAUDE.md frontend rule.

- [ ] **Step 1: Start backend + frontend dev servers**

Backend (in one terminal):
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

Frontend (in another terminal):
```bash
cd frontend && npm run dev
```

- [ ] **Step 2: Open the inventory page**

Visit `http://localhost:5173/inventory` in a browser.

- [ ] **Step 3: Verify three states**

- Existing Stock-Dates from before this change → the `×N` column shows `—`.
- After hitting the `↻` re-capture button on any Stock-Date and waiting for it to finish, the row should now show empty (count went from null → 1, which is rendered as blank).
- Re-capture the same Stock-Date again. The row should now show `×2`.

- [ ] **Step 4: Verify sorting**

Click the `×N` column header. Rows with the highest count come first; rows with `null` (`—`) sink to the bottom regardless of direction.

- [ ] **Step 5: Stop dev servers**

`Ctrl+C` both terminals. No commit — verification only.

---

## Verification gate (out-of-plan, but documented for completeness)

After Task 8, the full-flow pipeline's step 6 will run:

```bash
uv run pytest
cd frontend && npm run build
```

Both must pass before proceeding to step 7 (architecture improvements).

---

## Open follow-ups (Non-goals, deferred)

- Backfill: not in this plan. Legacy Stock-Dates carry `null` until Retry'd.
- Left card aggregation (sum of `full_capture_count` per code): not in this plan.
- Capture timeline (when each Full Capture happened): not in this plan.
- ADR: explicitly not created (single additive field, rationale in spec + glossary).

---

## Self-review checklist (already verified)

- [x] Every spec section maps to a task (model→T1, queries→T2, parser→T3, types→T4, sortDates→T5, UI→T6, fixture sync→T7, smoke→T8).
- [x] No placeholders ("TBD", "TODO", etc.).
- [x] Function names consistent: `full_capture_count` (Python, JSON, TS), `fullCaptureCount` (TS SortKey), `renderFullCaptureCount` (helper). Mirror discipline preserved.
- [x] All file paths absolute or repo-relative; all line ranges cited from current code.
- [x] Tests precede implementation in every task (TDD).
