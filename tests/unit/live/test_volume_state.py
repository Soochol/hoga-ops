import datetime as dt

import pytest

from hoga.live.collector_ipc import DISPLAY_MAX_FRAME_BYTES, encode
from hoga.live.volume_state import MINUTE, VolumeReplica, VolumeSource
from hoga.util.timeenc import KST

START = int(dt.datetime(2026, 10, 21, 10, 0, tzinfo=KST).timestamp() * 1000)


def tick(cum, qty, stamp):
    return dict(kind='trade', venue='KRX', t_ms=stamp, cum_volume=cum,
                trades=[dict(t_ms=stamp, qty=qty)])


def source():
    s = VolumeSource('epoch')
    s.configure({'005930'})
    s.health({'005930': 'account:1'}, START)
    return s


def test_exact_rollover_and_quiet_minutes_do_not_require_a_trade_every_15_seconds():
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    s.ingest('005930', tick(120, 20, START + 1000), START + 1000)
    s.ingest('005930', tick(125, 5, START + 180_000), START + 180_000)
    assert [(b.start, b.volume, b.valid) for b in s.streams['005930'].bars] == [
        (START, 30, True), (START + 180_000, 5, True)]


def test_midminute_start_does_not_certify_a_complete_bar():
    s = source()
    s.health({}, START + 500)
    s.health({'005930': 'account:2'}, START + 1000)
    s.ingest('005930', tick(100, 5, START + 2000), START + 2000)
    assert not s.streams['005930'].bars[-1].valid
    s.ingest('005930', tick(107, 7, START + MINUTE), START + MINUTE)
    assert s.streams['005930'].bars[-1].valid


def test_missing_boundary_trades_invalidate_both_sides_and_duplicates_do_not_add():
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    s.ingest('005930', tick(100, 10, START), START)
    s.ingest('005930', tick(200, 5, START + MINUTE), START + MINUTE)
    assert [b.volume for b in s.streams['005930'].bars] == [10, 5]
    assert not any(b.valid for b in s.streams['005930'].bars)


def test_reset_connection_epoch_and_late_frames_do_not_inflate_volume():
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    s.health({'005930': 'account:2'}, START + 1000)
    s.ingest('005930', tick(10_000, 1, START + 2000), START + 2000)
    assert s.streams['005930'].bars[-1].volume == 11
    assert not s.streams['005930'].bars[-1].valid
    r = VolumeReplica()
    r.reset('new')
    with pytest.raises(ValueError, match='epoch'):
        r.apply(s.frames(START + 2000)[0], START + 2000)


def test_lost_snapshot_is_recovered_by_absolute_full_replay_and_revision():
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    old = s.frames(START)[0]
    s.ingest('005930', tick(110, 10, START + MINUTE), START + MINUTE)
    s.ingest('005930', tick(120, 10, START + 2 * MINUTE), START + 2 * MINUTE)
    latest = s.frames(START + 2 * MINUTE)[0]
    r = VolumeReplica()
    r.reset('epoch')
    r.apply(latest, START + 2 * MINUTE)
    r.apply(latest, START + 2 * MINUTE)
    r.apply(old, START + 2 * MINUTE)
    assert len(r.get('005930', START + 2 * MINUTE)['bars']) == 3
    assert r.get('005930', START + 2 * MINUTE)['bars'][-1][1] == 10


def test_chunks_and_replay_are_bounded_for_512_symbols_and_390_minutes():
    s = VolumeSource('epoch')
    codes = {f'{i:06d}' for i in range(512)}
    s.configure(codes)
    s.health(dict.fromkeys(codes, 'a:1'), START)
    for minute in range(390):
        stamp = START + minute * MINUTE
        # Remain inside the regular-session window using a 9am start.
        stamp -= 60 * MINUTE
        if minute == 0:
            s.health(dict.fromkeys(codes, 'a:2'), stamp)
        for code in codes:
            s.ingest(code, tick(1000 + minute, 1, stamp), stamp)
    assert all(len(state.bars) <= 16 for state in s.streams.values())
    frames = s.frames(stamp)
    assert sum(len(frame['streams']) for frame in frames) == 512
    assert all(len(encode(frame)) <= DISPLAY_MAX_FRAME_BYTES for frame in frames)


def test_readd_same_symbol_uses_new_incarnation_even_in_same_connection():
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    r = VolumeReplica()
    r.reset('epoch')
    r.apply(s.frames(START)[0], START)
    old = r.get('005930', START)['generation']
    s.configure(set())
    s.configure({'005930'})
    s.health({'005930': 'account:1'}, START + 1000)
    r.apply(s.frames(START + 1000)[0], START + 1000)
    assert r.get('005930', START + 1000)['generation'] != old
    assert r.get('005930', START + 1000)['bars'] == []


@pytest.mark.parametrize('trades', [None, ['invalid'], {}, 10])
def test_invalid_trade_shape_cannot_break_the_capture_publisher(trades):
    s = source()
    s.ingest('005930', tick(100, 10, START), START)
    payload = tick(101, 1, START + 1000)
    payload['trades'] = trades
    s.ingest('005930', payload, START + 1000)
    assert not s.streams['005930'].bars[-1].valid
