"""봉합 사이징 가드 — promote 주기가 버퍼 보존을 넘어 today 봉합에 hole을 내지
않도록 런타임 강제(코드리뷰 seam 잔여).

불변식(range.ts:24 주석·buffer.py 봉합 사이징): pastMaxQrT는 now보다
(promote 주기 + refetch 주기)만큼 뒤처질 수 있고 버퍼가 그 구간을 메워야 hole이
없다. promote는 env(HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S) 가변, refetch는 프론트
하드코딩(5분)이라 desync 가능 → 가드가 필요한 유일한 가변점은 promote.
"""
from __future__ import annotations

import logging

from hoga.live.buffer import (
    DEFAULT_RETENTION_MS,
    TODAY_RANGE_REFETCH_S,
    max_safe_promote_interval_s,
)
from hoga.live.lifecycle import resolve_today_promote_interval


def test_max_safe_is_retention_minus_refetch() -> None:
    # 안전 상한 = 보존 − refetch = 900s − 300s = 600s.
    # 이 값 '이상'의 promote는 promote+refetch ≥ retention → hole.
    assert max_safe_promote_interval_s() == DEFAULT_RETENTION_MS / 1000.0 - TODAY_RANGE_REFETCH_S
    assert max_safe_promote_interval_s() == 600.0


def test_default_300_passes_unchanged() -> None:
    # 기본 300s는 안전(300+300=600 < 900) → 그대로 통과, 경고 없음.
    assert resolve_today_promote_interval(300.0) == 300.0


def test_below_limit_passes_unchanged() -> None:
    # 판별 테스트(advisor): 480s는 통과해야 한다(480+300=780 < 900).
    # 만약 480이 막히면 '2×promote' 공식을 잘못 구현한 것.
    assert resolve_today_promote_interval(480.0) == 480.0
    # 경계 직전 599s도 통과(599+300=899 < 900).
    assert resolve_today_promote_interval(599.0) == 599.0


def test_at_or_above_limit_falls_back_with_warning(caplog) -> None:
    # 첫 flag 값 600s: 600+300=900 = retention → 경계, hole 위험 → 기본 폴백+경고.
    with caplog.at_level(logging.WARNING):
        result = resolve_today_promote_interval(600.0)
    assert result == 300.0
    assert any("promote_interval_unsafe" in r.message for r in caplog.records)


def test_far_above_limit_falls_back(caplog) -> None:
    # 명백한 오설정(1시간) → 기본 폴백.
    with caplog.at_level(logging.WARNING):
        result = resolve_today_promote_interval(3600.0)
    assert result == 300.0
    assert any("promote_interval_unsafe" in r.message for r in caplog.records)
