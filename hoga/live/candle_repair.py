"""KIS 분봉으로 /study 저장뷰 구간의 hogaplay 캡처 공백을 영구 복구.

배경. /study 캔들은 hogaplay 캡처 parquet(ADR-0037)에서 합성한다. hogaplay
업스트림 장애로 특정 거래일이 통째로 비면 그날 캔들이 렌더되지 않는다(빈 응답,
정상 경로). 이 모듈은 저장뷰가 실제로 걸친 구간에 한해, 빈 거래일을 KIS 과거
분봉으로 한 번 가져와 디스크에 박제한다.

설계 — 기존 소스 우선순위 사다리 재사용.
    ``resolve_source_result``(:mod:`hoga.api.sources`)는 ``hogaplay_first`` 정책을
    ``hogaplay → kis_live → kis_api`` 순으로 이미 해석한다. 복구본을
    ``parquet/<date>/<code>/kis_api/candles.parquet``(+ ``meta.json``)으로 쓰면
    ``/api/range``의 캔들 슬라이스가 **읽기 경로 변경 없이** 자동으로 서빙한다 —
    hogaplay가 있으면 hogaplay가 이기고, 없는 날만 kis_api가 이긴다. hogaplay가
    나중에 재캡처되면 정본이 다시 승리하므로 provenance 복원도 공짜다.

경계.
    - ADR-0040 불변식("kis_live 승격은 candles.parquet을 절대 쓰지 않는다")은
      *kis_live* 한정이다. kis_api 네임스페이스에 캔들을 쓰는 것은 위반이 아니다.
    - ADR-0095("KIS 과거 분봉 캐시는 memory-only")가 거부한 것은 *라이브 스크롤백
      캐시*다. 이 모듈은 캡처 공백의 *정본 복구*라 목적이 다르다 — 저장뷰가 실제로
      가리키는 구간만, 1회, 영구 저장한다.
    - hogaplay가 부분(SOURCE_PARTIAL)으로라도 존재하는 날은 hogaplay가 계속
      이긴다. 부분일 병합은 비목표.

게이트. ``kis_rest_bypass_enabled``(ADR-0083) ON이면 스킵한다. KIS fetch가
불가(자격증명 없음)하면 스킵한다. (code, date) 단위 in-flight 집합으로 저장 훅과
CLI 스윕의 중복 실행을 막는다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from hoga.api._atomic_write import atomic_write_json
from hoga.api.calendar import is_trading_day
from hoga.api.disk_state import DiskState
from hoga.api.queries import QueryEngine
from hoga.api.sources import resolve_source_result
from hoga.api.timeenc import KST, unix_ms_to_ms_from_midnight
from hoga.live import kis_access
from hoga.live.kis_models import KisCandle
from hoga.tables import candles as candles_tbl
from hoga.tables.candles import Candle

if TYPE_CHECKING:
    from hoga.api.models import StudyViewReference

log = logging.getLogger(__name__)

# (code, date_yyyymmdd) -> 그 KST 거래일의 분봉. 빈 리스트 = 데이터 없음(만료/미보유).
# 앱은 KIS 클라이언트로, 테스트는 canned 응답으로 주입한다.
MinuteFetch = Callable[[str, str], Awaitable[list[KisCandle]]]

# meta.json ``created_from`` 마커 — 복구본 kis_api Stock-Date를 식별한다.
# /api/range가 이 값을 읽어 프론트에 "KIS 보충 캔들" 배지를 띄운다.
REPAIR_MARKER = "kis_minute_repair"

_SOURCE_PREF = "hogaplay_first"

# 동시 복구 방지 — 저장 훅과 CLI 스윕이 같은 (code, date)를 겹쳐 잡지 않도록.
_inflight: set[tuple[str, str]] = set()
_inflight_lock = asyncio.Lock()


@dataclass(slots=True)
class RepairSummary:
    """한 저장뷰(또는 한 스윕 항목) 복구 결과 집계."""

    code: str
    from_date: str
    to_date: str
    repaired: list[str] = field(default_factory=list)   # 새로 복구한 거래일
    skipped: list[str] = field(default_factory=list)     # 이미 캔들 있음(멱등 스킵)
    unavailable: list[str] = field(default_factory=list)  # KIS 빈 응답(만료 등) → 미기록
    errors: list[str] = field(default_factory=list)       # fetch/쓰기 실패

    def as_log_fields(self) -> dict[str, object]:
        return {
            "code": self.code,
            "range": f"{self.from_date}-{self.to_date}",
            "repaired": len(self.repaired),
            "skipped": len(self.skipped),
            "unavailable": len(self.unavailable),
            "errors": len(self.errors),
        }


def _today_kst_yyyymmdd() -> str:
    return datetime.now(KST).strftime("%Y%m%d")


def _trading_days_in_range(from_date: str, to_date: str, *, today_kst: str) -> list[str]:
    """[from_date, to_date] 안의 과거 거래일(YYYYMMDD)만 오름차순으로.

    오늘 및 미래는 제외한다 — 오늘 공백은 진행 중인 캡처의 정상 상태이고, KIS
    과거 분봉은 완료된 세션에만 의미가 있다. ``is_trading_day``가 None(캘린더
    미가용)이면 그 날은 건너뛴다 — 거래일을 확신할 수 없을 때 KIS 예산을
    낭비하지 않는다(다음 복구 시도가 캘린더 복구 후 재평가).
    """
    out: list[str] = []
    cur = datetime.strptime(from_date, "%Y%m%d")
    end = datetime.strptime(to_date, "%Y%m%d")
    while cur <= end:
        date_s = cur.strftime("%Y%m%d")
        if date_s < today_kst and is_trading_day(date_s) is True:
            out.append(date_s)
        cur += timedelta(days=1)
    return out


def _has_served_candles(engine: QueryEngine, code: str, date_s: str) -> bool:
    """서빙 로직이 이 (code, date)에 캔들을 내는가 — 공백 판정의 SSOT.

    ``build_candles_slice``와 동일하게 ``hogaplay_first``로 승리 소스를 정하고 그
    ``candles.parquet``을 읽는다. 순환 import(live → api.bundle → live)를 피하려
    bundle을 import하지 않고 같은 결과를 재현한다. 승리 소스가 INVALID면 서빙이
    그날을 제외하므로 여기서도 공백으로 본다. 이미 복구된 날(kis_api 승리, 캔들
    존재)은 자연히 non-empty가 되어 멱등 스킵된다."""
    res = resolve_source_result(engine, date_s, code, _SOURCE_PREF)
    if res.path is None or res.classification is None:
        return False
    if res.classification.state == DiskState.INVALID:
        return False
    candles_path = res.path / "candles.parquet"
    if not candles_path.exists():
        return False
    return len(candles_tbl.query_all(engine.conn, path=candles_path)) > 0


def _kis_candle_to_row(c: KisCandle, date_s: str) -> Candle:
    """KIS 분봉(t_ms=Unix epoch ms)을 candles.parquet 스키마로.

    ts_ms는 자정 기준 ms(KST). vol_a=거래량, vol_b=0 — 스크리너 일봉 갭필이 쓰는
    관례와 동일(단일 거래량 채널을 vol_a에 싣는다)."""
    return Candle(
        ts_ms=unix_ms_to_ms_from_midnight(date_s, c.t_ms),
        open_=c.open,
        close_=c.close,
        high=c.high,
        low=c.low,
        vol_a=c.volume,
        vol_b=0,
    )


def _repair_meta(code: str, date_s: str, row_count: int) -> dict:
    """복구본 kis_api Stock-Date의 meta.json.

    KRX 정규장 경계(09:00–15:30)로 세팅 — invariant(open/close KST 범위,
    close>open)를 통과하고 ``classify_from_meta``가 SOURCE_PARTIAL(healthy)로
    분류하게 한다. ``created_from``이 이 파티션을 복구본으로 표식한다."""
    return {
        "source": "kis_api",
        "code": code,
        "date": date_s,
        "created_from": REPAIR_MARKER,
        "collection_complete": True,
        "is_partial": True,
        "row_counts": {"candles": row_count},
        "regular_session_open_ms": 90000000,    # 09:00:00.000 (ADR-0003 인코딩)
        "regular_session_close_ms": 153000000,  # 15:30:00.000
        "repaired_at": datetime.now(UTC).isoformat(),
    }


def _write_repair(data_dir: Path, code: str, date_s: str, rows: list[Candle]) -> None:
    """kis_api/candles.parquet 기록 + meta.json 생성(없을 때만).

    기존 meta는 절대 덮어쓰지 않는다 — rest30 승격이 만든 kis_api meta가 있는
    날이면 그 스냅샷 지표와 복구 캔들이 공존한다(캔들만 추가)."""
    target = data_dir / "parquet" / date_s / code / "kis_api"
    target.mkdir(parents=True, exist_ok=True)
    candles_tbl.write_parquet(rows, target / "candles.parquet")
    meta_path = target / "meta.json"
    if not meta_path.exists():
        atomic_write_json(meta_path, _repair_meta(code, date_s, len(rows)))


async def _repair_one_date(
    engine: QueryEngine,
    data_dir: Path,
    *,
    code: str,
    date_s: str,
    fetch: MinuteFetch,
    summary: RepairSummary,
) -> None:
    key = (code, date_s)
    async with _inflight_lock:
        if key in _inflight:
            summary.skipped.append(date_s)
            return
        _inflight.add(key)
    try:
        if _has_served_candles(engine, code, date_s):
            summary.skipped.append(date_s)
            return
        try:
            candles = await fetch(code, date_s)
        except Exception:
            log.exception("candle_repair fetch failed code=%s date=%s", code, date_s)
            summary.errors.append(date_s)
            return
        if not candles:
            # KIS 빈 응답 — 1년 보존 초과(만료) 또는 미보유. 빈 parquet은 쓰지
            # 않는다(추후 재시도 여지를 남긴다).
            summary.unavailable.append(date_s)
            return
        rows = [_kis_candle_to_row(c, date_s) for c in candles]
        try:
            await asyncio.to_thread(_write_repair, data_dir, code, date_s, rows)
        except OSError:
            log.exception("candle_repair write failed code=%s date=%s", code, date_s)
            summary.errors.append(date_s)
            return
        summary.repaired.append(date_s)
    finally:
        async with _inflight_lock:
            _inflight.discard(key)


def scan_saved_view_gaps(
    engine: QueryEngine,
    *,
    code: str,
    from_date: str,
    to_date: str,
    today_kst: str | None = None,
) -> list[str]:
    """구간의 과거 거래일 중 캔들이 서빙되지 않는 날(공백) 목록 — KIS 미접근.

    ``--dry-run`` 리포트용. 복구가 KIS로 실제 메울 대상을 fetch 없이 미리 보여준다
    (단, 1년 보존 만료로 실제론 못 메울 수도 있음은 fetch 시점에 판명)."""
    today = today_kst or _today_kst_yyyymmdd()
    return [
        date_s
        for date_s in _trading_days_in_range(from_date, to_date, today_kst=today)
        if not _has_served_candles(engine, code, date_s)
    ]


async def repair_saved_view_range(
    engine: QueryEngine,
    data_dir: Path,
    *,
    code: str,
    from_date: str,
    to_date: str,
    fetch: MinuteFetch | None,
    today_kst: str | None = None,
) -> RepairSummary | None:
    """저장뷰 구간 [from_date, to_date]의 캡처 공백을 KIS 분봉으로 복구.

    반환 None = 게이트에 막혀 아무것도 하지 않음(bypass ON 또는 fetch 없음).
    그 외엔 :class:`RepairSummary`. 날짜는 순차 처리한다 — 저빈도 백그라운드
    작업이라 KIS를 몰아치지 않는다."""
    if kis_access.kis_rest_bypass_enabled(data_dir):
        log.info("candle_repair skipped (kis_rest_bypass enabled) code=%s", code)
        return None
    if fetch is None:
        log.info("candle_repair skipped (no KIS fetch available) code=%s", code)
        return None

    today = today_kst or _today_kst_yyyymmdd()
    summary = RepairSummary(code=code, from_date=from_date, to_date=to_date)
    for date_s in _trading_days_in_range(from_date, to_date, today_kst=today):
        await _repair_one_date(
            engine, data_dir, code=code, date_s=date_s, fetch=fetch, summary=summary,
        )
    if summary.repaired or summary.errors:
        log.info("candle_repair done %s", summary.as_log_fields())
    return summary


def build_saved_view_repair_hook(
    engine: QueryEngine, data_dir: Path, fetch: MinuteFetch | None,
) -> Callable[[StudyViewReference], None]:
    """저장뷰 저장 훅 — 실행 중인 이벤트 루프에 복구를 fire-and-forget 예약.

    저장 응답을 블로킹하지 않는다(KIS fetch가 일당 최대 ~2초). ``fetch``가 None
    (KIS 오프라인)이면 ``repair_saved_view_range``가 게이트에서 즉시 반환하므로
    훅은 붙여둬도 무해하다."""
    def _hook(save: StudyViewReference) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 실행 중 루프 없음(예: 동기 컨텍스트) — 예약 불가, 로깅만.
            log.warning("candle_repair hook: no running loop; skipped id=%s", save.id)
            return
        loop.create_task(
            repair_saved_view_range(
                engine,
                data_dir,
                code=save.code,
                from_date=save.range.from_date,
                to_date=save.range.to_date,
                fetch=fetch,
            )
        )

    return _hook
