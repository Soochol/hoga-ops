Status
- Completed

Commit
- a0290eb2

Work completed
- Added `GET /api/live/index-sector-rankings` route in `hoga/live/api.py` with:
  - validation via `_parse_yyyymmdd` returning `invalid_date`
  - future-date guard against `_today_kst_yyyymmdd` returning `date_in_future`
  - response via `build_index_sector_rankings(...).model_dump()`
- Added `tests/api/test_index_sector_rankings_route.py` with the required three tests for invalid input, future-date rejection, and service payload passthrough.

Tests run
- `/home/dev/.local/bin/uv run --extra dev python -m pytest tests/api/test_index_sector_rankings_route.py -v`
  - PASSED
- `/home/dev/.local/bin/uv run --extra dev python -m pytest tests/api/test_index_sector_rankings_route.py tests/unit/live/test_index_sector_rankings.py -v`
  - PASSED

Notes/concerns
- To make the test-helper compatible with current router API, `_client` passes `get_status=lambda: None` to `build_router`.
- The route returns `model_dump()` explicitly so the unit route test can monkeypatch with a lightweight fake object.
