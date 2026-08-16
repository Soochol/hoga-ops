"""이벤트 루프 지연 프로브 — 기아를 **사후 추론이 아니라 신호로** 만든다.

## 왜 필요한가

이 앱은 `--workers` 를 쓸 수 없다(#998 — 프로세스 내 싱글턴: 키움 WS 세션·스케줄러·
DuckDB). 즉 **단일 이벤트 루프가 REST·WS·스케줄러를 전부 처리**한다. 그래서 어딘가에서
GIL 을 오래 쥐면 그 시간 동안 앱 전체가 멎는다 — 무관한 요청도, WS 하트비트도.

문제는 **그게 보이지 않는다**는 것이었다. 증상은 "가끔 앱이 순간 멎는다" 로만 나타나고,
원인 규명은 slow-log 두 줄의 타임스탬프를 눈으로 맞춰 보는 **사후 co-timing 추론**뿐이었다
(2026-08-16 감사가 실제로 그렇게 했다). 게다가 그 추론은 오염돼 있었다 — 여러 백엔드가
같은 로그 파일에 append 하기 때문이다(`request_timing._PID` 주석 참조).

이 프로브는 그 추론을 **직접 측정**으로 바꾼다. 정해진 간격으로 자고 일어나 "얼마나 늦게
깨어났는가" 를 잰다. 루프가 막혀 있었으면 그만큼 늦게 깨어난다 — 원인을 몰라도 **기아가
있었다는 사실 자체**는 확실해진다.

## 읽는 법

    grep 'hoga_perf loop_lag' hoga.log | sort -t= -k4 -rn | head

같은 타임스탬프 근처의 `hoga_perf http_request` 줄을 보면 누가 막았는지 좁혀진다.
`pid=` 가 같은 줄만 보는 것을 잊지 말 것 — 다른 프로세스의 지연은 내 문제가 아니다.

## 기본값의 근거

- `interval` 0.5초: 초당 2회. 이 정도면 수백 ms 급 기아를 놓치지 않으면서, 프로브 자체가
  루프에 얹는 부담은 무시할 수 있다(`sleep` 하나 + 뺄셈 하나).
- `warn_ms` 250: 스케줄링 지터는 보통 한 자릿수 ms 다. 250ms 초과는 "무언가 오래 붙들고
  있었다" 가 거의 확실한 폭이고, 정상 운영에서 로그가 조용하도록 잡은 값이다.
  **경보가 흔하면 읽히지 않는다** — 이 리포가 반복해서 배운 것이다.

`HOGA_LOOP_LAG_WARN_MS=0` 으로 끌 수 있다. 끄는 것이 기본이 아닌 이유는, 이 신호가
필요해지는 순간은 예고 없이 오기 때문이다(장중 한 번의 2초 정지는 재현이 어렵다).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

log = logging.getLogger(__name__)

DEFAULT_INTERVAL_S = 0.5
DEFAULT_WARN_MS = 250.0


def warn_ms_from_env(env: dict[str, str] | None = None) -> float:
    """`HOGA_LOOP_LAG_WARN_MS` — 0 이면 비활성. 파싱 실패는 기본값(설정 오타가
    프로브를 조용히 꺼 버리지 않게)."""
    raw = (env if env is not None else os.environ).get("HOGA_LOOP_LAG_WARN_MS", "")
    if not raw:
        return DEFAULT_WARN_MS
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_WARN_MS


def overshoot_ms(elapsed_s: float, interval_s: float) -> float:
    """자기로 한 시간을 **얼마나 넘겼는가**(ms). 음수는 0 으로 클램프.

    `sleep` 은 최소 보장이라 약간 늦게 깨는 것이 정상이다 — 재는 것은 절대 경과가
    아니라 **초과분**이고, 그게 곧 "루프가 나를 깨우지 못한 시간" 이다.
    """
    return max(0.0, (elapsed_s - interval_s) * 1000.0)


async def loop_lag_probe(
    *,
    interval_s: float = DEFAULT_INTERVAL_S,
    warn_ms: float = DEFAULT_WARN_MS,
    iterations: int | None = None,
) -> None:
    """`interval_s` 마다 깨어나 초과 지연을 잰다. 임계 초과분만 로그한다.

    `iterations` 는 테스트용 종료 조건이다(기본 None = 무한). 프로덕션에서 이 태스크는
    lifespan 이 취소할 때까지 산다 — 영구 루프이므로 **정상 반환은 조용한 죽음**이고,
    `supervised_task_health` 가 그걸 `dead` 로 잡는다(ADR-0064).
    """
    if warn_ms <= 0:
        return
    count = 0
    while iterations is None or count < iterations:
        t0 = time.perf_counter()
        await asyncio.sleep(interval_s)
        lag = overshoot_ms(time.perf_counter() - t0, interval_s)
        if lag >= warn_ms:
            # 포맷은 이 리포의 관례 그대로 — `hoga_perf <name> key=value`(grep 표면 공유).
            log.warning(
                "hoga_perf loop_lag lag_ms=%.1f interval_ms=%.0f threshold_ms=%.0f",
                lag,
                interval_s * 1000.0,
                warn_ms,
            )
        count += 1
