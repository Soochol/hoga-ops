Status: PARTIAL

Summary:
- Focused backend verification for the KIS REST bypass slice passed.
- Focused frontend verification for the KIS REST bypass slice passed.
- Broader backend live-suite verification passed.
- Broader frontend build passed, but full frontend test and lint sweeps failed due to pre-existing repo issues outside the Task 8 slice.
- Manual dev-server smoke was not performed in this subagent pass.
- No documentation changes were required; the current spec/ADR language checked for this slice still matches the observed field/reason names.

Verification:
- PASS `./.venv/bin/python -m pytest tests/unit/live/test_settings.py tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py tests/unit/live/test_api_kis_rest_bypass_candles.py tests/unit/live/test_api_kis_rest_bypass_quotes.py -q`
  - Result: `40 passed in 0.50s`
- PASS `npm test -- --run src/api/liveSettings.test.ts src/state/kisRestMode.test.ts src/live/KisRestUnavailableToastHost.test.tsx src/live/LiveSettingsSections.test.tsx src/api/liveQuotes.test.tsx src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx`
  - Run from: `frontend/`
  - Result: `7 files, 91 tests passed`
- PASS `npm run build`
  - Run from: `frontend/`
  - Note: this repo does not define a separate `typecheck` script in `frontend/package.json`; `build` is the closest supported typecheck/build command and completed successfully.
- PASS `./.venv/bin/python -m pytest tests/unit/live -q`
  - Result: `870 passed in 96.61s`
- FAIL `npm test -- --run`
  - Run from: `frontend/`
  - Failure summary: `src/studyViews/StudyPage.test.tsx` failed 5 tests (`325` files total, `3004` tests passed, `5` failed).
  - Primary error: `TestingLibraryElementError: Found multiple elements with the title: SK하이닉스 · 눌림 복기 · 5m`
  - Additional noise observed during run: repeated jsdom canvas warnings (`HTMLCanvasElement.getContext()` not implemented without the `canvas` package) and expected error-boundary test logging from `frontend/tests/component/ChartErrorBoundary.test.tsx`.
- FAIL `npm run lint`
  - Run from: `frontend/`
  - Failure summary: `424 problems (393 errors, 31 warnings)`.
  - Representative failures are broad and pre-existing, not localized to the bypass slice:
    - `frontend/src/api/liveQuotes.ts` React hooks/refs render-time ref access errors
    - `frontend/src/api/liveSeries.ts` React purity / set-state-in-effect / ref access errors
    - `frontend/src/watchlist/WatchlistDrawer.tsx` widespread `react-hooks/refs` errors
    - multiple unrelated test/style issues across calendar/captures/watchlist/component tests
- FAIL `./.venv/bin/python -m ruff check hoga tests/unit/live`
  - Failure summary: `998 errors` across broad pre-existing backend and test files.
  - Representative failures are repo-wide and not specific to this task:
    - import ordering / unused imports in `hoga/api/app.py`
    - line-length / complexity / magic-value findings in `hoga/api/bundle.py`
    - multiple style/import issues in `tests/unit/live/test_rest_poller.py`, `test_stream.py`, `test_ws_client.py`, and others

Manual Smoke:
- Not performed in this subagent context.
- Remaining manual QA for coordinator/local operator:
  - start the normal dev servers
  - open `/live`
  - toggle `KIS API 우회`
  - confirm `/api/live/settings` and `/api/live/status` both expose `"kis_rest_bypass_enabled": true`
  - pan minute charts and confirm no new KIS REST calls are triggered while bypass is ON
  - verify stored-data UI state/toast behavior and bypass-OFF refetch behavior

Documentation:
- No docs changed.
- I checked the active spec/ADR language for `kis_rest_bypass_enabled` and `kis_rest_bypassed`; verification did not reveal a mismatch requiring alignment.

Concerns:
- Task 8 verification is not fully green at the repo level because the full frontend test sweep, frontend lint sweep, and broad Ruff sweep already fail outside this bypass slice.
- The bypass-specific confidence is still strong because the targeted backend/frontend suites passed and the entire backend `tests/unit/live` suite passed.
