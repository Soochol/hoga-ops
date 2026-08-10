"""GC gen0 임계 상향 (`HOGA_GC_GEN0_THRESHOLD`).

왜 있나: `/api/range` 처럼 요청당 수만 개의 모델을 만드는 경로에서 CPython 의
stop-the-world 수집이 팽창의 절반을 차지했다 — gen0 임계를 올리면 6-스레드 wall 이
candles +37% · sidecar +55% 개선되고 gen0 수집 횟수가 869→12 · 1442→7 로 떨어진다
(ADR-0085 v3.2, 실측표는 `app.GC_GEN0_THRESHOLD_DEFAULT` 주석).

여기서 재는 것은 **효과가 아니라 배선**이다 — 효과는 벽시계라 테스트로 고정하지
않는다(리포 규칙). 배선은 세 가지다: 켜지는가 · 끌 수 있는가 · **원복되는가**.
"""
from __future__ import annotations

import gc

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import GC_GEN0_THRESHOLD_DEFAULT, create_app, gc_gen0_threshold


def _observe_threshold_inside_lifespan(tmp_path) -> tuple[int, ...]:
    """lifespan 이 열려 있는 동안의 `gc.get_threshold()`."""
    app = create_app(data_dir=tmp_path / "data")
    seen: list[tuple[int, ...]] = []
    with TestClient(app) as client:
        client.get("/health")
        seen.append(gc.get_threshold())
    return seen[0]


def test_lifespan_raises_gen0_threshold(tmp_path, monkeypatch):
    monkeypatch.delenv("HOGA_GC_GEN0_THRESHOLD", raising=False)
    inside = _observe_threshold_inside_lifespan(tmp_path)
    assert inside[0] == GC_GEN0_THRESHOLD_DEFAULT, (
        f"gen0 임계가 안 올라갔다 — {inside}. 이게 죽으면 팽창의 절반이 돌아온다."
    )


def test_lifespan_restores_threshold_on_exit(tmp_path, monkeypatch):
    """**원복이 없으면 pytest 프로세스 전체로 샌다.**

    `TestClient` 는 한 프로세스 안에서 앱을 수백 번 만든다. 이 전역 설정이 남으면
    GC 동작에 의존하는 다른 테스트를 조용히 흔든다 — 프로덕션이 아니라 여기를
    위한 복원이다.
    """
    monkeypatch.delenv("HOGA_GC_GEN0_THRESHOLD", raising=False)
    before = gc.get_threshold()
    _observe_threshold_inside_lifespan(tmp_path)
    assert gc.get_threshold() == before, "lifespan 종료 후 임계가 원복되지 않았다"


def test_zero_disables_the_tuning(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_GC_GEN0_THRESHOLD", "0")
    before = gc.get_threshold()
    inside = _observe_threshold_inside_lifespan(tmp_path)
    assert inside == before, f"0 은 튜닝을 꺼야 한다 — {inside}"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", GC_GEN0_THRESHOLD_DEFAULT),      # 미설정
        ("12345", 12345),
        ("0", 0),                              # 끄기
        ("-5", 0),                             # 음수는 끄기로 접는다
        ("나쁜값", GC_GEN0_THRESHOLD_DEFAULT),  # 파싱 실패 → 기본값(서버는 뜬다)
    ],
)
def test_threshold_env_parsing(monkeypatch, raw, expected):
    if raw:
        monkeypatch.setenv("HOGA_GC_GEN0_THRESHOLD", raw)
    else:
        monkeypatch.delenv("HOGA_GC_GEN0_THRESHOLD", raising=False)
    assert gc_gen0_threshold() == expected
