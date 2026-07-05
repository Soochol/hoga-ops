Status: DONE

Task: Lock Backend Wire Contract For Ranked Post-Untouched Arrays

Summary:
- Added ranked post-untouched array fields to the backend dual-row contract, API models, bundle conversion layer, and frontend TypeScript wire mirror.
- Preserved legacy single `untraded_*` / `untraded_max_*` fields by deriving them from rank 1 when ranked arrays are present, and by falling back to existing singleton row fields when arrays are empty.

Implemented:
- `hoga/tables/snapshots.py`
  - Added `untraded_peaks` and `untraded_max_peaks` tuple fields to both `AskPeakDualRow` and `BidPeakDualRow`, defaulting to `()`.
  - Updated dual-row docstrings to document `untraded_*` as legacy rank-1 wire fields and the new tuple fields as the ranked post-untouched contract.
- `hoga/api/models.py`
  - Added `untraded_peaks` and `untraded_max_peaks` to `AskPeak` and `BidPeak` with `Field(default_factory=list)`.
  - Updated model docs to distinguish:
    - `traded_*` arrays as the post-touch ranked wire with singleton compatibility fields.
    - `untraded_*` singletons as the legacy post-untouched rank-1 wire plus new ranked arrays.
- `hoga/api/bundle.py`
  - Updated `_ask_peak_from_dual_row` and `_bid_peak_from_dual_row` to map `row.untraded_peaks` / `row.untraded_max_peaks` through `_ask_candidate`.
  - When ranked arrays are present, singleton `untraded_*` and `untraded_max_*` are populated from the first candidate.
  - When ranked arrays are empty, singleton fields continue to use the legacy row values.
- `frontend/src/api/types.ts`
  - Added optional `untraded_peaks` and `untraded_max_peaks` to the existing `AskPeak` and `BidPeak` TS wire types.

Tests Added:
- `tests/test_api_ask_peak_model.py`
  - `test_ask_peak_accepts_ranked_untraded_candidates`
  - `test_bid_peak_accepts_ranked_untraded_candidates`
- `tests/hoga/api/test_bundle.py`
  - `test_ask_peak_from_dual_row_preserves_ranked_untraded_arrays`
  - `test_bid_peak_from_dual_row_preserves_ranked_untraded_arrays`

TDD Evidence:
- RED:
  - Initial plain `pytest` attempt failed because `pytest` was not installed in the bare shell environment.
  - Switched to the repo runner: `uv run --extra dev pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py -q`
  - Observed expected contract failures:
    - `AskPeak` missing `untraded_peaks`
    - `BidPeak` missing `untraded_peaks`
    - `AskPeakDualRow` missing `untraded_peaks`
    - `BidPeakDualRow` missing `untraded_peaks`
  - Result: `4 failed, 59 passed`
- GREEN:
  - Re-ran `uv run --extra dev pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py -q`
  - Result: `63 passed in 1.27s`

Tests Run:
- `uv run --extra dev pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py -q`
  - PASS: `63 passed in 1.27s`

Additional Verification:
- `git diff --check`
  - PASS
- `uv run --extra dev ruff check hoga/tables/snapshots.py hoga/api/models.py hoga/api/bundle.py tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py`
  - Not used as a gate: repository has a large pre-existing Ruff baseline in these files, including unrelated long-line and import-placement findings outside this task's scope.

Self-Review:
- The backend wire contract is now explicit at the dual-row, API-model, and TS mirror layers.
- Compatibility behavior is locked:
  - ranked arrays preserved end-to-end in bundle conversion
  - singleton legacy fields sourced from rank 1 when arrays exist
  - singleton legacy fields preserved when arrays are absent
- Changes were kept scoped to the contract layer only; no peak classification or rendering behavior was changed.

Commits:
- Pending at report write time; filled after commit in git history.

Concerns:
- None for Task 1 scope.
