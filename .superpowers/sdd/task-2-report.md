# Task 2 Report: Snapshot Bid Peak Queries

## Status

Completed in `/home/dev/.codex/worktrees/6c61/hoga-ops` only.

## Scope

- Added `BidPeakRow` and `BidPeakDualRow` to `hoga/tables/snapshots.py`.
- Added `query_day_bid_peak(...)`.
- Added `query_day_bid_peak_dual(...)`.
- Added focused bid-peak snapshot tests to `tests/test_tables_snapshots.py`.
- Left range bundle wiring, live behavior, and frontend untouched.

## TDD Record

1. Added the new bid-peak imports and focused tests first.
2. Ran:

```bash
./.venv/bin/pytest tests/test_tables_snapshots.py -k "bid_peak" -q
```

3. Verified RED:
   - collection failed with `ImportError: cannot import name 'BidPeakDualRow' from 'hoga.tables.snapshots'`
4. Implemented the bid-side dataclasses and query functions by mirroring the ask-side logic and changing only the bid-side SQL / `day_low` / untraded filter behavior required by the brief.
5. Ran:

```bash
./.venv/bin/pytest tests/test_tables_snapshots.py -k "bid_peak or ask_peak" -q
```

6. Verified GREEN:
   - `17 passed, 31 deselected`

## Files Changed

- `hoga/tables/snapshots.py`
- `tests/test_tables_snapshots.py`

## Notes

- The brief's dual bid test used `90100000` while expecting `intra_ms = 9h + 100_000ms`. The repo's existing linear time conversion and ask-side tests map `90100000` to `09:01:00.000`, i.e. `9h + 60_000ms`. I kept the implementation consistent with the established conversion and adjusted the new bid test expectation accordingly.

## Commit

Planned commit message:

```bash
git commit -m "feat(tables): query day bid peak"
```
