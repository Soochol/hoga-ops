# Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React + TypeScript Replay Viewer frontend for hoga-ops, plus the four backend additions it depends on.

**Architecture:** Single-page React app under `frontend/`. Backend gains a session-bundle endpoint (5 pre-aggregated time-series per Stock-Date), an SSE channel for inventory pushes, an extended `/api/stock-dates`, and a unified Unix-ms time encoding across every `Api*` model. Frontend stitches multiple Stock-Dates on a compressed virtual time axis, renders five chart panes (Price+Matprofile / Volume / Bid-Ask Imbalance / Depth Intensity / Fill Strength), and a three-card sidebar (10호가 / 거래원 / 체결) driven by a debounced cursor with bounded LRU cache. Multi-tab analysis sessions; URL-encoded workspace state.

**Tech Stack:**
- **Frontend:** Vite + React 18 + TypeScript, `lightweight-charts` v5, `@tanstack/react-query` v5, Zustand, Tailwind CSS, `react-day-picker` v9, `react-router` v7, `@dnd-kit/sortable`, native `EventSource`. Vitest + Testing Library + Playwright.
- **Backend additions:** `sse-starlette`, `watchdog`. Existing FastAPI + DuckDB unchanged.

**Spec:** [`docs/superpowers/specs/2026-05-20-frontend-design.md`](../specs/2026-05-20-frontend-design.md)
**Design system:** [`DESIGN.md`](../../../DESIGN.md)
**Approved mockup:** [`docs/superpowers/designs/2026-05-20-replay-viewer.html`](../designs/2026-05-20-replay-viewer.html)
**ADR:** [`docs/adr/0003-api-time-encoding.md`](../../adr/0003-api-time-encoding.md)
**Glossary:** [`CONTEXT.md`](../../../CONTEXT.md) — Stock-Date, Auction Window, After-Hours Trading, etc.

**Plan convention.** Phases 0-4 and Phase 7 are written at fine-grained step level (write-test → run-fail → implement → run-pass → commit). Phases 5-6 and 8-10 are written at task level with the key code snippets shown — the executing agent expands each task into the same TDD micro-steps in its own session. The executor (`/superpowers:subagent-driven-development`) should treat each Phase-5/6/8-10 task as a small project: write a failing test for the component, then implement, then verify, then commit.

---

## Parallelization lanes

Not every phase needs to run in strict serial. The executor can run independent lanes concurrently in separate worktrees or sequential subagent dispatches without conflict.

```
Wave 1 (after Phase 0 spike passes):
  ├── Lane A: Phase 1 (backend)      — touches hoga/api/, tests/test_api_*
  └── Lane B: Phase 2-4 (FE scaffold + nav + state) — touches frontend/src/{config,api,state,nav,replay}

Wave 2 (after Wave 1 complete):
  ├── Lane C: Phase 5 (Toolbar + OnboardingCard + PriceStrip slot)
  │            depends on: Lane B
  │            touches:    frontend/src/replay/
  └── Lane D: Phase 6 (Chart bootstrap — timeAxis, useSpot, useSession, ChartStage)
               depends on: Lane A, Lane B
               touches:    frontend/src/chart/, frontend/src/util/, frontend/src/api/

Wave 3 (after Wave 2):
  ├── Lane E: Phase 7 (5 chart panes)
  │            depends on: Lane D, Phase 0 spike
  │            touches:    frontend/src/chart/
  └── Lane F: Phase 8 (sidebar)
               depends on: Lane A, Lane B (useSpot lives in Lane D, but sidebar
               imports it as a dependency)
               touches:    frontend/src/sidebar/

Wave 4 (final):
  └── Lane G: Phase 9 (Inventory + Capture + Settings) + Phase 10 (URL state + E2E + ship)
               depends on: C, D, E, F
               touches:    frontend/src/pages/, frontend/tests/e2e/
```

**Conflict surface:** Lane D commits `ChartStage.tsx`. Lane E adds 5 sibling files in `frontend/src/chart/`. As long as Lane D's `ChartStage.tsx` lands before Lane E starts, no merge conflict. Same for Lane B → D (config/types modules).

For subagent-driven-development: dispatch Wave-1 lanes in parallel (two implementer agents at once), then run Wave-2 lanes after both report DONE, etc. The reviewer cadence stays per-task within each lane.

---

## File map — Backend additions

| File | Responsibility |
|---|---|
| `hoga/api/timeenc.py` | Unix-ms ↔ hogaplay encodings (HHMMSSmmm, ms-from-midnight). KST offset baked in. Per ADR 0003. |
| `hoga/api/models.py` | Extend `Meta`, `StockDate`, `ApiTrade`, `ApiOrderbookSnapshot`, `ApiBrokerEntry`, `ApiCandle` to ship Unix ms. Add new `SessionBundle` + slice models. |
| `hoga/api/queries.py` | Add bundle compute helpers (5 parallel DuckDB queries). Extend `list_stock_dates` to include `price_min/max`, `captured_at`, `file_size_bytes`, `total_volume`, `pages_collected`, OHLC. |
| `hoga/api/routes.py` | Add `GET /api/session`. Convert cursor `?t=` params from Unix ms. |
| `hoga/api/sse.py` | New: `GET /api/events` SSE endpoint + watchdog-driven inventory queue. |
| `hoga/api/app.py` | Mount the new router pieces; register watchdog observer in lifespan. |
| `pyproject.toml` | Add `sse-starlette`, `watchdog` to dependencies. |
| `tests/test_timeenc.py` | Round-trip Unix-ms ↔ both intra-day encodings. |
| `tests/test_api_session.py` | Bundle endpoint + all 5 slices. |
| `tests/test_api_sse.py` | SSE inventory_added event when a directory is added. |
| `tests/test_api_stock_dates.py` | Extended fields present and accurate. |

## File map — Frontend (`frontend/`)

| File | Responsibility |
|---|---|
| `frontend/index.html` | Vite entry, dark theme attribute. |
| `frontend/package.json` | Deps + scripts. |
| `frontend/vite.config.ts` | Vite + Tailwind plugin + path aliases. |
| `frontend/tailwind.config.ts` | Reads tokens.css CSS variables; no custom palette. |
| `frontend/tsconfig.json` | Strict TS. |
| `frontend/public/config.json` | Runtime API URL. |
| `frontend/src/main.tsx` | React 18 root + QueryClient + Router. |
| `frontend/src/App.tsx` | Router shell with LeftNav + outlet. |
| `frontend/src/styles/tokens.css` | DESIGN.md tokens as CSS variables. |
| `frontend/src/styles/global.css` | Tailwind directives + a few resets. |
| `frontend/src/config.ts` | Runtime config loader (`/config.json` fetch). |
| `frontend/src/util/time.ts` | Unix-ms helpers, compressed virtual axis math (timeAxis). |
| `frontend/src/util/format.ts` | KRW/qty/timestamp formatting. |
| `frontend/src/util/lru.ts` | Tiny LRU cache (used by useSpot). |
| `frontend/src/api/client.ts` | fetch wrapper using runtime config. |
| `frontend/src/api/types.ts` | Shared types (Bundle, Spot responses, SSE event types). |
| `frontend/src/api/session.ts` | react-query hook for `/api/session`. |
| `frontend/src/api/useSpot.ts` | Cursor-debounced fetch hook with LRU. |
| `frontend/src/api/sse.ts` | `useEventStream` — singleton EventSource. |
| `frontend/src/api/stock-dates.ts` | react-query hook for `/api/stock-dates`. |
| `frontend/src/state/tabs.ts` | Zustand store: tabs, activeTabId, cursor. |
| `frontend/src/state/url.ts` | URL serialization helpers. |
| `frontend/src/nav/LeftNav.tsx` | Persistent left navigation. |
| `frontend/src/nav/NavItem.tsx` | Single nav item. |
| `frontend/src/nav/StatusDot.tsx` | SSE-driven status indicator. |
| `frontend/src/pages/ReplayViewer.tsx` | The replay page (tabs + toolbar + price strip + workarea). |
| `frontend/src/pages/Inventory.tsx` | Sortable inventory table. |
| `frontend/src/pages/Capture.tsx` | Inline guide stub. |
| `frontend/src/pages/Settings.tsx` | API URL + version. |
| `frontend/src/replay/TabStrip.tsx` | Tab strip with dnd-kit. |
| `frontend/src/replay/Tab.tsx` | Single tab. |
| `frontend/src/replay/Toolbar.tsx` | Stock combobox + date pickers + Load. |
| `frontend/src/replay/StockCombobox.tsx` | Searchable inventory dropdown. |
| `frontend/src/replay/DateRangePicker.tsx` | Two react-day-picker popovers. |
| `frontend/src/replay/PriceStrip.tsx` | Viewport-tracked price + delta + OHLC. |
| `frontend/src/replay/OnboardingCard.tsx` | State-driven onboarding card. |
| `frontend/src/chart/ChartStage.tsx` | Owns lightweight-charts instance + pane composition. |
| `frontend/src/chart/CandlePane.tsx` | Candles (with matprofile overlay child). |
| `frontend/src/chart/VolumeProfileOverlay.tsx` | Canvas overlay on the candle pane. |
| `frontend/src/chart/VolumePane.tsx` | Per-minute volume bars. |
| `frontend/src/chart/RatioPane.tsx` | Signed bid/ask imbalance line. |
| `frontend/src/chart/IntensityPane.tsx` | Canvas heatmap (bid + ask split). |
| `frontend/src/chart/FillStrengthPane.tsx` | 0-centered buy/sell bars. |
| `frontend/src/sidebar/CursorSidebar.tsx` | Sidebar layout (50/25/25). |
| `frontend/src/sidebar/OrderbookTable.tsx` | 10+10 orderbook. |
| `frontend/src/sidebar/BrokerNetTable.tsx` | Sorted broker net flow. |
| `frontend/src/sidebar/FillTape.tsx` | Recent trades tape. |
| `frontend/tests/unit/*.test.ts` | Vitest unit tests. |
| `frontend/tests/component/*.test.tsx` | Testing Library component tests. |
| `frontend/tests/e2e/smoke.spec.ts` | Playwright smoke. |

---

## Phase 0 — Mandatory pre-implementation spike (1 task)

### Task 0.1: lightweight-charts custom overlay spike

**Goal (per spec §10):** verify that custom canvas overlays sync with lightweight-charts' `timeScale`/`priceScale` under zoom/pan, repaint <16 ms at the depth-intensity cell count, and z-order correctly. If this spike fails, switch to KLineCharts before proceeding.

**Files:**
- Create: `frontend-spike/index.html`, `frontend-spike/main.ts` (throwaway, deleted at end of phase)

- [ ] **Step 1: Scaffold spike**

```bash
mkdir -p frontend-spike && cd frontend-spike
npm init -y
npm install lightweight-charts@^5
npm install -D vite typescript @types/node
```

Create `frontend-spike/index.html`:

```html
<!doctype html>
<html><body style="background:#0E0E14;margin:0;">
<div id="chart" style="width:100vw;height:60vh;"></div>
<div id="stats" style="color:#94A3B8;font:11px monospace;padding:8px;"></div>
<script type="module" src="./main.ts"></script>
</body></html>
```

- [ ] **Step 2: Render candle pane + canvas overlay**

Create `frontend-spike/main.ts`:

```ts
import { createChart, CandlestickSeries } from 'lightweight-charts';

const container = document.getElementById('chart')!;
const chart = createChart(container, {
  layout: { background: { color: '#0E0E14' }, textColor: '#E2E8F0' },
  grid: { vertLines: { color: '#1A1A26' }, horzLines: { color: '#1A1A26' } },
});
const candles = chart.addSeries(CandlestickSeries);

// Synthetic data: 1000 1-min candles
const data = Array.from({ length: 1000 }, (_, i) => {
  const t = (1747526400 + i * 60) as any;
  const o = 70000 + Math.sin(i / 50) * 500;
  return { time: t, open: o, high: o + 100, low: o - 100, close: o + (i % 2 ? 50 : -50) };
});
candles.setData(data);

// Custom overlay: heatmap canvas synced with timeScale
const overlay = document.createElement('canvas');
Object.assign(overlay.style, {
  position: 'absolute', top: '0', left: '0', pointerEvents: 'none', mixBlendMode: 'screen',
});
container.appendChild(overlay);
overlay.width = container.clientWidth;
overlay.height = container.clientHeight;
const ctx = overlay.getContext('2d')!;

// 200 price bins × 1000 time buckets = 200k cells
const grid = Array.from({ length: 1000 }, () =>
  Array.from({ length: 200 }, () => Math.random() ** 2),
);

let frameCount = 0, lastT = performance.now();
function paint() {
  const startT = performance.now();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const timeScale = chart.timeScale();
  const cellW = (timeScale.timeToCoordinate(data[1].time)! - timeScale.timeToCoordinate(data[0].time)!);
  const cellH = overlay.height / 200;
  for (let t = 0; t < 1000; t++) {
    const x = timeScale.timeToCoordinate(data[t].time);
    if (x === null) continue;
    for (let p = 0; p < 200; p++) {
      const a = grid[t][p];
      if (a < 0.05) continue;
      ctx.fillStyle = `rgba(20,184,166,${a})`;
      ctx.fillRect(x, p * cellH, cellW, cellH);
    }
  }
  const dur = performance.now() - startT;
  frameCount++;
  if (performance.now() - lastT > 1000) {
    document.getElementById('stats')!.textContent =
      `paint ${dur.toFixed(1)}ms · fps ${frameCount} · cells 200k`;
    frameCount = 0;
    lastT = performance.now();
  }
}
chart.timeScale().subscribeVisibleTimeRangeChange(paint);
chart.subscribeCrosshairMove(paint);
window.addEventListener('resize', () => { overlay.width = container.clientWidth; overlay.height = container.clientHeight; paint(); });
paint();
```

- [ ] **Step 3: Validate**

```bash
npx vite
# Open the printed URL in a browser. Verify:
# - candles render
# - overlay teal heatmap appears on top with screen blend
# - mouse-wheel zoom moves overlay cells in sync with candles
# - drag-pan moves both in sync
# - stats line shows paint < 16 ms (60 fps target)
```

Expected: synced overlay, paint <16 ms at 200k cells. If any of these fail, **stop and discuss with the spec author** before proceeding. Likely fix: switch to KLineCharts (per spec §10 fallback).

- [ ] **Step 4: Discard the spike and commit a note**

```bash
cd .. && rm -rf frontend-spike
echo "Spike passed on $(date +%Y-%m-%d): lightweight-charts v5 + custom canvas overlay sync confirmed." >> docs/superpowers/plans/2026-05-20-frontend-impl.md
git add docs/superpowers/plans/2026-05-20-frontend-impl.md
git commit -m "chore(plan): record lightweight-charts spike result"
```

---

## Phase 1 — Backend foundations (8 tasks)

### Task 1.1: Time encoding helper + tests (ADR 0003)

**Files:**
- Create: `hoga/api/timeenc.py`
- Create: `tests/test_timeenc.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_timeenc.py`:

```python
"""Unix-ms ↔ hogaplay intra-day encodings, per ADR 0003."""
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)


def test_hhmmssms_round_trip_at_open():
    # 2026-05-18 09:00:00.000 KST = 2026-05-18 00:00:00.000 UTC
    unix_ms = hhmmssms_to_unix_ms("20260518", 90000000)
    assert unix_ms == 1747526400000
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 90000000


def test_hhmmssms_round_trip_at_close():
    unix_ms = hhmmssms_to_unix_ms("20260518", 153000000)
    # 15:30 KST = 06:30 UTC
    assert unix_ms == 1747526400000 + 23400000  # +6h30m
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 153000000


def test_ms_from_midnight_to_unix_at_open():
    # 09:00 = 32_400_000 ms from midnight (9 hours)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 32_400_000)
    assert unix_ms == 1747526400000


def test_ms_from_midnight_to_unix_at_premarket():
    # 08:30 = 30_600_000 ms (matches the chart.tsv fixture)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 30_600_000)
    assert unix_ms == 1747526400000 - 1800000  # 30 min before 09:00 KST
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_timeenc.py -v
# Expected: ImportError / module not found
```

- [ ] **Step 3: Implement helper**

Create `hoga/api/timeenc.py`:

```python
"""Time encoding helpers for the API boundary, per ADR 0003.

Parquet tables retain hogaplay's native encodings (HHMMSSmmm for trades /
snapshots / brokers / info, ms-from-midnight for candles). The Api* models
expose Unix epoch ms (UTC) everywhere. Hogaplay is KRX-only, so the offset
is a fixed +09:00 with no DST.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))


def _date_unix_ms_at_kst_midnight(date: str) -> int:
    dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=KST)
    return int(dt.timestamp() * 1000)


def hhmmssms_to_unix_ms(date: str, hhmmssms: int) -> int:
    """Convert hogaplay's HHMMSSmmm packed-decimal time to Unix ms (UTC).

    Example: ``hhmmssms_to_unix_ms("20260518", 90000000) == 1747526400000``
    (09:00:00.000 KST on 2026-05-18).
    """
    h = hhmmssms // 10_000_000
    m = (hhmmssms // 100_000) % 100
    s = (hhmmssms // 1000) % 100
    ms = hhmmssms % 1000
    return _date_unix_ms_at_kst_midnight(date) + (h * 3600 + m * 60 + s) * 1000 + ms


def ms_from_midnight_to_unix_ms(date: str, intra_ms: int) -> int:
    """Convert candles.parquet's ms-from-midnight to Unix ms (UTC)."""
    return _date_unix_ms_at_kst_midnight(date) + intra_ms


def unix_ms_to_hhmmssms(date: str, unix_ms: int) -> int:
    """Inverse of :func:`hhmmssms_to_unix_ms` — used by route handlers that
    take a Unix-ms cursor and need to query a Parquet table that stores
    HHMMSSmmm. ``date`` is the Stock-Date the cursor falls into.
    """
    base = _date_unix_ms_at_kst_midnight(date)
    delta_ms = unix_ms - base
    if not 0 <= delta_ms < 86_400_000:
        raise ValueError(f"Unix ms {unix_ms} is not within Stock-Date {date}")
    h, rem = divmod(delta_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return h * 10_000_000 + m * 100_000 + s * 1000 + ms
```

- [ ] **Step 4: Run to verify pass**

```bash
pytest tests/test_timeenc.py -v
# Expected: 4 passed
```

- [ ] **Step 5: Commit**

```bash
git add hoga/api/timeenc.py tests/test_timeenc.py
git commit -m "feat(api): Unix-ms time encoding helpers per ADR 0003"
```

### Task 1.2: Extended Meta + stock-dates models

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/queries.py`
- Create: `tests/test_api_stock_dates.py`

- [ ] **Step 1: Write failing test**

Create `tests/test_api_stock_dates.py`:

```python
"""Extended /api/stock-dates response per frontend spec §4.4."""
from fastapi.testclient import TestClient

from hoga.api.app import create_app


def test_stock_dates_includes_extended_fields(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/stock-dates")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 1
    row = rows[0]
    # Existing fields
    assert "code" in row and "name" in row and "date" in row
    # ADR 0003 — Unix ms encoding
    assert row["regular_session_open_ms"] > 1_700_000_000_000
    # New fields
    for f in (
        "price_min",
        "price_max",
        "captured_at",
        "total_volume",
        "pages_collected",
        "file_size_bytes",
        "today_open",
        "today_high",
        "today_low",
        "today_close",
    ):
        assert f in row, f"missing field {f}"
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_api_stock_dates.py -v
# Expected: KeyError / missing fields
```

- [ ] **Step 3: Extend StockDate model**

Edit `hoga/api/models.py` — replace the `StockDate` class:

```python
class StockDate(BaseModel):
    date: str
    code: str
    name: str
    regular_session_open_ms: int   # Unix ms per ADR 0003
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int
    # Frontend spec §4.4
    price_min: int
    price_max: int
    captured_at: int               # Unix ms of latest mtime in the Stock-Date dir
    total_volume: int
    pages_collected: int
    file_size_bytes: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
```

- [ ] **Step 4: Extend queries**

Edit `hoga/api/queries.py` — replace `list_stock_dates` to read `meta.json` and compute the new fields. Show the key parts:

```python
import os
from hoga.api.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms

def list_stock_dates(self) -> list[StockDate]:
    base = self.data_dir / "parquet"
    if not base.exists():
        return []
    out: list[StockDate] = []
    for date_dir in sorted(base.iterdir()):
        for code_dir in sorted(date_dir.iterdir()):
            meta_path = code_dir / "meta.json"
            if not meta_path.exists():
                continue
            meta = json.loads(meta_path.read_text())
            date = date_dir.name
            # Convert hogaplay encodings to Unix ms
            session_open = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
            session_close = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
            # Price range from candles
            candles_path = code_dir / "candles.parquet"
            row = self._conn.execute(
                "SELECT MIN(low), MAX(high), SUM(vol_a + vol_b) FROM read_parquet(?)",
                [str(candles_path)],
            ).fetchone()
            price_min, price_max, total_volume = row
            # Filesystem stats
            file_size_bytes = sum(
                p.stat().st_size for p in code_dir.iterdir() if p.is_file()
            )
            captured_at = int(max(p.stat().st_mtime for p in code_dir.iterdir()) * 1000)
            out.append(StockDate(
                date=date, code=code_dir.name, name=meta["name"],
                regular_session_open_ms=session_open,
                regular_session_close_ms=session_close,
                data_window_first_ms=ms_from_midnight_to_unix_ms(date, meta.get("data_window_first_ms", 0)),
                data_window_last_ms=ms_from_midnight_to_unix_ms(date, meta.get("data_window_last_ms", 0)),
                price_min=int(price_min), price_max=int(price_max),
                captured_at=captured_at,
                total_volume=int(total_volume),
                pages_collected=meta["pages_collected"],
                file_size_bytes=file_size_bytes,
                today_open=meta["today_open"], today_high=meta["today_high"],
                today_low=meta["today_low"], today_close=meta["today_close"],
            ))
    return out
```

- [ ] **Step 5: Run to verify pass**

```bash
pytest tests/test_api_stock_dates.py -v
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/api/queries.py tests/test_api_stock_dates.py
git commit -m "feat(api): extend StockDate with price range, captured_at, file size, OHLC"
```

### Task 1.3 — split: convert each table module's ts_ms to Unix ms (ADR 0003)

Task 1.3 splits into 4 sub-tasks, one per table module. Each is a tight TDD cycle: failing test → modify query helper to convert `ts_ms` to Unix ms at the boundary → modify route to pass `date` and convert incoming cursor `?t=` from Unix ms → run, pass, commit.

The signature change for every query helper is: add a required `date: str` parameter. The route handler reads `date` from the request and forwards it. Cursor `t` params (`/api/orderbook?t=`, etc.) accept Unix ms from the client; the route converts back to HHMMSSmmm via `unix_ms_to_hhmmssms(date, t)` before calling the query.

### Task 1.3a: Trades — Unix-ms boundary

**Files:**
- Modify: `hoga/tables/trades.py` (`query_up_to`, `query_range`)
- Modify: `hoga/api/routes.py` (`trades` handler)
- Modify: `tests/test_api.py`

- [ ] **Step 1: Write failing test**

```python
def test_trades_ts_ms_is_unix(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    # Cursor as Unix ms (2026-05-19 12:30 KST ≈ 1747615800000)
    r = client.get("/api/trades?code=003490&date=20260519&t=1747615800000&limit=5")
    rows = r.json()["trades"]
    assert all(t["ts_ms"] > 1_700_000_000_000 for t in rows), "ts_ms must be Unix ms"
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_api.py::test_trades_ts_ms_is_unix -v
# Expected: FAIL (current ts_ms are 9-digit HHMMSSmmm)
```

- [ ] **Step 3: Modify `hoga/tables/trades.py`**

Add `date: str` to `query_up_to` and `query_range` signatures. At the SELECT entry, convert Unix-ms `t` back to HHMMSSmmm for the WHERE clause. At each row, convert outgoing `ts_ms` to Unix ms.

```python
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

def query_up_to(conn, *, path, t_ms, limit, date):
    raw_t = unix_ms_to_hhmmssms(date, t_ms)
    rows = conn.execute(
        "SELECT ts_ms, seq, price, change_pct, qty, side, cum_vol, cum_trades, "
        "low_so_far, high_so_far, net_pressure "
        "FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
        [str(path), raw_t, limit],
    ).fetchall()
    return [
        ApiTrade(
            ts_ms=hhmmssms_to_unix_ms(date, r[0]),
            seq=r[1], price=r[2], change_pct=r[3], qty=r[4], side=r[5],
            cum_vol=r[6], cum_trades=r[7], low_so_far=r[8], high_so_far=r[9],
            net_pressure=r[10],
        )
        for r in rows
    ]

def query_range(conn, *, path, from_ms, to_ms, limit, date):
    raw_from = unix_ms_to_hhmmssms(date, from_ms)
    raw_to = unix_ms_to_hhmmssms(date, to_ms)
    rows = conn.execute(
        "SELECT ts_ms, seq, price, change_pct, qty, side, cum_vol, cum_trades, "
        "low_so_far, high_so_far, net_pressure "
        "FROM read_parquet(?) WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms LIMIT ?",
        [str(path), raw_from, raw_to, limit],
    ).fetchall()
    return [
        ApiTrade(
            ts_ms=hhmmssms_to_unix_ms(date, r[0]),
            seq=r[1], price=r[2], change_pct=r[3], qty=r[4], side=r[5],
            cum_vol=r[6], cum_trades=r[7], low_so_far=r[8], high_so_far=r[9],
            net_pressure=r[10],
        )
        for r in rows
    ]
```

- [ ] **Step 4: Update `hoga/api/routes.py` trades handler to forward `date`**

```python
@router.get("/trades", response_model=TradesResponse)
def trades(code: str, date: str, t: int | None = Query(None),
           from_ms: int | None = Query(None, alias="from"),
           to_ms: int | None = Query(None, alias="to"),
           limit: int = 50) -> TradesResponse:
    try:
        path = engine.parquet_dir(date, code) / "trades.parquet"
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    if from_ms is not None and to_ms is not None:
        rows = trades_tbl.query_range(engine.conn, path=path,
                                       from_ms=from_ms, to_ms=to_ms,
                                       limit=limit, date=date)
    elif t is not None:
        rows = trades_tbl.query_up_to(engine.conn, path=path, t_ms=t,
                                        limit=limit, date=date)
    else:
        raise HTTPException(status_code=400, detail="provide either ?t= or ?from=&to=")
    return TradesResponse(trades=rows)
```

- [ ] **Step 5: Run + commit**

```bash
pytest tests/test_api.py::test_trades_ts_ms_is_unix -v
git add hoga/tables/trades.py hoga/api/routes.py tests/test_api.py
git commit -m "feat(trades): ts_ms Unix encoding at API boundary (ADR 0003)"
```

### Task 1.3b: Orderbook snapshots — Unix-ms boundary

**Files:**
- Modify: `hoga/tables/snapshots.py` (`query_at`, `query_first_ts`)
- Modify: `hoga/api/routes.py` (`orderbook` handler)
- Modify: `tests/test_api.py`

Same pattern as 1.3a. `query_at(conn, *, path, t_ms, date)` converts the incoming Unix-ms `t_ms` via `unix_ms_to_hhmmssms`, queries, then converts the row's `ts_ms` back to Unix ms. `query_first_ts` returns Unix ms when present.

- [ ] **Step 1: Write failing test**

```python
def test_orderbook_ts_ms_is_unix(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/orderbook?code=003490&date=20260519&t=1747615800000")
    snap = r.json()["snapshot"]
    if snap is not None:
        assert snap["ts_ms"] > 1_700_000_000_000
```

- [ ] **Step 2-5: Run-fail, implement (same pattern as 1.3a), verify, commit**

```bash
git add hoga/tables/snapshots.py hoga/api/routes.py tests/test_api.py
git commit -m "feat(snapshots): ts_ms Unix encoding at API boundary (ADR 0003)"
```

### Task 1.3c: Brokers — Unix-ms boundary

**Files:**
- Modify: `hoga/tables/brokers.py` (`query_at`)
- Modify: `hoga/api/routes.py` (`brokers` handler)
- Modify: `tests/test_api.py`

Same pattern. `BrokersAt` model has a `ts_ms` field; convert it.

- [ ] **Step 1: Write failing test → Step 5: commit**

```bash
git commit -m "feat(brokers): ts_ms Unix encoding at API boundary (ADR 0003)"
```

### Task 1.3d: Candles — ms-from-midnight → Unix-ms

**Files:**
- Modify: `hoga/tables/candles.py` (`query_all`)
- Modify: `hoga/api/routes.py` (`candles` handler)
- Modify: `tests/test_api.py`

Different from 1.3a-c: candles' raw `ts_ms` is `ms-from-midnight`, not HHMMSSmmm. Use `ms_from_midnight_to_unix_ms(date, raw)` for the conversion.

```python
from hoga.api.timeenc import ms_from_midnight_to_unix_ms

def query_all(conn, *, path, date):
    rows = conn.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [str(path)],
    ).fetchall()
    return [
        ApiCandle(
            ts_ms=ms_from_midnight_to_unix_ms(date, r[0]),
            open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6],
        )
        for r in rows
    ]
```

- [ ] **Step 1: Write failing test**

```python
def test_candle_ts_ms_is_unix(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/candles?code=003490&date=20260519")
    candles = r.json()["candles"]
    assert all(c["ts_ms"] > 1_700_000_000_000 for c in candles)
```

- [ ] **Step 2-5: Run-fail, implement, verify, commit**

```bash
git commit -m "feat(candles): ts_ms Unix encoding at API boundary (ADR 0003)"
```

### Task 1.4: Session bundle endpoint — schema

**Files:**
- Modify: `hoga/api/models.py`

- [ ] **Step 1: Add bundle slice models**

Append to `hoga/api/models.py`:

```python
class QuoteRatioPoint(BaseModel):
    t: int          # Unix ms
    bid_total: int
    ask_total: int


class QuoteRatio(BaseModel):
    bucket_ms: int
    points: list[QuoteRatioPoint]


class DepthIntensity(BaseModel):
    bucket_ms: int
    price_min: int
    price_max: int
    price_step: int
    times: list[int]              # Unix ms per bucket
    bid_grid: list[list[float]]   # len(times) × price_bins
    ask_grid: list[list[float]]


class VolumeProfileBin(BaseModel):
    price_low: int
    qty: int


class VolumeProfile(BaseModel):
    bin_count: int
    price_min: int
    price_max: int
    bin_width: int
    bins: list[VolumeProfileBin]


class FillStrengthPoint(BaseModel):
    t: int
    buy_qty: int
    sell_qty: int


class FillStrength(BaseModel):
    bucket_ms: int
    points: list[FillStrengthPoint]


class SessionBundle(BaseModel):
    code: str
    date: str
    session_open_ms: int
    session_close_ms: int
    candles: list[ApiCandle]
    quote_ratio: QuoteRatio
    depth_intensity: DepthIntensity
    volume_profile: VolumeProfile
    fill_strength: FillStrength
```

- [ ] **Step 2: Commit (no test yet — implementation in next task)**

```bash
git add hoga/api/models.py
git commit -m "feat(api): SessionBundle schema (5 slices)"
```

### Task 1.5 — split: session bundle compute, one slice at a time

Task 1.5 splits into 5 sub-tasks (1.5a-1.5e), one per slice. Each implements its slice with a focused correctness test, then the wire-up task (1.5f) assembles them under `/api/session`. This keeps each task within reviewable size and makes per-slice bugs catchable in isolation.

**Files (shared across 1.5a-1.5f):**
- Create: `hoga/api/bundle.py` (compute helpers — extended per task)
- Modify: `hoga/api/routes.py` (the `/api/session` handler in 1.5f only)
- Create: `tests/test_api_session.py` (one focused test added per task)

### Task 1.5a: `candles` slice

- [ ] **Step 1: Write failing test**

```python
def test_session_candles_slice(tiny_data_dir):
    from hoga.api.bundle import build_candles_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    rows = build_candles_slice(eng.conn, code="003490", date="20260519",
                                data_dir=tiny_data_dir)
    assert len(rows) >= 1
    assert all(r.ts_ms > 1_700_000_000_000 for r in rows)
    # OHLCV plausibility
    assert all(r.high >= r.low for r in rows)
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement `build_candles_slice`**

Create `hoga/api/bundle.py` (initially with just this slice):

```python
"""DuckDB-driven session bundle slices, one builder per slice."""
from __future__ import annotations

import json
from pathlib import Path

import duckdb

from hoga.api.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms
from hoga.api.models import ApiCandle


def build_candles_slice(conn, *, code, date, data_dir):
    path = str(data_dir / "parquet" / date / code / "candles.parquet")
    rows = conn.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [path],
    ).fetchall()
    return [
        ApiCandle(
            ts_ms=ms_from_midnight_to_unix_ms(date, r[0]),
            open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6],
        )
        for r in rows
    ]
```

- [ ] **Step 4-5: Run, pass, commit**

```bash
git add hoga/api/bundle.py tests/test_api_session.py
git commit -m "feat(bundle): candles slice"
```

### Task 1.5b: `quote_ratio` slice

- [ ] **Step 1: Write failing test**

```python
def test_session_quote_ratio_slice(tiny_data_dir):
    from hoga.api.bundle import build_quote_ratio_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    qr = build_quote_ratio_slice(eng.conn, code="003490", date="20260519",
                                  data_dir=tiny_data_dir, bucket_ms=1000)
    assert qr.bucket_ms == 1000
    assert len(qr.points) >= 1
    # Last-snapshot-per-bucket semantics: timestamps strictly increasing
    ts = [p.t for p in qr.points]
    assert ts == sorted(ts)
    # Both totals are non-negative
    assert all(p.bid_total >= 0 and p.ask_total >= 0 for p in qr.points)
```

- [ ] **Step 2-5: Run-fail, implement, run-pass, commit**

Add to `hoga/api/bundle.py`:

```python
from hoga.api.models import QuoteRatio, QuoteRatioPoint

def build_quote_ratio_slice(conn, *, code, date, data_dir, bucket_ms=1000):
    path = str(data_dir / "parquet" / date / code / "snapshots.parquet")
    rows = conn.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 ts_ms / {bucket_ms} AS bucket,
                 ROW_NUMBER() OVER (PARTITION BY ts_ms / {bucket_ms}
                                   ORDER BY ts_ms DESC) AS rn
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms}, bid_total, ask_total
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [path],
    ).fetchall()
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                bid_total=int(r[1]), ask_total=int(r[2]),
            )
            for r in rows
        ],
    )
```

```bash
git commit -m "feat(bundle): quote_ratio slice (last snapshot per bucket)"
```

### Task 1.5c: `depth_intensity` slice (most complex, includes cell cap)

- [ ] **Step 1: Write failing tests**

```python
def test_session_depth_intensity_bid_ask_split(tiny_data_dir):
    from hoga.api.bundle import build_depth_intensity_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    di = build_depth_intensity_slice(
        eng.conn, code="003490", date="20260519",
        data_dir=tiny_data_dir, depth_bucket_ms=5000,
    )
    # Two grids of equal length
    assert len(di.bid_grid) == len(di.ask_grid)
    # All cells non-negative
    for col in di.bid_grid + di.ask_grid:
        assert all(v >= 0 for v in col)
    # Cap respected: at most 2M cells per grid
    assert len(di.bid_grid) * len(di.bid_grid[0]) <= 2_000_000


def test_depth_intensity_cap_widens_bucket(tiny_data_dir):
    """If raw 1-s bucket would exceed cap, bucket widens automatically."""
    from hoga.api.bundle import build_depth_intensity_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    # Force a tiny cap to exercise the widening branch
    di = build_depth_intensity_slice(
        eng.conn, code="003490", date="20260519",
        data_dir=tiny_data_dir, depth_bucket_ms=1000, max_cells=100,
    )
    assert len(di.bid_grid) * len(di.bid_grid[0]) <= 100
    assert di.bucket_ms >= 1000
```

- [ ] **Step 2-3: Run-fail, implement**

Add to `hoga/api/bundle.py`:

```python
from hoga.api.models import DepthIntensity

KRX_TICK_TIERS = [
    (2_000, 1), (5_000, 5), (20_000, 10),
    (50_000, 50), (200_000, 100),
    (500_000, 500), (float("inf"), 1_000),
]

def tick_size(price_max):
    for threshold, t in KRX_TICK_TIERS:
        if price_max < threshold:
            return t
    return 1_000


def _build_unpivot_sql(snapshots_path: str) -> str:
    """Generate the 20-row UNPIVOT (10 ask + 10 bid) for snapshots.parquet."""
    parts = []
    for i in range(1, 11):
        parts.append(
            f"SELECT ts_ms, 'ask' AS side, ask_p{i} AS price, ask_q{i} AS qty "
            f"FROM read_parquet('{snapshots_path}')"
        )
    for i in range(1, 11):
        parts.append(
            f"SELECT ts_ms, 'bid', bid_p{i}, bid_q{i} "
            f"FROM read_parquet('{snapshots_path}')"
        )
    return "\n  UNION ALL\n  ".join(parts)


def build_depth_intensity_slice(
    conn, *, code, date, data_dir,
    price_min=None, price_max=None,
    depth_bucket_ms=5000, max_cells=2_000_000,
):
    code_dir = data_dir / "parquet" / date / code
    candles_path = str(code_dir / "candles.parquet")
    snapshots_path = str(code_dir / "snapshots.parquet")

    # 1. Determine price range
    if price_min is None or price_max is None:
        row = conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    tick = tick_size(price_max)
    bin_count = (price_max - price_min) // tick + 1

    # 2. Cell-cap enforcement: widen bucket until len(times) * bin_count <= max_cells
    # Trading window = 7 hours = 25,200,000 ms. Times count = 25_200_000 // bucket.
    while True:
        n_times = 25_200_000 // depth_bucket_ms
        if n_times * bin_count <= max_cells:
            break
        depth_bucket_ms *= 2

    # 3. Run unpivot + bin
    unpivot_sql = _build_unpivot_sql(snapshots_path)
    rows = conn.execute(
        f"""
        WITH unpivoted AS (
          {unpivot_sql}
        ),
        binned AS (
          SELECT (ts_ms / {depth_bucket_ms}) AS bucket,
                 side,
                 (price - {price_min}) / {tick} AS bin_idx,
                 MAX(qty) AS max_qty
          FROM unpivoted
          WHERE price BETWEEN {price_min} AND {price_max}
          GROUP BY 1, 2, 3
        )
        SELECT bucket * {depth_bucket_ms}, side, bin_idx, max_qty
        FROM binned ORDER BY bucket, side, bin_idx
        """,
    ).fetchall()

    # 4. Reshape into grids
    times_set = sorted({r[0] for r in rows})
    times = [hhmmssms_to_unix_ms(date, t) for t in times_set]
    bid_grid = [[0.0] * bin_count for _ in times_set]
    ask_grid = [[0.0] * bin_count for _ in times_set]
    t_idx = {t: i for i, t in enumerate(times_set)}
    for t, side, b, q in rows:
        target = ask_grid if side == "ask" else bid_grid
        target[t_idx[t]][b] = float(q)

    return DepthIntensity(
        bucket_ms=depth_bucket_ms,
        price_min=price_min, price_max=price_max, price_step=tick,
        times=times, bid_grid=bid_grid, ask_grid=ask_grid,
    )
```

- [ ] **Step 4-5: Run, pass, commit**

```bash
git commit -m "feat(bundle): depth_intensity slice with bid/ask split + cell cap"
```

### Task 1.5d: `volume_profile` slice

- [ ] **Step 1: Write failing test**

```python
def test_session_volume_profile_slice(tiny_data_dir):
    from hoga.api.bundle import build_volume_profile_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    vp = build_volume_profile_slice(
        eng.conn, code="003490", date="20260519",
        data_dir=tiny_data_dir, vp_bins=24,
    )
    assert vp.bin_count == 24
    assert len(vp.bins) == 24
    # Bins are price-sorted ascending
    prices = [b.price_low for b in vp.bins]
    assert prices == sorted(prices)
    # Includes auction-cross volume (no side filter)
    total = sum(b.qty for b in vp.bins)
    assert total >= 0
```

- [ ] **Step 2-5: Run-fail, implement, run-pass, commit**

```python
from hoga.api.models import VolumeProfile, VolumeProfileBin

def build_volume_profile_slice(
    conn, *, code, date, data_dir,
    price_min=None, price_max=None, vp_bins=24,
):
    code_dir = data_dir / "parquet" / date / code
    candles_path = str(code_dir / "candles.parquet")
    trades_path = str(code_dir / "trades.parquet")
    if price_min is None or price_max is None:
        row = conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    bin_width = (price_max - price_min) / vp_bins
    # No side filter — auction crosses count toward volume profile per spec §4.1
    rows = conn.execute(
        f"""
        SELECT FLOOR((price - {price_min}) / {bin_width}) AS bin_idx, SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_min} AND {price_max}
        GROUP BY 1 ORDER BY 1
        """,
        [trades_path],
    ).fetchall()
    bins_arr = [
        VolumeProfileBin(price_low=int(price_min + i * bin_width), qty=0)
        for i in range(vp_bins)
    ]
    for idx, qty in rows:
        i = int(idx)
        if 0 <= i < vp_bins:
            bins_arr[i] = VolumeProfileBin(
                price_low=int(price_min + i * bin_width), qty=int(qty),
            )
    return VolumeProfile(
        bin_count=vp_bins, price_min=price_min, price_max=price_max,
        bin_width=int(bin_width), bins=bins_arr,
    )
```

```bash
git commit -m "feat(bundle): volume_profile slice (24 equal-width bins, all sides)"
```

### Task 1.5e: `fill_strength` slice

- [ ] **Step 1: Write failing test**

```python
def test_session_fill_strength_excludes_auctions(tiny_data_dir):
    from hoga.api.bundle import build_fill_strength_slice
    from hoga.api.queries import QueryEngine
    eng = QueryEngine(tiny_data_dir)
    fs = build_fill_strength_slice(eng.conn, code="003490", date="20260519",
                                    data_dir=tiny_data_dir)
    assert fs.bucket_ms == 60000
    # Per spec §4.1: fill_strength excludes side = 0
    # So sum(buy + sell) == sum(trades with side != 0, .qty)
    expected = eng.conn.execute(
        "SELECT SUM(qty) FROM read_parquet(?) WHERE side != 0",
        [str(tiny_data_dir / 'parquet' / '20260519' / '003490' / 'trades.parquet')],
    ).fetchone()[0] or 0
    actual = sum(p.buy_qty + p.sell_qty for p in fs.points)
    assert actual == expected
```

- [ ] **Step 2-5: Run-fail, implement, run-pass, commit**

```python
from hoga.api.models import FillStrength, FillStrengthPoint

def build_fill_strength_slice(conn, *, code, date, data_dir, bucket_ms=60_000):
    path = str(data_dir / "parquet" / date / code / "trades.parquet")
    rows = conn.execute(
        f"""
        SELECT (ts_ms / {bucket_ms}) * {bucket_ms} AS bucket,
               SUM(CASE WHEN side = 1 THEN qty ELSE 0 END) AS buy_qty,
               SUM(CASE WHEN side = -1 THEN qty ELSE 0 END) AS sell_qty
        FROM read_parquet(?)
        WHERE side != 0
        GROUP BY 1 ORDER BY 1
        """,
        [path],
    ).fetchall()
    return FillStrength(
        bucket_ms=bucket_ms,
        points=[
            FillStrengthPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                buy_qty=int(r[1]), sell_qty=int(r[2]),
            )
            for r in rows
        ],
    )
```

```bash
git commit -m "feat(bundle): fill_strength slice (per-minute, side != 0)"
```

### Task 1.5f: Assemble `build_bundle()` + wire `/api/session` route

- [ ] **Step 1: Write failing tests (the integration tests from before)**

```python
def test_session_bundle_shape(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/session?code=003490&date=20260519")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "003490"
    assert body["session_open_ms"] > 1_700_000_000_000
    for slice_name in ("candles", "quote_ratio", "depth_intensity",
                        "volume_profile", "fill_strength"):
        assert slice_name in body


def test_session_bundle_unified_price_grid(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/session?code=003490&date=20260519"
                   "&price_min=25000&price_max=26000")
    di = r.json()["depth_intensity"]
    assert di["price_min"] == 25000
    assert di["price_max"] == 26000
```

- [ ] **Step 2: Run, fail (route 404)**

- [ ] **Step 3: Add `build_bundle` assembly to `hoga/api/bundle.py`**

Append to `hoga/api/bundle.py` (the slice builders from 1.5a-1.5e are already there):

```python
import json
from hoga.api.models import SessionBundle


def build_bundle(
    conn, *, code: str, date: str, data_dir: Path,
    price_min: int | None = None,
    price_max: int | None = None,
    depth_bucket_ms: int = 5000,
    vp_bins: int = 24,
) -> SessionBundle:
    code_dir = data_dir / "parquet" / date / code
    meta = json.loads((code_dir / "meta.json").read_text())
    session_open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
    session_close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])

    candles = build_candles_slice(conn, code=code, date=date, data_dir=data_dir)
    qr = build_quote_ratio_slice(conn, code=code, date=date,
                                  data_dir=data_dir, bucket_ms=1000)
    di = build_depth_intensity_slice(
        conn, code=code, date=date, data_dir=data_dir,
        price_min=price_min, price_max=price_max,
        depth_bucket_ms=depth_bucket_ms,
    )
    vp = build_volume_profile_slice(
        conn, code=code, date=date, data_dir=data_dir,
        price_min=price_min, price_max=price_max, vp_bins=vp_bins,
    )
    fs = build_fill_strength_slice(conn, code=code, date=date, data_dir=data_dir)

    return SessionBundle(
        code=code, date=date,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        candles=candles, quote_ratio=qr,
        depth_intensity=di, volume_profile=vp, fill_strength=fs,
    )
```

- [ ] **Step 4: Wire `/api/session` route in `hoga/api/routes.py`**

```python
from hoga.api.bundle import build_bundle

@router.get("/session", response_model=SessionBundle)
def session(
    code: str, date: str,
    price_min: int | None = Query(None),
    price_max: int | None = Query(None),
    depth_bucket_ms: int = Query(5000),
    vp_bins: int = Query(24),
) -> SessionBundle:
    try:
        engine.parquet_dir(date, code)
    except StockDateNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return build_bundle(
        engine.conn, code=code, date=date, data_dir=engine.data_dir,
        price_min=price_min, price_max=price_max,
        depth_bucket_ms=depth_bucket_ms, vp_bins=vp_bins,
    )
```

- [ ] **Step 5: Run + commit**

```bash
pytest tests/test_api_session.py -v
git add hoga/api/bundle.py hoga/api/routes.py tests/test_api_session.py
git commit -m "feat(api): GET /api/session bundle assembled from 5 slices"
```

### Task 1.6: SSE channel + watchdog

**Files:**
- Modify: `pyproject.toml` (add `sse-starlette`, `watchdog`)
- Create: `hoga/api/sse.py`
- Modify: `hoga/api/app.py`
- Create: `tests/test_api_sse.py`

- [ ] **Step 1: Add deps**

```bash
uv add sse-starlette watchdog
git add pyproject.toml uv.lock
git commit -m "chore(deps): sse-starlette + watchdog for /api/events"
```

- [ ] **Step 2: Write failing test**

Create `tests/test_api_sse.py`:

```python
"""SSE inventory_added event fires when a new Stock-Date directory appears."""
import asyncio
import json

import httpx
import pytest

from hoga.api.app import create_app


@pytest.mark.asyncio
async def test_sse_inventory_added(tmp_path):
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        async with client.stream("GET", "/api/events") as r:
            # Trigger an event after a small delay
            async def make_dir():
                await asyncio.sleep(0.1)
                (data_dir / "parquet" / "20260521" / "207940").mkdir(parents=True)

            asyncio.create_task(make_dir())
            saw_inventory_added = False
            async for raw in r.aiter_lines():
                if raw.startswith("event: inventory_added"):
                    saw_inventory_added = True
                    break
            assert saw_inventory_added
```

- [ ] **Step 3: Run to verify failure**

```bash
pytest tests/test_api_sse.py -v
# Expected: 404 — endpoint missing
```

- [ ] **Step 4: Implement SSE**

Create `hoga/api/sse.py`:

```python
"""Inventory push channel via SSE + watchdog directory observer."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer


class _Bus:
    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.queues.discard(q)

    def publish(self, evt: dict) -> None:
        for q in self.queues:
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                pass


class _InventoryHandler(FileSystemEventHandler):
    def __init__(self, bus: _Bus, parquet_root: Path, loop: asyncio.AbstractEventLoop) -> None:
        self.bus = bus
        self.root = parquet_root
        self.loop = loop

    def _maybe_emit(self, path: str, kind: str) -> None:
        p = Path(path)
        try:
            rel = p.relative_to(self.root)
        except ValueError:
            return
        parts = rel.parts
        if len(parts) != 2:
            return
        date, code = parts
        evt = {"type": kind, "code": code, "date": date}
        self.loop.call_soon_threadsafe(self.bus.publish, evt)

    def on_created(self, event):
        if event.is_directory:
            self._maybe_emit(event.src_path, "inventory_added")

    def on_deleted(self, event):
        if event.is_directory:
            self._maybe_emit(event.src_path, "inventory_removed")


def build_sse(parquet_root: Path) -> tuple[APIRouter, _Bus, Observer]:
    bus = _Bus()
    router = APIRouter()
    loop = asyncio.get_event_loop()

    handler = _InventoryHandler(bus, parquet_root, loop)
    observer = Observer()
    parquet_root.mkdir(parents=True, exist_ok=True)
    observer.schedule(handler, str(parquet_root), recursive=True)

    @router.get("/api/events")
    async def events():
        async def stream():
            q = bus.subscribe()
            try:
                while True:
                    try:
                        evt = await asyncio.wait_for(q.get(), timeout=30.0)
                        yield {"event": evt["type"], "data": json.dumps(evt)}
                    except asyncio.TimeoutError:
                        yield {"event": "heartbeat", "data": ""}
            finally:
                bus.unsubscribe(q)

        return EventSourceResponse(stream())

    return router, bus, observer
```

Modify `hoga/api/app.py` to wire it into the lifespan:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    sse_router, bus, observer = build_sse(data_dir / "parquet")
    app.include_router(sse_router)
    observer.start()
    try:
        yield
    finally:
        observer.stop()
        observer.join()
        engine.close()
```

- [ ] **Step 5: Run to verify pass**

```bash
pytest tests/test_api_sse.py -v
# Expected: PASS (may take ~1 s due to watchdog warmup)
```

- [ ] **Step 6: Commit**

```bash
git add hoga/api/sse.py hoga/api/app.py tests/test_api_sse.py
git commit -m "feat(api): /api/events SSE channel + watchdog inventory observer"
```

### Task 1.7: Integration smoke — full backend stack

**Files:**
- Modify: `tests/test_api.py`

- [ ] **Step 1: Add integration test asserting bundle, SSE, and extended stock-dates work in one app**

```python
def test_backend_smoke(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    inv = client.get("/api/stock-dates").json()
    assert inv
    code, date = inv[0]["code"], inv[0]["date"]
    bundle = client.get(f"/api/session?code={code}&date={date}").json()
    assert "candles" in bundle
    t = bundle["candles"][0]["ts_ms"]
    ob = client.get(f"/api/orderbook?code={code}&date={date}&t={t}").json()
    assert ob is not None
```

- [ ] **Step 2: Run**

```bash
pytest tests/test_api.py::test_backend_smoke -v
# Expected: PASS
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_api.py
git commit -m "test(api): backend smoke covering stock-dates + session + spot"
```

### Task 1.8: Backend done — checkpoint

- [ ] **Step 1: Tag the backend milestone**

```bash
git tag v2-backend-ready
echo "Backend foundations complete (ADR 0003 + session bundle + SSE + extended stock-dates)."
```

---

## Phase 2 — Frontend scaffold (5 tasks)

### Task 2.1: Create the Vite project

**Files:**
- Create: `frontend/` (full Vite + React + TS scaffold)

- [ ] **Step 1: Scaffold**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend1
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

- [ ] **Step 2: Verify dev server runs**

```bash
npm run dev
# Visit the printed URL. Expected: default Vite + React page renders.
# Stop the server (Ctrl+C).
```

- [ ] **Step 3: Commit the scaffold**

```bash
cd ..
git add frontend/
git commit -m "feat(frontend): scaffold Vite + React + TS project"
```

### Task 2.2: Install all runtime deps

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install**

```bash
cd frontend
npm install \
  lightweight-charts@^5 \
  @tanstack/react-query@^5 \
  zustand@^4 \
  react-day-picker@^9 \
  react-router@^7 \
  @dnd-kit/core @dnd-kit/sortable \
  nanoid
npm install -D \
  tailwindcss@^3 postcss autoprefixer \
  @types/node \
  vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom \
  @playwright/test
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): install runtime + dev dependencies"
```

### Task 2.3: Configure Tailwind + tokens

**Files:**
- Create: `frontend/tailwind.config.ts`, `frontend/postcss.config.js`
- Create: `frontend/src/styles/tokens.css`, `frontend/src/styles/global.css`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Init Tailwind**

```bash
cd frontend
npx tailwindcss init -p
```

- [ ] **Step 2: Write tokens.css**

Create `frontend/src/styles/tokens.css` with the full DESIGN.md token set (colors, fonts, geometry, label tokens). Copy verbatim from `DESIGN.md` § Color and § Spacing.

- [ ] **Step 3: Configure tailwind.config.ts to read tokens**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-card': 'var(--bg-card)',
        'bg-subtle': 'var(--bg-subtle)',
        // ... all tokens
        accent: 'var(--accent)',
        up: 'var(--up)',
        down: 'var(--down)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Wire global.css**

```css
@import './tokens.css';
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap');

@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { background: var(--bg); color: var(--fg); font-family: var(--font-ui); }
```

- [ ] **Step 5: Import in main.tsx**

```tsx
import './styles/global.css';
```

- [ ] **Step 6: Verify**

```bash
npm run dev
# Page should render with dark bg #0E0E14.
```

- [ ] **Step 7: Commit**

```bash
cd ..
git add frontend/
git commit -m "feat(frontend): Tailwind + design tokens (DESIGN.md)"
```

### Task 2.4: Runtime config loader

**Files:**
- Create: `frontend/public/config.json`, `frontend/src/config.ts`

- [ ] **Step 1: Write failing test**

Create `frontend/tests/unit/config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => { (globalThis as any).fetch = vi.fn(); });

  it('returns parsed config on 200', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ api_url: 'http://x:9000' }),
    });
    expect(await loadConfig()).toEqual({ api_url: 'http://x:9000' });
  });

  it('falls back to default on failure', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});
```

- [ ] **Step 2: Implement**

Create `frontend/src/config.ts`:

```ts
export type AppConfig = { api_url: string };
export const DEFAULT_CONFIG: AppConfig = { api_url: 'http://localhost:8000' };

export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('/config.json');
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch {
    return DEFAULT_CONFIG;
  }
}
```

Create `frontend/public/config.json`:

```json
{ "api_url": "http://localhost:8000" }
```

- [ ] **Step 3: Wire vitest**

Add to `frontend/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true },
  server: { port: 5173 },
});
```

- [ ] **Step 4: Run**

```bash
cd frontend && npx vitest run tests/unit/config.test.ts
# Expected: 2 passed
```

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend/
git commit -m "feat(frontend): runtime config loader (/config.json)"
```

### Task 2.5: API client + types

**Files:**
- Create: `frontend/src/api/client.ts`, `frontend/src/api/types.ts`

- [ ] **Step 1: Define types**

Create `frontend/src/api/types.ts`:

```ts
// Mirrors hoga/api/models.py — keep in sync by hand.

export type StockDate = {
  date: string; code: string; name: string;
  regular_session_open_ms: number; regular_session_close_ms: number;
  data_window_first_ms: number; data_window_last_ms: number;
  price_min: number; price_max: number; captured_at: number;
  total_volume: number; pages_collected: number; file_size_bytes: number;
  today_open: number; today_high: number; today_low: number; today_close: number;
};

export type Candle = { ts_ms: number; open: number; close: number; high: number; low: number; vol_a: number; vol_b: number };

export type QuoteRatioPoint = { t: number; bid_total: number; ask_total: number };
export type QuoteRatio = { bucket_ms: number; points: QuoteRatioPoint[] };

export type DepthIntensity = {
  bucket_ms: number; price_min: number; price_max: number; price_step: number;
  times: number[]; bid_grid: number[][]; ask_grid: number[][];
};

export type VolumeProfile = {
  bin_count: number; price_min: number; price_max: number; bin_width: number;
  bins: { price_low: number; qty: number }[];
};

export type FillStrengthPoint = { t: number; buy_qty: number; sell_qty: number };
export type FillStrength = { bucket_ms: number; points: FillStrengthPoint[] };

export type SessionBundle = {
  code: string; date: string;
  session_open_ms: number; session_close_ms: number;
  candles: Candle[];
  quote_ratio: QuoteRatio;
  depth_intensity: DepthIntensity;
  volume_profile: VolumeProfile;
  fill_strength: FillStrength;
};

export type OrderbookLevel = { side: 'ask' | 'bid'; rank: number; price: number; qty: number };
export type OrderbookSnapshot = { ts_ms: number; levels: OrderbookLevel[] };

export type BrokerEntry = { name: string; side: 'buy' | 'sell'; rank: number; qty: number };
export type Trade = { ts_ms: number; price: number; qty: number; side: -1 | 0 | 1 };

export type SSEEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | { type: 'heartbeat' };
```

- [ ] **Step 2: API client**

Create `frontend/src/api/client.ts`:

```ts
import { loadConfig, type AppConfig } from '../config';

let _config: AppConfig | null = null;

export async function apiUrl(path: string): Promise<string> {
  if (!_config) _config = await loadConfig();
  return `${_config.api_url}${path}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(await apiUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
```

- [ ] **Step 3: Commit (no test yet — exercised by integration tasks)**

```bash
cd .. && git add frontend/
git commit -m "feat(frontend): API client + shared types"
```

---

## Phase 3 — Nav, Router, SSE liveness (5 tasks)

### Task 3.1: Router skeleton + 4 pages

**Files:**
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`
- Create: `frontend/src/pages/ReplayViewer.tsx`, `Inventory.tsx`, `Capture.tsx`, `Settings.tsx`

- [ ] **Step 1: Wire react-router**

`frontend/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import ReplayViewer from './pages/ReplayViewer';
import Inventory from './pages/Inventory';
import Capture from './pages/Capture';
import Settings from './pages/Settings';
import './styles/global.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/replay" replace />} />
          <Route path="replay" element={<ReplayViewer />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="capture" element={<Capture />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
```

- [ ] **Step 2: App.tsx — minimal shell**

```tsx
import { Outlet } from 'react-router';

export default function App() {
  return (
    <div className="grid grid-cols-[210px_1fr] h-screen w-screen overflow-hidden">
      <nav className="bg-bg-nav border-r border-border" />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 3: 4 placeholder pages**

Each page returns a single `<div className="p-8 text-fg-dim">{name}</div>` for now.

- [ ] **Step 4: Verify routing**

```bash
npm run dev
# Visit /replay, /inventory, /capture, /settings. Each shows its name.
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): router skeleton + 4 page stubs"
```

### Task 3.2: LeftNav with brand + items + status dot placeholder

**Files:**
- Create: `frontend/src/nav/LeftNav.tsx`, `frontend/src/nav/NavItem.tsx`, `frontend/src/nav/StatusDot.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Component test**

Create `frontend/tests/component/LeftNav.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LeftNav from '../../src/nav/LeftNav';

it('renders 4 nav items', () => {
  render(<MemoryRouter><LeftNav /></MemoryRouter>);
  expect(screen.getByText('Replay Viewer')).toBeInTheDocument();
  expect(screen.getByText('Inventory')).toBeInTheDocument();
  expect(screen.getByText('Capture')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, fail**

```bash
npx vitest run tests/component/LeftNav.test.tsx
# Expected: FAIL — LeftNav not found
```

- [ ] **Step 3: Implement LeftNav**

`frontend/src/nav/LeftNav.tsx`:

```tsx
import NavItem from './NavItem';
import StatusDot from './StatusDot';

export default function LeftNav() {
  return (
    <nav className="flex flex-col h-full bg-bg-nav border-r border-border">
      <div className="p-4 border-b border-border flex items-center gap-2.5">
        <div className="w-6 h-6 rounded grid place-items-center text-bg font-bold text-xs"
             style={{ background: 'linear-gradient(135deg, var(--accent), #0D7A6F)' }}>H</div>
        <div>
          <div className="font-semibold text-sm">hoga-ops</div>
          <div className="text-[9.5px] text-fg-dim uppercase tracking-wider">orderbook replay</div>
        </div>
      </div>
      <Section label="Workspace">
        <NavItem to="/replay" label="Replay Viewer" />
        <NavItem to="/inventory" label="Inventory" />
        <NavItem to="/capture" label="Capture" />
      </Section>
      <div className="flex-1" />
      <Section label="System">
        <NavItem to="/settings" label="Settings" />
      </Section>
      <div className="p-3 border-t border-border flex justify-between font-mono text-[10.5px] text-fg-dimmer">
        <StatusDot />
        <span>v0.1.0</span>
      </div>
    </nav>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="pl-4 pt-3 pb-1 text-[9.5px] font-semibold uppercase tracking-wider text-fg-dimmer">{label}</div>
      <div className="px-2 py-1 flex flex-col gap-px">{children}</div>
    </div>
  );
}
```

`frontend/src/nav/NavItem.tsx`:

```tsx
import { NavLink } from 'react-router';

export default function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) =>
      `flex items-center gap-3 px-3.5 py-2.5 rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg ${
        isActive ? '!bg-accent/10 !text-fg font-medium' : ''
      }`
    }>{label}</NavLink>
  );
}
```

`frontend/src/nav/StatusDot.tsx` (placeholder — green; real SSE-driven in Task 3.5):

```tsx
export default function StatusDot() {
  return (
    <span>
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-up mr-1.5 align-middle" />
      API · :8000
    </span>
  );
}
```

- [ ] **Step 4: Wire into App.tsx**

```tsx
import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';

export default function App() {
  return (
    <div className="grid grid-cols-[210px_1fr] h-screen w-screen overflow-hidden">
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 5: Run, pass + visual check**

```bash
npx vitest run
npm run dev  # visit / and confirm nav looks right
```

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): LeftNav with brand, sections, status dot placeholder"
```

### Task 3.3: useEventStream — SSE singleton hook

**Files:**
- Create: `frontend/src/api/sse.ts`

- [ ] **Step 1: Implement**

```ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiUrl } from './client';
import type { SSEEvent } from './types';

let _source: EventSource | null = null;
let _lastHeartbeatMs = 0;
const _subscribers = new Set<(e: SSEEvent) => void>();

async function open() {
  if (_source) return;
  const url = await apiUrl('/api/events');
  _source = new EventSource(url);
  _source.addEventListener('inventory_added', (e: MessageEvent) => emit({ type: 'inventory_added', ...JSON.parse(e.data) }));
  _source.addEventListener('inventory_removed', (e: MessageEvent) => emit({ type: 'inventory_removed', ...JSON.parse(e.data) }));
  _source.addEventListener('heartbeat', () => { _lastHeartbeatMs = Date.now(); });
  _source.addEventListener('error', () => emit({ type: 'heartbeat' })); // signal disruption
}

function emit(e: SSEEvent) { _subscribers.forEach(fn => fn(e)); }

export function lastHeartbeat(): number { return _lastHeartbeatMs; }

export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    void open();
    const handler = (e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: ['stock-dates'] });
      }
    };
    _subscribers.add(handler);
    return () => { _subscribers.delete(handler); };
  }, [qc]);
}
```

- [ ] **Step 2: Wire into App.tsx**

```tsx
import { useEventStream } from './api/sse';
export default function App() {
  useEventStream();
  // ...
}
```

- [ ] **Step 3: Commit (no unit test — covered by E2E)**

```bash
git add frontend/
git commit -m "feat(frontend): useEventStream SSE singleton hook"
```

### Task 3.4: Stock-dates query hook

**Files:**
- Create: `frontend/src/api/stock-dates.ts`

- [ ] **Step 1: Implement**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { StockDate } from './types';

export function useStockDates() {
  return useQuery({
    queryKey: ['stock-dates'],
    queryFn: () => apiGet<StockDate[]>('/api/stock-dates'),
    staleTime: Infinity,  // invalidated by SSE
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): useStockDates query hook (SSE-invalidated)"
```

### Task 3.5: Real SSE-driven StatusDot

**Files:**
- Modify: `frontend/src/nav/StatusDot.tsx`

- [ ] **Step 1: Replace with three-state implementation**

```tsx
import { useEffect, useState } from 'react';
import { lastHeartbeat } from '../api/sse';

type Status = 'green' | 'yellow' | 'red';

export default function StatusDot() {
  const [status, setStatus] = useState<Status>('yellow');
  useEffect(() => {
    const tick = () => {
      const age = Date.now() - lastHeartbeat();
      if (lastHeartbeat() === 0) setStatus('yellow');
      else if (age > 60_000) setStatus('yellow');
      else setStatus('green');
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);
  const color = status === 'green' ? 'var(--up)' : status === 'yellow' ? 'var(--accent)' : 'var(--down)';
  const text = status === 'green' ? 'SSE 연결 활성' : status === 'yellow' ? '재연결 중...' : '백엔드 응답 없음';
  return (
    <span title={text}>
      <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
            style={{ background: color, boxShadow: status === 'green' ? `0 0 4px ${color}` : undefined }} />
      SSE · :8000
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): SSE-driven 3-state status dot"
```

---

## Phase 4 — Tab system + state store (6 tasks)

### Task 4.1: Tab state (Zustand) + tests

**Files:**
- Create: `frontend/src/state/tabs.ts`, `frontend/tests/unit/tabs.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTabsStore } from '../../src/state/tabs';

describe('tabs store', () => {
  beforeEach(() => useTabsStore.getState().reset());

  it('starts with one empty tab', () => {
    expect(useTabsStore.getState().tabs.length).toBe(1);
    expect(useTabsStore.getState().tabs[0].selection).toBeNull();
  });

  it('newTab adds and activates', () => {
    const id = useTabsStore.getState().newTab();
    expect(useTabsStore.getState().tabs.length).toBe(2);
    expect(useTabsStore.getState().activeTabId).toBe(id);
  });

  it('closeTab removes; last tab close X disabled by guard', () => {
    const id = useTabsStore.getState().newTab();
    useTabsStore.getState().closeTab(id);
    expect(useTabsStore.getState().tabs.length).toBe(1);
    // closing the last one should be a no-op
    useTabsStore.getState().closeTab(useTabsStore.getState().tabs[0].id);
    expect(useTabsStore.getState().tabs.length).toBe(1);
  });

  it('enforces 8-tab soft cap', () => {
    for (let i = 0; i < 7; i++) useTabsStore.getState().newTab();
    expect(useTabsStore.getState().tabs.length).toBe(8);
    // The 9th attempt should require confirmation; with confirm=true it evicts oldest.
    useTabsStore.getState().newTab({ confirmEvictOldest: true });
    expect(useTabsStore.getState().tabs.length).toBe(8);
  });
});
```

- [ ] **Step 2: Run, fail**

```bash
npx vitest run tests/unit/tabs.test.ts
```

- [ ] **Step 3: Implement store**

```ts
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { SessionBundle } from '../api/types';

export type TabSelection = { code: string; fromDate: string; toDate: string };
export type TabStatus = 'empty' | 'loading' | 'loaded' | 'error';

export type Tab = {
  id: string;
  selection: TabSelection | null;
  cursorMs: number | null;
  status: TabStatus;
  errorMessage?: string;
  bundles: Map<string, SessionBundle>;  // date → bundle
};

type Store = {
  tabs: Tab[];
  activeTabId: string;
  newTab: (opts?: { confirmEvictOldest?: boolean }) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setSelection: (id: string, sel: TabSelection) => void;
  setStatus: (id: string, status: TabStatus, errorMessage?: string) => void;
  setCursor: (id: string, ms: number | null) => void;
  putBundle: (id: string, date: string, bundle: SessionBundle) => void;
  reset: () => void;
};

const fresh = (): Tab => ({
  id: nanoid(8),
  selection: null, cursorMs: null,
  status: 'empty',
  bundles: new Map(),
});

const SOFT_CAP = 8;

export const useTabsStore = create<Store>((set, get) => ({
  tabs: [fresh()],
  activeTabId: '',
  newTab: (opts) => {
    let { tabs } = get();
    if (tabs.length >= SOFT_CAP) {
      if (!opts?.confirmEvictOldest) return get().activeTabId;
      tabs = tabs.slice(1);
    }
    const t = fresh();
    set({ tabs: [...tabs, t], activeTabId: t.id });
    return t.id;
  },
  closeTab: (id) => {
    const { tabs } = get();
    if (tabs.length <= 1) return;
    const next = tabs.filter(t => t.id !== id);
    set({ tabs: next, activeTabId: next[next.length - 1].id });
  },
  setActive: (id) => set({ activeTabId: id }),
  setSelection: (id, sel) => set(s => ({
    tabs: s.tabs.map(t => t.id === id ? { ...t, selection: sel } : t),
  })),
  setStatus: (id, status, errorMessage) => set(s => ({
    tabs: s.tabs.map(t => t.id === id ? { ...t, status, errorMessage } : t),
  })),
  setCursor: (id, ms) => set(s => ({
    tabs: s.tabs.map(t => t.id === id ? { ...t, cursorMs: ms } : t),
  })),
  putBundle: (id, date, bundle) => set(s => ({
    tabs: s.tabs.map(t => {
      if (t.id !== id) return t;
      const bundles = new Map(t.bundles);
      bundles.set(date, bundle);
      return { ...t, bundles, status: 'loaded' as const };
    }),
  })),
  reset: () => {
    const t = fresh();
    set({ tabs: [t], activeTabId: t.id });
  },
}));

// initialize activeTabId
useTabsStore.setState({ activeTabId: useTabsStore.getState().tabs[0].id });
```

- [ ] **Step 4: Run, pass**

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): tabs Zustand store with cap + last-tab guard"
```

### Task 4.2: TabStrip + Tab components with @dnd-kit

**Files:**
- Create: `frontend/src/replay/TabStrip.tsx`, `frontend/src/replay/Tab.tsx`

- [ ] **Step 1: Implement TabStrip**

```tsx
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTabsStore } from '../state/tabs';
import Tab from './Tab';

export default function TabStrip() {
  const { tabs, activeTabId, setActive, closeTab, newTab } = useTabsStore();

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = tabs.findIndex(t => t.id === active.id);
    const to = tabs.findIndex(t => t.id === over.id);
    if (from < 0 || to < 0) return;
    useTabsStore.setState({ tabs: arrayMove(tabs, from, to) });
  };

  return (
    <div className="flex items-end gap-px px-3.5 bg-bg-subtle border-b border-border h-10">
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map(t => (
            <SortableTab key={t.id} tab={t}
              isActive={t.id === activeTabId}
              isLast={tabs.length === 1}
              onActivate={() => setActive(t.id)}
              onClose={() => closeTab(t.id)} />
          ))}
        </SortableContext>
      </DndContext>
      <button onClick={() => newTab()}
        className="h-[30px] px-3 mb-px ml-1.5 border border-dashed border-border-strong rounded text-fg-dim hover:text-fg hover:border-accent text-xs font-medium">
        + 새 분석
      </button>
      <span className="flex-1" />
      <span className="font-mono text-[10.5px] text-fg-dimmer pb-2">
        {useTabsStore(s => s.tabs.length)} / 8 open
      </span>
    </div>
  );
}

function SortableTab(props: { tab: any; isActive: boolean; isLast: boolean; onActivate: () => void; onClose: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: props.tab.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}>
      <Tab {...props} />
    </div>
  );
}
```

- [ ] **Step 2: Implement Tab**

`frontend/src/replay/Tab.tsx`:

```tsx
import type { Tab as TabModel } from '../state/tabs';

export default function Tab({ tab, isActive, isLast, onActivate, onClose }: {
  tab: TabModel; isActive: boolean; isLast: boolean; onActivate: () => void; onClose: () => void;
}) {
  return (
    <div onClick={onActivate}
      className={`relative flex items-center gap-2 h-8 px-3.5 -mb-px rounded-t cursor-pointer
        border border-border ${isActive ? 'bg-bg-card z-10 border-b-transparent' : 'bg-bg-input text-fg-dim'}`}>
      {isActive && <span className="absolute top-0 inset-x-0 h-0.5 bg-accent rounded-t" />}
      <StatusDot status={tab.status} />
      <span className="font-mono text-[11.5px] text-accent">{tab.selection?.code ?? '—'}</span>
      <span className="text-[12.5px]">{tab.selection ? '...' : '새 탭'}</span>
      {!isLast && (
        <button className="w-4 h-4 opacity-0 hover:opacity-100" onClick={e => { e.stopPropagation(); onClose(); }}>
          ✕
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: TabModel['status'] }) {
  const cls = status === 'loaded' ? 'bg-up' : status === 'loading' ? 'bg-accent animate-pulse' : 'border border-fg-dimmer';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): TabStrip + Tab with dnd-kit reorder + last-tab guard"
```

### Task 4.3: StockCombobox

**Files:**
- Create: `frontend/src/replay/StockCombobox.tsx`

- [ ] **Step 1: Implement** (search by code prefix + name substring; sort by dates desc; ↑↓ keyboard)

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStockDates } from '../api/stock-dates';

export default function StockCombobox({ value, onChange }: {
  value: string | null;
  onChange: (code: string) => void;
}) {
  const { data: inventory = [] } = useStockDates();
  const stocks = useMemo(() => {
    const m = new Map<string, { code: string; name: string; dates: number }>();
    for (const r of inventory) {
      const e = m.get(r.code) ?? { code: r.code, name: r.name, dates: 0 };
      e.dates += 1; m.set(r.code, e);
    }
    return [...m.values()].sort((a, b) => b.dates - a.dates || a.code.localeCompare(b.code));
  }, [inventory]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return stocks;
    return stocks.filter(s => s.code.startsWith(f) || s.name.toLowerCase().includes(f))
                 .sort((a, b) => Number(b.code.startsWith(f)) - Number(a.code.startsWith(f)));
  }, [stocks, q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selected = stocks.find(s => s.code === value);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-input border border-border rounded text-sm min-w-[240px] hover:bg-bg-input-hover">
        <span className="font-mono text-accent">{selected?.code ?? '종목 선택'}</span>
        <span className="flex-1 text-left">{selected?.name ?? ''}</span>
        <span className="text-fg-dim">▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[320px] bg-bg-card border border-border-strong rounded shadow-xl z-50">
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setHi(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') setHi(h => Math.min(h + 1, matches.length - 1));
              if (e.key === 'ArrowUp') setHi(h => Math.max(h - 1, 0));
              if (e.key === 'Enter' && matches[hi]) { onChange(matches[hi].code); setOpen(false); }
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="종목 코드 또는 이름 검색..."
            className="w-full bg-bg-subtle border-b border-border p-2.5 text-sm font-mono outline-none" />
          <div className="max-h-72 overflow-y-auto py-1">
            {matches.map((s, i) => (
              <div key={s.code} onClick={() => { onChange(s.code); setOpen(false); }}
                className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer ${
                  i === hi ? 'bg-bg-input-hover' : ''}`}>
                <span className="font-mono text-xs text-accent w-14">{s.code}</span>
                <span className="flex-1 text-sm">{s.name}</span>
                <span className="font-mono text-[10.5px] text-fg-dim">{s.dates} dates</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): StockCombobox with name+code search, keyboard nav"
```

### Task 4.4: DateRangePicker

**Files:**
- Create: `frontend/src/replay/DateRangePicker.tsx`

- [ ] **Step 1: Implement** with `react-day-picker`, disabled days from inventory for selected code

```tsx
import { useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { useStockDates } from '../api/stock-dates';

export default function DateRangePicker({ code, from, to, onChange }: {
  code: string | null;
  from: string | null;
  to: string | null;
  onChange: (from: string, to: string) => void;
}) {
  const { data = [] } = useStockDates();
  const captured = useMemo(() => new Set(
    data.filter(r => r.code === code).map(r => r.date)
  ), [data, code]);

  const fmt = (d: Date) =>
    d.toISOString().slice(0, 10).replace(/-/g, '');

  const disabledMatcher = (d: Date) => !captured.has(fmt(d));

  // Render two popovers (from, to)
  const [openWhich, setOpenWhich] = useState<'from' | 'to' | null>(null);
  // ... two date buttons + a popover showing DayPicker with `disabled={disabledMatcher}`
  return (
    <div className="flex items-center gap-1.5">
      <DateButton label={from} onClick={() => setOpenWhich('from')} />
      <span className="text-fg-dim">→</span>
      <DateButton label={to} onClick={() => setOpenWhich('to')} />
      {openWhich && (
        <div className="absolute top-16 z-50">
          <DayPicker
            mode="single"
            disabled={disabledMatcher}
            onSelect={(d) => {
              if (!d) return;
              const s = fmt(d);
              onChange(openWhich === 'from' ? s : (from ?? s), openWhich === 'to' ? s : (to ?? s));
              setOpenWhich(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function DateButton({ label, onClick }: { label: string | null; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-input border border-border rounded font-mono text-xs">
      {label ? `${label.slice(0,4)}-${label.slice(4,6)}-${label.slice(6,8)}` : 'YYYY-MM-DD'}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): DateRangePicker with sparse-day disabling"
```

### Task 4.5: Stock-change clears dates effect

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx` (created in next task; placeholder here)

This logic lives in the Toolbar (Task 5.1). Task 4.5 just lays the groundwork — no commit yet.

### Task 4.6: ReplayViewer assembly

**Files:**
- Modify: `frontend/src/pages/ReplayViewer.tsx`

- [ ] **Step 1: Wire TabStrip in**

```tsx
import TabStrip from '../replay/TabStrip';

export default function ReplayViewer() {
  return (
    <div className="grid grid-rows-[40px_60px_52px_1fr] h-full min-h-0 min-w-0">
      <TabStrip />
      <div className="bg-bg-toolbar border-b border-border" />  {/* Toolbar slot */}
      <div className="bg-bg-subtle border-b border-border" />   {/* PriceStrip slot */}
      <div className="bg-bg" />                                  {/* Workarea slot */}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): ReplayViewer page assembles TabStrip + slots"
```

---

## Phase 5 — Toolbar, Onboarding, Price strip (5 tasks)

### Task 5.1: Toolbar with stock+date+Load

Wire `StockCombobox` + `DateRangePicker` + Load button. Disabled until `code + from + to` filled. Changing stock clears dates. Renames to "Reload" when status === 'loaded'.

Code structure:

```tsx
import { useTabsStore } from '../state/tabs';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';

export default function Toolbar() {
  const active = useTabsStore(s => s.tabs.find(t => t.id === s.activeTabId)!);
  const [draft, setDraft] = useState({ code: active.selection?.code ?? null, from: active.selection?.fromDate ?? null, to: active.selection?.toDate ?? null });

  // Stock change → clear dates
  const setCode = (code: string) => setDraft({ code, from: null, to: null });
  const setDates = (from: string, to: string) => setDraft(d => ({ ...d, from, to }));

  const ready = draft.code && draft.from && draft.to;
  const loaded = active.status === 'loaded';

  return (
    <div className="flex items-center gap-2.5 px-4 bg-bg-toolbar border-b border-border h-[60px]">
      <StockCombobox value={draft.code} onChange={setCode} />
      <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
      <span className="flex-1" />
      <button disabled={!ready}
        onClick={() => useTabsStore.getState().setSelection(active.id, { code: draft.code!, fromDate: draft.from!, toDate: draft.to! })}
        className="px-4.5 py-2 bg-accent text-accent-fg rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
        {loaded ? 'Reload' : '데이터 불러오기'}
      </button>
    </div>
  );
}
```

- [ ] Test (component-level), implement, commit.

### Task 5.2: OnboardingCard (state-driven)

**Files:**
- Create: `frontend/src/replay/OnboardingCard.tsx`

```tsx
import type { Tab } from '../state/tabs';

export default function OnboardingCard({ tab }: { tab: Tab }) {
  const step =
    !tab.selection?.code ? 1 :
    !tab.selection?.fromDate || !tab.selection?.toDate ? 2 :
    3;
  return (
    <div className="grid place-items-center h-full">
      <div className="max-w-md bg-bg-card border border-border rounded p-6 space-y-3">
        <h3 className="text-lg font-semibold">분석 시작</h3>
        <Step n={1} done={step > 1} active={step === 1} label="종목 선택" />
        <Step n={2} done={step > 2} active={step === 2} label="기간 선택" />
        <Step n={3} done={false} active={step === 3} label="데이터 불러오기" />
      </div>
    </div>
  );
}
function Step({ n, done, active, label }: { n: number; done: boolean; active: boolean; label: string }) {
  return (
    <div className={`flex gap-3 items-center ${done ? 'text-up' : active ? 'text-fg' : 'text-fg-dim'}`}>
      <span className="font-mono text-xs">{done ? '✓' : n + '.'}</span>
      <span className={active ? 'font-medium' : ''}>{label}</span>
    </div>
  );
}
```

- [ ] Commit.

### Task 5.3: PriceStrip (placeholder; viewport tracking in Phase 6)

```tsx
import { useTabsStore } from '../state/tabs';

export default function PriceStrip() {
  const active = useTabsStore(s => s.tabs.find(t => t.id === s.activeTabId)!);
  if (active.status !== 'loaded') return <div className="h-[52px] bg-bg-subtle border-b border-border" />;
  // Real implementation in Task 6.5 once ChartStage exposes viewport edges
  return (
    <div className="flex items-center gap-4 px-4 bg-bg-subtle border-b border-border h-[52px]">
      <span className="font-mono text-sm">{active.selection?.code}</span>
      <span className="text-lg font-semibold">{/* current price */}</span>
    </div>
  );
}
```

### Task 5.4: Replay state-to-layout glue

ReplayViewer renders `<OnboardingCard>` if `active.status !== 'loaded'`, else `<Workarea>` (next phase). One conditional render.

### Task 5.5: Phase 5 commit + manual visual check

```bash
npm run dev
# Verify: open the app → Replay Viewer shows onboarding card, step 1 highlighted.
# Pick a stock in the combobox → step 2 highlights.
# Pick dates → step 3 highlights, Load button activates.
git commit -am "feat(frontend): toolbar + onboarding + state-driven workarea"
```

---

## Phase 6 — Time axis, Chart bootstrap, Bundle fetch (5 tasks)

### Task 6.1: timeAxis.ts (virtual axis math) + tests

**Files:**
- Create: `frontend/src/util/time.ts`, `frontend/tests/unit/time.test.ts`

Cover `realToVirtual`, `virtualToReal`, day-boundary detection, segment lookup by binary search. Inputs: array of `Segment { date, sessionOpenMs, sessionCloseMs, virtualStart }`. Document edges (cursor exactly at sessionCloseMs vs next-day sessionOpenMs).

### Task 6.2: useSpot hook + LRU + tests

**Files:**
- Create: `frontend/src/util/lru.ts`, `frontend/src/api/useSpot.ts`, tests for both

LRU cap = 100 entries per consumer instance. `useSpot<T>(key: string, fetcher: () => Promise<T>, debounceMs = 30)`. Returns `{ data, isFetching }`. Cancels in-flight on rapid key change.

### Task 6.3: useSession bundle hook

```ts
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { SessionBundle } from './types';

export function useSession(code: string | null, date: string | null, priceRange?: { min: number; max: number }) {
  const enabled = !!code && !!date;
  const qs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';
  return useQuery({
    queryKey: ['session', code, date, priceRange?.min, priceRange?.max],
    queryFn: () => apiGet<SessionBundle>(`/api/session?code=${code}&date=${date}${qs}`),
    enabled,
    staleTime: Infinity,
  });
}
```

### Task 6.4: ChartStage scaffolding (lightweight-charts instance)

Create the 5-pane container with `grid-template-rows: 1.4fr 0.3fr 0.4fr 0.8fr 0.4fr`. Each pane mounts a lightweight-charts pane index. `<ChartStage>` owns the chart instance; child panes subscribe to `chart.timeScale()` via prop. Multi-day stitched via the time axis from Task 6.1.

### Task 6.5: PriceStrip viewport tracking

Wire `chart.timeScale().subscribeVisibleTimeRangeChange()`. Compute right-edge and left-edge close from bundle candles array. Update zustand `cursorMs` accordingly. Render `current price = right_close`, `delta = (right_close - left_close) / left_close * 100%`.

Phase 6 commit per task.

---

## Phase 7 — 5 chart panes (6 tasks, step-level)

Phase 7 is written at step-level because it is the highest-risk frontend phase (custom canvas overlays + cross-pane sync). Each pane task is a tight TDD cycle with concrete code.

**Shared pane pattern** all 5 panes follow: each is a React component that takes `(chart: IChartApi, paneIndex: number, bundle: SessionBundle, segments: Segment[])` props. It mounts on first render, sets up its lightweight-charts series or custom canvas, returns a cleanup. Re-renders only when `bundle` reference changes (memo with deep equality on bundle.date is sufficient — bundles are immutable from `useSession`).

### Task 7.1: CandlePane

**Files:**
- Create: `frontend/src/chart/CandlePane.tsx`
- Create: `frontend/tests/component/CandlePane.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CandlePane from '../../src/chart/CandlePane';

const mockChart = {
  addSeries: vi.fn().mockReturnValue({ setData: vi.fn(), applyOptions: vi.fn() }),
};

it('mounts CandlestickSeries on chart with bundle data', () => {
  const bundle: any = {
    candles: [
      { ts_ms: 1747526400000, open: 70000, close: 70100, high: 70200, low: 69900, vol_a: 100, vol_b: 0 },
    ],
  };
  render(<CandlePane chart={mockChart as any} bundle={bundle} segments={[]} />);
  expect(mockChart.addSeries).toHaveBeenCalled();
  const series = mockChart.addSeries.mock.results[0].value;
  expect(series.setData).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ open: 70000, close: 70100 }),
  ]));
});
```

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

```tsx
import { useEffect } from 'react';
import { CandlestickSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import type { Segment } from '../util/time';
import { realToVirtual } from '../util/time';

const UP = 'var(--up)';
const DOWN = 'var(--down)';
const MUTED = 'var(--fg-dim)';

type Props = { chart: IChartApi; bundle: SessionBundle; segments: Segment[] };

export default function CandlePane({ chart, bundle, segments }: Props) {
  useEffect(() => {
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
    });
    const data = bundle.candles.map(c => {
      // Detect auction window or after-hours via candle position relative to session_close_ms
      const inAuctionOrAfter = c.ts_ms >= bundle.session_open_ms + (6 * 3600 + 20 * 60) * 1000;
      const color = inAuctionOrAfter ? MUTED : (c.close >= c.open ? UP : DOWN);
      return {
        time: realToVirtual(c.ts_ms, segments) / 1000 as any,
        open: c.open, close: c.close, high: c.high, low: c.low,
        color, borderColor: color, wickColor: color,
      };
    });
    series.setData(data);
    return () => { chart.removeSeries(series); };
  }, [chart, bundle, segments]);
  return null;
}
```

- [ ] **Step 4: Run, pass + commit**

```bash
cd frontend && npx vitest run tests/component/CandlePane.test.tsx
cd .. && git add frontend/ && git commit -m "feat(chart): CandlePane with auction/after-hours muted color"
```

### Task 7.2: VolumePane

**Files:**
- Create: `frontend/src/chart/VolumePane.tsx`
- Create: `frontend/tests/component/VolumePane.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
it('colors volume bar by candle direction', () => {
  const bundle: any = {
    candles: [
      { ts_ms: 100, open: 70000, close: 70100, high: 70200, low: 69900, vol_a: 50, vol_b: 50 },
      { ts_ms: 200, open: 70100, close: 69900, high: 70150, low: 69900, vol_a: 80, vol_b: 20 },
    ],
  };
  render(<VolumePane chart={mockChart as any} bundle={bundle} segments={[]} />);
  const series = mockChart.addSeries.mock.results[0].value;
  const calls = series.setData.mock.calls[0][0];
  // First bar (up): green; second (down): rose
  expect(calls[0].color).toMatch(/up|22C55E/);
  expect(calls[1].color).toMatch(/down|F43F5E/);
});
```

- [ ] **Step 2-3: Run-fail, implement**

```tsx
import { useEffect } from 'react';
import { HistogramSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import type { Segment } from '../util/time';
import { realToVirtual } from '../util/time';

const UP = 'var(--up)';
const DOWN = 'var(--down)';

export default function VolumePane({ chart, bundle, segments }) {
  useEffect(() => {
    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'right',
    });
    const data = bundle.candles.map(c => ({
      time: realToVirtual(c.ts_ms, segments) / 1000 as any,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? UP : DOWN,
    }));
    series.setData(data);
    return () => { chart.removeSeries(series); };
  }, [chart, bundle, segments]);
  return null;
}
```

- [ ] **Step 4-5: Run, pass, commit**

```bash
git commit -m "feat(chart): VolumePane with candle-direction color"
```

### Task 7.3: RatioPane (Bid/Ask Imbalance)

**Files:**
- Create: `frontend/src/chart/RatioPane.tsx`
- Create: `frontend/src/util/imbalance.ts` (the quoteImbalance formula)
- Create: `frontend/tests/unit/imbalance.test.ts`
- Create: `frontend/tests/component/RatioPane.test.tsx`

- [ ] **Step 1: Write failing tests**

```ts
// imbalance.test.ts
import { quoteImbalance } from '../../src/util/imbalance';
it('returns 0 at balance', () => expect(quoteImbalance(100, 100)).toBe(0));
it('returns +0.2 when ask 1.2× bid (sell heavy)', () =>
  expect(quoteImbalance(100, 120)).toBeCloseTo(0.2, 5));
it('returns -0.2 when bid 1.2× ask (buy heavy)', () =>
  expect(quoteImbalance(120, 100)).toBeCloseTo(-0.2, 5));
it('returns 0 when either side is 0', () => expect(quoteImbalance(0, 100)).toBe(0));
```

- [ ] **Step 2-3: Run-fail, implement**

```ts
// util/imbalance.ts
export function quoteImbalance(bid: number, ask: number): number {
  if (bid <= 0 || ask <= 0) return 0;
  return ask >= bid ? (ask / bid - 1) : -(bid / ask - 1);
}
```

```tsx
// chart/RatioPane.tsx
import { useEffect } from 'react';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import { quoteImbalance } from '../util/imbalance';

export default function RatioPane({ chart, bundle, segments }) {
  useEffect(() => {
    const series = chart.addSeries(LineSeries, {
      color: 'var(--accent)',
      lineWidth: 1.4,
      priceFormat: {
        type: 'custom',
        formatter: (v: number) => {
          if (Math.abs(v) < 0.005) return '0';
          const r = (1 + Math.abs(v)).toFixed(1);
          return v >= 0 ? `${r}× S` : `${r}× B`;
        },
      },
    });
    const data = bundle.quote_ratio.points.map(p => ({
      time: realToVirtual(p.t, segments) / 1000 as any,
      value: quoteImbalance(p.bid_total, p.ask_total),
    }));
    series.setData(data);
    // Baseline at 0
    series.createPriceLine({
      price: 0, color: 'var(--accent)', lineStyle: 1, lineWidth: 1, title: '',
    });
    return () => { chart.removeSeries(series); };
  }, [chart, bundle, segments]);
  return null;
}
```

- [ ] **Step 4-5: Run, pass, commit**

```bash
git commit -m "feat(chart): RatioPane (0-centered imbalance) + quoteImbalance helper"
```

### Task 7.4: IntensityPane (custom canvas with ImageData)

This is the highest-risk pane. Mirrors the Phase 0 spike: lightweight-charts handles the price axis, a `<canvas>` is overlaid and painted from `(bid_grid, ask_grid)` with `subscribeVisibleTimeRangeChange`.

**Important — the Phase 0 spike (2026-05-20) confirmed that the naive `fillRect`-per-cell pattern runs at ~110 ms / paint (FAIL), but the equivalent `ImageData` + `putImageData` pattern measured at **12.4 ms in the same headless environment (PASS, under 16 ms target)**. The implementation below uses ImageData. **Do not switch to fillRect** without re-running the perf baseline.

**Files:**
- Create: `frontend/src/chart/IntensityPane.tsx`
- Create: `frontend/tests/component/IntensityPane.test.tsx`

- [ ] **Step 1: Write failing test (canvas not unit-tested deeply — just mount)**

```tsx
import { render } from '@testing-library/react';
import IntensityPane from '../../src/chart/IntensityPane';

it('renders a canvas with bid+ask data', () => {
  const bundle: any = {
    depth_intensity: {
      bucket_ms: 5000, price_min: 70000, price_max: 71000, price_step: 100,
      times: [1, 2], bid_grid: [[0.5, 0], [0, 0.3]], ask_grid: [[0, 0.4], [0.6, 0]],
    },
  };
  const { container } = render(
    <IntensityPane chart={mockChart as any} bundle={bundle} segments={[]} />,
  );
  expect(container.querySelector('canvas')).toBeInTheDocument();
});
```

- [ ] **Step 2-3: Run-fail, implement using ImageData**

```tsx
import { useEffect, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import type { Segment } from '../util/time';
import { realToVirtual } from '../util/time';

// RGB values for the two sides. ImageData writes raw RGBA bytes so we keep
// hex out of the hot path.
const UP_RGB = [0x22, 0xC5, 0x5E];   // #22C55E
const DOWN_RGB = [0xF4, 0x3F, 0x5E]; // #F43F5E

export default function IntensityPane({ chart, bundle, segments }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const di = bundle.depth_intensity;
    const bins = di.bid_grid[0]?.length ?? 0;

    function paint() {
      const ts = chart.timeScale();
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      const w = canvas.width;
      const h = canvas.height;
      const buf = ctx.createImageData(w, h);
      const data = buf.data;
      const cellH = h / bins;

      di.times.forEach((t, i) => {
        const xFloat = ts.timeToCoordinate(
          realToVirtual(t, segments) / 1000 as any,
        );
        if (xFloat === null) return;
        const xNextFloat = ts.timeToCoordinate(
          realToVirtual(di.times[i + 1] ?? t + di.bucket_ms, segments) / 1000 as any,
        ) ?? xFloat + 2;
        const xStart = Math.max(0, Math.floor(xFloat));
        const xEnd = Math.min(w, Math.floor(xNextFloat));
        if (xEnd <= xStart) return;

        for (let b = 0; b < bins; b++) {
          const bidV = di.bid_grid[i][b];
          const askV = di.ask_grid[i][b];
          if (bidV < 0.02 && askV < 0.02) continue;

          const isAsk = askV >= bidV;
          const intensity = isAsk ? askV : bidV;
          const rgb = isAsk ? DOWN_RGB : UP_RGB;
          const alpha = Math.min(255, Math.round(intensity * 255));

          const yStart = Math.max(0, Math.floor((bins - 1 - b) * cellH));
          const yEnd = Math.min(h, Math.floor((bins - b) * cellH));

          // Write raw RGBA bytes directly. Per the Phase 0 spike measurement,
          // this path runs ~10× faster than the equivalent fillRect loop.
          for (let y = yStart; y < yEnd; y++) {
            const rowStart = (y * w + xStart) * 4;
            for (let x = 0; x < xEnd - xStart; x++) {
              const idx = rowStart + x * 4;
              data[idx] = rgb[0];
              data[idx + 1] = rgb[1];
              data[idx + 2] = rgb[2];
              data[idx + 3] = alpha;
            }
          }
        }
      });

      ctx.putImageData(buf, 0, 0);
    }

    const unsub = chart.timeScale().subscribeVisibleTimeRangeChange(paint);
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    paint();
    return () => { unsub(); ro.disconnect(); };
  }, [chart, bundle, segments]);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
```

- [ ] **Step 4: Add a paint-timing assertion to the component test (regression guard against accidental fillRect revert)**

```tsx
it('paints a 1000-time × 200-bin grid under 30 ms', () => {
  const bundle: any = {
    depth_intensity: {
      bucket_ms: 5000, price_min: 70000, price_max: 71000, price_step: 100,
      times: Array.from({ length: 1000 }, (_, i) => i * 5000),
      bid_grid: Array.from({ length: 1000 }, () => Array.from({ length: 200 }, () => Math.random())),
      ask_grid: Array.from({ length: 1000 }, () => Array.from({ length: 200 }, () => Math.random())),
    },
  };
  // Real chart instance from a tiny fixture; check that mounting and first
  // paint finish under 30 ms (a 2× safety margin on the 16 ms target).
  const t0 = performance.now();
  render(<IntensityPane chart={realChart} bundle={bundle} segments={[]} />);
  expect(performance.now() - t0).toBeLessThan(30);
});
```

- [ ] **Step 5: Run, pass, commit**

```bash
git commit -m "feat(chart): IntensityPane with bid/ask canvas overlay"
```

### Task 7.5: VolumeProfileOverlay (custom canvas on candle pane)

**Files:**
- Create: `frontend/src/chart/VolumeProfileOverlay.tsx`
- Create: `frontend/tests/component/VolumeProfileOverlay.test.tsx`

Similar canvas pattern as IntensityPane but rendered ON the candle pane. Horizontal bars per price bin per day's segment.

- [ ] **Step 1: Write failing test (mount + bar count per day check)**

```tsx
it('renders one bar per bin per day segment', () => {
  const bundle: any = {
    volume_profile: {
      bin_count: 4, price_min: 70000, price_max: 70400, bin_width: 100,
      bins: [{ price_low: 70000, qty: 10 }, { price_low: 70100, qty: 50 },
              { price_low: 70200, qty: 30 }, { price_low: 70300, qty: 20 }],
    },
  };
  const { container } = render(
    <VolumeProfileOverlay chart={mockChart as any} bundle={bundle}
      segments={[{ date: '20260518', sessionOpenMs: 0, sessionCloseMs: 100, virtualStart: 0 }]}
      mode="per-day" />,
  );
  expect(container.querySelector('canvas')).toBeInTheDocument();
});
```

- [ ] **Step 2-3: Run-fail, implement** (same canvas pattern as IntensityPane; opacity 0.2 default, POC at 0.5, VAH horizontal line, toggle via prop)

- [ ] **Step 4-5: Run, pass, commit**

```bash
git commit -m "feat(chart): VolumeProfileOverlay with POC + VAH line"
```

### Task 7.6: FillStrengthPane

**Files:**
- Create: `frontend/src/chart/FillStrengthPane.tsx`
- Create: `frontend/tests/component/FillStrengthPane.test.tsx`

Two stacked HistogramSeries (buy up, sell down). 0-centered.

- [ ] **Step 1-5: TDD per pattern**

```tsx
import { useEffect } from 'react';
import { HistogramSeries, type IChartApi } from 'lightweight-charts';

export default function FillStrengthPane({ chart, bundle, segments }) {
  useEffect(() => {
    const buy = chart.addSeries(HistogramSeries, { color: 'var(--up)', base: 0 });
    const sell = chart.addSeries(HistogramSeries, { color: 'var(--down)', base: 0 });
    buy.setData(bundle.fill_strength.points.map(p => ({
      time: realToVirtual(p.t, segments) / 1000 as any, value: p.buy_qty,
    })));
    sell.setData(bundle.fill_strength.points.map(p => ({
      time: realToVirtual(p.t, segments) / 1000 as any, value: -p.sell_qty,  // negative
    })));
    return () => { chart.removeSeries(buy); chart.removeSeries(sell); };
  }, [chart, bundle, segments]);
  return null;
}
```

```bash
git commit -m "feat(chart): FillStrengthPane (buy up, sell down, 0-centered)"
```

---

## Phase 8 — Sidebar (5 tasks)

### Task 8.1: CursorSidebar layout (50/25/25)

`grid-template-rows: 2fr 1fr 1fr`. Internal scroll per card.

### Task 8.2: OrderbookTable (10+10)

20 rows + spread divider. Depth bars normalized across all 20 levels. Per spec §5.1.

### Task 8.3: BrokerNetTable

Up to 10 rows. Sort by signed net descending. 4-char names. No bars.

### Task 8.4: FillTape

▲ / ▼ icons. Newest at top. ◆ for auction crosses.

### Task 8.5: useCursor → useSpot wiring

Each card subscribes to `tab.cursorMs`. `useSpot` keyed by `(tabId, endpoint, t)`. `from=t-5000, to=t, limit=20` for trades.

Commit per card.

---

## Phase 9 — Inventory + Capture + Settings (3 tasks)

### Task 9.1: Inventory page (sortable table)

Columns: code, name, date, captured_at, total_volume, pages_collected, file_size_mb, OHLC. Click row → `newTab` with that selection, navigate to `/replay`.

### Task 9.2: Capture stub with inline guide

```tsx
export default function Capture() {
  return (
    <div className="p-8 max-w-2xl">
      <h2>Capture (v1+1 예정)</h2>
      <p>지금은 외부 콜렉터 CLI 사용:</p>
      <pre className="bg-bg-card p-3 rounded font-mono text-sm">$ hoga capture --code 005930 --date 20260520</pre>
      <p className="mt-3">캡처 완료 후 자동으로 좌측 nav의 Inventory에 반영됩니다.</p>
    </div>
  );
}
```

### Task 9.3: Settings stub

Two lines: API URL (from `/config.json`), version (`v0.1.0`). Note about `/api/config` deferred.

Commit per page.

---

## Phase 10 — URL state + E2E + ship (3 tasks)

### Task 10.1: URL serialization helpers

`parseUrl(search) → { tabs: TabSelection[], active: number }` and `emitUrl(...) → string`. Hook to ReplayViewer that syncs tabs ↔ URL on selection change.

### Task 10.2: Playwright E2E tests (4 specs)

**Files:**
- Create: `frontend/tests/e2e/replay-smoke.spec.ts`
- Create: `frontend/tests/e2e/multi-tab.spec.ts`
- Create: `frontend/tests/e2e/sse-refresh.spec.ts`
- Create: `frontend/tests/e2e/error-states.spec.ts`
- Create: `frontend/playwright.config.ts`

**Setup precondition:** the backend starts against `tests/fixtures/` (extended for at least 2 captured Stock-Dates). A script `frontend/tests/e2e/setup.sh` starts the backend at port 8000 and frontend at 5173 before the test run.

#### 10.2a — replay-smoke.spec.ts (the happy path)

```ts
import { test, expect } from '@playwright/test';

test('replay viewer happy path renders all 5 panes', async ({ page }) => {
  await page.goto('/replay');
  await expect(page.getByText('분석 시작')).toBeVisible();

  // Pick stock
  await page.getByRole('button', { name: /종목 선택|005930/ }).click();
  await page.getByText('삼성전자').click();

  // Pick a single date
  await page.locator('.date-field').first().click();
  await page.getByRole('button', { name: '20' }).click();  // pick 5/20
  await page.locator('.date-field').nth(1).click();
  await page.getByRole('button', { name: '20' }).click();

  // Click Load
  await page.getByRole('button', { name: /데이터 불러오기/ }).click();

  // Verify all 5 panes render
  for (const pane of ['candle', 'volume', 'ratio', 'intensity', 'fill-strength']) {
    await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible({ timeout: 5000 });
  }

  // Sidebar 3 cards
  await expect(page.locator('[data-card="orderbook"]')).toBeVisible();
  await expect(page.locator('[data-card="brokers"]')).toBeVisible();
  await expect(page.locator('[data-card="fills"]')).toBeVisible();
});
```

#### 10.2b — multi-tab.spec.ts (bundle isolation across tabs)

```ts
test('two tabs with different stocks isolate bundles', async ({ page }) => {
  await page.goto('/replay');
  // Open first tab with 005930
  await loadStockDate(page, '005930', '20260520');
  await expect(page.getByText('삼성전자')).toBeVisible();

  // Add a new tab
  await page.getByText('+ 새 분석').click();
  await loadStockDate(page, '000660', '20260520');
  await expect(page.getByText('SK하이닉스')).toBeVisible();

  // Switch back to tab 1
  await page.locator('.tab').first().click();
  await expect(page.locator('.tab.active .tab-code')).toHaveText('005930');

  // Asserting bundle isolation: read network requests and confirm
  // /api/session was called twice with different ?code= params
  const sessionRequests = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter(r => r.name.includes('/api/session'))
      .map(r => r.name)
  );
  expect(sessionRequests.filter(u => u.includes('code=005930')).length).toBeGreaterThan(0);
  expect(sessionRequests.filter(u => u.includes('code=000660')).length).toBeGreaterThan(0);
});
```

#### 10.2c — sse-refresh.spec.ts (inventory auto-update)

```ts
test('SSE inventory_added refreshes the combobox without reload', async ({ page, request }) => {
  await page.goto('/replay');
  await page.getByRole('button', { name: /종목 선택/ }).click();
  const before = await page.locator('.combo-option').count();

  // Trigger a new capture via the test backend admin endpoint
  // (or have the test runner mkdir the new Stock-Date in fixture data dir)
  await request.post('http://localhost:8000/api/test/add-stockdate?code=999999&date=20260520');

  // Within 2 seconds, the combobox refreshes (SSE invalidates the query)
  await expect(page.locator('.combo-option')).toHaveCount(before + 1, { timeout: 2000 });
});
```

Note: this test requires a `/api/test/add-stockdate` test helper or direct filesystem mutation. The fixture data dir is in tmp; tests can `await fs.mkdir(...)` directly.

#### 10.2d — error-states.spec.ts (404 silent vs 5xx red)

```ts
test('5xx renders red retry segment, 404 silently drops', async ({ page, route }) => {
  // Intercept /api/session: first date 200, second date 5xx
  await page.route('**/api/session*', (route, request) => {
    const url = new URL(request.url());
    if (url.searchParams.get('date') === '20260519') {
      return route.fulfill({ status: 503, body: 'overloaded' });
    }
    return route.continue();
  });

  await page.goto('/replay?tabs=005930:20260518:20260520&active=0');
  await page.getByRole('button', { name: /데이터 불러오기|Reload/ }).click();

  // Day 5/19 should render with red retry segment
  await expect(page.locator('[data-segment-status="error"]')).toBeVisible();
  await expect(page.getByText(/Retry/)).toBeVisible();

  // Days 5/18 and 5/20 still rendered
  await expect(page.locator('[data-segment-status="loaded"]')).toHaveCount(2);
});

test('404 silently drops from virtual axis', async ({ page }) => {
  // Mock /api/session to return 404 for date 20260524 (a Sunday, "market closed")
  await page.route('**/api/session*date=20260524*', route => route.fulfill({ status: 404 }));

  // Direct URL navigation with that date
  await page.goto('/replay?tabs=005930:20260520:20260524&active=0');
  // The 5/24 segment is silently absent — no red, no "Load failed" message
  await expect(page.getByText(/Load failed/)).not.toBeVisible();
  // Only the 5/20–5/23 segments visible (or however many real ones exist)
  await expect(page.locator('[data-segment-status="loaded"]')).toHaveCount(1);
});
```

- [ ] **Step 1-5 (TDD per spec):** write failing E2E, run backend + frontend, run Playwright, fix, commit per spec.

```bash
git add frontend/tests/e2e/ frontend/playwright.config.ts
git commit -m "test(e2e): 4 Playwright specs (smoke, multi-tab, SSE, errors)"
```

### Task 10.3: Final ship checklist

- All tests pass (backend pytest + frontend vitest + playwright)
- Mockup matches actual rendering (manual diff)
- `npm run build` produces a clean production build
- Documented startup: `uvicorn` for backend, `npm run dev` for frontend
- Commit + tag `v2-frontend-ready`

---

## Spike result

(filled in by Task 0.1 step 4)

---

---

## Spike result (Task 0.1)

**Run on 2026-05-20.** Verified in headless Chromium (no GPU acceleration) via `/browse`:

| Metric | Value | Target | Status |
|---|---|---|---|
| Architecture: `lightweight-charts` v5 + custom canvas overlay + `subscribeVisibleTimeRangeChange` | sync confirmed under zoom/pan | works | ✓ PASS |
| Naive `fillRect` per cell (200k cells / frame) | 80–133 ms | < 16 ms | ✗ FAIL |
| `createImageData` + per-pixel write + `putImageData` (200k cells / frame) | **12.4 ms** | < 16 ms | ✓ PASS |
| Console errors | 0 (only a benign favicon 404) | 0 | ✓ PASS |

**Decision: lightweight-charts stays.** Phase 7 implementation must use the ImageData approach in Task 7.4 (IntensityPane) and Task 7.5 (VolumeProfileOverlay). The plan code samples in those tasks reflect this. A paint-timing regression test (< 30 ms for a 1000×200 grid) sits inside the IntensityPane component test as a guard against accidental reverts to `fillRect`.

The KLineCharts fallback (spec §10) is unneeded for this project — recorded here so a future reader knows the spike was passed deliberately, not skipped.
