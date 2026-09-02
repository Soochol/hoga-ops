"""GC 임계 튜닝 값 — 리프 모듈.

원래 `hoga.api.app` 에 있던 값이다. 여기로 내린 이유는 하나다: **프로모터 워커
프로세스**(`hoga.live.promote_executor`, ADR-0168)가 같은 임계를 걸어야 하는데,
그쪽에서 `hoga.api.app` 을 import 하면 FastAPI 앱 전체가 자식 프로세스에 올라온다.
값의 근거 표(ADR-0085 v3.2 실측)는 `hoga.api.app` 의 주석에 그대로 있고, 그 모듈은
하위호환으로 이 이름들을 재수출한다.
"""
from __future__ import annotations

import os
from collections.abc import Mapping

#: GC gen0 임계 기본값. CPython 기본은 700 이다(근거는 `hoga.api.app` 주석).
GC_GEN0_THRESHOLD_DEFAULT = 50_000
#: gen1/gen2 — 실측 조합의 나머지 두 자리(기본은 10/10).
GC_UPPER_GEN_THRESHOLDS = (50, 50)

ENV_GC_GEN0_THRESHOLD = "HOGA_GC_GEN0_THRESHOLD"


def gc_gen0_threshold(env: Mapping[str, str] | None = None) -> int:
    """`HOGA_GC_GEN0_THRESHOLD` 해석. `0` = 튜닝 끔, 미설정 = 기본값.

    파싱 실패는 기본값으로 떨어진다 — 오타 하나로 서버가 안 뜨는 것보다,
    문서화된 기본으로 도는 편이 낫다(`slow_request_threshold_ms` 와 같은 규약).
    """
    source = os.environ if env is None else env
    raw = source.get(ENV_GC_GEN0_THRESHOLD, "")
    if not raw:
        return GC_GEN0_THRESHOLD_DEFAULT
    try:
        return max(0, int(raw))
    except ValueError:
        return GC_GEN0_THRESHOLD_DEFAULT


def gc_thresholds(env: Mapping[str, str] | None = None) -> tuple[int, int, int] | None:
    """앱이 기동 뒤에 거는 `gc.set_threshold` 인자 그대로. 튜닝이 꺼져 있으면 ``None``.

    워커 프로세스 initializer 가 부모와 같은 값을 걸기 위해 쓴다 — 부모의
    `gc.get_threshold()` 를 읽으면 안 된다: 풀은 lifespan 이 임계를 걸기 **전**에
    만들어질 수 있어 기본값을 베끼게 된다.
    """
    gen0 = gc_gen0_threshold(env)
    if gen0 <= 0:
        return None
    return (gen0, *GC_UPPER_GEN_THRESHOLDS)
