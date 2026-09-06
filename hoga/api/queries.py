"""Cross-table query coordinator. Per-table queries live in ``hoga/tables/``."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import duckdb

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.eligibility import is_terminal_partial
from hoga.api.invariants import indicator_session_bounds, normalize_session_bounds
from hoga.api.models import StockDate, StockDateVenue
from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.api.sources import resolve_source_result
from hoga.collector.orchestrator import now_kst
from hoga.duck import connect_bounded
from hoga.live.venue import Venue
from hoga.tables import snapshots
from hoga.tables.trade_binning import TradeBinningCache
from hoga.util.timeenc import hhmmssms_to_unix_ms


def _is_non_trading_day(date_yyyymmdd: str) -> bool:
    """비거래일(주말/휴장) 여부 — 서빙 인벤토리에서 유령 파티션 배제(defense-in-depth).

    주말은 순수 날짜연산으로 **확실히** 배제한다(캘린더 다운 시에도 동작). 휴장은
    캘린더가 **확정 False**일 때만 배제 — ``is_trading_day``가 None(KIS 미가용)/판정불가면
    관대하게 서빙한다(정상 데이터를 캘린더 flake로 드롭하지 않음, 캡처 게이트의 lenient
    정책과 일관). 파싱 불가 형식도 보류(기존 인벤토리 동작 보존).

    유령의 원천 차단은 캡처측 rest30 거래일 게이트다. 이 함수는 이미 디스크에 존재하는
    비거래일 파티션이 사이드카 지표로 서빙되는 것을 막는 2차 안전망이다.
    """
    try:
        if datetime.strptime(date_yyyymmdd, "%Y%m%d").weekday() >= 5:  # 토/일  # noqa: PLR2004 — 국소 비교 상수
            return True
    except ValueError:
        return False
    from hoga.api.calendar import is_trading_day  # noqa: PLC0415 — 지연 import(순환 회피)

    return is_trading_day(date_yyyymmdd) is False


def _is_confirmed_trading_day(date_yyyymmdd: str) -> bool:
    """**확정** 거래일인가 — 모름(None)은 False.

    `_is_non_trading_day` 의 단순 부정이 **아니다.** 둘은 같은 사실을 묻지만 관대함이
    향하는 곳이 반대다:

    * `_is_non_trading_day` — 서빙 인벤토리용. 모르면 **서빙한다**(False). 정상 데이터를
      달력 flake 로 드롭하지 않으려는 정책이다.
    * 이 함수 — 결손 **보고**용. 모르면 **말하지 않는다**(False). 모름이 "데이터 없음" 으로
      승격되면 시드 커버리지 뒤 구간이 통째로 결손처럼 뜬다.

    두 술어가 이 모듈에 나란히 사는 이유는 `tools/range_measurement_policy.py` 때문이다 —
    측정 진입점은 외부 달력에 닿으면 안 되므로 **이 모듈의 속성을 몽키패치**한다. 소비처가
    `hoga.api.calendar` 를 직접 부르면 그 이음매를 우회해 hermetic 이 깨진다.
    """
    try:
        if datetime.strptime(date_yyyymmdd, "%Y%m%d").weekday() >= 5:  # 토/일  # noqa: PLR2004 — 국소 비교 상수
            return False
    except ValueError:
        return False
    from hoga.api.calendar import is_trading_day  # noqa: PLC0415 — 지연 import(순환 회피)

    return is_trading_day(date_yyyymmdd) is True


def resolve_source_dir(stock_date_dir: Path, source: str, venue: Venue) -> Path:
    """Resolve the on-disk parquet dir for one source.

    Tries ``{stock_date_dir}/{source}/`` first (post-migration layout per
    ADR-0037). Falls back to ``{stock_date_dir}/`` (flat, pre-migration)
    only if the source subdir doesn't exist AND the flat dir has a
    meta.json — this preserves backward compatibility with test fixtures
    that build the flat layout directly.

    ⚠ 이 폴백은 **ADR-0037**(소스 축) 시절 유산이고 ADR-0140 의 venue 축 폴백과
    **다른 것**이다. 후자는 PR-D2 에서 삭제됐다(마이그레이션 완료). 여기 것은
    `{stock_date_dir}/meta.json` 이라는 더 옛 모양을 덮으며, 테스트 픽스처가
    그 모양을 직접 만들기 때문에 살아 있다 — 함께 지우지 말 것(#1140 명시).

    ⚠ **`venue` 에 기본값을 주지 말 것**(#1133). 예전엔 `= "KRX"` 였고, 그 하나가
    `/api/range` 의 venue 선택 전체를 무력화했다 — `QueryEngine.parquet_dir` 이
    venue 를 안 받아 여기로 떨어졌고, 호가 파생 지표 9종이 NXT·통합 요청에도
    **KRX 파케이를 읽었다**(실측 2026-08-06 287840 12:08 버킷: 디스크 NXT 총잔량
    ask 701 / bid 825 인데 응답은 KRX 의 154 / 141). 필수 인자면 그 누락이
    타입 에러가 된다.

    평면 레이아웃 폴백에도 venue 가드가 있다 — 평면은 **venue 축이 생기기 전**
    데이터라 정의상 KRX 이고, NXT·통합 요청에 돌려주면 `sources.resolve_source_result`
    가 같은 이유로 막아 둔 뒷문이 여기서 다시 열린다.
    """
    from hoga.api.sources import source_venue_dir  # noqa: PLC0415 — 순환 절단

    sub = source_venue_dir(stock_date_dir, source, venue)
    if sub.exists():
        return sub
    if venue == "KRX" and (stock_date_dir / "meta.json").exists():
        return stock_date_dir  # legacy flat layout
    return sub  # return the not-existing source path for the error to surface naturally


log = logging.getLogger(__name__)


@dataclass(slots=True)
class _ParquetStats:
    """Per-Stock-Date parquet aggregates, precomputed in one batched query.

    Field-for-field the values ``_compute_stock_date`` would otherwise derive
    from two per-row DuckDB calls. Defaults match that function's own
    "no parquet / empty parquet" branch, so a dir the batch didn't produce a
    row for lands on exactly the same values the per-row path would give.

    Mutable (no frozen=True) because _batch_parquet_stats fills the snapshots
    half and the candles half in two separate passes.
    """
    bounds: tuple[int, int] | None = None
    price_min: int = 0
    price_max: int = 0
    total_volume: int = 0
    # 캔들에서 유도한 시가·종가 — meta 에 `today_open`/`today_close` 가 없는 소스
    # (kiwoom_live)용. hogaplay 는 meta 값이 우선이라 여긴 안 쓰인다.
    open_price: int = 0
    close_price: int = 0


@dataclass(frozen=True, slots=True)
class _CachedStockDate:
    """Cache entry pairing a meta.json mtime fingerprint with the built StockDate.

    Keyed in QueryEngine._stock_date_cache by (date, code). Validity is
    checked by re-stat()ing meta.json on every list_stock_dates call —
    the filesystem is the source of truth; this struct just avoids the
    DuckDB + JSON parse work when nothing on disk has changed.
    """
    meta_mtime_ns: int
    value: StockDate


class StockDateNotFound(LookupError):
    """No parquet directory for (date, code)."""


def _venue_states(sd_dir: Path) -> list[StockDateVenue]:
    """`kiwoom_live` 의 venue 별 디스크 상태 (ADR-0140 §7). 없으면 빈 목록.

    **자리 목록은 `expected_venues` 가 정한다** — `kiwoom_live/meta.json` 에 PR-E 가
    캡처 시점 스냅샷으로 박아 둔 값이다. *현재* 마스터로 판정하면 안 된다:
    넥스트레이드가 종목을 단계적으로 늘리므로, 오늘 상장된 종목의 과거일에 NXT 자리가
    생겨 **그날은 결손이 아닌데 결손으로 보인다**.

    자리는 있는데 `disk_state` 가 None = "기대됐으나 없음"이고, 자리 자체가 없으면
    "이 시장에 상장 안 됨"이다. 그 둘을 모양으로 가르는 것이 이 함수의 목적이다.

    비용: `kiwoom_live/` 가 있는 행에서만 파일을 읽는다(실측 2026-08-05 기준 전체
    17,877 행 중 2,696 = 15%). 그마저도 mtime 캐시 미스 경로 안이다.
    """
    source_dir = sd_dir / "kiwoom_live"
    if not source_dir.is_dir():
        return []
    try:
        source_meta = json.loads((source_dir / "meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []  # 마이그레이션 전 평면 레이아웃이거나 손상 — venue 축 없음
    expected = source_meta.get("expected_venues")
    if not isinstance(expected, list) or not expected:
        return []
    out: list[StockDateVenue] = []
    for venue in expected:
        if not isinstance(venue, str):
            continue
        venue_dir = source_dir / venue
        state: str | None = None
        size = 0
        try:
            meta = json.loads((venue_dir / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = None  # 기대됐으나 아직 없음 — 자리는 남기고 내용을 비운다
        if meta is not None:
            state = classify_from_meta(meta).state.value
            size = sum(p.stat().st_size for p in venue_dir.iterdir() if p.is_file())
        out.append(StockDateVenue(venue=venue, disk_state=state, file_size_bytes=size))
    return out


def _row_name(meta: dict, code: str) -> str:
    """행에 표시할 종목명. meta 에 없으면 심볼 마스터, 그것도 없으면 코드.

    `name` 은 hogaplay 파서가 상단 정보 TSV 에서 뽑아 넣는 값이라 `kiwoom_live`
    meta 엔 없다. 코드로 폴백하면 710 행이 이름 없이 뜨므로(#1149 실측) 마스터를
    한 번 더 본다 — 마스터는 커밋된 시드가 있어 자격증명 없이도 산다.
    """
    name = meta.get("name")
    if isinstance(name, str) and name:
        return name
    from hoga.api import symbols as _symbols  # noqa: PLC0415 — 순환 절단(지연)

    try:
        for hit in _symbols.search(code, limit=5):
            if hit.code == code:
                return hit.name
    except Exception:  # noqa: BLE001 — 마스터 미로드는 이름 없음이지 행 실패가 아니다
        return code
    return code


class QueryEngine:
    """Owns the shared DuckDB connection; exposes cross-table queries (inventory + meta).

    Per-table queries (orderbook, trades, candles, brokers) live in the table
    modules and are called by routes.py directly with this engine's connection.
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        temp_directory: Path | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.trade_binning_cache = TradeBinningCache()
        self._conn = connect_bounded(temp_directory=temp_directory)
        # Per-call mtime-validated cache for list_stock_dates. See
        # _CachedStockDate docstring; keyed by (date, code).
        self._stock_date_cache: dict[tuple[str, str], _CachedStockDate] = {}

    def close(self) -> None:
        self._conn.close()

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        # Returns a fresh cursor per access. DuckDB's parent connection is
        # NOT thread-safe — concurrent .execute() from FastAPI's sync-route
        # thread pool would race on the shared connection state and crash
        # the process under modest load (verified 2026-05-23 with 30
        # concurrent read-path requests). Each cursor() call creates an
        # independent connection over the same in-memory database, so
        # callers can read in parallel without contention. Cursors are
        # cheap and GC'd as soon as the call expression ends.
        return self._conn.cursor()

    @property
    def indicators_cache(self) -> PastIndicatorsCache:
        """Disk cache of 1-minute /api/range indicators (호가비·체결강도), keyed by
        (code, date, source). Past days only — `build_range_bundle` gates today
        out. Mirrors the past-candles cache so a completed day's indicator slice
        is computed once, not on every leftward-pan fetch. Built lazily (first
        /range request) and memoised for the engine's lifetime."""
        cache = getattr(self, "_indicators_cache", None)
        if cache is None:
            cache = PastIndicatorsCache(self.data_dir)
            self._indicators_cache = cache
        return cache

    def parquet_dir(self, date: str, code: str, source: str = "hogaplay", *, venue: Venue) -> Path:
        """이 (Stock-Date, source, venue) 의 파케이 디렉터리.

        ⚠ **`venue` 는 키워드 전용 필수다**(#1133). `source` 뒤에 위치 인자로 두면
        기존 호출부가 조용히 통과하고, 그게 정확히 이 버그의 모양이었다 —
        시그니처에 venue 가 아예 없어 `resolve_source_dir` 의 기본값 "KRX" 로
        떨어졌고, `/api/range` 의 호가 파생 지표 9종이 venue 선택과 무관하게 KRX
        파케이를 읽었다. 필수 키워드면 누락이 런타임 오답이 아니라 타입 에러다.
        """
        sd_dir = self.data_dir / "parquet" / date / code
        if not sd_dir.exists():
            raise StockDateNotFound(f"{date}/{code}")
        resolved = resolve_source_dir(sd_dir, source, venue)
        # Verify a meta.json actually lives at the resolved path. Bare existence
        # of the Stock-Date dir isn't enough — could be an empty post-migration
        # shell without the requested source.
        if not (resolved / "meta.json").exists():
            raise StockDateNotFound(f"{date}/{code}/{source}/{venue}")
        return resolved

    def list_stock_dates(self) -> list[StockDate]:  # noqa: PLR0912 — ADR 이 지정한 단일 조립점 — 분기 분할이 설계에 반한다
        base = self.data_dir / "parquet"
        if not base.exists():
            # Disk gone entirely — drop the whole cache rather than
            # quietly hoarding stale entries until the next call sees
            # the same empty result.
            self._stock_date_cache.clear()
            return []
        # Pass 1 — walk the tree, split into cache hits and misses. Nothing
        # touches DuckDB here, so the steady-state (all hits) cost stays the
        # directory walk it always was (~274ms for 15.9k rows, 2026-07-29).
        out: list[StockDate] = []
        seen_keys: set[tuple[str, str]] = set()
        misses: list[tuple[str, str, Path, int]] = []  # (date, code, code_dir, mtime_ns)
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                if not code_dir.is_dir():
                    continue
                code = code_dir.name
                # Find the "winning" meta.json: prefer hogaplay/, fall back to
                # other source subdirs, then flat layout.
                meta_path = self._find_winning_meta(code_dir)
                if meta_path is None:
                    continue
                try:
                    mtime_ns = meta_path.stat().st_mtime_ns
                except FileNotFoundError:
                    continue
                key = (date, code)
                seen_keys.add(key)
                # Single .get() — must not be replaced by `key in cache`
                # then `cache[key]` (two ops). The spec mandates a single
                # atomic dict op so a racing prune cannot null the entry
                # between the check and the read.
                cached = self._stock_date_cache.get(key)
                if cached is not None and cached.meta_mtime_ns == mtime_ns:
                    out.append(cached.value)
                    continue
                # _compute_stock_date wants the dir containing the parquet files,
                # which is the source dir or the flat dir — same as meta_path.parent.
                misses.append((date, code, meta_path.parent, mtime_ns))

        # Pass 2 — one batched DuckDB query per artifact for every miss, instead
        # of two per row. Cold-cache inventory was 36.9s at 15.9k rows because
        # of ~32k individual read_parquet calls (2026-07-29). Returns {} on any
        # failure, which puts every row back on the per-row path below.
        batch = self._batch_parquet_stats([d for _, _, d, _ in misses]) if misses else {}

        # Pass 3 — build the missing rows. The try/except stays per row even
        # when the batch succeeded: a malformed parquet must cost one row, not
        # the whole inventory endpoint (a non-hogaplay schema raises DuckDB
        # BinderException). That isolation is why the batch is allowed to be
        # best-effort.
        by_key: dict[tuple[str, str], StockDate] = {}
        for date, code, code_dir, mtime_ns in misses:
            key = (date, code)
            try:
                sd = self._compute_stock_date(
                    date, code, code_dir, stats=batch.get(code_dir),
                )
            except Exception:  # noqa: BLE001
                seen_keys.discard(key)
                continue
            self._stock_date_cache[key] = _CachedStockDate(
                meta_mtime_ns=mtime_ns, value=sd
            )
            by_key[key] = sd

        # 정렬 계약 유지: 기존 구현은 (date, code) 오름차순으로 append 했다.
        # 위에서 히트/미스를 두 패스로 나누면서 순서가 섞이므로 여기서 복원한다.
        if by_key:
            out.extend(by_key.values())
            out.sort(key=lambda sd: (sd.date, sd.code))
        # Snapshot iteration via list() — safe against concurrent inserts
        # from another threadpool worker. pop(..., None) instead of del
        # because a concurrent pruner may have already removed the same
        # vanished key.
        for k in list(self._stock_date_cache.keys()):
            if k not in seen_keys:
                self._stock_date_cache.pop(k, None)
        return out

    @staticmethod
    def _find_winning_meta(code_dir: Path) -> Path | None:
        """Find the meta.json to use for inventory display.

        Returns the hogaplay/meta.json if present, else the flat-layout
        meta.json (pre-migration), else the kiwoom_live venue meta, else None.

        삭제된 `kis_live` 는 **의도적으로 제외했었다** — snapshots.parquet 이
        `t_ms`(Unix ms)를 쓰는데 인벤토리 리더는 hogaplay 의 `ts_ms`(HHMMSSmmm)를
        가정하기 때문이다. 그 소스는 이제 없다(2026-08-06 제거 · `_archive/kis_live/`).

        ⚠ **kiwoom_live 는 그 제외 사유가 없다**(#1149). 실측 결과 컬럼 66개가 hogaplay
        와 **완전히 동일**하다(`ts_ms` 포함) — 그냥 목록에 안 들어가 있었을 뿐이고, 그
        탓에 kiwoom_live 만 있는 **710 Stock-Date 가 보관함에서 통째로 안 보였다**.

        hogaplay 뒤에 두는 이유: hogaplay 는 상단 정보 TSV 에서 종목명·OHLC·상하한가를
        가져와 meta 가 더 풍부하다. kiwoom_live 는 그 필드가 없어 캔들·마스터에서
        유도해야 한다(`_row_name`·`_compute_stock_date`). 둘 다 있으면 풍부한 쪽이 낫다.

        hogaplay 는 **KRX 정규장만** 커버하므로 NXT 프리·애프터마켓 데이터는 원리적으로
        짝이 없다 — 저장 창이 넓어질수록(PR-G) 이 폴백에 걸리는 행이 늘어난다.
        """
        candidate = code_dir / "hogaplay" / "meta.json"
        if candidate.exists():
            return candidate
        flat = code_dir / "meta.json"
        if flat.exists():
            return flat
        # venue 축을 아는 해석은 disk_state 가 SSOT 다 — 여기서 다시 조립하면
        # `{source}/meta.json`(source 레벨, PR-E)을 venue meta 로 오독한다.
        kiwoom = code_dir / "kiwoom_live"
        if kiwoom.is_dir():
            from hoga.api.disk_state import source_meta_path  # noqa: PLC0415 — 순환 절단

            return source_meta_path(kiwoom)
        return None

    def _batch_parquet_stats(
        self, code_dirs: list[Path]
    ) -> dict[Path, _ParquetStats]:
        """Aggregate snapshots bounds + candle price/volume for many dirs at once.

        Why: ``_compute_stock_date`` issues **two** DuckDB parquet queries per
        Stock-Date. On a cold cache that is ~2 queries × 15.9k rows ≈ 32k
        separate ``read_parquet`` calls, measured at 36.9s for the full
        inventory (2026-07-29). DuckDB can fold the same work into one query
        per artifact via ``read_parquet([...], filename=true)`` + GROUP BY —
        measured 16.6s → 1.36s (12×) for the candles half alone.

        **This is strictly an optimization with a per-row fallback.** A single
        parquet whose schema doesn't match (a partially-migrated Stock-Date
        raises DuckDB BinderException) would fail the *whole* batch, whereas
        the per-row path skips just that row. So any failure here returns an
        empty dict and the caller silently falls back to per-row computation —
        slower, but the isolation property that ``list_stock_dates`` depends on
        is preserved. Never let this raise into the caller.

        Returns a dict keyed by the directory; a dir absent from the result (or
        whose parquet had no rows) simply gets the per-row path's zero/None
        defaults.
        """
        out: dict[Path, _ParquetStats] = {}
        snap_paths = [d / "snapshots.parquet" for d in code_dirs]
        snap_paths = [p for p in snap_paths if p.exists()]
        cand_paths = [d / "candles.parquet" for d in code_dirs]
        cand_paths = [p for p in cand_paths if p.exists()]

        def _stats_for(d: Path) -> _ParquetStats:
            return out.setdefault(d, _ParquetStats())

        if snap_paths:
            try:
                rows = self.conn.execute(
                    "SELECT filename, min(ts_ms), max(ts_ms) "
                    "FROM read_parquet(?, filename=true) GROUP BY filename",
                    [[str(p) for p in snap_paths]],
                ).fetchall()
            except Exception:  # noqa: BLE001 — 배치 실패는 행별 경로로 되돌린다
                log.warning("inventory: batched snapshots bounds failed; per-row fallback")
                return {}
            for filename, lo, hi in rows:
                if lo is None:
                    continue
                _stats_for(Path(filename).parent).bounds = (int(lo), int(hi))

        if cand_paths:
            try:
                rows = self.conn.execute(
                    "SELECT filename, MIN(low), MAX(high), "
                    "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                    "FROM read_parquet(?, filename=true) GROUP BY filename",
                    [[str(p) for p in cand_paths]],
                ).fetchall()
            except Exception:  # noqa: BLE001 — 배치 실패는 행별 경로로 되돌린다
                log.warning("inventory: batched candle aggregates failed; per-row fallback")
                return {}
            for filename, lo, hi, vol in rows:
                if lo is None:
                    continue
                st = _stats_for(Path(filename).parent)
                st.price_min = int(lo)
                st.price_max = int(hi)
                st.total_volume = int(vol)

            # 시가·종가는 **별도 best-effort 쿼리**다. 위 집계에 컬럼을 더하면
            # `open`/`ts_ms` 없는 파케이 하나가 배치 전체를 실패시키고, 그러면
            # 행별 경로도 같은 이유로 실패해 **행이 통째로 사라진다**. 이 값은
            # meta 에 OHLC 가 없는 소스(kiwoom_live)에만 쓰이는 부가 정보라
            # 실패해도 0 으로 두고 넘어가는 것이 맞다.
            try:
                ohlc = self.conn.execute(
                    "SELECT filename, arg_min(open, ts_ms), arg_max(close, ts_ms) "
                    "FROM read_parquet(?, filename=true) GROUP BY filename",
                    [[str(p) for p in cand_paths]],
                ).fetchall()
            except Exception:  # noqa: BLE001 — 부가 정보다. 나머지 통계는 살린다
                log.debug("inventory: batched candle open/close unavailable")
            else:
                for filename, op, cl in ohlc:
                    st = _stats_for(Path(filename).parent)
                    st.open_price = int(op) if op is not None else 0
                    st.close_price = int(cl) if cl is not None else 0

        # 배치가 답을 준 디렉터리만 "계산됨" 으로 표시한다. 여기 없는 디렉터리는
        # 호출부에서 stats=None 이 되어 행별 쿼리를 그대로 탄다.
        for d in code_dirs:
            out.setdefault(d, _ParquetStats())
        return out

    def _candle_open_close(self, candles_path: Path) -> tuple[int, int]:
        """캔들의 시가·종가. 실패하면 ``(0, 0)`` — **행을 죽이지 않는다**.

        meta 에 `today_open`/`today_close` 가 없는 소스(kiwoom_live)에만 쓰이는 부가
        정보다. `open`/`ts_ms` 컬럼이 없는 파케이가 있어도 나머지 통계는 살아야 하므로
        가격 집계 쿼리와 **분리**했다(합치면 한 파일의 스키마 불일치가 행을 통째로
        사라지게 한다 — 실측된 회귀다).
        """
        try:
            row = self.conn.execute(
                "SELECT arg_min(open, ts_ms), arg_max(close, ts_ms) FROM read_parquet(?)",
                [str(candles_path)],
            ).fetchone()
        except Exception:  # noqa: BLE001 — 부가 정보다
            return (0, 0)
        if row is None:
            return (0, 0)
        return (int(row[0]) if row[0] is not None else 0,
                int(row[1]) if row[1] is not None else 0)

    def _compute_stock_date(
        self, date: str, code: str, code_dir: Path,
        stats: _ParquetStats | None = None,
    ) -> StockDate:
        """Build a StockDate row from on-disk parquet for one (date, code).

        Caller has already verified that code_dir/meta.json exists.
        Reads meta.json + snapshots.parquet bounds + candles.parquet
        price/volume aggregates + dir stat() for captured_at and total size.

        ``stats`` — precomputed aggregates from :meth:`_batch_parquet_stats`.
        When None (the batch was skipped or failed) this falls back to the
        original one-query-per-artifact path, which is what keeps a single
        malformed parquet from taking down the whole inventory.
        """
        meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
        # StockDate has no field for classify_from_meta's warning note.
        _classification = classify_from_meta(meta)
        _state = _classification.state
        # ADR-0093/0126/0131 — "재캡처가 무의미하다" 판정. 서버가 답해야 한다:
        # 보유 창 만료 경로는 **오늘 날짜**가 있어야 풀리므로 클라이언트가
        # meta 만으로 재현할 수 없다. 워커·달력과 같은 술어를 공유한다.
        _terminal_partial = is_terminal_partial(_classification, date, now_kst())
        norm_meta, _ = normalize_session_bounds(meta)
        snap_path = code_dir / "snapshots.parquet"
        # snapshots.ts_ms is stored as HHMMSSmmm (per existing tests
        # asserting e.g. ts_ms == 90010435). Convert to Unix ms here.
        if stats is not None:
            bounds = stats.bounds
        else:
            bounds = (
                snapshots.query_time_bounds(self.conn, path=snap_path)
                if snap_path.exists()
                else None
            )
        open_ms = hhmmssms_to_unix_ms(date, norm_meta["regular_session_open_ms"])
        close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
        if bounds is not None:
            first_ms = hhmmssms_to_unix_ms(date, bounds[0])
            last_ms = hhmmssms_to_unix_ms(date, bounds[1])
        else:
            first_ms = open_ms
            last_ms = close_ms

        # Price range + total volume from candles.parquet.
        candles_path = code_dir / "candles.parquet"
        open_price = close_price = 0
        if stats is not None:
            price_min = stats.price_min
            price_max = stats.price_max
            total_volume = stats.total_volume
            open_price = stats.open_price
            close_price = stats.close_price
        elif candles_path.exists():
            row = self.conn.execute(
                "SELECT MIN(low), MAX(high), "
                "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                "FROM read_parquet(?)",
                [str(candles_path)],
            ).fetchone()
            open_price, close_price = self._candle_open_close(candles_path)
            if row is None or row[0] is None:
                price_min = 0
                price_max = 0
                total_volume = 0
            else:
                price_min = int(row[0])
                price_max = int(row[1])
                total_volume = int(row[2])
        else:
            price_min = 0
            price_max = 0
            total_volume = 0

        # Stock-Date dirs are flat by construction (parse_stock_date emits
        # only top-level parquet/meta files), so non-recursive iteration is
        # sufficient and intentional here.
        files = [p for p in code_dir.iterdir() if p.is_file()]
        captured_at = (
            int(max(p.stat().st_mtime for p in files) * 1000) if files else 0
        )
        file_size_bytes = sum(p.stat().st_size for p in files)

        return StockDate(
            date=date,
            code=code,
            name=_row_name(meta, code),
            regular_session_open_ms=open_ms,
            regular_session_close_ms=close_ms,
            data_window_first_ms=first_ms,
            data_window_last_ms=last_ms,
            price_min=price_min,
            price_max=price_max,
            captured_at=captured_at,
            total_volume=total_volume,
            # hogaplay 전용 개념 — 그 소스가 페이지 단위로 긁기 때문이다.
            # kiwoom_live 는 WS push 라 페이지가 없다(0).
            pages_collected=int(meta.get("pages_collected", 0)),
            file_size_bytes=file_size_bytes,
            # meta 에 없으면 **캔들에서 유도**한다(kiwoom_live). 0 으로 두면 화면에
            # "0원" 이 뜨는데, 그건 없는 값이 아니라 **틀린 값**이다.
            today_open=int(meta.get("today_open", open_price)),
            today_high=int(meta.get("today_high", price_max)),
            today_low=int(meta.get("today_low", price_min)),
            today_close=int(meta.get("today_close", close_price)),
            # Single source of truth for meta → completeness bits.
            # The DiskState enum normalizes the rule "if collection
            # didn't finish, is_partial is True regardless of what
            # meta says" — see classify_from_meta docstring.
            collection_complete=_state in (
                DiskState.COMPLETE, DiskState.SOURCE_PARTIAL,
            ),
            is_partial=_state in (
                DiskState.SOURCE_PARTIAL, DiskState.CLIENT_INCOMPLETE,
            ),
            full_capture_count=meta.get("full_capture_count"),
            # ADR-0093: how many consecutive completed captures reproduced the
            # identical result. >=2 = confirmed upstream gap (drawer shows it +
            # gates the force-recapture affordance). Null on legacy meta.
            identical_capture_count=meta.get("identical_capture_count"),
            upstream_gap_confirmed=_terminal_partial,
            # ADR-0020: surface the full enum so consumers can
            # see INVALID — the boolean pair above flattens it.
            disk_state=_state.value,
            # ⚠ `code_dir` 이 아니라 Stock-Date 디렉터리에서 읽는다. code_dir 은
            # **승자 소스** 디렉터리(`hogaplay/` 이거나 평면)라 레이아웃에 따라
            # 깊이가 다르다 — 경로를 직접 조립해 그 분기를 없앤다.
            venues=_venue_states(self.data_dir / "parquet" / date / code),
        )

    def get_meta(
        self, date: str, code: str, source: str = "hogaplay", *, venue: Venue = "KRX",
    ) -> dict[str, Any]:
        """이 (Stock-Date, source, venue) 의 **완결성 meta**.

        venue 기본값이 살아 있는 이유는 `parquet_dir` 과 다르다 — 이걸 부르는
        표면(`/api/stock-dates` 계열 메타 라우트)은 아직 venue 축이 없고, 거기서
        KRX 는 폴백이 아니라 **사실**이다. 지표 경로처럼 venue 선택을 받는 호출부는
        반드시 명시한다(#1133).
        """
        path = self.parquet_dir(date, code, source, venue=venue) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def compute_gap_ranges(
        self, date: str, code: str, source: str = "hogaplay", *, venue: Venue = "KRX",
    ) -> tuple[list[tuple[int, int]], bool, Literal["meta", "computed"]]:
        """Return ``(gap_ranges_hoga, sparse, origin)`` for one Stock-Date source.

        ``gap_ranges_hoga`` are (start, end) boundary pairs in HHMMSSmmm (HogaMs)
        — the caller converts to Unix ms at the API boundary. Prefers the
        parser-written ``gap_ranges`` in meta.json (``origin="meta"``); for legacy
        meta lacking the field, recomputes from snapshots.parquet via
        :func:`analyze_gaps` (``origin="computed"``). No write-back — meta.json
        stays single-writer (the parser).

        ``sparse`` is True when the in-session window had < 2 datapoints (the
        is_partial-by-count case with no discrete ranges). Raises
        :class:`StockDateNotFound` if the source has no meta.json.
        """
        from hoga.api.disk_state import (  # noqa: PLC0415 — 지연 import(순환/heavy)
            analyze_gaps,
        )
        from hoga.util.timeenc import HogaMs  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

        meta = self.get_meta(date, code, source, venue=venue)
        close_ms = meta.get("regular_session_close_ms")
        if "gap_ranges" in meta and isinstance(meta["gap_ranges"], list):
            ranges = [
                (int(g["start_ms"]), int(g["end_ms"]))
                for g in meta["gap_ranges"]
                if isinstance(g, dict) and "start_ms" in g and "end_ms" in g
            ]
            # is_partial without discrete ranges = the sparse (count-rule) case.
            sparse = bool(meta.get("is_partial")) and not ranges
            return ranges, sparse, "meta"

        # Legacy meta (pre-WS1) — recompute from the snapshot stream.
        if not isinstance(close_ms, int):
            return [], False, "computed"
        snap_path = self.parquet_dir(date, code, source, venue=venue) / "snapshots.parquet"
        if not snap_path.exists():
            return [], False, "computed"
        rows = self.conn.execute(
            "SELECT ts_ms FROM read_parquet(?)", [str(snap_path)],
        ).fetchall()
        norm_meta, _ = normalize_session_bounds(meta)
        open_ms, close_ms = indicator_session_bounds(norm_meta)
        analysis = analyze_gaps(
            (HogaMs(r[0]) for r in rows),
            session_open_ms=HogaMs(open_ms),
            session_close_ms=HogaMs(close_ms),
        )
        ranges = [(int(s), int(e)) for s, e in analysis.gap_ranges]
        sparse = analysis.in_session_count < 2 and not ranges  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        return ranges, sparse, "computed"

    def list_stock_dates_in_range(
        self, *, code: str, from_date: str, to_date: str,
        source_pref: str = "hogaplay",
    ) -> list[str]:
        """Ascending list of captured YYYYMMDD strings for ``code`` in [from_date, to_date].

        Filters the parquet inventory by code and inclusive date range. Compares
        as YYYYMMDD strings — lexical order matches calendar order for that format.
        Returns ``[]`` when no Stock-Date matches (caller maps to HTTP 404).

        Matches if EITHER the preferred source has meta.json OR any source does
        (ADR-0039: preference + fallback). Includes legacy flat layout.

        비거래일(주말/휴장) 파티션은 서빙에서 제외한다(:func:`_is_non_trading_day`,
        defense-in-depth). 유령 REST 호가 캡처가 비거래일 파티션을 만들면 사이드카
        지표로 표시됐던 회귀의 2차 안전망 — 원천 차단은 캡처측 rest30 거래일 게이트다.
        """
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[str] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            if date < from_date or date > to_date:
                continue
            if _is_non_trading_day(date):
                continue
            code_dir = date_dir / code
            if not code_dir.is_dir():
                continue
            resolution = resolve_source_result(self, date, code, source_pref)
            if resolution.path is not None:
                out.append(date)
        return out

    def earliest_stock_date(
        self, *, code: str, source_pref: str = "hogaplay", venue: Venue = "KRX",
    ) -> str | None:
        """이 (code, source, venue) 의 **가장 오래된 캡처 거래일**. 없으면 None.

        디스크 모드(hogaplay 우회) 분봉의 **좌측 팬 바닥**이다. 벤더 모드에는 250일
        벽이 있지만 디스크 모드의 끝은 벽이 아니라 **캡처 유무**이고, 그 사실을
        프론트가 알 방법이 종전에는 없었다 — `minuteScrollbackFloorDate` 가 우회
        모드에서 `null` 이라 `planFillStep` 의 정지 조건이 절대 안 걸렸다. 그래서
        사용자가 캡처 시작 이전으로 무한히 팬할 수 있었고, 그 구간엔 데이터가
        영원히 없어 **빈 화면 + 「과거 불러오는 중」이 계속** 뜬다(2026-08-26 사용자
        신고: 028050 은 20260106 부터인데 창이 20251117 까지 갔다).

        **오름차순 순회 중 첫 매치에서 멈춘다.** 그 앞의 날짜 디렉터리들은
        `code_dir.is_dir()` 로 싸게 걸러지고, 비싼 `resolve_source_result` 는 후보에만
        닿는다 — `/api/range` 가 워크백에서 타일마다 부르므로 전 범위 스캔이면 안 된다.

        venue 를 받는 이유: 캡처 트리가 venue 별이라 NXT/UN 의 시작일이 KRX 와 다를
        수 있다. 하나로 뭉치면 그 창에서 틀린 바닥이 된다.
        """
        base = self.data_dir / "parquet"
        if not base.exists():
            return None
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            if _is_non_trading_day(date):
                continue
            if not (date_dir / code).is_dir():
                continue
            if resolve_source_result(self, date, code, source_pref, venue).path is not None:
                return date
        return None
