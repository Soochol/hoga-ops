# Capture UI — In-App Data Collection

**Status:** Draft (awaiting user review)
**Date:** 2026-05-21
**Spec owner:** blessp@naver.com
**Related:**
- `CONTEXT.md` — domain language (**Stock-Date**, **Data Window**, **Regular Session**, **Page**, **Full Capture**).
- `DESIGN.md` — design system tokens. **Source of truth for any visual question this spec does not answer.**
- `docs/superpowers/specs/2026-05-20-frontend-design.md` — parent frontend spec. Capture is listed there as "v1+1 stub"; this spec promotes it to v1+1.
- `docs/adr/0003-api-time-encoding.md` — API timestamps are Unix epoch ms (UTC). Capture API timestamps follow this rule.
- `hoga/collector/orchestrator.py` — backend `collect_stock_date()`. Reused as-is plus a non-breaking `on_progress` callback parameter.
- `hoga/api/sse.py` — existing SSE bus. Reused for new `capture_*` event topics.
- `.superpowers/brainstorm/36081-1779322296/content/layout.html`, `global-indicator.html`, `done-error.html` — visual mockups produced during brainstorming (preserved under `.superpowers/`).

**Authority order if these disagree:** This spec (WHAT and WHY) → `DESIGN.md` (visual tokens) → mockups (pixel reference). If a mockup contradicts `DESIGN.md`, the mockup is stale.

---

## 1. Goal

Let the user kick off a hogaplay capture directly from the browser instead of running `hoga capture --code … --date …` in a terminal. The page must:

1. Accept a **Code** and **Stock-Date** (and a few options), then start a capture against the running local backend.
2. Show **live progress** while the capture runs — Pages captured, unique events accumulated, **Capture Frontier** position, estimated percentage.
3. Allow the user to **navigate to other pages while the capture runs** (Inventory, Replay Viewer) and still see a small global status indicator in the LeftNav.
4. Chain **parse** after capture by default so the artifact the user cares about (a row in Inventory with `parsed=Y`) is the natural endpoint.
5. Recover from common failures with **Resume** (the collector already preserves raw Pages and `_progress.json` on failure).
6. Persist nothing in the frontend — the backend is the single source of truth for capture state; the page reads state on mount via a single HTTP call.

## 2. Non-goals (v1+1)

- **Batch capture** (multiple Stock-Dates queued in one click). v1+1 captures one Stock-Date at a time. The form's Date field is single-value. Multi-date queue is captured in §10 for follow-up.
- **Scheduled / automated capture** (cron, "capture today at 16:05"). Out of scope.
- **Concurrent captures** (parallel hogaplay sessions). Backend enforces one active capture at a time per server process. A second `POST /api/captures` while one is running returns 409.
- **Capture from non-hogaplay sources**. The collector ships with one client; that client is what this UI exposes.
- **Editing collector internals from the UI** (rate limit, page step). These remain CLI / config flags.
- **Persistence of capture history** beyond what `data/raw/` and `data/parquet/` already encode on disk. The backend holds only the *current* job in memory; history is "go look at Inventory."

## 3. Stack

No new dependencies. All needed infrastructure is already present:

| Layer | Existing piece reused | Why it fits |
|---|---|---|
| HTTP framework | FastAPI (`hoga/api/app.py`) | Add one new router module. |
| Background execution | `asyncio.create_task` | Collector spends almost all time in network I/O via `httpx`. CPU-bound parsing happens at the end (parse phase) but for a single Stock-Date it is short enough to run in the same task without thread offloading in v1+1. |
| Progress channel | `_Bus` + `EventSourceResponse` in `hoga/api/sse.py` | Already powers `inventory_added` / `inventory_removed`. Add new event topics. |
| Frontend SSE plumbing | `useEventStream` in `frontend/src/api/sse.ts` | Module-level singleton `EventSource`. Add new `capture_*` listeners alongside existing inventory listeners. |
| Frontend state | `@tanstack/react-query` mutations + a tiny `useCaptureJob` hook | Mutation for `POST /api/captures`, query for `GET /api/captures/latest`, invalidate on SSE `capture_finished`. |
| Visual tokens | `DESIGN.md` | Single accent (teal), Geist Mono `tabular-nums` for all numbers, `--warn` (amber) for partial-capture warning. |

## 4. Backend API

**Wire Model location** — `CaptureJob`, `CaptureProgress`, `CaptureResult`, `CaptureError` are pydantic classes in `hoga/api/models.py` (the existing home for "API response container models" per its module docstring). Precedent: `StockDate` already lives there with no underlying Parquet table — capture state is the same shape of concern (metadata about something, not a table row). No new ADR needed; ADR-0004's "Wire Model = consumer shape, verbatim" rule applies to the response shape, not the directory.

**Timestamp encoding** — every `_ms` field in this section is **Unix epoch ms (UTC) per ADR-0003**: `started_at_ms`, `frontier_ms` (the Capture Frontier surfaced to clients), `elapsed_ms` (a duration, encoding-neutral). The collector's internal `_progress.json` keeps writing `last_time_ms` as HHMMSSmmm — that is its private encoding (mirrors hogaplay's wire format, matches the existing forensic-Parquet rule). Conversion happens in `hoga/api/captures.py` (see §4.3).

**`started_at_ms` definition** — set **immediately before the first `collect_stock_date` call**, after the `asyncio.Lock` has been acquired and the partial-capture guard has passed. Not the POST receipt time. Rationale: `elapsed_ms = now - started_at_ms` should represent **time the collector has been working**, not HTTP/lock overhead. Pseudocode:
```python
async def _run_capture_job(job, ...):
    job.started_at_ms = int(time.time() * 1000)   # ← here
    job.phase = "capturing"
    await loop.run_in_executor(None, collect_stock_date, ...)
```
Test seam: `time.time` is patched in `test_capture_started_at_at_collector_entry` to assert the stamp is set after lock + guard, before collector entry.

### 4.1 Routes (new module `hoga/api/captures.py`)

`POST /api/captures` — start a capture.

Request body:
```json
{
  "code": "005930",
  "date": "20260520",
  "allow_partial": false,
  "resume": false,
  "capture_only": false
}
```

Response (`201 Created`):
```json
{
  "job_id": "20260521T103014-005930-20260520",
  "code": "005930",
  "date": "20260520",
  "phase": "capturing",
  "options": {"allow_partial": false, "resume": false, "capture_only": false},
  "started_at_ms": 1779322214000
}
```

Error responses:
- `409 Conflict` if a capture is already running. Body includes the running job summary so the UI can render the progress panel without a follow-up call.
- `400 Bad Request` with `code = "partial_refused"` if `_is_partial_capture(date, now)` is true and `allow_partial=false`. (Backend re-validates even though the UI also previews this — never trust the client.)
- `400 Bad Request` with `code = "invalid_code"` / `"invalid_date"` for shape violations (regex `^\d{6}$` and `^\d{8}$` respectively).
- `422 Unprocessable Entity` from FastAPI on JSON shape mismatch.

`GET /api/captures/latest` — fetch the most recent job (running OR terminal), or `null` if no capture has been started since server boot. **Clients must inspect `phase` to decide whether the job is still in flight** — `latest` is "most recent" not "currently running". This is the API contract.

Response (`200 OK`):
```json
{
  "job_id": "20260521T103014-005930-20260520",
  "code": "005930",
  "date": "20260520",
  "phase": "capturing",
  "started_at_ms": 1779322214000,
  "progress": {
    "pages_done": 47,
    "events_seen": 12401,
    "frontier_ms": 1779349440000,
    "estimate_pct": 62,
    "elapsed_ms": 134000
  },
  "error": null,
  "result": null
}
```

When `phase = "done"`, `progress.pages_done` is the final count, `result` is populated, and the object stays in memory until either (a) a new capture starts (overwriting it) or (b) the user calls `DELETE /api/captures/latest` to dismiss.

When `phase = "failed"`, `error` is populated:
```json
{"code": "cookie_expired", "message": "hogaplay returned 401 for /first.php. Refresh your .cookie from a logged-in browser session.", "at_page": 34}
```

**Error code mapping** — the API code is derived from the Python exception class raised inside the collector. This is the contract the frontend branches on:

| Python exception (where it lives) | API `code` | HTTP status (when raised at `POST /captures`) | UI treatment in the error panel |
|---|---|---|---|
| `PartialCaptureRefused` (`orchestrator.py`) | `partial_refused` | 400 at POST time (never reaches background task) | Inline form banner; no error panel |
| `CookieExpiredError` (`client.py`, raised on **401 OR 403**) | `cookie_expired` | n/a (raised in background task → terminal `failed`) | Show `message` verbatim ("Refresh your .cookie from a logged-in browser session."); primary CTA "Retry with Resume" |
| `HogaplayHTTPError` (`client.py`, other 4xx or exhausted 5xx) | `hogaplay_http_error` | n/a (background) | Show `message` verbatim; primary CTA "Retry with Resume" |
| `CaptureCancelled` (new, `orchestrator.py`) | n/a — terminal phase is `cancelled`, not `failed` | n/a | (handled by `cancelled` UI, not error panel) |
| Any other `Exception` | `internal_error` | 500 if raised synchronously; otherwise terminal `failed` | Show `message` truncated; full stack in server log only |

The mapping lives in `hoga/api/captures.py::_exception_to_error_code` — one function, one source of truth, unit-tested.

`POST /api/captures/latest/cancel` — cancel a running job. Returns `202 Accepted` on success (the cancel signal is delivered; terminal transition happens asynchronously and is observable on the next `GET /latest` or via `capture_finished` SSE). Returns `409 Conflict` with `code = "not_running"` if `latest` is null or already terminal. Idempotent at the cancel-signal level (multiple POSTs while the job is winding down are no-ops). Mechanics: signals the asyncio task via the **CancelToken** (see §4.3); raw Pages already written are preserved on disk; the task transitions to `phase="cancelled"` and publishes `capture_finished`.

`DELETE /api/captures/latest` — dismiss a terminal job, clearing in-memory state so the page returns to its idle "form-only" view. Returns `204 No Content` on success. Returns `409 Conflict` with `code = "still_running"` if `latest.phase` is `capturing` or `parsing` (must cancel first). Idempotent: deleting when `latest` is already `null` returns `204`.

### 4.2 SSE event topics (extends `hoga/api/sse.py` bus)

All payloads include `job_id`, `code`, `date` so subscribers can filter without round-tripping.

| Event name | When emitted | Payload (in addition to job_id/code/date) |
|---|---|---|
| `capture_progress` | After every `_write_progress` call inside collector | `{phase, pages_done, events_seen, frontier_ms, estimate_pct, elapsed_ms}` |
| `capture_phase` | At each phase transition (`capturing` → `parsing` → `done`) | `{phase}` |
| `capture_finished` | Terminal: success, cancel, or error | `{phase: "done"|"failed"|"cancelled", result: CollectResult|null, error: ErrorObj|null}` |

**No event throttling in v1+1.** Every `capture_progress` from the collector is published to the SSE bus 1:1. Rationale: the collector emits ~5 progress events per second at default `rate_limit_s=0.2`, well below the bus queue capacity (64) and React Query's re-render budget. Pre-emptive throttling would be an unmeasured optimization that adds a buffering-and-flush mechanism (with its own bugs around terminal transitions). If a real capture session demonstrates queue overflow or render lag, add throttling deliberately in v1+2 — captured in §11.

### 4.3 Collector integration

`hoga/collector/orchestrator.py::collect_stock_date` gets one new optional parameter:

```python
def collect_stock_date(
    *,
    client, code, date, data_dir,
    rate_limit_s: float = 0.2,
    allow_partial: bool = False,
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,  # NEW
    cancel_token: CancelToken | None = None,                      # NEW
) -> CollectResult: ...
```

`ProgressEvent` is a frozen dataclass mirroring the SSE payload. The CLI (`hoga/cli.py::collect`) does not pass `on_progress` or `cancel_token`, so CLI behavior is unchanged.

Where `on_progress` is called:
- Inside `_page_step_loop`, immediately after the existing `_write_progress(progress_path, …)` call (one source of truth for "the progress just advanced").
- Once at the start of the parse phase (only when the API layer wraps capture + parse).

**Encoding seam** — the `ProgressEvent` the collector emits carries the **raw HHMMSSmmm** value (`controller.next_t`), keeping the collector encoding-neutral and matching its `_progress.json` writes. The HHMMSSmmm → Unix-ms conversion happens **inside `hoga/api/captures.py`**, reusing the existing `hoga.api.timeenc.to_unix_ms(date, value, encoding="hhmmssms")` helper (the same one ADR-0003 mandates for all API timestamps). The captures module converts before publishing to the SSE bus and before returning from `GET /api/captures/latest`. **Rationale**: keeps ADR-0003's "single source of truth" rule — the collector never knows about Unix-ms; the API layer never leaks HHMMSSmmm; the timeenc helper is the one place where the encoding boundary lives.

`CancelToken` is a thin wrapper around `asyncio.Event` (lives in `hoga/collector/orchestrator.py`):
```python
class CancelToken:
    def __init__(self) -> None: self._event = asyncio.Event()
    def cancel(self) -> None: self._event.set()
    @property
    def cancelled(self) -> bool: return self._event.is_set()
```
The API layer owns the token (one per job), wires it into `collect_stock_date`, and calls `.cancel()` on `POST /api/captures/latest/cancel`. `cancel_token` is checked at the top of every loop iteration in `_page_step_loop` and before the `chart.php` fetch. On cancellation:
- The collector raises `CaptureCancelled` (new exception in `hoga/collector/orchestrator.py`).
- The asyncio task in `hoga/api/captures.py` catches it, writes `_progress.json` with `cancelled: true, finished_at: <now>`, and emits a terminal `capture_finished` with `phase="cancelled"`.
- Raw `first_NNN.tsv` files written before cancel are preserved (the user can `resume` later).

### 4.4 Job state machine

```
            ┌──────────┐  POST /api/captures   ┌────────────┐
            │   none   ├──────────────────────►│ capturing  │
            └──────────┘                       └─────┬──────┘
                ▲                                    │ collector returns CollectResult
                │ DELETE /latest (dismiss)           ▼ (capture_only=false)
            ┌──────────┐   capture_finished      ┌────────────┐
            │   done   │◄────────────────────────┤  parsing   │
            └──────────┘                         └─────┬──────┘
                ▲                                      │ parse_stock_date returns
                │                                      ▼ (or capture_only=true)
                │                                ┌────────────┐
                └────────────────────────────────┤   done     │
                                                 └────────────┘

  Any phase can also transition to:
   * `failed`   on exception (preserves raw, emits capture_finished with error)
   * `cancelled` on POST /latest/cancel (preserves raw, emits capture_finished)

  Dismiss vs cancel:
   * DELETE /latest only legal when latest.phase ∈ {done, failed, cancelled}
   * POST /latest/cancel only legal when latest.phase ∈ {capturing, parsing}
```

Singleton enforcement: `hoga/api/captures.py` holds a module-level `_latest: CaptureJob | None`. `POST /api/captures` acquires an `asyncio.Lock`; if `_latest` is non-terminal, the lock returns 409. Terminal states (`done`/`failed`/`cancelled`) are overwritten on the next successful POST.

**Single-worker assumption (enforced at startup).** The `_latest` singleton and `asyncio.Lock` are per-process. Multi-worker uvicorn (`--workers N`) or gunicorn would silently break the semantics — each worker would carry its own singleton, two parallel captures could start, and SSE events from one worker would never reach subscribers on another. The product framing (single-user local tool, `hoga serve` CLI controls the launch) makes single-worker the natural deployment, but we refuse to boot when this assumption is violated rather than letting it fail silently:

```python
# hoga/api/captures.py (top of module)
if int(os.environ.get("WEB_CONCURRENCY", "1")) > 1:
    raise RuntimeError(
        "hoga-ops captures require a single uvicorn worker. "
        "Found WEB_CONCURRENCY > 1. Use `hoga serve` or pass --workers 1."
    )
```

This runs once at module import (before any request is served). If someone runs `uvicorn hoga.api.app:default_app --workers 4` directly, every worker fails to load and the server never accepts traffic — loud failure instead of silent corruption.

## 5. Frontend architecture

### 5.1 File layout

```
frontend/src/
  pages/Capture.tsx                    # layout: idle vs running vs terminal
  capture/
    CaptureForm.tsx                    # form + validation + partial preview
    CaptureProgress.tsx                # right panel: stats, bar, log, cancel
    CaptureLog.tsx                     # buffered log lines (last 10)
    CaptureResult.tsx                  # done/failed/cancelled summary
    useCaptureJob.ts                   # query + mutation + SSE subscription
  nav/
    CaptureStatusPill.tsx              # LeftNav global indicator (renders null when no job)
  api/
    captures.ts                        # POST/GET/DELETE + type CaptureJob
    sse.ts                             # EXTEND with capture_* listeners
    types.ts                           # EXTEND SSEEvent union with capture_* variants
```

### 5.2 Hook: `useCaptureJob()`

Single hook used by `Capture.tsx`, `CaptureStatusPill.tsx`, and anyone else who needs the job. Implementation sketch:

```ts
export function useCaptureJob() {
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['capture', 'latest'],
    queryFn: () => api.getCurrentCapture(),
    staleTime: 0,
  });

  // Subscribe to SSE on mount, invalidate on capture_finished, patch on capture_progress.
  useEffect(() => {
    const off = subscribeToCaptureEvents((e) => {
      if (e.type === 'capture_progress') {
        qc.setQueryData(['capture', 'latest'], (prev) =>
          prev && prev.job_id === e.job_id ? { ...prev, phase: e.phase, progress: e.progress } : prev,
        );
      } else if (e.type === 'capture_finished') {
        qc.invalidateQueries({ queryKey: ['capture', 'latest'] });
      }
    });
    return off;
  }, [qc]);

  const start = useMutation({
    mutationFn: api.startCapture,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capture', 'latest'] }),
  });
  const cancel = useMutation({ mutationFn: api.cancelLatest, onSuccess: () => qc.invalidateQueries({ queryKey: ['capture', 'latest'] }) });
  const dismiss = useMutation({ mutationFn: api.dismissLatest, onSuccess: () => qc.setQueryData(['capture', 'latest'], null) });

  return { job: job.data ?? null, isLoading: job.isLoading, start, cancel, dismiss };
}
```

**Why `invalidateQueries` (not `setQueryData`) on `start`:** an SSE `capture_progress` event can arrive between the POST response landing and `onSuccess` running — fast hogaplay responses make this a real race window (~10–30ms). Using `setQueryData(initial_job_state)` in `onSuccess` would overwrite progress already received. `invalidateQueries` instead triggers a fresh `GET /latest`; the GET response reads the same in-memory `_latest` the SSE bus is publishing from, so it cannot regress. The extra GET is cheap (local network, small payload) and the race is eliminated by construction.

`subscribeToCaptureEvents` is a new export from `frontend/src/api/sse.ts` that hooks into the existing module-level subscriber set — keeping the singleton `EventSource` rule from the current implementation. The TypeScript `SSEEvent` union in `types.ts` is extended; existing inventory handling is unchanged.

### 5.3 Page layout (idle / running / terminal)

Per brainstorming decision **D3 = A** (split view), `Capture.tsx` always renders the form on the left. The right panel changes by job state:

- `job == null` → right panel is collapsed: a single illustrated hint ("Fill in a Code and Date, then Start Capture") — kept narrow so the form expands to take more space.
- `job.phase == "capturing" | "parsing"` → right panel is `<CaptureProgress />`.
- `job.phase in {"done", "failed", "cancelled"}` → right panel is `<CaptureResult />` with CTAs:
  - `done` → primary "Open in Replay" (`navigate('/replay?code=…&date=…')`), secondary "View in Inventory", tertiary "Dismiss".
  - `failed` → primary "Retry with Resume" (pre-fills the form with same code/date + `resume=true`), tertiary "Dismiss". The error panel renders the server-side message verbatim — for `cookie_expired` this reads "Refresh your .cookie from a logged-in browser session.", which is self-explanatory because the cookie lives on disk (`.cookie` file or `HOGAPLAY_COOKIE` env), not in a UI-editable surface. No "Open Settings" CTA in v1+1 (see §11).
  - `cancelled` → primary "Resume from page N", tertiary "Dismiss".

The form itself stays interactive in every state (you can type a new code/date while a capture runs). Clicking **Start Capture** while a job is running shows an inline tooltip ("Cancel the current capture first") rather than enabling the button — the backend would also return 409, but blocking client-side is friendlier.

### 5.4 Form fields & validation

| Field | Type | Validation | Default |
|---|---|---|---|
| Code | text | regex `^\d{6}$` | empty; recent codes (last 10) shown as a datalist |
| Date | text | regex `^\d{8}$`; KST calendar valid | yesterday in KST |
| `allow_partial` | checkbox | always allowed | false |
| `resume` | checkbox | always allowed | false |
| `capture_only` | checkbox | always allowed | false |

**Partial-capture preview (client-side):** When the user picks today's date in KST and the current KST hour < 16, the form shows the amber inline banner and auto-expands Advanced + pre-checks `allow_partial`. The check is local-only — the backend still re-validates. Today is determined client-side from `Date.now()` adjusted to KST (UTC+9) — no network call.

**Banner copy (precise domain terms)** — the partial-capture banner does **not** say "Regular Session not closed", because per `CONTEXT.md` the **Regular Session** closes at **15:30**, not 16:00. The relevant boundary is the **Data Window** end (16:00 KST, when **After-Hours Trading** completes and hogaplay stops emitting new events for the **Stock-Date**). Banner headline: **"Today's date — Data Window not yet complete (closes 16:00 KST)"**. Body: "hogaplay collects through 16:00 (After-Hours Trading close), so captures before then are partial. Enable `allow partial` to capture what's available so far; re-run with `resume` after 16:00 to fill in the rest."

**Collector rename (same PR)** — `hoga/collector/orchestrator.py::_REGULAR_SESSION_CLOSE_HOUR = 16` is misnamed per `CONTEXT.md` — 16:00 is the **Data Window** / **After-Hours Trading** close, not the Regular Session close (15:30). Rename to `_DATA_WINDOW_CLOSE_HOUR` and update the in-file comment + the `PartialCaptureRefused` message in the same PR as this feature. The behavior (refuse capture before 16:00) is correct and unchanged; only the symbol and the user-facing string change. Captured here (not in §11) because it is a one-line rename inside the module this spec already touches, and shipping the UI with accurate domain language while leaving the backend symbol lying is a half-measure.

**Recent codes datalist:** Persisted to `localStorage['hoga.capture.recentCodes']` as a JSON array. Last 10, most-recent-first, dedup on insert. Purely a convenience; the backend doesn't see this.

### 5.5 Progress panel

Three large mono numbers (`Pages`, `Events`, `Frontier`), an estimated progress bar, and a live log of the last 10 page events.

- **Progress bar source:** the backend computes `estimate_pct` (integer 0–98; never returns 100 — that is reserved for the terminal `done` state) and ships it in the `progress` payload. The frontend renders it as a width and labels it `~{n}%` with the `~` always present, signaling it's an estimate. Backend formula lives in `hoga/api/captures.py`: `clip(round(100 * (frontier_hhmmss - DATA_WINDOW_START_MS) / (CHART_FINAL_TIME_MS - DATA_WINDOW_START_MS)), 0, 98)`, where the frontier value used here is the raw HHMMSSmmm (pre-Unix conversion) so the collector's constants stay encoding-consistent. Rationale: (1) keeps ADR-0003's "single source of truth" rule — frontend never sees collector internal encoding; (2) the collector constants `DATA_WINDOW_START_MS` / `CHART_FINAL_TIME_MS` stay private to backend modules; (3) `allow_partial` captures (today's date, market still open) can later adjust the denominator backend-side without a frontend change. The estimate is intentionally rough — Page Step is variable (collector halves it on misses), so a deterministic % is impossible.
- **Log buffer:** kept in a `useRef<LogLine[]>` of length 10, appended on each `capture_progress` event. Lost on page navigation (acceptable: the source of truth is the current progress numbers, not the log history).
- **Capture Frontier display:** the API exposes the Frontier as Unix-ms (per ADR-0003); the UI renders it as `HH:MM:SS` (KST) for human readability. Format helper lives next to existing time helpers in `frontend/src/util/`.
- **Cancel button:** secondary style; clicking opens a small confirm popover ("Cancel this capture? Captured pages will be preserved for Resume.") — the action is destructive enough to warrant one click of friction.

### 5.6 LeftNav global indicator (`CaptureStatusPill.tsx`)

Renders `null` when `job == null` or `job.phase in {"done", "failed", "cancelled"}` (terminal states only show on the Capture page itself).

While `job.phase in {"capturing", "parsing"}`:
- **Placement.** Insert `<CaptureStatusPill />` between the existing `flex-1` spacer (`LeftNav.tsx:20`) and the System `Section` (`LeftNav.tsx:21`). The spacer pushes the pill against the System block from above; when the pill renders `null` (no active job), the spacer absorbs the gap with no layout shift.
- **Content.** Pulsing teal dot · `CAPTURING` (or `PARSING`) label · code · "N pg · E ev · ~P%" — all values from `useCaptureJob()`'s `job.progress`.
- **Interaction.** The whole pill is a `<Link to="/capture">` — no custom click handler.
- **Visual states (per DESIGN.md).**
  - Background `--bg-card`, border `--border`, radius 5px, padding 8×10px, margin 10px on all sides for visual breathing room.
  - Hover background `--bg-input-hover` (matches the NavItem hover convention already in the codebase).
  - Active dot: 6×6px circle, `--accent`, 1.5s ease-in-out pulse opacity `1 → 0.4 → 1` (keyframe lives in `frontend/src/styles/global.css`).
  - Label text: 9.5px, 600 weight, uppercase, letter-spacing 0.08em, `--accent`.
  - Code: Geist Mono 11px `--fg` `tabular-nums`.
  - Stats line: Geist Mono 10px `--fg-dim` `tabular-nums`.
  - Optional 2px progress strip below stats line (`--bg-input` track, `--accent` fill at `estimate_pct` width).
- **Pill visible on `/capture` page too.** The right-panel `<CaptureProgress />` and the LeftNav pill carry different information density (panel = full detail, pill = at-a-glance summary). Same position regardless of route keeps the affordance learnable. No special-case hiding.

The pill subscribes to the same `useCaptureJob()` hook → automatic refresh from SSE. No additional plumbing.

## 6. Layout & Design System

All visual choices map to `DESIGN.md` tokens. No new tokens introduced.

- **Form card:** `bg-bg-card` background, `border-border`, 14px padding.
- **Inputs:** `bg-bg-input`, focus `border-accent`. Geist Mono `tabular-nums` (every input value is numeric).
- **Primary CTA:** `bg-accent text-bg`, hover darkens to `accent-shade` (already in design system).
- **Progress numbers:** Geist Mono, 22px, `font-weight: 500`, `tabular-nums`. Color `--fg`.
- **Phase pill:**
  - `capturing` / `parsing` → tint `rgba(20,184,166,0.12)`, text `--accent`
  - `done` → tint `rgba(34,197,94,0.10)`, text `--up`
  - `failed` → tint `rgba(244,63,94,0.10)`, text `--down`
  - `cancelled` → tint `rgba(148,163,184,0.12)`, text `--fg-dim`
- **Partial-capture warning banner:** `rgba(245,158,11,0.08)` background, `rgba(245,158,11,0.30)` border, text `--warn` for the headline and `--fg-dim` for the body. This is the first production usage of `--warn` in the codebase.
- **Pulse animation** on the LeftNav pill dot: 1.5s ease-in-out infinite, opacity 1 → 0.4 → 1. Single keyframe rule added to `frontend/src/styles/global.css`.
- **Density:** matches the rest of the app — 12px card padding for the form, 14px for the progress card (slightly looser because the numbers are 22px).

Color discipline (DESIGN.md rule "teal=UI, up/down=data") is preserved: teal is used for in-progress UI state, green for the completion *data* (Parsed=Y), red for the failure *data*.

## 7. URL state

The Capture page does **not** participate in URL state in v1+1. The form is local-only; the current job lives in backend memory. Two intentional consequences:

1. Reloading `/capture` mid-capture shows the same progress (because `GET /api/captures/latest` recovers the state). The form fields reset to defaults — the *job* is what matters across reloads, not the form input.
2. There is no shareable URL like `/capture?code=005930&date=20260520`. Capture is a workflow trigger, not a viewable artifact. The shareable artifact is `/replay?code=…&date=…` after capture completes.

## 8. Testing strategy

### 8.1 Backend (`pytest`)

- `tests/test_api_captures.py` (flat `tests/` + `test_{area}_{topic}` convention; see existing `test_api_sse.py`, `test_api_session.py`):
  - `test_start_capture_returns_job` — POST with a fake `HogaplayClientProto` injected; assert 201 + body shape.
  - `test_start_capture_409_if_running` — start one, immediately start another; assert 409 with the running job in body.
  - `test_start_capture_400_partial_refused` — date=today (mocked KST clock), `allow_partial=false`; assert 400 with `code="partial_refused"`.
  - `test_get_latest_null_when_idle` — fresh app, `GET /latest` returns `null`.
  - `test_get_latest_after_done` — start + wait for terminal; assert `phase="done"`, `result` populated.
  - `test_cancel_running` — start a capture with a fake client that sleeps in `fetch_first`, `POST /latest/cancel`, assert 202; poll `GET /latest` until terminal `phase="cancelled"`; assert raw files preserved.
  - `test_cancel_when_idle_409` — `POST /latest/cancel` with no job returns 409 `code="not_running"`.
  - `test_cancel_when_terminal_409` — start, wait for done, `POST /latest/cancel` returns 409 `code="not_running"`.
  - `test_dismiss_terminal_clears` — `DELETE /latest` on `done` job returns 204; `GET /latest` returns `null`.
  - `test_dismiss_when_running_409` — `POST /captures`, then immediately `DELETE /latest` returns 409 `code="still_running"`; job continues.
  - `test_dismiss_when_idle_204` — `DELETE /latest` with `latest=null` returns 204 (idempotent).

- `tests/test_collector_progress_callback.py`:
  - `test_on_progress_called_per_page` — inject a recording callback, run collector against a fixture, assert call sequence matches `_write_progress` calls.
  - `test_cancel_token_stops_loop` — assert `CaptureCancelled` raised, `_progress.json` has `cancelled: true`, raw pages preserved.
  - `test_no_callback_keeps_cli_behavior` — call with `on_progress=None, cancel_token=None` and assert byte-identical output to the pre-refactor version (snapshot of an existing fixture).

- `tests/test_api_sse_capture.py`:
  - `test_progress_events_delivered_1to1` — emit N progress events via the bus, subscribe via test client, assert all N are delivered in order (no throttling in v1+1).
  - `test_capture_finished_after_last_progress` — emit progress + terminal `capture_finished`; assert subscriber sees them in order.

### 8.2 Frontend (`vitest` + Testing Library)

- `frontend/src/capture/CaptureForm.test.tsx` — validation: 5-digit code shows error, 5-digit date shows error, valid input enables the CTA. Today's date triggers the partial warning + Advanced auto-expand.
- `frontend/src/capture/CaptureProgress.test.tsx` — progress events update the three big numbers; cancel button shows the confirm popover; log buffer caps at 10 lines.
- `frontend/src/capture/useCaptureJob.test.ts` — mock SSE; assert `setQueryData` patching on `capture_progress`, `invalidateQueries` on `capture_finished`.
- `frontend/src/nav/CaptureStatusPill.test.tsx` — null when no job, null in terminal states, renders pill in `capturing` / `parsing`, link points to `/capture`.

### 8.3 E2E (Playwright)

**Fake-client dependency injection (not a fake endpoint).** The production `POST /api/captures` is the only entry point — E2E hits the real route. The test harness substitutes `HogaplayClient` with `FakeHogaplayClient` via DI, so production code paths (router, lock, SSE bus, error mapping, state machine) all execute identically in E2E and prod. A "fake test endpoint" parallel to the real one would create a second code path that real users never exercise; rejected.

| Concern | Decision |
|---|---|
| Where does the fake client live? | `hoga/api/captures_fake.py` (new file). Implements `HogaplayClientProto` (the Protocol already in `orchestrator.py`). Keeps `hoga/api/test_routes.py` focused on its existing job (the inventory-seeder route). |
| How is it activated? | `hoga/api/app.py` checks `HOGA_ENABLE_TEST_ENDPOINTS=1` (the existing flag); when set, the captures router is built with `FakeHogaplayClient()` instead of `HogaplayClient(cookie=…)`. Same flag the existing `test_routes` uses — no new env var. |
| What does it emit? | A short scripted TSV stream — 5 Pages × ~20 events each, returning sequentially on each `fetch_first` call, plus a stub `chart.tsv` and a stub `info.tsv`. The events use real Code `005930` so downstream parse + inventory paths work end-to-end. |
| Timing | The fake's `fetch_first` sleeps **150ms** between Pages so the collector's progress emits 5 times spread over ~750ms. With no throttling (see §4.2), all 5 events reach the browser. The test asserts phase transitions; the count is incidentally checkable but not the primary assertion. |
| File system isolation | Reuse existing pattern — E2E harness already sets `HOGA_DATA_DIR=<tmp>` (see commit `a5552b8`). Fake-captured raw files go there; real `data/` is untouched. |
| Singleton lock | Unchanged. The fake client uses the same captures router, same `_latest` singleton, same 409 semantics. E2E that tries two simultaneous captures sees the real conflict behavior. |

`frontend/e2e/capture-flow.spec.ts`:
  1. Precondition: backend started with `HOGA_ENABLE_TEST_ENDPOINTS=1` and `HOGA_DATA_DIR=<tmp>` (already provided by `globalSetup`).
  2. Navigate to `/capture`, fill `005930` / `20260520`, click **Start Capture**.
  3. Assert phase pill transitions through `capturing` → `parsing` → `done` (poll via `data-testid="capture-phase"`).
  4. Click **Open in Replay** → assert URL is `/replay?code=005930&date=20260520`.
  5. Navigate back to `/capture`, click **Dismiss** → assert form-only state restored, `GET /api/captures/latest` returns `null`.

Extra E2E one-liner that's cheap to add and worth the coverage:
  6. After step 5, repeat steps 2–3 once more and at the `capturing` phase, navigate to `/inventory`. Assert the LeftNav pill (`data-testid="capture-pill"`) is visible there. Navigate back; the progress panel still reflects accumulated state.

### 8.4 Adversarial cases to verify by hand

- Server restart mid-capture → frontend `GET /api/captures/latest` returns null (in-memory state is lost on restart). UI shows form-only state. **Document this in the User-visible behavior section §9.**
- Two browser tabs open to `/capture` while a capture runs → both see the same progress via their own `useCaptureJob` hook (SSE multiplexes; same backend state).
- SSE disconnect (laptop sleep): on reconnect, `useEventStream`'s `error` handler emits `disconnected`; a follow-up `GET /api/captures/latest` would catch up — currently the existing code only invalidates inventory queries on disconnect; we need to also invalidate `['capture', 'latest']` (see §10).

## 9. User-visible behavior catalog

- **One capture at a time per server process.** Starting a second returns "Already capturing 005930 / 20260520 — cancel first" in a toast.
- **Single-worker server required.** `hoga serve` boots one uvicorn worker. Running uvicorn directly with `--workers N > 1` (or gunicorn with multiple workers) refuses to load — see §4.4. This is by design for a single-user local tool.
- **Server restart loses in-progress state.** If you restart the FastAPI server while a capture is running, the in-memory job is gone — but the raw files written so far are still on disk. The next visit to `/capture` shows form-only state. Use **Resume** to continue.
- **Reload survives.** Reloading the browser while a capture runs re-fetches `GET /latest` and resumes showing progress live.
- **Cross-page survival.** Navigate to `/inventory` or `/replay` while capturing; the global pill in LeftNav stays visible until the capture completes.
- **Inventory auto-update.** After parse completes, the existing `inventory_added` SSE event fires and the Inventory page list refreshes — this already works in production for CLI-driven captures, no change needed.
- **Cookie expiry.** If the hogaplay cookie is missing or expired, the capture starts but the first `fetch_first` raises `CookieExpiredError` (covers both 401 and 403 — same recovery action either way). The error panel shows `code = "cookie_expired"` and renders the server-side message verbatim ("Refresh your .cookie from a logged-in browser session."). The user updates `.cookie` (or `HOGAPLAY_COOKIE` env) on disk and clicks **Retry with Resume**. A UI-editable cookie surface is out of scope for v1+1 (see §11).

## 10. Open questions resolved

- **Q: Should capture and parse be one button or two?** A: One button by default; the `capture_only` checkbox under Advanced lets you skip parse for debugging.
- **Q: Should the form support multi-date queue?** A: No in v1+1. Captured for follow-up (§11). One reason: the partial-capture warning is per-date; batching multiplies that complexity.
- **Q: Where does the progress live during navigation?** A: Backend memory (singleton job state); the frontend hook re-reads it on mount and lives off SSE updates afterward. No frontend persistence.
- **Q: Pulse animation discipline.** A: Used only on the LeftNav pill dot. No other pulses in the app. The motion is small enough to add to `global.css` as one keyframe — no animation framework.
- **Q: SSE invalidates on disconnect — does this cover capture state?** A: Not yet. The existing handler only invalidates `STOCK_DATES_QUERY_KEY`. We will extend it to also invalidate `['capture', 'latest']`. Captured in the implementation plan as a small concrete TODO.

## 11. Out of scope, captured for follow-ups

- **Multi-date batch capture** ("capture 005930 for 20260518..20260520"). Would require a job queue + status per item. Future: a queue table at the bottom of the Capture page; the right panel shows the currently-running item.
- **Capture history view** ("show me the last 20 captures with their outcomes"). Currently `Inventory` shows only what's on disk; a richer history with timing + error details would need a small persisted log.
- **Scheduled / automated capture.** Cron-like trigger. Out of scope for a user-driven analyst tool.
- **Per-page rate limit override from the UI.** Currently CLI-only.
- **Concurrent captures.** Would require multiplexing the cookie / client pool. Real demand unclear for a single-user local tool.
- **Light mode.** Tracked separately at the design system level.
- **Cookie editing UI.** v1+1 keeps the cookie on disk (`.cookie` file or `HOGAPLAY_COOKIE` env). A future Settings rework will add `/api/config` and a cookie-editing field — at that point, the Capture error panel for `cookie_expired` should grow an "Update cookie →" CTA linking to Settings. Out of scope here because cookie management is a meaningful design surface on its own (manual paste vs browser cookie import vs encryption-at-rest).
- **SSE event throttling.** v1+1 emits every `capture_progress` 1:1. If a real capture surfaces queue overflow (`"SSE queue full, dropped event"` log warning) or React Query re-render lag, add a buffer-latest throttle to the bus — emit at most 1 per N ms, but always flush the latest pending event immediately before publishing the terminal `capture_finished`. The "flush on terminal" rule is the non-obvious part; record it in the implementation PR.

## 12. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Long-running asyncio task starves other requests | Low (collector is I/O-bound `httpx`) | Medium (API feels slow) | Verify with a throughput probe during E2E; if a problem, move collector to a `ThreadPoolExecutor` in v1+2. |
| SSE bus queue (size 64) overflows on a long, fast capture | Low (collector emits ~5/s; bus drains continuously) | Medium (silent log warning, progress numbers stutter) | Monitored in v1+1 (the existing bus already logs `"SSE queue full, dropped event"`). If observed in real captures, add a buffer-latest throttle in v1+2 — captured in §11. |
| Cancel races with last `_progress.json` write | Low | Low (file system race, last write wins) | Acceptable — `_progress.json` is read on resume, and either state is consistent enough to resume from. |
| `--warn` (amber) color first use; might clash in dark mode | Low | Low | Mockup verified against `DESIGN.md` palette; visually distinct from teal and red. |
| User starts a capture, closes browser, server restarts → no recovery UI | Medium | Low (one click to Resume) | Documented in §9. Resume flow is the recovery mechanism by design. |
| Operator runs uvicorn multi-worker, singleton breaks silently | Low (hoga serve uses 1 worker; needs deliberate override) | High (parallel captures, cookie 429, SSE blind spots) | Module-level assert in `hoga/api/captures.py` refuses to boot when `WEB_CONCURRENCY > 1` — fail fast, fail loud (see §4.4). |
