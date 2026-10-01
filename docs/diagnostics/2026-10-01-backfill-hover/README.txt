2026-10-01 /live backfill + hover diagnostic, source commit beef04d6e.

For the original investigation results.json, product source files were not edited. Existing user servers/settings were untouched.
Production diagnostic build exposes existing chart/store QA handles.
Native results: results.json, summary.json. 16 runs, 2 repeats per condition.
Only first chart extends; additional charts receive synchronized cursor activity.
Fixtures seed accumulated 30/120-calendar-day history; subsequent real delta
requests add 10 calendar days after a controlled 600ms server delay. Seed
overserves intentionally to exclude cold bootstrap from the measured interval.
Each weekday supplies 390 synthetic 1m bars; product Regular Session clipping
produces 8,763/33,147 initial displayed bars. Holidays are approximated by weekdays.
90 real mouse moves with one requestAnimationFrame wait, tooltip OFF.
Native performance.now/Date/rAF, no CPU throttle, Chrome headless 1800x1000.
No real backend/vendor/WS traffic. This reproduces an update stall, not every
possible cause of the user's actual screen. Frame interval is not direct INP.

cache-ab.json: 3 pairs of optional canonical merged-cache structural-sharing
bypass (diagnostic only). Publication time drops from 8.5–30.1ms to 0–0.1ms;
large chart update tasks persist. Global improvement rate is not claimed.
profile.json/profile-summary.json/profile-run.json: separate CPU profiling run,
excluded from native timing results. Source-map attribution is sampling evidence,
not a precise per-function benchmark. Chart library dominates sampled JS work.

Reproduce from repository root with ./docs/diagnostics/2026-10-01-backfill-hover/run.sh
Requires installed frontend dependencies and system Chrome; port 5198 free.
Optional BF_FOCUS=1 BF_AB=1 BF_REPEATS=3 BF_OUTPUT=new-cache-ab for cache probe;
BF_FOCUS=1 BF_PROFILE=1 BF_REPEATS=1 BF_OUTPUT=new-profile for profiling.
Choose a fresh BF_OUTPUT name to preserve recorded evidence.

Implementation measurements (uncommitted source):
- window-v1/v2/v3.json: intermediate implementation probes.
- window-profile.json and window-profile-cpu-profile.json: separate profiling.
- after.json: same 16-condition matrix after bounded native rendering and
  shared candle geometry. Native setData is instrumented through the diagnostic
  nativeChart handle, NOT through the application-facing enqueue method.
- after-calendar.json: final 120-day condition, 3 repeats, after date/session cache.
- implementation-comparison.json: compact before/after frame and native-set timings.
- implementation-validation.md: functional tests and full-suite limitations.

The current harness measures the current working tree. baseCommit identifies
only the original investigation baseline, not the uncommitted implementation.
The final date/session optimization probe still has 62–72ms long tasks;
50ms max-frame target is not universally met. No claim of zero input delay.
Renderer windowing keeps all original full-history data and full indicator
calculations. Touch devices and unsupported series options retain full rendering;
sparse line neighbours and large zoom spans can enlarge the native window.

Merged #1917 and follow-up measurements:
- merged-repeat.json / merged-profile.json / merged-profile-cpu-profile.json: #1917 product, 5 timing repeats and a separate CPU sampling run.
- lookup-repeat.json: initial shared-grid implementation, 5 timing repeats.
- lookup-matrix.json: 36 extended conditions (single repeat each), before final numeric-only closure retention.
- final-default.json / final-tooltip.json / final-pan.json: final product file hashes, 5 OFF / 5 ON backfills and 3 cached mouse pans.
- follow-up-summary.json / follow-up-validation.md: compact results, limits and validation.

BF_MATRIX=1 BF_REPEATS=1 BF_OUTPUT=fresh-matrix enables 1/5/30m, 30/120/240-day seeds, 1/3 charts and normal/full-history zoom. API fixtures aggregate to the requested bucket. BF_INPUT=1 measures handler start to rAF callback with performance.now(), excluding pre-dispatch queue and paint; this is not INP. BF_TOOLTIP=1 enables candle tooltip. BF_FOCUS=1 BF_CACHED=1 measures actual mouse pan in a cached interior view and asserts zero requests and changed visible range.
