"""오늘자(promote 중) 지표의 short-TTL 프로세스 캐시 (ADR-0090, ADR-0043 보완).

ADR-0043의 "오늘 지표 캐시 금지"는 정확히는 **영속(디스크) 캐시 금지**다 — 오늘
snapshots는 아직 promotion 중이라 디스크에 박제하면 곧 stale해진다. 이
프로세스-메모리 short-TTL 메모는 그 위반이 아니라 클래스-C 정책(승격대기 × 고비용
계산)의 나머지 반쪽이며, 오늘 peak뿐 아니라 호가비·체결강도까지 감싼다(bundle.py).

single-flight(peak_slice_guard)는 *동시* 중복만 접고 *순차* 반복(관심종목 전환
버스트, 어긋난 다중 클라이언트 폴링)은 못 접는다. 이 캐시는 TTL(기본 15s) 동안만
오늘자 계산 결과를 재사용한다 — /live의 오늘 범위 refetch 주기(5분)에 비해 무시할
staleness. TTL=0이면 완전 비활성(ADR-0043 원 동작). 키에 date가 들어가므로 자정
경계는 자연 무효화된다.
"""
from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Hashable
from typing import Any

from hoga.util.cache_stats import CacheStats

DEFAULT_TTL_MS = 15_000


def _resolve_ttl_ms() -> int:
    raw = os.environ.get("HOGA_TODAY_INDICATOR_TTL_MS")
    if raw is None:
        return DEFAULT_TTL_MS
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_TTL_MS


class TodayTtlCache:
    """(hit, value) 튜플을 돌려주는 이유: peak 행처럼 값 자체가 None인 결과를
    캐시 미스와 구분해야 한다."""

    def __init__(
        self,
        ttl_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_s = (ttl_ms if ttl_ms is not None else _resolve_ttl_ms()) / 1000.0
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[Hashable, tuple[float, Any]] = {}
        # This is the one cache genuinely hit from multiple threads — counters
        # live inside the existing lock, so no separate CacheStats locking.
        self._stats = CacheStats()

    def stats_snapshot(self) -> dict[str, int | float | None]:
        with self._lock:
            return self._stats.snapshot(size=len(self._entries))

    def lookup(self, key: Hashable) -> tuple[bool, Any]:
        if self._ttl_s <= 0:
            return (False, None)  # cache disabled — not a lookup, not counted
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry[0] < self._clock():
                self._stats.record_miss()
                return (False, None)
            self._stats.record_hit()
            return (True, entry[1])

    def put(self, key: Hashable, value: Any) -> None:
        if self._ttl_s <= 0:
            return
        now = self._clock()
        with self._lock:
            # 만료 정리 — 키는 (kind, code, 오늘) 스코프라 개수가 작고, put 빈도도
            # TTL당 1회 수준이라 선형 스캔으로 충분하다.
            expired = [k for k, (dl, _) in self._entries.items() if dl < now]
            for k in expired:
                del self._entries[k]
            self._stats.record_eviction(len(expired))
            self._stats.record_store()
            self._entries[key] = (now + self._ttl_s, value)


# 프로세스 전역 인스턴스. 테스트 격리는 tests/conftest.py의 autouse 픽스처가
# 매 테스트 새 인스턴스로 갈아끼운다(교차 오염 방지 — 같은 code/date 픽스처 재사용).
TODAY_TTL = TodayTtlCache()
