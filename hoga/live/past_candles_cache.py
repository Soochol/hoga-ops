"""Memory-only cache for vendor minute candle results.

Backs GET /api/live/past-candles. Both past and today's candles live only in
process memory; restart/deploy/eviction is natural invalidation.

past 계층은 코드-지역성 2단 LRU: (venue, code) 코드-LRU 아래에 (tic_scope, date)
슬롯-LRU. 전역 예산 초과 시 LRU '코드'의 가장 오래된 슬롯부터 축출한다 — 단일
전역 날짜-LRU에서는 관심종목 순환이 딥스크롤 중인 활성 코드의 창을 밀어내
같은 날짜를 세션 중 수십 회 재fetch하는 churn이 있었다.

## 왜 `tic_scope` 가 **내부** 키인가

키움 `ka10080` 은 요청한 분 주기 그대로 900행을 준다(#1008). 표시 tf 로 직접
받으면 콜당 커버리지가 tf 배수만큼 늘지만(10분 뷰 10×), 같은 날짜라도 **스코프가
다르면 다른 봉**이라 한 슬롯에 담을 수 없다. 어딘가에는 반드시 있어야 한다.

**바깥 키에 두면 격리가 깨진다.** per-code 쿼터가 "종목×스코프"당이 되어 한 종목이
차지할 수 있는 최대가 스코프 수만큼 곱해지고, 2단 구조가 애초에 막으려던 독식이
그대로 돌아온다. 그래서 스코프는 안쪽에 있고, 쿼터는 종목 단위로 남는다.

## 왜 예산이 **봉 수**인가

엔트리 개수로 세는 모델은 모든 엔트리가 같은 크기일 때만 맞고, 그 전제는 1분봉
전용이던 시절엔 참이었다. 지금은 아니다 — 하루치가 1분 382봉, 30분 ~14봉이라
30분 엔트리는 1분 엔트리의 1/28 이다.

개수로 재면 두 방향으로 틀린다: ① 작은 엔트리가 예산을 과하게 소비한 것처럼 세어
캐시를 너무 일찍 버리고, ② 날짜 쿼터를 스코프들이 나눠 쓰면 6개 tf 에서 각 53일밖에
못 담아 read-ahead 클램프(243일, ADR-0090)를 못 채운다.

봉 수로 재면 둘 다 사라진다. 상위 tf 는 싼 만큼 **같은 예산 안에서 더 깊게** 담기고
(10분봉은 1분봉과 같은 바이트로 10배 많은 날짜), tf 를 늘려도 각 tf 의 유효 깊이가
`1/N` 로 깎이지 않는다. 6개 tf 를 전부 채워도 실측 봉 수 합은 1분 단독의 약 1.75배다.

빈 엔트리(비거래일)에 하한 무게를 주는 이유는 `_MIN_ENTRY_WEIGHT` 참고.

today 계층은 **1분 고정이라 스코프가 키에 없다.** 오늘분은 실시간 tail(WS 체결틱
1분 합성, ADR-0125)과 병합되어야 하므로 언제나 1분으로 받고, 표시 버킷 집계는
프론트 `aggregateCandles` 가 한다.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Literal

from hoga.live.venue import Venue
from hoga.util.cache_stats import CacheStats
from hoga.util.timeenc import KST

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")


# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0

# 1분봉 하루치 봉 수(정규장 09:00~15:30, 종가 단일가 포함 실측 ~382). 예산을
# **날짜가 아니라 봉 수**로 세므로, 옛 "엔트리 개수" 상한을 이 값으로 환산한다.
_BARS_PER_DAY_1MIN = 390

# 전역 예산 = 옛 2048 엔트리 × 390봉. 사이징 근거는 그대로다: 워크백 250거래일 ×
# 2종목 + 60일 워밍 여러 종목 + 여백(ADR-0091), 봉당 ~130KB/일 기준 최악 ~270MB
# (ADR-0036 단일 운영 서버 수용). 코드-지역성 2단 구조가 512 시절의 축출 churn
# (한 종목 반년 워크백만으로 최근 날짜 축출 → 60초 refetch 가 매번 벤더 재호출,
# 2026-07-07 실측)을 구조적으로 막고, 이 예산은 총량 상한이다.
DEFAULT_PAST_MEM_MAX_BARS = 2048 * _BARS_PER_DAY_1MIN
# per-code 쿼터: ADR-0090 read-ahead 클램프(243캘린더일) + 여유 = 320일치 1분봉.
DEFAULT_PAST_MAX_BARS_PER_CODE = 320 * _BARS_PER_DAY_1MIN
DEFAULT_TODAY_MEM_MAX_ENTRIES = 256

# 비거래일은 빈 배열로 캐시해 재요청을 막는다(live_candle_backfill 두 곳). 봉 수로만
# 세면 그 엔트리들이 예산을 **전혀** 소비하지 않아 무한 증식한다 — 243일 창에서
# 주말·공휴일이 ~70일이라 무시할 비중이 아니다. 그래서 모든 엔트리에 하한 1 을 준다.
_MIN_ENTRY_WEIGHT = 1

TodayState = Literal["hit", "miss", "negative"]

PastKey = tuple[Venue, str]
"""(venue, code). **격리 단위** — 한 종목이 전역을 독식하지 못하게 막는 축이다.

`tic_scope` 는 여기가 아니라 내부 키에 있다. 스코프를 이 키에 넣으면 per-code 쿼터가
"종목×스코프"당이 되어 종목당 상한이 스코프 수만큼 곱해진다 — 2단 구조가 애초에
막으려던 독식이 그대로 돌아온다.
"""

InnerKey = tuple[str, str]
"""(tic_scope, date). 스코프는 `kiwoom_minute_candles` 의 문자열("1"/"10"/…).

같은 날짜라도 스코프가 다르면 다른 봉이므로 한 슬롯에 담을 수 없다. 내부 LRU 가
스코프 혼재 상태로 돌지만, 예산이 **봉 수**라서 상위 tf 는 싼 만큼 더 깊게 담긴다 —
날짜 개수로 쿼터를 걸면 6개 tf 가 320 을 나눠 각 53일이 되어 read-ahead(243일)를
못 채운다.
"""


class PastCandlesCache:
    """Memory-only cache for vendor minute candles."""

    def __init__(
        self,
        data_dir: Path,
        *,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        max_past_mem_bars: int = DEFAULT_PAST_MEM_MAX_BARS,
        max_past_bars_per_code: int = DEFAULT_PAST_MAX_BARS_PER_CODE,
        max_today_mem_entries: int = DEFAULT_TODAY_MEM_MAX_ENTRIES,
    ):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        self._max_past_mem_bars = max(0, int(max_past_mem_bars))
        self._max_past_bars_per_code = max(0, int(max_past_bars_per_code))
        self._max_today_mem_entries = max(0, int(max_today_mem_entries))
        self._past_mem: OrderedDict[
            PastKey, OrderedDict[InnerKey, list[dict]]
        ] = OrderedDict()
        # 엔트리 수 — **관측용**이다. 예산 판단은 아래 봉 수가 한다. 두 값을 함께
        # 두는 이유: `size` 는 stats 표면의 기존 계약이라 의미를 바꾸면 소비자가
        # 조용히 틀린 값을 읽는다.
        self._past_total = 0
        self._past_bars_total = 0
        self._past_bars_by_key: dict[PastKey, int] = {}
        self._today_mem: OrderedDict[
            tuple[Venue, str],
            tuple[float, list[dict] | None],
        ] = OrderedDict()
        self._past_stats = CacheStats()
        self._today_stats = CacheStats()

    # --- past ---

    @staticmethod
    def _weight(bars: list[dict]) -> int:
        """엔트리가 예산에서 차지하는 몫. 빈 엔트리도 자리는 있다(`_MIN_ENTRY_WEIGHT`)."""
        return max(_MIN_ENTRY_WEIGHT, len(bars))

    def past_entry_count(self) -> int:
        return self._past_total

    def past_bar_count(self) -> int:
        """예산이 실제로 세는 값. 엔트리 수와 달리 tf 마다 무게가 다르다."""
        return self._past_bars_total

    def stats_snapshot(self) -> dict[str, dict[str, int | float | None]]:
        # `size` 는 엔트리 수 — 기존 계약이라 의미를 바꾸지 않는다. `bars` 는 예산이
        # **실제로 세는 값**이고, 둘의 비(bars/size)가 캐시에 담긴 tf 구성을 말해
        # 준다(1분봉 위주면 ~390, 상위 tf 위주면 훨씬 작다). 축출이 늘기 시작할 때
        # 예산을 올릴지 tf 구성이 바뀐 것인지는 이 비를 봐야 갈린다.
        past = self._past_stats.snapshot(size=self._past_total)
        past["bars"] = self._past_bars_total
        return {
            "past": past,
            "today": self._today_stats.snapshot(size=len(self._today_mem)),
        }

    def get_past(
        self, venue: Venue, code: str, date: str, tic_scope: str
    ) -> list[dict] | None:
        key: PastKey = (venue, code)
        slot: InnerKey = (tic_scope, date)
        inner = self._past_mem.get(key)
        if inner is None:
            self._past_stats.record_miss()
            return None
        bars = inner.get(slot)
        if bars is None:
            self._past_stats.record_miss()
            return None
        if not self._bars_match_date(bars, date):
            # Stale entry (wrong-date rows) — a correctness invalidation, not LRU
            # pressure, so drop it without counting an eviction (advisor #3).
            self._drop_slot(key, inner, slot)
            self._past_stats.record_miss()
            return None
        inner.move_to_end(slot)
        self._past_mem.move_to_end(key)
        self._past_stats.record_hit()
        return bars

    @staticmethod
    def _bars_match_date(bars: list[dict], date_yyyymmdd: str) -> bool:
        """True if `bars` is empty or first bar `t_ms` matches requested date."""
        if not bars:
            return True
        first_ts = bars[0].get("t_ms")
        if not isinstance(first_ts, int):
            return False
        return _ts_ms_to_kst_yyyymmdd(first_ts) == date_yyyymmdd

    def store_past(
        self, venue: Venue, code: str, date: str, bars: list[dict], tic_scope: str
    ) -> None:
        key: PastKey = (venue, code)
        slot: InnerKey = (tic_scope, date)
        inner = self._past_mem.get(key)
        if inner is None:
            inner = OrderedDict()
            self._past_mem[key] = inner
        if slot in inner:
            # 덮어쓰기 — 옛 무게를 먼저 빼야 예산이 어긋나지 않는다.
            self._add_weight(key, -self._weight(inner[slot]))
        else:
            self._past_total += 1
        inner[slot] = bars
        self._add_weight(key, self._weight(bars))
        inner.move_to_end(slot)
        self._past_mem.move_to_end(key)
        self._past_stats.record_store()
        # ① per-code 쿼터: 자기 자신의 LRU 슬롯부터. 봉 수로 재므로 상위 tf 는
        #    싼 만큼 더 많은 날짜가 같은 예산 안에 들어간다.
        while (
            self._past_bars_by_key.get(key, 0) > self._max_past_bars_per_code
            and inner
        ):
            self._evict_lru_slot(key, inner)
        if not inner:
            self._past_mem.pop(key, None)
            self._past_bars_by_key.pop(key, None)
        # ② 전역 예산: LRU 코드의 LRU 슬롯부터 (방금 저장한 코드는 MRU라 보호).
        while self._past_bars_total > self._max_past_mem_bars and self._past_mem:
            lru_key, lru_inner = next(iter(self._past_mem.items()))
            self._evict_lru_slot(lru_key, lru_inner)
            if not lru_inner:
                del self._past_mem[lru_key]
                self._past_bars_by_key.pop(lru_key, None)

    def delete_past(
        self, venue: Venue, code: str, date: str, tic_scope: str
    ) -> None:
        key: PastKey = (venue, code)
        slot: InnerKey = (tic_scope, date)
        inner = self._past_mem.get(key)
        if inner is None:
            return
        if slot in inner:
            self._drop_slot(key, inner, slot)

    def _add_weight(self, key: PastKey, delta: int) -> None:
        self._past_bars_total += delta
        self._past_bars_by_key[key] = self._past_bars_by_key.get(key, 0) + delta

    def _evict_lru_slot(
        self, key: PastKey, inner: OrderedDict[InnerKey, list[dict]]
    ) -> None:
        _slot, bars = inner.popitem(last=False)
        self._past_total -= 1
        self._add_weight(key, -self._weight(bars))
        self._past_stats.record_eviction()

    def _drop_slot(
        self, key: PastKey, inner: OrderedDict[InnerKey, list[dict]], slot: InnerKey
    ) -> None:
        bars = inner.pop(slot, None)
        self._past_total -= 1
        if bars is not None:
            self._add_weight(key, -self._weight(bars))
        if not inner:
            self._past_mem.pop(key, None)
            self._past_bars_by_key.pop(key, None)

    # --- today ---

    def get_today_tri(
        self, venue: Venue, code: str
    ) -> tuple[TodayState, list[dict] | None]:
        """Tri-state today accessor."""
        entry = self._today_mem.get((venue, code))
        if entry is None:
            self._today_stats.record_miss()
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            self._today_mem.pop((venue, code), None)
            self._today_stats.record_miss()
            return "miss", None
        self._today_mem.move_to_end((venue, code))
        if value is None:
            self._today_stats.record_negative()
            return "negative", None
        self._today_stats.record_hit()
        return "hit", value

    def store_today(
        self, venue: Venue, code: str, bars: list[dict] | None
    ) -> None:
        key = (venue, code)
        self._today_mem[key] = (time.monotonic(), bars)
        self._today_mem.move_to_end(key)
        while len(self._today_mem) > self._max_today_mem_entries:
            self._today_mem.popitem(last=False)
