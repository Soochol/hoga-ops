Task 4: Ignore Corrupt Disk Cache And Recompute

Changes made:
- Added `test_build_index_sector_rankings_ignores_corrupt_disk_cache` to `tests/unit/live/test_index_sector_rankings.py`.
- No implementation change was required in `hoga/live/index_sector_rankings.py`; the existing cache reader already ignores malformed JSON and recomputes normally.

Test evidence:
- Ran: `/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_ignores_corrupt_disk_cache -q`
- Result: PASS
