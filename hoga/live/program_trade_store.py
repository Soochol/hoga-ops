"""Disk sidecar for stock-level program-trade rows (종목프로그램매매).

공급원은 키움 0w push(PR-F4 컷오버)다 — 원래 KIS REST(FHPPG04650101) 폴링이라
SOURCE/디스크 경로에 "kis" 가 남아 있지만, 이 둘은 저장 데이터·wire
(api/models.py ProgramTradeSeries.source Literal)와의 호환용 **동결 식별자**라
바꾸지 않는다(변경 = 데이터 마이그레이션 + 프론트 계약 범프).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from hoga.api.timeenc import KST, hhmmssms_to_unix_ms
from hoga.api._atomic_write import atomic_write_json
from hoga.util.mtime_cache import MtimeLruCache

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
SOURCE = "kis_program_trade"  # 동결 — 모듈 docstring 참조


class ProgramTradeByStockRow(BaseModel):
    """One stock-level program-trade row — 프로그램 사이드카의 wire/디스크 행.

    키움 0w latch 를 collector 가 30초 drain 해 만든다(과거엔 KIS REST 응답 행,
    PR-F4 로 공급원 교체 — shape 은 그대로라 저장·소비 무변경). `bsop_hour`는
    intraday HHMMSS 병합 키(0w 는 시각 FID 가 없어 수신 시각으로 합성). 누적
    net-buy 수량·금액이라 rolling 창이 중간 행을 건너뛰어도 각 관측점이 독립적
    으로 유의미하다. 금액은 원 단위(0w 백만원은 파서가 ×1e6 정규화).
    """

    code: str
    bsop_hour: str
    t_ms: int
    price: int | None
    net_qty: int | None
    net_amount: int | None
    buy_qty: int | None
    sell_qty: int | None
    buy_amount: int | None
    sell_amount: int | None
    delta_qty: int | None
    delta_amount: int | None


# 읽기 전용 소비자(build_program_trade_series)용 프로세스-전역 mtime 캐시. 범위 번들이
# today 포함으로 주기적 refetch 될 때 과거 전 날짜 JSON 을 매번 재파싱하던 것을, 파일이
# 안 바뀐 과거일은 파싱 결과를 재사용해 제거한다. today 는 캡처 write(atomic)가 mtime 을
# 바꿔 자연 무효화. 쓰기 경로(merge_response)는 반드시 uncached load()를 써야 한다.
_LOAD_CACHE: "MtimeLruCache[ProgramTradeDayFile]" = MtimeLruCache(max_entries=512)


class ProgramTradeStoredRow(ProgramTradeByStockRow):
    date: str
    observed_at_ms: int


class ProgramTradeDayFile(BaseModel):
    schema_version: int = SCHEMA_VERSION
    source: str = SOURCE
    code: str
    date: str
    poll_interval_ms: int = 30_000
    rows: list[ProgramTradeStoredRow] = Field(default_factory=list)
    gap_events: list[dict[str, int | str]] = Field(default_factory=list)
    anomaly_events: list[dict[str, int | str]] = Field(default_factory=list)
    updated_at_ms: int | None = None


class ProgramTradeStore:
    def __init__(self, data_dir: Path, *, poll_interval_ms: int = 30_000):
        self._data_dir = data_dir
        self._poll_interval_ms = poll_interval_ms

    def path(self, code: str, date: str) -> Path:
        return self._data_dir / "kis-program-trade" / code / f"{date}.json"

    def load(self, code: str, date: str) -> ProgramTradeDayFile:
        path = self.path(code, date)
        if not path.exists():
            return ProgramTradeDayFile(
                code=code,
                date=date,
                poll_interval_ms=self._poll_interval_ms,
            )
        try:
            return ProgramTradeDayFile.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, ValidationError) as e:
            stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
            backup = path.with_name(f"{path.name}.corrupt-{stamp}")
            try:
                path.rename(backup)
            except OSError:
                log.exception("could not back up corrupt program-trade file path=%s", path)
            log.warning("program_trade_store.corrupt path=%s error=%s", path, e)
            return ProgramTradeDayFile(
                code=code,
                date=date,
                poll_interval_ms=self._poll_interval_ms,
            )

    def load_cached(self, code: str, date: str) -> ProgramTradeDayFile:
        """읽기 전용 소비자용 mtime 검증 캐시 load. 절대 쓰기 경로에서 쓰지 말 것 —
        캐시가 stale write 를 막지 못한다(merge_response 는 uncached load() 사용).
        반환 모델은 참조 공유이므로 소비자는 변형하지 말 것."""
        path = self.path(code, date)
        return _LOAD_CACHE.get_or_load(path, lambda _p: self.load(code, date))

    def merge_response(
        self,
        *,
        code: str,
        date: str,
        rows: list[ProgramTradeByStockRow],
        observed_at_ms: int,
    ) -> ProgramTradeDayFile:
        current = self.load(code, date)
        incoming = sorted(rows, key=lambda r: r.bsop_hour)
        if not incoming:
            return current

        previous_latest = current.rows[-1].bsop_hour if current.rows else None
        incoming_times = {r.bsop_hour for r in incoming}
        new_oldest = incoming[0].bsop_hour
        new_newest = incoming[-1].bsop_hour

        if previous_latest is not None and previous_latest > new_newest:
            if _is_future_sidecar(
                date=date,
                observed_at_ms=observed_at_ms,
                previous_latest=previous_latest,
                new_newest=new_newest,
            ):
                self._quarantine(current)
                current = ProgramTradeDayFile(
                    code=code,
                    date=date,
                    poll_interval_ms=self._poll_interval_ms,
                )
                previous_latest = None
            else:
                current.anomaly_events.append({
                    "kind": "stale_or_out_of_order",
                    "previous_latest": previous_latest,
                    "new_oldest": new_oldest,
                    "new_newest": new_newest,
                    "observed_at_ms": observed_at_ms,
                })
                current.updated_at_ms = observed_at_ms
                self._write(current)
                return current

        if (
            previous_latest is not None
            and previous_latest not in incoming_times
            and previous_latest < new_oldest
        ):
            current.gap_events.append({
                "previous_latest": previous_latest,
                "new_oldest": new_oldest,
                "new_newest": new_newest,
                "observed_at_ms": observed_at_ms,
            })

        by_time = {r.bsop_hour: r for r in current.rows}
        for row in incoming:
            normalized = row.model_copy(
                update={"t_ms": _row_time_ms(date=date, bsop_hour=row.bsop_hour, t_ms=row.t_ms)}
            )
            by_time[row.bsop_hour] = ProgramTradeStoredRow(
                **normalized.model_dump(),
                date=date,
                observed_at_ms=observed_at_ms,
            )
        current.rows = sorted(by_time.values(), key=lambda r: r.bsop_hour)
        current.updated_at_ms = observed_at_ms
        self._write(current)
        return current

    def _write(self, day: ProgramTradeDayFile) -> None:
        atomic_write_json(self.path(day.code, day.date), day.model_dump())

    def _quarantine(self, day: ProgramTradeDayFile) -> None:
        path = self.path(day.code, day.date)
        if not path.exists():
            return
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = path.with_name(f"{path.name}.poisoned-{stamp}")
        try:
            path.rename(backup)
        except OSError:
            log.exception("could not quarantine poisoned program-trade file path=%s", path)


def _row_time_ms(*, date: str, bsop_hour: str, t_ms: int) -> int:
    if t_ms > 0:
        return t_ms
    return hhmmssms_to_unix_ms(date, int(bsop_hour) * 1000)


def _is_future_sidecar(
    *,
    date: str,
    observed_at_ms: int,
    previous_latest: str,
    new_newest: str,
) -> bool:
    observed = dt.datetime.fromtimestamp(observed_at_ms / 1000, tz=KST)
    if observed.strftime("%Y%m%d") != date:
        return False
    observed_hhmmss = f"{observed.hour:02d}{observed.minute:02d}{observed.second:02d}"
    return previous_latest > observed_hhmmss and new_newest <= observed_hhmmss
