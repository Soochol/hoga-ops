"""거버너 스냅샷의 **생산 키**와 **wire 모델 필드**가 어긋나지 않는다.

## 왜 필요한가

`LiveStatus.rest_capacity_scheduler` 는 `KiwoomGovernorSnapshot` 으로 좁혀져 있고,
그 라우트는 `response_model=LiveStatus` 다. FastAPI 는 **선언되지 않은 키를 조용히
스트립한다** — 에러도 경고도 없다. 그래서 `snapshot()` 에 키를 더하고 모델을 안
고치면, 그 값은 서버 로그에도 예외에도 안 남고 **프론트에서만 사라진다**.

이 리포가 반복해서 다룬 실패 유형이라(CLAUDE.md "⚠ `response_model` 은 500 이 아니라
조용히 필드를 버린다") 생산 함수의 키를 **전수로** 읽어 대조한다.

## 막는 방향과 못 보는 것

**막는다**: 두 집합의 **어느 방향 어긋남이든**. 스냅샷에만 있는 키(= 스트립됨)와
모델에만 있는 키(= 항상 기본값이라 죽은 필드) 둘 다 실패한다.

**못 본다**: 값의 **타입**. `queued` 가 `int` 로 선언됐는데 스냅샷이 `str` 을 내면
pydantic 이 강제 변환하거나 검증 에러를 낼 뿐, 여기서는 안 잡힌다. 키 이름만 본다.
프론트 미러(`frontend/src/api/liveStatus.ts`)와의 대조도 이 테스트의 범위가 아니다 —
그건 사람이 같은 PR 에서 맞춘다(ADR-0004).

**등록 의존 없음**: 스케줄러 인스턴스에서 직접 `snapshot()` 을 부르고 모델의
`model_fields` 를 읽는다. 새 키를 어디 등록할 필요가 없다.
"""

from __future__ import annotations

from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.lifecycle import KiwoomGovernorSnapshot


def test_snapshot_keys_match_wire_model_fields() -> None:
    produced = set(KiwoomCapacityScheduler().snapshot())
    declared = set(KiwoomGovernorSnapshot.model_fields)
    stripped = produced - declared
    dead = declared - produced
    assert produced == declared, (
        "거버너 스냅샷과 wire 모델이 갈렸다. "
        f"모델에 없어 **조용히 스트립되는** 키={sorted(stripped)} "
        f"스냅샷이 안 내는 죽은 필드={sorted(dead)}. "
        "`KiwoomGovernorSnapshot`(hoga/live/lifecycle.py)과 "
        "`KiwoomCapacityScheduler.snapshot()` 을 같은 PR 에서 함께 고칠 것."
    )


def test_wire_model_accepts_a_real_snapshot() -> None:
    """실제 스냅샷이 모델을 통과하고, 왕복해도 키가 보존된다.

    키 이름이 같아도 타입이 어긋나면 `model_validate` 가 여기서 죽는다 — 위 테스트가
    못 보는 축을 좁게나마 덮는다.
    """
    snap = KiwoomCapacityScheduler().snapshot()
    assert KiwoomGovernorSnapshot.model_validate(snap).model_dump().keys() == snap.keys()
