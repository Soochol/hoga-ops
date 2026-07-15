"""partition_live_set — 연속 슬라이스 M/M (스펙 §5.3, Q4). M=_PER_ACCOUNT_MAX."""
from hoga.live.lifecycle import (
    KIS_WS_MAX_REGISTRATIONS,
    TRS_PER_CODE,
    _PER_ACCOUNT_MAX,
    partition_live_set,
)

M = _PER_ACCOUNT_MAX  # 계좌당 종목 상한(현재 19). 리터럴 대신 도출값에 묶어 강건화.


def _codes(n: int) -> list[str]:
    return [f"{i:06d}" for i in range(n)]


def test_partition_2M_into_2_is_M_M():
    # 2M개를 2계좌로: 연속 슬라이스라 M/M 균등 분할.
    parts = partition_live_set(_codes(2 * M), 2)
    assert len(parts) == 2
    assert parts[0] == _codes(2 * M)[:M]
    assert parts[1] == _codes(2 * M)[M : 2 * M]


def test_partition_M_into_2_leaves_second_empty():
    # 정확히 M개면 계좌 0이 가득 차고 계좌 1은 빈 파티션.
    parts = partition_live_set(_codes(M), 2)
    assert parts[0] == _codes(M)
    assert parts[1] == []


def test_partition_M_plus_1_into_2_puts_overflow_on_account_1():
    # M+1번째 코드(0-based index M)만 계좌 1로 넘어간다.
    parts = partition_live_set(_codes(M + 1), 2)
    assert len(parts[0]) == M
    assert parts[1] == [f"{M:06d}"]  # the (M+1)th code (0-based index M)


def test_partition_M_into_1():
    parts = partition_live_set(_codes(M), 1)
    assert parts == [_codes(M)]


def test_partition_stable_account_0_unchanged_when_appending_overflow():
    # M+1번째 코드 추가가 계좌 0의 앞 M개를 절대 옮기지 않는다.
    a = partition_live_set(_codes(M), 2)
    b = partition_live_set(_codes(M + 1), 2)
    assert a[0] == b[0]


def test_per_account_max_derives_from_cap():
    # 계좌당 상한 = 등록 한도 // 코드당 구독수 (사이징 단일진실원).
    # 39//2 = 19 (ADR-0111: 거래원 TR 제외로 종목당 3→2 TR, 13→19종목).
    assert _PER_ACCOUNT_MAX == 19
    assert _PER_ACCOUNT_MAX == KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE


def test_trs_single_source_no_drift():
    """사이징(TRS_PER_CODE)과 실제 구독수(ws_client._TRS)가 ws_fields.TRS 단일소스 — 한 곳만
    고치면 양쪽 동기화돼 드리프트 불가(2026-06-10). _TRS를 빼/더하면 _PER_ACCOUNT_MAX 자동 보정."""
    from hoga.live import ws_fields
    from hoga.live.ws_client import _TRS
    assert TRS_PER_CODE == len(ws_fields.TRS)   # 사이징 = ws_fields.TRS
    assert _TRS is ws_fields.TRS                # 구독수도 같은 튜플 참조
