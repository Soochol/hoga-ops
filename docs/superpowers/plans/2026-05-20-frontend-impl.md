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

**Plan convention.** Phases 0-4 are written at fine-grained step level (write-test → run-fail → implement → run-pass → commit). Phases 5-10 are written at task level with the key code snippets shown — the executing agent expands each task into the same TDD micro-steps in its own session. This trade-off keeps the plan under ~1500 lines while still being executable. The executor (`/superpowers:subagent-driven-development`) should treat each Phase-5+ task as a small project: write a failing test for the component, then implement, then verify, then commit.

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

### Task 1.3: Extend Api* response models to Unix ms

**Files:**
- Modify: `hoga/tables/trades.py`, `hoga/tables/snapshots.py`, `hoga/tables/brokers.py`, `hoga/tables/candles.py`
- Modify: `hoga/api/models.py`
- Modify: `tests/test_api.py`

Each table module's `query_*` function converts `ts_ms` to Unix ms at the boundary. The `Api*` models keep field name `ts_ms` but the value is now Unix.

- [ ] **Step 1: Write failing tests**

Add to `tests/test_api.py`:

```python
def test_trades_ts_ms_is_unix(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/trades?code=003490&date=20260519&t=1747652000000&limit=5")
    rows = r.json()["trades"]
    assert all(t["ts_ms"] > 1_700_000_000_000 for t in rows)


def test_candle_ts_ms_is_unix(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/candles?code=003490&date=20260519")
    candles = r.json()["candles"]
    assert all(c["ts_ms"] > 1_700_000_000_000 for c in candles)
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_api.py -v -k "ts_ms_is_unix"
# Expected: FAIL (current ts_ms are 9-digit HHMMSSmmm or ms-from-midnight)
```

- [ ] **Step 3: Convert ts_ms at the query boundary**

In `hoga/tables/trades.py` `query_up_to`/`query_range`/etc., wrap each `ts_ms` with `hhmmssms_to_unix_ms(date, raw)`. Same for `snapshots`, `brokers`. For `candles`, use `ms_from_midnight_to_unix_ms`.

Example for trades:

```python
from hoga.api.timeenc import hhmmssms_to_unix_ms

def query_up_to(conn, *, path, t_ms, limit, date):
    # t_ms is now Unix ms in; convert back for the parquet query
    from hoga.api.timeenc import unix_ms_to_hhmmssms
    raw_t = unix_ms_to_hhmmssms(date, t_ms)
    rows = conn.execute(
        "SELECT ... FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
        [str(path), raw_t, limit],
    ).fetchall()
    return [ApiTrade(ts_ms=hhmmssms_to_unix_ms(date, r[0]), ...) for r in rows]
```

Update route handlers in `hoga/api/routes.py` to pass `date` to query helpers.

- [ ] **Step 4: Run to verify pass**

```bash
pytest tests/test_api.py -v
# Expected: all PASS
```

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/ hoga/api/routes.py tests/test_api.py
git commit -m "feat(api): all Api* models ship Unix epoch ms (ADR 0003)"
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

### Task 1.5: Session bundle endpoint — implementation

**Files:**
- Create: `hoga/api/bundle.py` (compute helpers)
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/queries.py`
- Create: `tests/test_api_session.py`

- [ ] **Step 1: Write failing test**

Create `tests/test_api_session.py`:

```python
def test_session_bundle_shape(tiny_data_dir):
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/session?code=003490&date=20260519")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "003490"
    assert body["session_open_ms"] > 1_700_000_000_000
    assert "candles" in body
    qr = body["quote_ratio"]
    assert qr["bucket_ms"] == 1000
    assert isinstance(qr["points"], list)
    di = body["depth_intensity"]
    assert len(di["times"]) == len(di["bid_grid"])
    assert len(di["bid_grid"]) == len(di["ask_grid"])
    vp = body["volume_profile"]
    assert vp["bin_count"] == 24
    fs = body["fill_strength"]
    assert fs["bucket_ms"] == 60000


def test_session_bundle_unified_price_grid(tiny_data_dir):
    """When price_min and price_max are supplied, depth_intensity must use them."""
    app = create_app(tiny_data_dir)
    client = TestClient(app)
    r = client.get("/api/session?code=003490&date=20260519&price_min=25000&price_max=26000")
    body = r.json()
    di = body["depth_intensity"]
    assert di["price_min"] == 25000
    assert di["price_max"] == 26000
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/test_api_session.py -v
# Expected: 404 — endpoint does not exist
```

- [ ] **Step 3: Implement bundle compute**

Create `hoga/api/bundle.py`:

```python
"""DuckDB-driven session bundle computation.

Five slices computed via concurrent queries:
- candles (raw read)
- quote_ratio (snapshots, last-per-bucket of bid_total / ask_total)
- depth_intensity (snapshots, max per price bin per time bucket, bid/ask split)
- volume_profile (trades, 24 equal-width bins by default)
- fill_strength (trades side != 0, per-minute aggregate)
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import duckdb

from hoga.api.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms
from hoga.api.models import (
    SessionBundle, QuoteRatio, QuoteRatioPoint,
    DepthIntensity, VolumeProfile, VolumeProfileBin,
    FillStrength, FillStrengthPoint, ApiCandle,
)


KRX_TICK_TIERS = [
    (2_000, 1),
    (5_000, 5),
    (20_000, 10),
    (50_000, 50),
    (200_000, 100),
    (500_000, 500),
    (float("inf"), 1_000),
]


def tick_size(price_max: int) -> int:
    for threshold, tick in KRX_TICK_TIERS:
        if price_max < threshold:
            return tick
    return 1_000


def build_bundle(
    conn: duckdb.DuckDBPyConnection,
    *,
    code: str,
    date: str,
    data_dir: Path,
    price_min: int | None = None,
    price_max: int | None = None,
    depth_bucket_ms: int = 5000,
    vp_bins: int = 24,
) -> SessionBundle:
    code_dir = data_dir / "parquet" / date / code
    candles_path = str(code_dir / "candles.parquet")
    snapshots_path = str(code_dir / "snapshots.parquet")
    trades_path = str(code_dir / "trades.parquet")

    meta = json.loads((code_dir / "meta.json").read_text())
    session_open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
    session_close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])

    # ----- candles -----
    candle_rows = conn.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [candles_path],
    ).fetchall()
    candles = [
        ApiCandle(
            ts_ms=ms_from_midnight_to_unix_ms(date, r[0]),
            open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6],
        )
        for r in candle_rows
    ]

    # ----- quote_ratio: last snapshot per 1-second bucket -----
    qr_rows = conn.execute(
        """
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 ts_ms / 1000 AS bucket,
                 ROW_NUMBER() OVER (PARTITION BY ts_ms / 1000 ORDER BY ts_ms DESC) AS rn
          FROM read_parquet(?)
        )
        SELECT bucket * 1000, bid_total, ask_total
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [snapshots_path],
    ).fetchall()
    qr = QuoteRatio(
        bucket_ms=1000,
        points=[
            QuoteRatioPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                bid_total=int(r[1]), ask_total=int(r[2]),
            )
            for r in qr_rows
        ],
    )

    # ----- depth_intensity: bid_grid + ask_grid -----
    # Determine price range and tick.
    if price_min is None or price_max is None:
        row = conn.execute(
            "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [candles_path],
        ).fetchone()
        price_min = int(row[0])
        price_max = int(row[1])
    tick = tick_size(price_max)
    bin_count = (price_max - price_min) // tick + 1
    # Unpivot 20 levels then bin. (Pseudo — actual SQL is long but mechanical.)
    di_rows = conn.execute(
        f"""
        WITH unpivoted AS (
          SELECT ts_ms, 'ask' AS side, ask_p1 AS price, ask_q1 AS qty FROM read_parquet(?)
          UNION ALL SELECT ts_ms, 'ask', ask_p2, ask_q2 FROM read_parquet(?)
          -- ... 18 more UNION ALLs for ask_p3..p10 and bid_p1..p10 ...
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
        [snapshots_path] * 20,
    ).fetchall()
    # Reshape into grids
    times_set = sorted({r[0] for r in di_rows})
    times = [hhmmssms_to_unix_ms(date, t) for t in times_set]
    bid_grid = [[0.0] * bin_count for _ in times_set]
    ask_grid = [[0.0] * bin_count for _ in times_set]
    t_idx = {t: i for i, t in enumerate(times_set)}
    for t, side, b, q in di_rows:
        target = ask_grid if side == "ask" else bid_grid
        target[t_idx[t]][b] = float(q)
    di = DepthIntensity(
        bucket_ms=depth_bucket_ms,
        price_min=price_min, price_max=price_max, price_step=tick,
        times=times, bid_grid=bid_grid, ask_grid=ask_grid,
    )

    # ----- volume_profile: 24 equal-width bins across (price_min, price_max) -----
    bin_width = (price_max - price_min) / vp_bins
    vp_rows = conn.execute(
        f"""
        SELECT FLOOR((price - {price_min}) / {bin_width}) AS bin_idx, SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_min} AND {price_max}
        GROUP BY 1 ORDER BY 1
        """,
        [trades_path],
    ).fetchall()
    vp_bins_arr = [VolumeProfileBin(price_low=int(price_min + i * bin_width), qty=0) for i in range(vp_bins)]
    for idx, qty in vp_rows:
        if 0 <= int(idx) < vp_bins:
            vp_bins_arr[int(idx)] = VolumeProfileBin(
                price_low=int(price_min + int(idx) * bin_width), qty=int(qty),
            )
    vp = VolumeProfile(
        bin_count=vp_bins, price_min=price_min, price_max=price_max,
        bin_width=int(bin_width), bins=vp_bins_arr,
    )

    # ----- fill_strength: per-minute buy / sell qty (side != 0 only) -----
    fs_rows = conn.execute(
        """
        SELECT (ts_ms / 60000) * 60000 AS bucket,
               SUM(CASE WHEN side = 1 THEN qty ELSE 0 END) AS buy_qty,
               SUM(CASE WHEN side = -1 THEN qty ELSE 0 END) AS sell_qty
        FROM read_parquet(?)
        WHERE side != 0
        GROUP BY 1 ORDER BY 1
        """,
        [trades_path],
    ).fetchall()
    fs = FillStrength(
        bucket_ms=60000,
        points=[
            FillStrengthPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                buy_qty=int(r[1]), sell_qty=int(r[2]),
            )
            for r in fs_rows
        ],
    )

    return SessionBundle(
        code=code, date=date,
        session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        candles=candles, quote_ratio=qr,
        depth_intensity=di, volume_profile=vp, fill_strength=fs,
    )
```

The `depth_intensity` UNION ALL is mechanical — write all 20 `ask_p1..p10` and `bid_p1..p10` columns. Cell count cap enforcement: after computing `bin_count`, if `len(times) * bin_count > 2_000_000`, widen `depth_bucket_ms` until it fits and recompute.

- [ ] **Step 4: Wire route**

In `hoga/api/routes.py`:

```python
from hoga.api.bundle import build_bundle

@router.get("/session", response_model=SessionBundle)
def session(
    code: str,
    date: str,
    price_min: int | None = Query(None),
    price_max: int | None = Query(None),
    depth_bucket_ms: int = Query(5000),
    vp_bins: int = Query(24),
) -> SessionBundle:
    return build_bundle(
        engine.conn, code=code, date=date, data_dir=engine.data_dir,
        price_min=price_min, price_max=price_max,
        depth_bucket_ms=depth_bucket_ms, vp_bins=vp_bins,
    )
```

- [ ] **Step 5: Run to verify pass**

```bash
pytest tests/test_api_session.py -v
# Expected: 2 PASS
```

- [ ] **Step 6: Commit**

```bash
git add hoga/api/bundle.py hoga/api/routes.py tests/test_api_session.py
git commit -m "feat(api): GET /api/session bundle endpoint"
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

## Phase 7 — 5 chart panes (6 tasks)

### Task 7.1: CandlePane

lightweight-charts `CandlestickSeries`. Up/down colored. Auction Window + After-Hours minutes rendered with a muted color (per spec §4.1 candle behavior).

### Task 7.2: VolumeProfileOverlay (canvas)

Per spec §4.1 horizontal-bar overlay. Per-day overlay rendered in each day's segment width. Bars at 20% opacity teal, POC at 50%, VAH line at 100%. Pane header toggle switches to combined mode (single overlay across all dates) — toggle state in tab store.

### Task 7.3: VolumePane

`HistogramSeries`. Color = candle-direction sync (green/rose) computed from candles array. Right y-axis K/M auto-format.

### Task 7.4: RatioPane

`LineSeries`. Y-axis: auto-fit, no clipping. Custom tick labels via `priceFormat.formatter` (e.g., `1.2× S`, `0`, `1.2× B`). Teal dashed baseline at 0.

### Task 7.5: IntensityPane (canvas — the Phase 0 spike pattern)

Two grids stacked (bid + ask, different hues). 5-second buckets default, tick-aligned price bins. Repaint on visible-range change.

### Task 7.6: FillStrengthPane

`HistogramSeries` × 2 stacked at center. Buy bars up (`--up`), sell bars down (`--down`), 0 baseline.

Commit per pane.

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

### Task 10.2: Playwright smoke

```ts
import { test, expect } from '@playwright/test';

test('replay viewer smoke', async ({ page }) => {
  await page.goto('http://localhost:5173/replay');
  await expect(page.getByText('분석 시작')).toBeVisible();
  await page.getByText('종목 선택').click();
  await page.getByText('삼성전자').click();
  // ... pick dates, click Load, verify 5 panes render
  await page.waitForSelector('[data-pane="candles"]');
  await page.waitForSelector('[data-pane="volume"]');
  // ...
});
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
