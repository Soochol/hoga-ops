"""히트맵 그룹 헤더 "당일 흐름" 시계열 — `/api/heatmap/group-flow`.

각 그룹(폴더)의 당일 흐름 = 버킷(5분)별 **멤버 평균 등락률(%)**. 가격 소스는 장중
연속 기록되는 키움 1분봉 JSONL(``<data_dir>/live_kiwoom/{YYYYMMDD}/{code}.jsonl``,
LiveWriter). 전일종가 기준선은 ``screener/daily_adjusted.parquet``. 즉
``index_sector_rankings`` 의 "한 시점 섹터 평균"을 버킷마다 반복한 시계열 변형이다.

디스크 기반이라 서버 재시작에도 아침 흐름이 자동 보존된다(옵션 B3, ADR 예정). 무거운
파일 읽기(~수백 종목 × JSONL)는 30초 TTL 캐시 뒤에 두고, 이벤트 루프를 막지 않도록
``asyncio.to_thread`` 로 감싼다(라우트에서). 순수 계산부(``build_group_flow``)는
스레드 안전(모듈 전역 미변경).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from hoga.api.heatmap import load_document
from hoga.live.index_sector_rankings import _entry_groups, _load_daily_rows

log = logging.getLogger(__name__)

_KST = ZoneInfo("Asia/Seoul")
BUCKET_MS = 300_000  # 5분
_SESSION_OPEN = dt.time(9, 0)
_SESSION_CLOSE = dt.time(15, 30)


class HeatmapGroupFlow(BaseModel):
    folder_id: str
    folder_name: str
    order: int
    # 버킷 순서(t_base_ms 부터 bucket_ms 간격) 평균 등락률(%). 미도래·무데이터 버킷은 null.
    pct: list[float | None]


class HeatmapGroupFlowResponse(BaseModel):
    date: str          # 거래일(YYYY-MM-DD, KST)
    bucket_ms: int
    t_base_ms: int     # 첫 버킷 시작(정규장 개장) unix ms
    groups: list[HeatmapGroupFlow]


def _kst_ms(basis: dt.date, at: dt.time) -> int:
    return int(dt.datetime.combine(basis, at, _KST).timestamp() * 1000)


def _read_candle_closes(jsonl_path: Path) -> list[tuple[int, float]]:
    """live_kiwoom JSONL 에서 (t_ms, close) 를 시간순으로. 없으면 빈 리스트.
    마지막 줄이 찢겨(torn) JSONDecodeError 나도 그때까지를 반환(관용 파싱)."""
    if not jsonl_path.exists():
        return []
    out: list[tuple[int, float]] = []
    try:
        with jsonl_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    break  # 찢긴 마지막 줄 — 그때까지로 종료
                if obj.get("kind") != "candle":
                    continue
                payload = obj.get("payload") or {}
                close = payload.get("close")
                t_ms = obj.get("t_ms")
                if isinstance(t_ms, int) and isinstance(close, (int, float)) and close > 0:
                    out.append((t_ms, float(close)))
    except OSError:
        log.warning("group-flow: failed reading %s", jsonl_path)
        return []
    out.sort(key=lambda r: r[0])
    return out


def _code_bucket_pct(
    closes: list[tuple[int, float]],
    prev_close: float,
    t_base_ms: int,
    n_buckets: int,
    last_ms: int,
) -> list[float | None]:
    """한 종목의 버킷별 등락률(%). 각 버킷 = 그 끝시각 이하 마지막 체결의 종가를
    carry-forward 해 전일종가 대비. 아직 체결 없는(선행) 버킷·미도래 버킷은 null."""
    out: list[float | None] = [None] * n_buckets
    j = 0
    last_close: float | None = None
    for b in range(n_buckets):
        bucket_end = t_base_ms + (b + 1) * BUCKET_MS
        if bucket_end - BUCKET_MS > last_ms:
            break  # 미도래 버킷 — 이후 전부 null
        while j < len(closes) and closes[j][0] < bucket_end:
            last_close = closes[j][1]
            j += 1
        if last_close is not None:
            out[b] = round((last_close / prev_close - 1.0) * 100.0, 4)
    return out


def build_group_flow(data_dir: Path, basis: dt.date, *, now_ms: int) -> HeatmapGroupFlowResponse:
    """순수 계산(스레드 안전). 무거운 디스크 IO 포함 — 라우트가 to_thread 로 감싼다."""
    doc = load_document(data_dir)
    folder_names = {f.id: f.name for f in doc.folders}
    folder_orders = {f.id: f.order for f in doc.folders}
    groups = _entry_groups(doc.entries, folder_names, folder_orders)

    t_base_ms = _kst_ms(basis, _SESSION_OPEN)
    close_ms = _kst_ms(basis, _SESSION_CLOSE)
    n_buckets = max(1, (close_ms - t_base_ms) // BUCKET_MS)
    last_ms = min(now_ms, close_ms)

    all_codes = [e.code for _, _, _, entries in groups for e in entries]
    daily_path = data_dir / "screener" / "daily_adjusted.parquet"
    rows_by_code = _load_daily_rows(daily_path, all_codes, basis) if daily_path.exists() else {}
    prev_close_of: dict[str, float] = {}
    for code, rows in rows_by_code.items():
        prev = next((r for r in reversed(rows) if r["date"] < basis), None)
        if prev is not None and float(prev["close"]) > 0:
            prev_close_of[code] = float(prev["close"])

    live_root = data_dir / "live_kiwoom" / basis.strftime("%Y%m%d")

    out_groups: list[HeatmapGroupFlow] = []
    for folder_id, folder_name, order, entries in groups:
        # 멤버별 버킷 등락률 → 버킷마다 비결측 평균.
        sums = [0.0] * n_buckets
        counts = [0] * n_buckets
        for e in entries:
            prev_close = prev_close_of.get(e.code)
            if prev_close is None:
                continue
            closes = _read_candle_closes(live_root / f"{e.code}.jsonl")
            if not closes:
                continue
            series = _code_bucket_pct(closes, prev_close, t_base_ms, n_buckets, last_ms)
            for b, v in enumerate(series):
                if v is not None:
                    sums[b] += v
                    counts[b] += 1
        pct: list[float | None] = [
            round(sums[b] / counts[b], 4) if counts[b] > 0 else None for b in range(n_buckets)
        ]
        out_groups.append(HeatmapGroupFlow(
            folder_id=folder_id, folder_name=folder_name, order=order, pct=pct,
        ))

    return HeatmapGroupFlowResponse(
        date=basis.isoformat(), bucket_ms=BUCKET_MS, t_base_ms=t_base_ms, groups=out_groups,
    )
