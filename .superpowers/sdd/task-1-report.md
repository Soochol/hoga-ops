## Task 1 Report: Add Disk Cache Path And Fingerprint Helpers

### Result
- Implemented `_ranking_disk_cache_path(data_dir, basis_date, heatmap_mtime_ns, corpus_mtime_ns)` in `hoga/live/index_sector_rankings.py`.
- Added the focused unit test in `tests/unit/live/test_index_sector_rankings.py`.

### TDD Evidence
#### RED
Command:
`/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_index_sector_ranking_disk_cache_path_uses_input_fingerprint -q`

Observed failure:
- `AttributeError: module 'hoga.live.index_sector_rankings' has no attribute '_ranking_disk_cache_path'`

#### GREEN
Same command after implementation:
- Passed: `1 passed in 0.01s`

### Notes
- The helper is deterministic and only constructs the cache path under `data_dir / "cache" / "index_sector_rankings"`.
- No disk read/write behavior was added.

### Follow-up Fix
- Removed the keyword-only restriction from `_ranking_disk_cache_path` so the fingerprint arguments match the task brief exactly.
- Updated the focused test to call `_ranking_disk_cache_path(tmp_path, "20260619", 111, 222)` positionally.

### Re-Verification
Command:
`/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_index_sector_ranking_disk_cache_path_uses_input_fingerprint -q`

Observed result:
- Passed: `1 passed in 0.04s`
