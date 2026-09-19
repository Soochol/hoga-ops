# Hover measurement evidence

Primary results use the user's **3 charts / tooltip OFF** condition.
Product commit: `8a16a20824542cdc354efbed1f0d715dc8b0b18b`.
See [chart report](../2026-09-19-live-hover-performance.md) and
[data-window follow-up](../2026-09-19-live-hover-data-windows.md) for interpretation and limitations.

## Files

- `production-three*.json`: raw Chrome metrics, input validation, frame samples.
- `production-three*-summary.json`: three-run medians/ranges, pooled frame intervals.
- `summarize.py`: reproducible aggregation (first partial rAF interval discarded).
- `*.ts.txt`: standalone diagnostic Playwright spec, configs and production QA entry.
  Deliberately outside ordinary test discovery and TypeScript project builds.
- `exploratory/`: initial **2-chart, tooltip enabled except tooltip-off scenario**, Vite dev
  measurements, setup image, and CPU profiles. Not the user's final condition.
  The early CPU profiles include profiler start/stop overhead; do not use their frame maxima
  as product frame-latency evidence. One development A/B interval also overlapped the separate
  production build. Production runs were serial and did not overlap builds.

## Re-run

Requirements: Node/npm, dependencies installed with `cd frontend && npm ci`, system Chrome,
Python 3, bash/flock. Existing user servers 5173/8000 are not used. Port 5197 must be available.
The harness intercepts all API requests and the WebSocket; vendor credentials/backend are unnecessary.

From the repository root:

```bash
# All six scenarios, D and 1m, 60 moves × 3 repeats, 3 charts, tooltip OFF.
docs/research/2026-09-19-hover-evidence/run.sh

# Reverse-order confirmation with faster input (no extra rAF after each move).
HOVER_FAST=1 HOVER_SCENARIOS=format-cache,baseline HOVER_OUTPUT=rerun-fast \
  docs/research/2026-09-19-hover-evidence/run.sh

# Four-times CPU slowdown, kept separate from native results.
HOVER_THROTTLE=4 HOVER_SCENARIOS=format-cache,baseline HOVER_OUTPUT=rerun-4x \
  docs/research/2026-09-19-hover-evidence/run.sh
```

Optional: `HOVER_TF=D` or `1m`, `HOVER_REPEATS=3`, `HOVER_STEPS=60`,
`HOVER_WINDOWS=3`, `HOVER_TOOLTIP=1`. `HOVER_PROFILE=1` collects baseline CPU profiles;
exclude profiler runs from frame timing comparisons.

The script refuses to overwrite existing temporary harness files, serializes runs with flock,
creates a diagnostic production build under `/tmp/hoga-hover-perf-dist`, runs the spec and
removes only the four files it created. Vite preview is stopped by Playwright.
Measurements assert successful hover/cursor/tooltip conditions and formatter string parity;
they do not falsely assert that the user's real-world stutter has been fixed.

## Experiments

- `baseline`: normal behavior; 3 synchronized charts, tooltip OFF by default.
- `cached-data`: stable fixture-only cache replacing registered series.data() reads.
  This is an experiment, not a production-safe cache (no data invalidation).
- `format-cache`: intercept only Number.toLocaleString('ko-KR') with no options,
  using one Intl.NumberFormat. Other locale/options fall through unchanged.
  Proposed production fix uses shared helpers, never prototype replacement.
- `labels-off`: high/low label feature off; includes geometry and primitive cost.
- `other-group`: first chart group 1, other charts group 2; removes useful remote work too.
- `same-bar`: fixed X, Y movement only, preserving ordinary chart event handling.

Instrumentation counts only MA/daily-MA/pane-registry data() calls and getBoundingClientRect.
These are not a complete memory allocation profile or count of all browser geometry reads.

## Program and investor daily windows

`panels-moving`, `panels-dwell`, `panels-attribution`, and `panels-history` JSON files
record the follow-up measurements, including formatter calls, sidebar publications,
actual scrollTop writes, table row counts, and intercepted API requests.
The history run is exploratory (one repetition). Other panel runs use native CPU speed.

```bash
HOVER_PANELS=1 HOVER_SCENARIOS=baseline,follow-off,linked-off,format-all-cache HOVER_OUTPUT=panels-moving \
  docs/research/2026-09-19-hover-evidence/run.sh

HOVER_PANELS=1 HOVER_DWELL=450 HOVER_SETTLE=450 HOVER_STEPS=12 HOVER_REPEATS=2 HOVER_SCENARIOS=baseline,follow-off HOVER_OUTPUT=panels-dwell \
  docs/research/2026-09-19-hover-evidence/run.sh

HOVER_PANELS=1 HOVER_TF=D HOVER_DWELL=450 HOVER_SETTLE=450 HOVER_STEPS=12 HOVER_REPEATS=2 HOVER_SCENARIOS=investor-follow-off,program-follow-off,format-all-cache HOVER_OUTPUT=panels-attribution \
  docs/research/2026-09-19-hover-evidence/run.sh

HOVER_PANELS=1 HOVER_TF=D HOVER_SPAN=140 HOVER_DWELL=450 HOVER_SETTLE=450 HOVER_STEPS=12 HOVER_REPEATS=1 HOVER_SCENARIOS=baseline HOVER_OUTPUT=panels-history \
  docs/research/2026-09-19-hover-evidence/run.sh
```

- `follow-off`: disable only both tables' automatic date following.
- `investor-follow-off` / `program-follow-off`: disable one table's following.
- `linked-off`: disable data-window cursor linking, preserving chart synchronization.
- `format-all-cache`: cache Intl.NumberFormat by locale and options; both follow toggles stay ON.

Fixtures cover January–September 2026; these archived runs used September 19, 2026.
Use the same calendar date or extend fixtures for later reproduction. Do not use
Playwright Clock in native frame benchmarks: even setFixedTime installs timer/rAF
instrumentation. Native runs leave Date, performance, timers, and rAF untouched.
Use a new `HOVER_OUTPUT` name to preserve committed evidence.


## Implementation follow-up

See [implementation report](../2026-09-19-live-hover-implementation.md).
`final-panels-moving`, `final-panels-dwell`, `final-charts`, and `final-panels-history`
are final-code measurements run serially after unit/E2E verification finished.
They use the same fixture calendar date and native browser clocks.
`implemented-panels-dwell` is an intermediate check after table/formatter changes;
it predates the sync-selector changes and overlapped targeted checks. Do not use it
as the final performance comparison.

Reproduction: use the panel commands above with `HOVER_SCENARIOS=baseline`,
`HOVER_REPEATS=3`, and a new output name. The history probe keeps one repetition.
Chart-only final measurements use `HOVER_SCENARIOS=baseline,same-bar`.
After the fix, `formatCalls` still counts only Number.toLocaleString calls; it no
longer measures all formatting, because the product now reuses Intl.NumberFormat.
The component regression tests verify unchanged cells are not reformatted.
