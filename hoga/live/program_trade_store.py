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
from collections.abc import Mapping
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from hoga.util.atomic_write import atomic_write_json
from hoga.util.mtime_cache import MtimeLruCache
from hoga.util.timeenc import KST, hhmmssms_to_unix_ms

log = logging.getLogger(__name__)

#: 2 = venue 축 도입(경로 `{code}/{venue}/{date}.json` + `venue` 필드). 스탬프일 뿐
#: 무효화에 쓰이지 않는다 — 읽기는 버전을 보지 않고 레거시(v1) 파일을 그대로 받는다.
SCHEMA_VERSION = 2
SOURCE = "kis_program_trade"  # 동결 — 모듈 docstring 참조

#: venue 축 이전(v1) 파일이 담고 있던 시장. collector 가 KRX 태그만 병합했으므로
#: 레거시 파일은 **정의상 전부 KRX** 다 — 폴백을 이 venue 에만 여는 근거다.
LEGACY_VENUE = "KRX"

# 갭 판정 최소 시간 점프(폴 주기 배수). 0w drain 은 30초마다 새 행 1개짜리 배치를
# 만들므로 "이전 최신 행이 새 배치에 없음"은 정상 상태다 — 시각이 폴 주기를 이만큼
# 초과해 점프했을 때만 실제 수집 공백으로 본다(30초 주기 기준 임계 90초 = 2사이클
# 이상 연속 누락). 읽기 경로(bundle)도 같은 술어로 과거 오염 이벤트를 걸러낸다.
GAP_MIN_JUMP_INTERVALS = 3


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
_LOAD_CACHE: MtimeLruCache[ProgramTradeDayFile] = MtimeLruCache(max_entries=512)


class ProgramTradeStoredRow(ProgramTradeByStockRow):
    date: str
    observed_at_ms: int


class ProgramTradeDayFile(BaseModel):
    schema_version: int = SCHEMA_VERSION
    source: str = SOURCE
    code: str
    date: str
    #: 이 파일이 담은 시장. **모델 기본값은 레거시 파일 해석용**이다 — v1 파일엔 이
    #: 키가 없고 그 내용은 전부 KRX 였다. 저장소 API(`path`·`load`·`merge_response`)
    #: 쪽 인자에는 기본값을 두지 않는다: 거기서의 기본값은 곧 두 시장이 한 파일에
    #: 섞이는 경로다(JSONL writer 가 venue 를 필수로 둔 것과 같은 이유, ADR-0140 §3).
    venue: str = LEGACY_VENUE
    poll_interval_ms: int = 30_000
    rows: list[ProgramTradeStoredRow] = Field(default_factory=list)
    gap_events: list[dict[str, int | str]] = Field(default_factory=list)
    anomaly_events: list[dict[str, int | str]] = Field(default_factory=list)
    updated_at_ms: int | None = None


class ProgramTradeStore:
    def __init__(self, data_dir: Path, *, poll_interval_ms: int = 30_000):
        self._data_dir = data_dir
        self._poll_interval_ms = poll_interval_ms

    def path(self, code: str, date: str, venue: str) -> Path:
        """쓰기 경로 — venue 축이 들어간 자리. **기본값 없음**이 요점이다(ADR-0140 §3).

        `{code}/{venue}/{date}.json` 순서인 이유: 레거시가 `{code}/{date}.json` 이라
        code 아래에 축을 끼우는 것이 변경이 가장 작고, 종목 단위로 도는 소비자가
        디렉터리 구조를 그대로 쓴다.
        """
        return self._data_dir / "kis-program-trade" / code / venue / f"{date}.json"

    def _legacy_path(self, code: str, date: str) -> Path:
        """venue 축 이전(v1) 경로. **읽기 전용** — 쓰기는 언제나 새 경로로 간다."""
        return self._data_dir / "kis-program-trade" / code / f"{date}.json"

    def read_path(self, code: str, date: str, venue: str) -> Path:
        """실제로 읽을 파일 — 새 경로 우선, 없으면 KRX 에 한해 레거시.

        레거시를 KRX 에만 여는 근거는 `LEGACY_VENUE` 주석 참조(그 파일들은 정의상
        KRX 뿐이라, NXT·통합으로 읽으면 다른 시장의 값을 그 시장 것으로 답하게 된다).

        쓰기는 폴백하지 않으므로 KRX 당일 파일은 **첫 병합에서 새 경로로 옮겨 앉는다**
        — 레거시를 읽어 새 경로에 통째로 쓰는 셈이라 별도 마이그레이션이 필요 없고,
        과거일은 레거시에 남은 채로 계속 읽힌다.
        """
        path = self.path(code, date, venue)
        if path.exists():
            return path
        if venue == LEGACY_VENUE:
            legacy = self._legacy_path(code, date)
            if legacy.exists():
                return legacy
        return path

    def load(self, code: str, date: str, venue: str) -> ProgramTradeDayFile:
        path = self.read_path(code, date, venue)
        if not path.exists():
            return ProgramTradeDayFile(
                code=code,
                date=date,
                venue=venue,
                poll_interval_ms=self._poll_interval_ms,
            )
        try:
            loaded = ProgramTradeDayFile.model_validate(
                json.loads(path.read_text(encoding="utf-8"))
            )
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
                venue=venue,
                poll_interval_ms=self._poll_interval_ms,
            )
        # 레거시 파일은 `venue` 키가 없어 모델 기본값(KRX)이 들어온다. 요청 venue 로
        # 덮어써 **쓰기 경로가 읽은 자리와 갈리지 않게** 한다 — 안 하면 v1 을 읽은
        # 뒤의 `_write` 가 파일 안 값(KRX)을 따라가 요청 venue 와 어긋날 수 있다.
        return loaded.model_copy(update={"venue": venue})

    def load_cached(self, code: str, date: str, venue: str) -> ProgramTradeDayFile:
        """읽기 전용 소비자용 mtime 검증 캐시 load. 절대 쓰기 경로에서 쓰지 말 것 —
        캐시가 stale write 를 막지 못한다(merge_response 는 uncached load() 사용).
        반환 모델은 참조 공유이므로 소비자는 변형하지 말 것.

        캐시 키는 **실제로 읽을 경로**다(`read_path`) — 새 경로 키로 캐시하면 레거시를
        읽고도 존재하지 않는 파일의 mtime 을 검증하게 돼 무효화가 성립하지 않는다.
        """
        path = self.read_path(code, date, venue)
        return _LOAD_CACHE.get_or_load(path, lambda _p: self.load(code, date, venue))

    def merge_response(
        self,
        *,
        code: str,
        date: str,
        venue: str,
        rows: list[ProgramTradeByStockRow],
        observed_at_ms: int,
    ) -> ProgramTradeDayFile:
        current = self.load(code, date, venue)
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
                    venue=venue,
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
            event: dict[str, int | str] = {
                "previous_latest": previous_latest,
                "new_oldest": new_oldest,
                "new_newest": new_newest,
                "observed_at_ms": observed_at_ms,
            }
            if is_significant_gap_event(event, poll_interval_ms=self._poll_interval_ms):
                current.gap_events.append(event)

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
        # 언제나 **새 경로**다 — 레거시를 읽어 왔더라도 그쪽에 되쓰지 않는다.
        atomic_write_json(self.path(day.code, day.date, day.venue), day.model_dump())

    def _quarantine(self, day: ProgramTradeDayFile) -> None:
        # 격리 대상은 방금 읽은 파일이므로 레거시일 수 있다 — `read_path` 로 잡는다.
        path = self.read_path(day.code, day.date, day.venue)
        if not path.exists():
            return
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = path.with_name(f"{path.name}.poisoned-{stamp}")
        try:
            path.rename(backup)
        except OSError:
            log.exception("could not quarantine poisoned program-trade file path=%s", path)


def is_significant_gap_event(event: Mapping[str, int | str], *, poll_interval_ms: int) -> bool:
    """gap 이벤트가 실제 수집 공백인지 — 시간 점프가 폴 주기의 GAP_MIN_JUMP_INTERVALS
    배를 초과할 때만 참. 쓰기(merge_response)와 읽기(bundle) 양쪽이 같은 술어를 쓰므로
    임계 이하 간격으로 이미 쌓인 과거 오염 이벤트도 읽기에서 걸러진다. 시각을 파싱할
    수 없는 이벤트는 보수적으로 갭으로 유지한다."""
    previous = _hhmmss_to_ms(event.get("previous_latest"))
    new_oldest = _hhmmss_to_ms(event.get("new_oldest"))
    if previous is None or new_oldest is None:
        return True
    return new_oldest - previous > GAP_MIN_JUMP_INTERVALS * poll_interval_ms


def _hhmmss_to_ms(value: int | str | None) -> int | None:
    text = str(value or "")
    if len(text) != 6 or not text.isdigit():  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        return None
    return (int(text[:2]) * 3600 + int(text[2:4]) * 60 + int(text[4:6])) * 1000


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
