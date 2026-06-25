"""Disk sidecar for KIS stock-level program-trade rows."""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.api._atomic_write import atomic_write_json
from hoga.live.kis_models import ProgramTradeByStockRow

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
SOURCE = "kis_program_trade"


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


def _row_time_ms(*, date: str, bsop_hour: str, t_ms: int) -> int:
    if t_ms > 0:
        return t_ms
    return hhmmssms_to_unix_ms(date, int(bsop_hour) * 1000)
