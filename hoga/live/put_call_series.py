"""P/C 비율 당일 시계열 링버퍼 (ADR-0135 후속).

스냅샷 P/C 는 "지금 얼마"만 말한다 — "지금 풋이 쌓이는 중인가"는 추이가 있어야
읽힌다. 전수 수집(5분 주기)이 올 때마다 한 점을 쌓는다. ATM 계층은 쓰지 않는다:
P/C 의 표준 정의가 전 종목 비율이라 ATM 창 값을 섞으면 시계열이 두 지표의 혼합이
된다.

**프로세스 메모리 당일 한정**이다. 서버 재시작이면 그 시점부터 다시 쌓인다 —
"오늘의 흐름" 지표라 과거일 영속의 가치가 낮고, 디스크 스키마를 늘릴 이유가 없다
(ADR-0043 계열: 오늘자 파생값은 영속 캐시 금지). 날짜(KST)가 바뀌면 자동 리셋.
"""
from __future__ import annotations

from dataclasses import dataclass

#: 5분 간격 24시간 = 288점. 여유를 둔 상한 — 요청 구동이라 실제로는 훨씬 적다.
_MAX_POINTS = 500


@dataclass(frozen=True)
class PutCallPoint:
    t_ms: int
    volume_ratio: float | None
    oi_ratio: float | None


class PutCallSeries:
    """당일 P/C 시계열. ``date_key``(KST YYYYMMDD)가 바뀌면 버퍼를 비운다.

    시계 없는 순수 자료구조다 — 시각과 날짜는 호출자(런타임)가 주입한다.
    datetime 을 내부에서 읽으면 날짜 경계 테스트가 벽시계에 묶인다.
    """

    def __init__(self, max_points: int = _MAX_POINTS) -> None:
        self._max = max_points
        self._date_key: str | None = None
        self._points: list[PutCallPoint] = []

    def append(
        self,
        *,
        t_ms: int,
        date_key: str,
        volume_ratio: float | None,
        oi_ratio: float | None,
    ) -> None:
        if date_key != self._date_key:
            self._date_key = date_key
            self._points = []
        self._points.append(PutCallPoint(t_ms, volume_ratio, oi_ratio))
        if len(self._points) > self._max:
            # 상한 초과분은 앞(가장 오래된 것)에서 버린다 — 당일 최신 흐름이 목적.
            self._points = self._points[-self._max :]

    def points(self) -> tuple[PutCallPoint, ...]:
        return tuple(self._points)
