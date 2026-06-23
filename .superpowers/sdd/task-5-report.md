Task 5 report

Implemented the heatmap input-change cache regression test in `tests/unit/live/test_index_sector_rankings.py`.

Test evidence:

```bash
/home/dev/.local/bin/uv run --extra dev python -m pytest tests/unit/live/test_index_sector_rankings.py::test_build_index_sector_rankings_uses_new_disk_cache_after_heatmap_changes -q
```

Result: `1 passed`
