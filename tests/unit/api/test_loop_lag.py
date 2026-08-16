"""이벤트 루프 지연 프로브.

**벽시계로 재지 않는다.** 이 리포는 벽시계 비율 단언을 이미 기각했고(#434/#516/#977)
같은 실수를 반복하지 않는다 — 프로브의 계약은 "얼마나 빨리 도는가" 가 아니라
**"초과분을 어떻게 계산하고 언제 로그하는가"** 이고, 그 둘은 순수 함수와 호출 횟수로
결정론적으로 잴 수 있다.
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from hoga.api import loop_lag


def test_overshoot_is_the_excess_not_the_elapsed():
    """재는 것은 절대 경과가 아니라 **자기로 한 시간을 넘긴 분량**이다.

    `sleep` 은 최소 보장이라 조금 늦게 깨는 것이 정상 — 절대값을 재면 정상 동작이
    상시 경보가 된다.
    """
    assert loop_lag.overshoot_ms(0.5, 0.5) == 0.0
    assert loop_lag.overshoot_ms(0.75, 0.5) == pytest.approx(250.0)
    # 일찍 깬 경우(측정 오차)는 음수가 아니라 0.
    assert loop_lag.overshoot_ms(0.49, 0.5) == 0.0


def test_warn_ms_env_parsing():
    assert loop_lag.warn_ms_from_env({}) == loop_lag.DEFAULT_WARN_MS
    assert loop_lag.warn_ms_from_env({"HOGA_LOOP_LAG_WARN_MS": "400"}) == 400.0
    assert loop_lag.warn_ms_from_env({"HOGA_LOOP_LAG_WARN_MS": "0"}) == 0.0
    # 오타가 프로브를 **조용히 끄면 안 된다** — 기본값으로 되돌린다.
    assert loop_lag.warn_ms_from_env({"HOGA_LOOP_LAG_WARN_MS": "이백"}) == loop_lag.DEFAULT_WARN_MS


@pytest.mark.asyncio
async def test_probe_is_silent_when_the_loop_is_free(caplog):
    """루프가 한가하면 로그가 없어야 한다 — 흔한 경보는 읽히지 않는다."""
    with caplog.at_level(logging.WARNING):
        await loop_lag.loop_lag_probe(interval_s=0.001, warn_ms=500.0, iterations=3)
    assert "loop_lag" not in caplog.text


@pytest.mark.asyncio
async def test_probe_logs_when_the_loop_is_blocked(caplog):
    """루프를 실제로 막으면 잡힌다.

    동기 블로킹을 `sleep` 직후가 아니라 **다른 태스크에서** 일으켜, 프로브가 자기
    코드가 아니라 **루프 상태**를 재고 있음을 보인다.
    """
    async def hog():
        await asyncio.sleep(0)          # 프로브가 먼저 잠들게 양보
        import time as _t
        _t.sleep(0.05)                  # 동기 블로킹 — GIL 을 쥔 순수 파이썬 구간과 같다

    with caplog.at_level(logging.WARNING):
        await asyncio.gather(
            loop_lag.loop_lag_probe(interval_s=0.001, warn_ms=20.0, iterations=1),
            hog(),
        )
    assert "hoga_perf loop_lag" in caplog.text
    assert "threshold_ms=20" in caplog.text


@pytest.mark.asyncio
async def test_probe_disabled_returns_immediately(caplog):
    """`warn_ms=0` 이면 태스크가 바로 끝난다(감독 목록의 `completed` 상태)."""
    with caplog.at_level(logging.WARNING):
        await loop_lag.loop_lag_probe(interval_s=999.0, warn_ms=0.0)
    assert caplog.text == ""
