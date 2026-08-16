from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Hashable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from hoga.duck import connect_bounded
from hoga.live.quote_models import Quote

log = logging.getLogger(__name__)

ChangePctSource = Literal[
    "kis",
    "adjusted_daily",
    "hidden_pre_open",
    "unavailable",
]


@dataclass(frozen=True)
class QuoteChangeResolution:
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: ChangePctSource = "unavailable"
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Baseline:
    date: str
    close: int


@dataclass(frozen=True)
class _AdjustedDailySignature:
    mtime_ns: int
    size: int


_BASELINE_SCALE_MISMATCH_RATIO = 3.0
# 프라임 쿼리 하나가 묶는 코드 수. 히트맵 전량(296)이 한 번에 들어가는 크기이면서,
# 파라미터 플레이스홀더가 무한정 늘지 않도록 상한을 둔다.
_PRIME_CHUNK = 500


class QuoteChangeResolver:
    def __init__(self, *, adjusted_daily_path: Path | None) -> None:
        self._adjusted_daily_path = adjusted_daily_path
        self._baseline_cache: dict[Hashable, _Baseline | None] = {}
        self._baseline_cache_signature: _AdjustedDailySignature | None = None

    def resolve_quote(
        self,
        q: Quote,
        *,
        phase: str,
        today: dt.date | None = None,
    ) -> QuoteChangeResolution:
        baseline = self._baseline_for(q.code, today=today)
        warnings: list[str] = []

        if phase == "pre_open":
            previous_close = self._valid_previous_close(q)
            baseline_price = previous_close if previous_close is not None else (baseline.close if baseline else None)
            baseline_date = None if previous_close is not None else (baseline.date if baseline else None)
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=None,
                change_won=None,
                baseline_price=baseline_price,
                baseline_date=baseline_date,
                change_pct_source="hidden_pre_open",
            )

        previous_close = self._valid_previous_close(q)
        if previous_close is not None:
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=round((q.price / previous_close - 1.0) * 100.0, 2),
                change_won=round(q.price - previous_close),
                baseline_price=previous_close,
                baseline_date=None,
                change_pct_source="kis",
                warnings=warnings,
            )

        adjusted_pct = self._adjusted_change_pct(q, baseline)
        if baseline is not None and adjusted_pct is not None:
            if self._baseline_stale_for_today(baseline, today):
                warnings.append("adjusted_baseline_stale")
                return QuoteChangeResolution(
                    code=q.code,
                    price=q.price,
                    change_pct=None,
                    change_won=None,
                    baseline_price=baseline.close,
                    baseline_date=baseline.date,
                    change_pct_source="unavailable",
                    warnings=warnings,
                )
            if self._baseline_scale_mismatch(q, baseline):
                warnings.append("adjusted_baseline_scale_mismatch")
                return QuoteChangeResolution(
                    code=q.code,
                    price=q.price,
                    change_pct=None,
                    change_won=None,
                    baseline_price=baseline.close,
                    baseline_date=baseline.date,
                    change_pct_source="unavailable",
                    warnings=warnings,
                )
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=adjusted_pct,
                change_won=round(q.price - baseline.close),
                baseline_price=baseline.close,
                baseline_date=baseline.date,
                change_pct_source="adjusted_daily",
                warnings=warnings,
            )

        if q.change_pct is not None:
            if self._adjusted_daily_path is not None and self._adjusted_daily_path.exists():  # noqa: SIM102 — 중첩 if 가 조건의 의미 단위를 보존
                if baseline is None:
                    warnings.append("adjusted_baseline_unavailable")
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=q.change_pct,
                change_won=q.change_won,
                baseline_price=baseline.close if baseline else None,
                baseline_date=baseline.date if baseline else None,
                change_pct_source="kis",
                warnings=warnings,
            )

        if self._adjusted_daily_path is not None and self._adjusted_daily_path.exists():
            warnings.append("adjusted_baseline_unavailable")
        return QuoteChangeResolution(
            code=q.code,
            price=q.price,
            change_pct=None,
            change_won=None,
            change_pct_source="unavailable",
            warnings=warnings,
        )

    def _sync_cache_generation(self) -> _AdjustedDailySignature | None:
        """파일 세대와 캐시를 맞춘다. None = 코퍼스 없음(캐시도 비운다).

        `_baseline_for` 와 `prime_baselines` 가 공유한다 — 프라임이 이 정렬을 건너뛰면
        **스테일 세대의 캐시에 새 값을 섞어** 넣게 된다.
        """
        signature = self._adjusted_daily_signature()
        if signature is None:
            self._baseline_cache.clear()
            self._baseline_cache_signature = None
            return None
        if signature != self._baseline_cache_signature:
            self._baseline_cache.clear()
            self._baseline_cache_signature = signature
        return signature

    def prime_baselines(self, codes: Sequence[str], *, today: dt.date | None) -> None:
        """캐시에 없는 코드의 기준가를 **한 쿼리로** 채운다. 호출은 선택적 최적화다.

        ⚠ **블로킹이다 — `asyncio.to_thread` 로 부를 것.** 이름이 그 규율을 말해 주지
        않으므로 여기 적는다.

        왜 필요한가: `resolve_quote` 는 종목마다 `_baseline_for` 를 부르고, 캐시 미스면
        종목당 DuckDB 쿼리가 1건씩 난다(N+1). `/api/live/quotes` 는 히트맵 화면에서
        **한 요청에 296종목**을 받고(`Heatmap.tsx` 가 유니크 코드 전량을 넘긴다), 그
        전 경로가 `async def` 인데 `to_thread` 가 한 곳도 없었다. `--workers` 금지
        구조(#998)라 그동안 **이벤트 루프 전체가 멎는다**.

        캐시가 있는데 왜 폭발하나 — 무효화 계기가 셋이다:
          ① 백엔드 재시작 후 첫 벤더 성공 응답
          ② 매일 17:25 코퍼스 갱신(`_adjusted_daily_signature` 의 mtime/size 세대)
          ③ **KST 날짜가 바뀔 때** — 캐시 키가 `(code, today.isoformat())` 이라
             거래일 아침 첫 폴링이 전량 미스다. 사용자가 화면을 가장 열심히 보는 순간이
             하필 여기다.

        실측(2026-08-16, 실데이터 133.9MB / 8,692,057행, 실히트맵 296종목, 콜드 캐시):

            종전 N+1 **1,538 ms** → 배치 프라임 + 캐시 히트 **37 ms** = **41.7배**
            296종목 반환값 **완전 일치**(코퍼스 부재 0건, 부재도 None 으로 캐시됨).

        그 1.5초는 전부 이벤트 루프 위였다.

        의미론은 `_load_baseline` 과 **글자 그대로 같다**: `close > 0` 이고
        `date < today` 인 행 중 **date 가 가장 큰 것**. 즉 종가 0 인 날은 건너뛰고 그
        이전 양수 종가를 집는다(히트맵 그룹플로우의 `_load_prev_closes` 와 **반대**
        계약이다 — 그쪽은 마지막 행을 고른 뒤 0 이면 제외한다. 두 경로를 합치지 말 것).

        부재도 `None` 으로 캐시한다 — 안 하면 코퍼스에 없는 종목이 매 폴링마다 다시
        쿼리를 태워 배치화의 목적이 반감된다.
        """
        signature = self._sync_cache_generation()
        if signature is None or self._adjusted_daily_path is None:
            return
        if not self._adjusted_daily_path.exists():
            return
        today_key = today.isoformat() if today is not None else None
        missing = [
            code for code in dict.fromkeys(codes)
            if (code, today_key) not in self._baseline_cache
        ]
        if not missing:
            return
        found: dict[str, _Baseline] = {}
        try:
            with connect_bounded() as con:
                for start in range(0, len(missing), _PRIME_CHUNK):
                    chunk = missing[start:start + _PRIME_CHUNK]
                    placeholders = ",".join("?" for _ in chunk)
                    date_guard = "AND date < ?" if today is not None else ""
                    params: list[object] = [*chunk]
                    if today is not None:
                        params.append(today)
                    rows = con.execute(
                        f"""
                        SELECT code,
                               CAST(max(date) AS VARCHAR) AS date_s,
                               max_by(close, date) AS close
                        FROM '{self._adjusted_daily_path}'
                        WHERE code IN ({placeholders}) AND close > 0 {date_guard}
                        GROUP BY code
                        """,
                        params,
                    ).fetchall()
                    for row in rows:
                        found[str(row[0])] = _Baseline(
                            date=str(row[1]), close=int(round(float(row[2]))),
                        )
        except Exception:  # noqa: BLE001 — 프라임 실패가 시세 응답을 죽이면 안 된다.
            # 아무것도 캐시하지 않고 조용히 물러난다. 그러면 `_baseline_for` 의 종목별
            # 폴백이 그대로 돌아 **동작은 종전과 같다**(느릴 뿐). 여기서 부분 결과를
            # 캐시하면 실패 시점에 따라 어떤 종목만 기준가가 비는 비결정적 응답이 된다.
            #
            # 이 성질은 **청크가 여러 개일 때도** 성립한다 — 아래 캐시 쓰기가 try 블록
            # **밖**에 있어서, 청크 2가 터지면 청크 1의 `found` 까지 통째로 버려진다.
            # (테스트는 단일 청크 실패만 재현한다. 실히트맵 296 < `_PRIME_CHUNK` 500 이라
            #  다중 청크는 오늘 죽은 경로이고, 위 배치는 코드 검토로만 확인했다.)
            log.warning("adjusted-daily baseline prime failed (%d codes)", len(missing), exc_info=True)
            return
        for code in missing:
            self._baseline_cache[(code, today_key)] = found.get(code)

    def _baseline_for(self, code: str, *, today: dt.date | None) -> _Baseline | None:
        signature = self._sync_cache_generation()
        if signature is None:
            return None
        cache_key = (code, today.isoformat() if today is not None else None)
        if cache_key in self._baseline_cache:
            return self._baseline_cache[cache_key]
        baseline = self._load_baseline(code, today=today)
        self._baseline_cache[cache_key] = baseline
        return baseline

    def _adjusted_daily_signature(self) -> _AdjustedDailySignature | None:
        if self._adjusted_daily_path is None:
            return None
        try:
            stat = self._adjusted_daily_path.stat()
        except FileNotFoundError:
            return None
        return _AdjustedDailySignature(mtime_ns=stat.st_mtime_ns, size=stat.st_size)

    def _load_baseline(self, code: str, *, today: dt.date | None) -> _Baseline | None:
        if self._adjusted_daily_path is None or not self._adjusted_daily_path.exists():
            return None
        try:
            with connect_bounded() as con:
                date_guard = "AND date < ?" if today is not None else ""
                params: list[object] = [code]
                if today is not None:
                    params.append(today)
                row = con.execute(
                    f"""
                    SELECT CAST(date AS VARCHAR) AS date_s, close
                    FROM '{self._adjusted_daily_path}'
                    WHERE code = ? AND close > 0 {date_guard}
                    ORDER BY date DESC
                    LIMIT 1
                    """,
                    params,
                ).fetchone()
        except Exception:  # noqa: BLE001 — 기준가 조회 실패가 시세 응답을 죽이면 안 된다.
            # None 을 돌려주면 change_pct_source 가 "unavailable" 이 되는데, 그 값은
            # "코퍼스에 그 종목이 없음" 과 "parquet 읽기가 터짐" 을 구분하지 못한다.
            # 후자는 손대야 하는 고장이므로 여기서만 남길 수 있다.
            # 호출부 _baseline_for 가 (code, today) 로 결과를 캐시하고 파일 시그니처가
            # 바뀔 때만 비우므로, 이 로그는 파일 세대당 종목 1회로 묶인다(폭주 없음).
            log.warning("adjusted-daily baseline read failed for %s", code, exc_info=True)
            return None
        if row is None:
            return None
        return _Baseline(date=str(row[0]), close=int(round(float(row[1]))))

    def _adjusted_change_pct(self, q: Quote, baseline: _Baseline | None) -> float | None:
        if baseline is None or baseline.close <= 0 or q.price <= 0:
            return None
        return round((q.price / baseline.close - 1.0) * 100.0, 2)

    def _valid_previous_close(self, q: Quote) -> int | None:
        if q.previous_close is None or q.previous_close <= 0 or q.price <= 0:
            return None
        return q.previous_close

    def _baseline_scale_mismatch(self, q: Quote, baseline: _Baseline) -> bool:
        quote_prices = [
            value for value in (q.price, q.open, q.high, q.low)
            if value is not None and value > 0
        ]
        if not quote_prices or baseline.close <= 0:
            return False
        quote_min = min(quote_prices)
        quote_max = max(quote_prices)
        return (
            baseline.close * _BASELINE_SCALE_MISMATCH_RATIO < quote_min
            or baseline.close / _BASELINE_SCALE_MISMATCH_RATIO > quote_max
        )

    def _baseline_stale_for_today(self, baseline: _Baseline, today: dt.date | None) -> bool:
        if today is None:
            return False
        try:
            baseline_date = dt.date.fromisoformat(baseline.date)
        except ValueError:
            return True
        age_days = (today - baseline_date).days
        if age_days < 1:
            return True
        return age_days > _max_expected_baseline_age_days(today)


def _max_expected_baseline_age_days(today: dt.date) -> int:
    if today.weekday() == 6:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        return 2
    if today.weekday() == 0:
        return 3
    return 1
