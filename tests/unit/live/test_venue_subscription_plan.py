"""venue 구독 파생과 **등록 수 기준** 슬롯 회계 (ADR-0140 §2·§5, PR-F).

시분할(시각→venue 하나)이 폐지되면서 두 가지가 동시에 바뀐다:

1. 한 종목이 차지하는 wire 등록 수가 **1 또는 3** 으로 갈린다 → 분할·용량 산술의 단위가
   "종목 수"에서 "등록 수"로 바뀐다. 이 단위를 놓치면 계정 하나가 최대 600 등록을
   시도하고 **키움이 200 에서 거부**한다.
2. 판정 불가("모름")를 어느 쪽으로 떨어뜨리느냐가 데이터 결손과 직결된다.

실측 2026-08-05: 저장셋 274 종목 중 NXT 상장 176 · 미상장 98 → **626 등록**(앱키 4개분).
"""
import pytest

from hoga.live.coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    partition_kiwoom,
    plan_storage_targets,
    subscription_venues,
    venue_weight,
)

NXT_LISTED = {"005930": True}
NXT_ABSENT = {"005930": False}


def test_nxt_listed_gets_three_venues():
    assert subscription_venues("005930", NXT_LISTED) == ("KRX", "NXT", "UN")
    assert venue_weight("005930", NXT_LISTED) == 3


def test_not_listed_gets_krx_only():
    """미상장에 `_NX`/`_AL` 을 구독하면 슬롯만 태운다 — 키움이 `rc=0` 을 주고 틱은 없다."""
    assert subscription_venues("005930", NXT_ABSENT) == ("KRX",)
    assert venue_weight("005930", NXT_ABSENT) == 1


@pytest.mark.parametrize(("label", "nxt_map"), [
    ("마스터 미로드", None),
    ("코드가 마스터에 없음", {}),
    ("행은 있으나 nxtEnable 미수신", {"005930": None}),
])
def test_unknown_fails_open_to_all_venues(label, nxt_map):
    """**모름은 미상장이 아니다 — 구독한다**(fail-open).

    두 실패가 비대칭이라서다: 모름을 미상장으로 보면 실제 NXT 상장 종목의 그날이
    **영구 결손**이고(지나간 장은 다시 안 온다), 상장으로 보면 슬롯 2개를 낭비하고
    다음 마스터 갱신에 회수된다. ADR-0140 §8 의 "저장은 끄는 것이 더 위험하다"와 같은
    규율이다.

    세 가지 "모름"이 **전부 같은 답**이어야 한다는 것이 이 테스트의 요점이다 — 키의
    부재와 값 None 을 다르게 다루면 신규 상장 종목만 조용히 빠진다.
    """
    assert subscription_venues("005930", nxt_map) == ("KRX", "NXT", "UN"), label


# ── 분할: 단위가 종목이 아니라 등록 수 ────────────────────────────────────────

def test_partition_without_weight_matches_old_slicing():
    """가중 미지정이면 예전 슬라이싱과 **결과가 동일** — 시분할 시절 계약의 회귀 가드."""
    codes = [f"{i:06d}" for i in range(450)]
    parts = partition_kiwoom(codes, 3)
    assert parts[0] == codes[:200]
    assert parts[1] == codes[200:400]
    assert parts[2] == codes[400:]


def test_partition_counts_registrations_not_codes():
    """NXT 상장 종목은 3 등록을 쓰므로 계정 하나에 **67 종목**까지만 담긴다(3×67=201>200).

    종목 수로 세면 200 종목 × 3 = 600 등록을 한 연결에 밀어 넣고 키움이 거부한다.
    """
    codes = [f"{i:06d}" for i in range(200)]
    parts = partition_kiwoom(codes, 3, weight=lambda _c: 3)
    assert [len(p) for p in parts] == [66, 66, 66]
    for part in parts:
        assert sum(3 for _ in part) <= KIWOOM_PER_ACCOUNT_MAX


def test_partition_drops_overflow_beyond_capacity():
    """용량을 넘는 종목은 어느 계정에도 안 담긴다 — 호출자가 경고한다(조용히 안 삼킨다)."""
    codes = [f"{i:06d}" for i in range(200)]
    parts = partition_kiwoom(codes, 1, weight=lambda _c: 3)
    assert sum(len(p) for p in parts) == 66  # 200 등록 예산 / 3
    assert len(codes) - 66 == 134  # 드롭


def test_partition_keeps_a_codes_venues_on_one_connection():
    """한 종목의 등록들은 쪼개지지 않는다 — 경계에서 슬롯이 놀아도 같은 연결에 묶인다.

    표시·저장 라우팅이 연결별 stream 하나로 모이는 구조라(`_conn_members`), KRX 는
    계정 0 이고 NXT 는 계정 1 이면 같은 종목의 틱이 두 stream 으로 갈린다.
    """
    codes = [f"{i:06d}" for i in range(70)]
    parts = partition_kiwoom(codes, 2, weight=lambda _c: 3)
    assert parts[0] == codes[:66]   # 198 등록, 2 슬롯이 논다
    assert parts[1] == codes[66:]
    assert set(parts[0]).isdisjoint(parts[1])


# ── 용량 절단 ────────────────────────────────────────────────────────────────

def test_plan_truncates_by_registration_budget():
    codes = [f"{i:06d}" for i in range(100)]
    targets = plan_storage_targets(codes, kiwoom_capacity=30, weight=lambda _c: 3)
    assert len(targets.kiwoom_targets) == 10  # 30 등록 / 3


def test_plan_keeps_scanning_past_an_unaffordable_code():
    """비싼 종목 하나에서 멈추지 않는다 — 뒤의 KRX 전용(1 등록) 종목은 아직 들어간다.

    여기서 break 하면 NXT 상장 종목 하나가 뒤의 미상장 종목 수십 개를 통째로 밀어낸다.
    """
    codes = ["AAA", "BBB", "CCC"]
    weight = {"AAA": 1, "BBB": 3, "CCC": 1}
    targets = plan_storage_targets(codes, kiwoom_capacity=2, weight=weight.__getitem__)
    assert targets.kiwoom_targets == ("AAA", "CCC")  # BBB 만 건너뛴다


def test_plan_without_weight_is_unchanged():
    """가중 미지정 경로는 종목 수 절단 그대로 — 기존 호출부 무영향."""
    codes = [f"{i:06d}" for i in range(50)]
    targets = plan_storage_targets(codes, kiwoom_capacity=20)
    assert targets.kiwoom_targets == tuple(codes[:20])
