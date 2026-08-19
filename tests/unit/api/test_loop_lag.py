
"""이벤트 루프 지연 프로브.

**벽시계로 재지 않는다.** 이 리포는 벽시계 비율 단언을 이미 기각했고(#434/#516/#977)
같은 실수를 반복하지 않는다 — 프로브의 계약은 "얼마나 빨리 도는가" 가 아니라
**"초과분을 어떻게 계산하고 언제 로그하는가"** 이고, 그 둘은 순수 함수와 호출 횟수로
결정론적으로 잴 수 있다.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

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


@pytest.mark.asyncio
async def test_watchdog_dumps_the_stack_while_the_loop_is_blocked(caplog) -> None:
    """정체 **도중에** 스택이 찍히는가 — 이 계측이 존재하는 이유.

    **막는 방향**: 정체가 끝난 뒤에 스택을 뜨는 쪽. 그러면 범인이 아니라 그 다음
    코드가 찍혀 진단이 조용히 틀린 곳을 가리킨다. 그래서 여기서는 루프를 **동기로**
    막아 두고, 그 블로킹 함수의 이름이 덤프에 들어 있는지 본다.

    **못 보는 것**: 실서버에서 무엇이 루프를 막는지는 말하지 않는다. 이 테스트는
    "막히면 그 프레임이 찍힌다" 는 기계적 성질만 고정한다.

    ⚠ 이 파일의 머리말은 "벽시계로 재지 않는다" 인데 이 테스트는 예외다 — 워치독의
    계약 자체가 "실제로 막힌 동안" 이라 가짜 시계로는 재현할 수 없다(정체를 흉내
    내려면 루프를 진짜로 붙들어야 하고, 그 순간 이벤트 루프 기반 가짜 시계도 함께
    멈춘다). 대신 **비율이 아니라 존재**를 단언하고 여유를 크게 잡는다: 블로킹
    450ms vs 임계 120ms vs 폴링 100ms. 느린 머신에서도 부등호가 뒤집히지 않는다.
    """
    def _block_the_loop_for_the_test() -> None:
        time.sleep(0.45)   # 워치독 임계(120ms)를 넉넉히 넘긴다

    caplog.set_level(logging.WARNING, logger="hoga.api.loop_lag")
    task = asyncio.create_task(
        loop_lag.loop_lag_probe(interval_s=0.02, warn_ms=120.0, iterations=40),
    )
    await asyncio.sleep(0.05)          # 프로브·워치독이 서로를 잡을 시간
    _block_the_loop_for_the_test()      # 루프를 동기로 붙든다
    await asyncio.sleep(0.15)           # 워치독이 찍은 줄이 도착할 시간
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    stalls = [r.getMessage() for r in caplog.records if "loop_stall" in r.getMessage()]
    assert stalls, f"정체 중 스택 덤프가 없다. 받은 로그: {[r.getMessage() for r in caplog.records]}"
    assert "_block_the_loop_for_the_test" in stalls[0], stalls[0]


def test_format_loop_stack_returns_empty_for_unknown_thread() -> None:
    """없는 스레드 id 는 빈 문자열 — 워치독이 그걸로 로그를 건너뛴다."""
    assert loop_lag.format_loop_stack(-1) == ""
