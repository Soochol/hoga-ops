"""investor-flow 스토어 — 저장 결정(#1115)이 코드에 남아 있는지 고정한다."""
from __future__ import annotations

import json

import pytest

from hoga.live.investor_flow_store import (
    GAP_MIN_JUMP_INTERVALS,
    DailyConfirmedFile,
    IntradaySample,
    InvestorFlowStore,
    compute_coverage,
    rows_equal,
)


def _sample(ms: int, *, mrkt: str = "0", rows: list[dict] | None = None) -> IntradaySample:
    return IntradaySample(
        sampled_at_ms=ms,
        request={"mrkt_tp": mrkt, "amt_qty_tp": "0", "base_dt": "20260805", "stex_tp": "3"},
        rows=rows if rows is not None else [{"inds_cd": "001_AL", "frgnr_netprps": "+100"}],
    )


def test_append_is_additive_not_rewrite(tmp_path):
    """추가 전용 — 기존 줄을 건드리지 않는다."""
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000))
    store.append_sample("20260805", _sample(2000))
    text = store.intraday_path("20260805").read_text(encoding="utf-8")
    assert text.count("\n") == 2
    assert [s.sampled_at_ms for s in store.load_samples("20260805")] == [1000, 2000]


def test_one_line_is_one_vendor_response(tmp_path):
    """한 줄 = 응답 하나. request 를 통째로 보존해야 단위 해석 증빙이 남는다(#1117)."""
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000))
    line = store.intraday_path("20260805").read_text(encoding="utf-8").splitlines()[0]
    payload = json.loads(line)
    assert payload["request"]["amt_qty_tp"] == "0"  # 금액(억원) 축
    assert payload["source"] == "kiwoom:ka10051"
    assert payload["rows"][0]["inds_cd"] == "001_AL"


def test_incomplete_tail_line_is_discarded(tmp_path):
    """append 중 크래시로 남은 반쪽 줄이 하루치를 죽이면 안 된다."""
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000))
    with store.intraday_path("20260805").open("a", encoding="utf-8") as fh:
        fh.write('{"sampled_at_ms": 2000, "req')  # 개행 없이 끊김
    assert [s.sampled_at_ms for s in store.load_samples("20260805")] == [1000]


def test_corrupt_line_does_not_kill_the_rest(tmp_path):
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000))
    with store.intraday_path("20260805").open("a", encoding="utf-8") as fh:
        fh.write("{not json}\n")
    store.append_sample("20260805", _sample(3000))
    assert [s.sampled_at_ms for s in store.load_samples("20260805")] == [1000, 3000]


def test_last_sample_is_per_market(tmp_path):
    """코스피·코스닥이 같은 파일에 섞이므로 중복 비교는 시장별이어야 한다."""
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000, mrkt="0"))
    store.append_sample("20260805", _sample(1100, mrkt="1"))
    kospi = store.last_sample("20260805", "0")
    kosdaq = store.last_sample("20260805", "1")
    assert kospi is not None and kospi.sampled_at_ms == 1000
    assert kosdaq is not None and kosdaq.sampled_at_ms == 1100
    assert store.last_sample("20260805", "9") is None


def test_confirmed_file_presence_is_the_marker(tmp_path):
    """잠정/확정을 따로 저장하지 않는다 — 파일 존재가 곧 확정이다(#1115)."""
    store = InvestorFlowStore(tmp_path)
    assert store.is_confirmed("20260805") is False
    store.write_confirmed(
        DailyConfirmedFile(
            date="20260805",
            confirmed_at_ms=9_999,
            request={"mrkt_tp": "0", "amt_qty_tp": "0", "base_dt": "20260805", "stex_tp": "3"},
            rows=[{"inds_cd": "001_AL"}],
        )
    )
    assert store.is_confirmed("20260805") is True
    loaded = store.load_confirmed("20260805")
    assert loaded is not None and loaded.confirmed_at_ms == 9_999


def test_duplicate_values_are_detectable():
    """동일 값이면 쓰지 않는다(#1099) — 그 판정이 값 비교여야 한다."""
    rows = [{"inds_cd": "001_AL", "frgnr_netprps": "+100"}]
    prev = _sample(1000, rows=rows)
    assert rows_equal(prev, rows) is True
    assert rows_equal(prev, [{"inds_cd": "001_AL", "frgnr_netprps": "+200"}]) is False
    assert rows_equal(None, rows) is False


@pytest.mark.parametrize("interval_ms", [60_000, 300_000])
def test_gap_threshold_is_relative_to_poll_interval(interval_ms):
    """주기 상대 임계 — 주기를 바꾸면 판정이 따라와야 하고, 정상 지터를 갭으로 안 센다."""
    step = interval_ms
    normal = [_sample(step * i) for i in range(4)]
    assert compute_coverage(normal, poll_interval_ms=interval_ms).gap_ranges == []

    # 임계(3주기)를 넘는 점프 하나
    jumped = [_sample(0), _sample(step * (GAP_MIN_JUMP_INTERVALS + 1))]
    cov = compute_coverage(jumped, poll_interval_ms=interval_ms)
    assert len(cov.gap_ranges) == 1
    assert cov.gap_ranges[0] == {"start_ms": 0, "end_ms": step * (GAP_MIN_JUMP_INTERVALS + 1)}
    assert cov.sample_count == 2
    assert cov.first_sample_ms == 0


def test_coverage_of_empty_day_is_empty_not_error():
    cov = compute_coverage([], poll_interval_ms=60_000)
    assert cov.sample_count == 0
    assert cov.first_sample_ms is None
    assert cov.gap_ranges == []


def test_last_sample_serves_from_memory_not_disk(tmp_path):
    """append 후의 `last_sample` 은 **디스크를 읽지 않는다**.

    막는 방향: 캐시를 지워 매 폴마다 하루치 JSONL 전체를 pydantic 파싱하던 회귀.
    그 비용은 장중 내내 선형으로 커져(실측 16.7MB → 수백 ms~2.7s) **이벤트 루프
    위에서** 돌았다 — `hoga_perf loop_stall` 스택 상위 단골이었다.

    파일을 지운 뒤에도 답이 나와야 메모리 경로가 증명된다. 개수 세기(mock)보다
    강한 단언이다 — 읽되 결과를 버리는 구현도 여기서 걸린다.
    """
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000, mrkt="0"))
    store.append_sample("20260805", _sample(2000, mrkt="1"))
    store.intraday_path("20260805").unlink()

    got = store.last_sample("20260805", "0")
    assert got is not None and got.sampled_at_ms == 1000
    got = store.last_sample("20260805", "1")
    assert got is not None and got.sampled_at_ms == 2000


def test_last_sample_falls_back_to_disk_after_restart(tmp_path):
    """새 인스턴스(프로세스 재시작 모사)는 디스크에서 복원한다 — 캐시가 억제 판정을
    깨뜨리면 안 된다. 미스는 키당 1회만 디스크를 읽고 이후는 메모리다."""
    InvestorFlowStore(tmp_path).append_sample("20260805", _sample(1000))

    fresh = InvestorFlowStore(tmp_path)
    got = fresh.last_sample("20260805", "0")
    assert got is not None and got.sampled_at_ms == 1000
    # 채워진 뒤에는 메모리 — 파일을 지워도 산다.
    fresh.intraday_path("20260805").unlink()
    assert fresh.last_sample("20260805", "0") is not None


def test_last_sample_cache_rolls_over_dates(tmp_path):
    """새 날짜를 append 하면 옛 날짜 캐시는 비워진다(영구 프로세스 무한 증식 방지).
    옛 날짜 조회는 디스크 폴백으로 여전히 정확하다."""
    store = InvestorFlowStore(tmp_path)
    store.append_sample("20260805", _sample(1000))
    store.append_sample("20260806", _sample(2000))
    assert list(store._last_cache) == [("20260806", "0")]
    got = store.last_sample("20260805", "0")
    assert got is not None and got.sampled_at_ms == 1000

