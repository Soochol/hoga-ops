"""GC 정지 프로브 — stop-the-world 를 **추론이 아니라 신호로** 만든다.

## 왜 필요한가

`loop_lag` 는 "루프가 늦게 깨어났다" 는 사실까지만 말하고 **누가 붙들었는지**는 말하지
않는다. 2026-09-04 장중에 그 구별을 손으로 했다 — 정지 순간의 스레드별 CPU 를 재서
루프 스레드가 태우면 GC·온루프 작업, 다른 스레드가 태우면 GIL convoy 로 갈랐다.
실측 11건 중 9건이 convoy, 2건이 GC 였고 convoy 쪽은 ADR-0169 후속으로 옮겼다.

남은 GC 쪽은 크기를 모른다. 오프라인 재현(앱의 링버퍼와 같은 중첩 dict)에서 gen2 정지가
추적 객체 5.8M 에 2.0초, 23M 에 6.6초, 69M 에 20초로 자랐고 관측된 정지가 3~10초였으니
앱의 추적 객체는 수천만 규모로 **추정**된다. 추정인 이유는 밖에서 볼 수단이 없어서다
(ptrace 차단, py-spy 불가). 이 모듈이 그 추정을 측정으로 바꾼다.

## 두 층으로 나눈 이유 — 하나는 상시, 하나는 옵트인

- **정지 계측(상시·무비용)**: `gc.callbacks` 로 수집의 시작·끝 시각만 받는다. 콜백은
  수집당 두 번이고 하는 일이 뺄셈 하나라 정상 운영에 얹는 부담이 없다. 임계를 넘는
  수집은 `loop_lag` 와 같은 형식으로 로그에 남고, 누적 통계는 `/health?deep=1` 이
  돌려준다. 이것만으로 "GC 가 몇 번, 얼마나 오래 멈추는가" 가 답해진다.
- **객체 조사(옵트인·비쌈)**: 어디에 그 객체들이 있는지는 `gc.get_objects()` 를 훑어야
  안다. 그 호출 자체가 전 객체를 리스트로 만들어 **앱을 수 초 멈춘다** — 그래서 기본은
  꺼져 있고(`HOGA_GC_INTROSPECT_ENABLED=true`), 켜도 `?gc_objects=1` 을 명시해야 돈다.
  장 마감 뒤 한 번 부르는 용도다. 절대 감독자 폴링 경로에 넣지 말 것.

## 왜 `/health?deep=1` 인가

새 라우트를 만들지 않은 이유는 소비자가 이미 거기를 물고 있어서다(운영 워치독·사람).
`HealthResponse.gc` 는 `queue`·`disk` 와 같은 성격의 관측 필드이고, 상시 층은 카운터
읽기라 deep health 의 "부작용 없음" 성질을 깨지 않는다.
"""
from __future__ import annotations

import gc
import logging
import os
import time
from collections import Counter
from collections.abc import Mapping
from typing import Any

log = logging.getLogger(__name__)

#: 이 시간을 넘은 수집은 경고로 남긴다. `loop_lag` 의 250ms 와 같은 값·같은 이유 —
#: 정상 운영에서 조용해야 신호가 읽힌다.
DEFAULT_PAUSE_WARN_MS = 250.0
ENV_PAUSE_WARN_MS = "HOGA_GC_PAUSE_WARN_MS"
ENV_INTROSPECT_ENABLED = "HOGA_GC_INTROSPECT_ENABLED"

#: 객체 조사에서 돌려줄 타입 수. 전량은 수천 종이라 읽히지 않는다.
INTROSPECT_TOP_N = 25


def pause_warn_ms_from_env(env: Mapping[str, str] | None = None) -> float:
    """`HOGA_GC_PAUSE_WARN_MS` 해석. `0` = 경고 끔, 미설정 = 기본값.

    파싱 실패는 기본값으로 떨어진다 — 오타 하나로 서버가 안 뜨는 것보다 낫다
    (`loop_lag.warn_ms_from_env`·`gc_gen0_threshold` 와 같은 규약).
    """
    source = os.environ if env is None else env
    raw = source.get(ENV_PAUSE_WARN_MS, "")
    if not raw:
        return DEFAULT_PAUSE_WARN_MS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_PAUSE_WARN_MS


def introspect_enabled(env: Mapping[str, str] | None = None) -> bool:
    """객체 조사 허용 여부. 기본 **꺼짐** — 그 조사는 앱을 수 초 멈춘다."""
    source = os.environ if env is None else env
    return source.get(ENV_INTROSPECT_ENABLED, "").strip().lower() == "true"


class GcPauseRecorder:
    """세대별 수집 횟수·정지 시간 누적기.

    `gc.callbacks` 는 수집 **전후로** 같은 콜백을 부르고 `info["generation"]` 으로 세대를
    알려 준다. 시작 시각을 담아 두었다가 끝에서 뺀다 — 그 사이가 stop-the-world 다.

    **재진입은 없다.** 수집 중에는 파이썬 코드가 이 인터프리터에서 돌지 않으므로 start
    두 번이 겹칠 수 없다. 그래도 start 를 못 본 stop(콜백을 수집 도중에 붙인 경우)은
    조용히 무시한다 — 그 한 건 때문에 음수 정지가 통계에 들어가면 전체가 못 쓰게 된다.
    """

    def __init__(self, *, warn_ms: float = DEFAULT_PAUSE_WARN_MS) -> None:
        self.warn_ms = warn_ms
        #: 세대 → {"collections", "total_ms", "max_ms", "last_ms", "last_at_ms"}
        self.by_generation: dict[int, dict[str, float]] = {}
        self.over_threshold = 0
        self._started_at: float | None = None

    def __call__(self, phase: str, info: dict) -> None:
        if phase == "start":
            self._started_at = time.perf_counter()
            return
        if phase != "stop" or self._started_at is None:
            return
        elapsed_ms = (time.perf_counter() - self._started_at) * 1000.0
        self._started_at = None
        gen = int(info.get("generation", -1))
        row = self.by_generation.setdefault(
            gen, {"collections": 0.0, "total_ms": 0.0, "max_ms": 0.0,
                  "last_ms": 0.0, "last_at_ms": 0.0},
        )
        row["collections"] += 1
        row["total_ms"] += elapsed_ms
        row["max_ms"] = max(row["max_ms"], elapsed_ms)
        row["last_ms"] = elapsed_ms
        row["last_at_ms"] = time.time() * 1000.0
        if self.warn_ms > 0 and elapsed_ms >= self.warn_ms:
            self.over_threshold += 1
            # `loop_lag` 와 같은 형식 — 같은 grep 으로 함께 읽히게 한다. collected 는
            # 이 수집이 실제로 회수한 객체 수라, 정지가 길기만 하고 회수가 적으면
            # "순회 대상이 크다"(=상주 객체가 많다)는 뜻이다.
            log.warning(
                "hoga_perf gc_pause gen=%d pause_ms=%.1f collected=%s uncollectable=%s "
                "threshold_ms=%.0f",
                gen, elapsed_ms, info.get("collected"), info.get("uncollectable"),
                self.warn_ms,
            )

    def snapshot(self) -> dict[str, Any]:
        """누적 통계 — 카운터 읽기라 값싸다(`/health?deep=1` 상시 층)."""
        counts = gc.get_count()
        return {
            "enabled": True,
            "warn_ms": self.warn_ms,
            "over_threshold": self.over_threshold,
            "thresholds": list(gc.get_threshold()),
            "current_counts": list(counts),
            "by_generation": {
                str(gen): {
                    "collections": int(row["collections"]),
                    "total_ms": round(row["total_ms"], 1),
                    "max_ms": round(row["max_ms"], 1),
                    "last_ms": round(row["last_ms"], 1),
                    "last_at_ms": int(row["last_at_ms"]),
                }
                for gen, row in sorted(self.by_generation.items())
            },
            # 인터프리터 자체 카운터 — 이 프로브가 붙기 전의 수집도 포함한다.
            "interpreter_stats": gc.get_stats(),
        }


class _Slot:
    """설치된 기록기 한 칸 — `global` 재대입 대신 속성 갱신(PLW0603)."""

    recorder: GcPauseRecorder | None = None


_slot = _Slot()


def install(*, warn_ms: float = DEFAULT_PAUSE_WARN_MS) -> GcPauseRecorder | None:
    """`gc.callbacks` 에 기록기를 건다. 이미 걸려 있으면 그것을 돌려준다.

    `warn_ms=0` 이면 경고는 끄되 계측은 계속한다 — 통계는 여전히 값싸고, 끄는 비용보다
    "필요할 때 데이터가 없다" 는 비용이 크다(`loop_lag` 가 기본 켜짐인 것과 같은 판단).
    """
    if _slot.recorder is not None:
        return _slot.recorder
    recorder = GcPauseRecorder(warn_ms=warn_ms)
    gc.callbacks.append(recorder)
    _slot.recorder = recorder
    log.info("hoga_perf gc_probe installed warn_ms=%.0f", warn_ms)
    return recorder


def uninstall() -> None:
    """콜백을 뗀다. 앱 인스턴스를 수백 번 만드는 테스트가 콜백을 쌓지 않게 한다."""
    recorder = _slot.recorder
    _slot.recorder = None
    if recorder is not None and recorder in gc.callbacks:
        gc.callbacks.remove(recorder)


def recorder() -> GcPauseRecorder | None:
    return _slot.recorder


def stats_snapshot() -> dict[str, Any]:
    """상시 층. 프로브가 없으면 그 사실을 그대로 알린다 — 빈 dict 는 "수집이 없었다"
    와 "재고 있지 않다" 를 구별하지 못한다."""
    rec = _slot.recorder
    if rec is None:
        return {"enabled": False, "thresholds": list(gc.get_threshold()),
                "current_counts": list(gc.get_count()),
                "interpreter_stats": gc.get_stats()}
    return rec.snapshot()


def introspect_objects(top_n: int = INTROSPECT_TOP_N) -> dict[str, Any]:
    """추적 객체를 타입별로 센다 — **앱을 수 초 멈춘다**. 호출자가 게이트를 책임진다.

    `gc.get_objects()` 는 추적 객체 전부를 리스트로 만든다(객체 수만큼의 포인터 배열 +
    전 세대 순회). 그래서 이 함수는 진단 목적의 **일회성** 호출용이고, 결과의 `elapsed_ms`
    가 곧 "이 조사 때문에 앱이 멈춘 시간" 이다.

    돌려주는 것은 타입 이름별 개수 상위 N 과 총 추적 객체 수다. GC 정지 시간은 바이트가
    아니라 **객체 개수**에 비례하므로(오프라인 곡선), 줄일 대상을 고르는 데 필요한 값이
    바로 이 표다.
    """
    t0 = time.perf_counter()
    objects = gc.get_objects()
    total = len(objects)
    histogram = Counter(type(o).__name__ for o in objects)
    top = histogram.most_common(top_n)
    # 리스트를 즉시 놓아 준다 — 다음 수집까지 붙들고 있으면 그 자체가 힙을 부풀린다.
    del objects
    return {
        "total_tracked_objects": total,
        "top_types": [{"type": name, "count": count} for name, count in top],
        "distinct_types": len(histogram),
        "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 1),
    }
