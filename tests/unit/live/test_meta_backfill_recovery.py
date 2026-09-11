"""Repair sweeps preserve exceptions and isolate malformed input files."""
import json
from datetime import datetime
from pathlib import Path

import pytest

from hoga.live import meta_backfill
from hoga.util.timeenc import KST


@pytest.fixture(autouse=True)
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 16, tzinfo=tz or KST)
    monkeypatch.setattr(meta_backfill, 'datetime', Clock)


def write_meta(base: Path, code: str, value: object, source: str = 'kiwoom_live/KRX') -> Path:
    path = base / 'parquet' / '20260914' / code / source / 'meta.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(value))
    return path


@pytest.mark.parametrize('sweep', [
    'backfill_live_meta', 'backfill_hogaplay_meta',
    'backfill_indicator_session_bounds', 'backfill_venue_gap_ranges',
])
@pytest.mark.parametrize('bad', [[], None, {'regular_session_open_ms': None},
                                {'regular_session_open_ms': True},
                                {'regular_session_open_ms': 159900000}])
def test_bad_file_does_not_abort_later_files(tmp_path: Path, sweep: str, bad: object, caplog) -> None:
    source = 'hogaplay' if sweep == 'backfill_hogaplay_meta' else 'kiwoom_live/KRX'
    broken = write_meta(tmp_path, '000001', bad, source)
    original = broken.read_bytes()
    good = write_meta(tmp_path, '000002', {
        'date': '20260914', 'regular_session_open_ms': 90000000,
        'regular_session_close_ms': 153000000,
    }, source)
    operation = getattr(meta_backfill, sweep)
    preview = operation(tmp_path, dry_run=True)
    assert (preview.scanned, preview.updated, preview.invalid) == (2, 1, 1)
    result = operation(tmp_path)
    assert (result.scanned, result.updated, result.skipped, result.invalid) == (2, 1, 1, 1)
    assert broken.read_bytes() == original
    assert 'is_partial' in json.loads(good.read_text())
    assert str(broken) in caplog.text


@pytest.mark.parametrize('has_bounds', [True, False])
def test_exception_hours_survive_indicator_repair(tmp_path: Path, has_bounds: bool) -> None:
    value = {
        'date': '20260914', 'regular_session_open_ms': 100000000,
        'regular_session_close_ms': 123000000, 'collection_complete': True,
        'krx_aftermarket_eligible': False,
        'indicator_continuous_windows': [[100000000, 122000000]],
    }
    if has_bounds:
        value.update(indicator_session_open_ms=100000000, indicator_session_close_ms=123000000)
    path = write_meta(tmp_path, '005930', value)
    result = meta_backfill.backfill_indicator_session_bounds(tmp_path)
    assert result.updated == int(not has_bounds)
    repaired = json.loads(path.read_text())
    assert (repaired['indicator_session_open_ms'], repaired['indicator_session_close_ms']) == (100000000, 123000000)
    assert repaired['indicator_continuous_windows'] == [[100000000, 122000000]]
    assert meta_backfill.backfill_indicator_session_bounds(tmp_path).updated == 0
