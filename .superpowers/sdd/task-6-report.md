Status: DONE

Commits created:
- Pending at report creation time; see final response for commit hash.

Summary:
- Wired live storage policy planning into lifecycle start/refresh/stop/status.
- Added REST 30s recorder lifecycle management and LiveStatus KIS API recorder fields.
- Preserved WS partitioning for non-empty WS targets while excluding WS targets from ws_plus_rest REST recorder targets.
- Ensured rest_only plans no WS targets and records all capture-enabled candidates through the REST API recorder.
- Added the requested lifecycle recorder tests and frontend live status fixture/type updates.
- Added a minimal frontend test script so the Task 6 frontend test command runs as written.

Verification:
- `uv run pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle.py tests/unit/live/test_lifecycle_dynamic_n.py -v` passed: 49 passed.
- `npm --prefix frontend test -- liveStatus.test.tsx --run` passed: 1 file, 3 tests.
- `npm --prefix frontend run build` passed.

Concerns:
- `npm ci` reported 1 high severity audit finding in existing frontend dependencies; not addressed in this task.
- Vite build reports an existing large chunk warning; not addressed in this task.
