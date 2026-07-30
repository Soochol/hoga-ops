"""히트맵 그룹 헤더 "당일 흐름" 시계열 — `/api/heatmap/group-flow`.

각 그룹(폴더)의 당일 흐름 = 버킷(5분)별 **멤버 평균 등락률(%)**. 가격 소스는 장중
연속 기록되는 키움 1분봉 JSONL(``<data_dir>/live_kiwoom/{YYYYMMDD}/{code}.jsonl``,
LiveWriter). 전일종가 기준선은 ``screener/daily_adjusted.parquet``. 즉
``index_sector_rankings`` 의 "한 시점 섹터 평균"을 버킷마다 반복한 시계열 변형이다.

디스크 기반이라 서버 재시작에도 아침 흐름이 자동 보존된다(옵션 B3, ADR 예정). 이벤트
루프를 막지 않도록 ``asyncio.to_thread`` 로 감싼다(라우트에서).

**JSONL 은 tail-append 증분으로 읽는다**(2026-07-30). 이전에는 폴링마다 당일 JSONL 을
**처음부터 전량** 재파싱했다 — 실측 243파일 947MB, candle 선별 후에도 2.52초. 그 비용은
장중 단조 증가한다(파일이 15:30까지 자라므로 09:05 엔 ~0, 15:25 엔 최대). 라우트의
버스트 합치기 창(30초)은 프론트 폴링 주기(60초)보다 짧아 **단일 클라이언트에서는 절대
히트하지 않으므로** 완화 장치가 되지 못했다. 이제 코드별로 (소비한 바이트 오프셋,
누적 closes)를 들고 있다가 새로 붙은 꼬리만 파싱한다 — 60초 증분이면 947MB 대신
수십 MB 다.

증분의 두 불변식:

1. **개행으로 끝나지 않은 꼬리는 소비하지 않는다.** 쓰기 도중의 부분 라인을 오프셋
   너머로 넘기면 그 줄은 영구히 유실된다(``live/promote.py`` 의 ``_JsonlParseState``
   와 같은 규율).
2. **파일이 줄어들면 전량 재파싱으로 복귀한다.** 승격·회전·수동 삭제로 교체된 파일에
   옛 오프셋을 적용하면 엉뚱한 바이트를 라인으로 읽는다.

캐시가 모듈 전역이므로 ``build_group_flow`` 는 더 이상 "모듈 전역 미변경" 이 아니다 —
동시 호출(라우트의 to_thread × 여러 요청)을 락으로 직렬화한다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from collections import OrderedDict
from pathlib import Path
from threading import Lock
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


# json.loads 앞에 두는 저비용 선별자. **의도적으로 느슨하다** — kind 필드가
# 아닌 곳에 이 문자열이 있어도 통과시킨다. 정확한 판정은 아래 obj.get("kind")
# 가 그대로 쥐고 있으므로, 이 검사는 과다수용(조금 느려짐)은 가능해도
# 과소수용(candle 을 놓침)은 불가능하다.
#
# `'"kind": "candle"'` 처럼 공백까지 맞추면 더 빠르지만, LiveSnapshot.to_jsonl
# (hoga/live/snapshot.py) 이 json.dumps 기본 separators 에 의존하므로 그쪽이
# 바뀌는 순간 이 필터가 조용히 0건을 반환한다. 그 실패는 예외 없이 "빈 그래프"
# 로만 나타나 원인 추적이 어렵다 — 속도보다 그 실패 모드를 피하는 쪽을 택했다.
_CANDLE_HINT = '"candle"'


_CANDLE_HINT_B = _CANDLE_HINT.encode("utf-8")

# 코드별 증분 상태 상한. 히트맵 멤버(실측 235) × 최근 2거래일이면 넉넉하다.
_TAIL_CACHE_MAX = 512
_tail_lock = Lock()
# path 문자열 → (소비한 바이트 오프셋, 누적 closes)
_tail_cache: OrderedDict[str, tuple[int, list[tuple[int, float]]]] = OrderedDict()


def reset_tail_cache_for_tests() -> None:
    """증분 상태를 비운다 — 같은 tmp_path 를 재사용하는 테스트용."""
    with _tail_lock:
        _tail_cache.clear()


def _parse_candle_lines(chunk: bytes) -> list[tuple[int, float]]:
    """완결된 라인들에서 (t_ms, close) 추출. ``chunk`` 는 개행으로 끝나야 한다."""
    out: list[tuple[int, float]] = []
    for raw in chunk.split(b"\n"):
        # 이 파일의 kind 는 ob/fill/broker/trade/candle 이 섞여 있고 candle 은
        # 실측 약 4% 다(2026-07-29, 243파일 947MB). 나머지 96% 를 json.loads
        # 로 만들었다가 버리는 것이 이 함수 비용의 대부분이었다. 버려지는
        # ob(10호가 × 6필드) 줄이 candle 줄보다 훨씬 길어 낭비되는 바이트
        # 비중은 줄 비중보다 더 크다.
        if _CANDLE_HINT_B not in raw:
            continue
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            # 완결 라인만 넘겨받으므로 여기 오는 것은 실제로 깨진 줄이다 —
            # 건너뛴다(구 구현의 `break` 는 뒤에 남은 정상 줄까지 버렸다).
            continue
        if obj.get("kind") != "candle":
            continue
        payload = obj.get("payload") or {}
        close = payload.get("close")
        t_ms = obj.get("t_ms")
        if isinstance(t_ms, int) and isinstance(close, (int, float)) and close > 0:
            out.append((t_ms, float(close)))
    return out


def _read_candle_closes(jsonl_path: Path) -> list[tuple[int, float]]:
    """live_kiwoom JSONL 에서 (t_ms, close) 를 시간순으로. 없으면 빈 리스트.

    tail-append 증분: 이전 호출이 소비한 오프셋 이후만 읽는다(근거는 모듈 docstring).
    바이너리로 읽는 이유는 오프셋이 **바이트** 여야 정확해서다 — 텍스트 모드에서
    `len(str)` 은 비ASCII(거래원 한글명 등)에서 바이트 수와 다르다.
    """
    key = str(jsonl_path)
    try:
        size = jsonl_path.stat().st_size
    except OSError:
        # 부재(아직 안 생김 · 승격 후 삭제) — 상태도 버린다.
        with _tail_lock:
            _tail_cache.pop(key, None)
        return []

    with _tail_lock:
        cached = _tail_cache.get(key)
    offset, closes = cached if cached is not None else (0, [])
    if cached is not None and size == offset:
        return closes                      # 새로 붙은 바이트 없음 — 읽지 않는다
    if size < offset:
        offset, closes = 0, []             # 파일 교체 — 전량 재파싱으로 복귀

    try:
        with jsonl_path.open("rb") as fh:
            fh.seek(offset)
            raw = fh.read()
    except OSError:
        log.warning("group-flow: failed reading %s", jsonl_path)
        return closes

    cut = raw.rfind(b"\n")
    if cut < 0:
        # 완결 라인이 아직 없다 — 오프셋을 전진시키지 않는다(부분 라인 보존).
        return closes
    chunk = raw[: cut + 1]
    merged = [*closes, *_parse_candle_lines(chunk)]
    merged.sort(key=lambda r: r[0])
    new_offset = offset + len(chunk)

    with _tail_lock:
        _tail_cache[key] = (new_offset, merged)
        _tail_cache.move_to_end(key)
        while len(_tail_cache) > _TAIL_CACHE_MAX:
            _tail_cache.popitem(last=False)
    return merged


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
