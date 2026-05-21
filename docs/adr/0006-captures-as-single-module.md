# 0006 — `hoga/api/captures.py` stays a single module

**Status:** accepted (2026-05-21)

## Decision

`hoga/api/captures.py` is kept as one module containing the full capture-feature surface: module-level singleton state (`_latest`, `_lock`, `_bus`, `_loop`), the `CaptureJobState` dataclass, the SSE bus injection (`set_bus`, `_publish_event`), the background lifecycle (`_apply_progress`, `_make_progress_callback`, `_run_capture_job`), error-code mapping (`_exception_to_error_code`), and the HTTP routes (`StartCaptureRequest`, `build_router`, the four endpoints). The module-import-time multi-worker assertion is also kept inline, not extracted.

This decision is recorded *because* the module is ≈410 lines and a future reviewer's natural reflex will be to split it into `captures_state.py` / `captures_lifecycle.py` / `captures_routes.py`, or to wrap everything in a `CaptureManager` class. That split has been considered and rejected; this ADR documents *why* so the same grilling doesn't recur every six months.

## Why

The module is large but its **interface is small** — production consumers (i.e. `hoga/api/app.py`) import three symbols: `build_router`, `set_bus`, `cancel_latest_on_shutdown`. Everything else is internal or test surface. Implementation size is not the same thing as interface depth, and depth is what costs callers; here, depth is fine.

The feature is **cohesive**. Capture state, capture lifecycle, capture routes, and capture error mapping all describe one concept — a single in-flight `CaptureJobState` and the operations that mutate, observe, and serve it. Splitting that into three files would force consumers to chase the same concept across three locations. ADR-0001 ("tables are modules, not layers") encodes the same instinct for the parser/query side; capture is the same shape of concern.

Splitting **loses locality without adding leverage**. A future contributor changing how `phase` transitions work would currently edit one file; after a split they would edit `captures_state.py` (the field), `captures_lifecycle.py` (the transitions), and `captures_routes.py` (the response shape) — three files for one logical change. The cross-module imports also grow: `captures_routes.py` would import from both `captures_state.py` and `captures_lifecycle.py`, the lifecycle would import the state, and so on. Three thin files, more import friction, same total volume.

The **class-wrapping alternative** (a `CaptureManager` class owning the state and exposing methods) is also rejected. The class would buy testability via "fresh instance per test," but the existing `reset_state_for_tests` + `autouse` fixture covers the same need at one line of cost. The class would let multiple instances coexist, but the singleton is intentional (one capture per server process per ADR — see the multi-worker assert) and a class shape suggests a multiplicity that doesn't exist. **Two-adapters rule from the architecture vocabulary**: introduce a seam only when something actually varies across it; here, nothing does. The class is a hypothetical seam.

The **module-level pattern is internally consistent** with the rest of `hoga/api/`. `hoga/api/sse.py` keeps its `_Bus` and observer at module level. `hoga/api/app.py` is itself a module-level factory. Switching captures alone to a class form would create asymmetry without precedent.

## Considered alternatives

- **Three-file split (`captures_state.py` / `captures_lifecycle.py` / `captures_routes.py`).** Rejected: spreads one cohesive concept across three files, increases cross-module imports, and disperses the single test surface (`tests/test_api_captures.py`) without locality gain.

- **`CaptureManager` class wrapping all of it.** Rejected: hypothetical seam (no second instance scenario exists in a single-user single-worker tool), breaks symmetry with the rest of `hoga/api/`, and the testability gain (no `reset_state_for_tests`) is small relative to the change cost.

- **Extract only the route handlers** into `captures_routes.py`, leaving the state + lifecycle in `captures.py`. Rejected as the worst of both: routes are tightly bound to the state via `_state_to_wire`-style helpers and to the lifecycle via `asyncio.create_task(_run_capture_job(...))`. Two files importing each other heavily — moves boundaries without removing them.

- **Extract only the multi-worker assertion** into a `_runtime_check.py`. Rejected as cosmetic. The assert is one block; moving it costs an import without removing complexity.

## Consequences worth flagging for future readers

- **If you came here intending to split this file, read this ADR first.** The split has been considered. The friction-vs-locality calculation came out against. If you have a new reason — a second `CaptureManager` instance is genuinely needed, the singleton has demonstrably caused harm, or the test surface has split anyway — reopen this ADR explicitly. Don't re-litigate from scratch.

- **Growth budget.** If the module passes ~700 lines AND a clean horizontal seam appears (e.g., a second capture source besides hogaplay, which would create a real two-adapters scenario at the `client_factory` boundary), revisit. The current shape is the right one for the current scope.

- **Test file follows the same rule.** `tests/test_api_captures.py` is also large (≈220 lines) and unified. Same logic applies: one test file for one feature.

- **Cross-reference.** Read with ADR-0001 (tables-as-modules) and ADR-0005 (capture state on the event loop). Together they describe the project's stance: cohesive features live in one place; cross-thread discipline lives at the call site, not in module structure.
