"""_first_trailing_single_price_book_hhmmssms 의 PastIndicatorsCache 배선 (WS1).

체결분포·POC 슬라이스의 선행 의존값(snapshots+trades 2-스캔). 완료된 과거일은
한 번 계산해 재사용 — 좌측 팬·스터디 스크럽에서 스텝당 2-스캔을 제거한다."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from hoga.api import bundle as bundle_mod
from hoga.api.bundle import _first_trailing_single_price_book_hhmmssms
from hoga.api.past_indicators_cache import PastIndicatorsCache
from hoga.api.queries import StockDateNotFound

_KST = timezone(timedelta(hours=9))
CODE = "005930"
PAST = "20260512"
SRC = "hogaplay"
CLOSE = 153_000_000
NXT_CLOSE = 200_000_000
TODAY = datetime.now(_KST).strftime("%Y%m%d")


def _engine(tmp_path: Path) -> MagicMock:
    # trades.parquet 은 만들지 않는다 → 두 번째(trades count) 스캔은 건너뛰고
    # 첫 번째 snapshots 쿼리 호출만 카운트해 캐시 효과를 깔끔히 격리한다.
    code_dir = tmp_path / PAST / CODE
    code_dir.mkdir(parents=True)
    (code_dir / "snapshots.parquet").touch()
    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.return_value = code_dir
    engine.indicators_cache = PastIndicatorsCache(tmp_path)
    return engine


def test_cache_hit_avoids_requery(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_first_trailing_single_price_book_intra_ms",
        return_value=151_030_000,
    ) as q:
        first = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=PAST, source=SRC, session_close_ms=CLOSE
        )
        second = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=PAST, source=SRC, session_close_ms=CLOSE
        )
    assert first == second
    assert first is not None
    assert q.call_count == 1, "2회째는 캐시 히트라 snapshots 스캔을 재실행하면 안 된다"


def test_none_result_is_cached(tmp_path: Path) -> None:
    # 경계 없음(None)도 유효 캐시값 → 2회째도 재쿼리하지 않는다.
    engine = _engine(tmp_path)
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_first_trailing_single_price_book_intra_ms",
        return_value=None,
    ) as q:
        a = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=PAST, source=SRC, session_close_ms=CLOSE
        )
        b = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=PAST, source=SRC, session_close_ms=CLOSE
        )
    assert a is None and b is None
    assert q.call_count == 1


def test_today_second_call_within_ttl_skips_query(tmp_path: Path) -> None:
    # ADR-0090: 오늘자는 디스크 캐시 대신 short-TTL 프로세스 캐시로 순차 반복을 흡수.
    # snapshots.parquet 존재 → TTL 창 내 2회째는 2-스캔을 재실행하지 않는다.
    engine = _engine(tmp_path)
    today = datetime.now(_KST).strftime("%Y%m%d")
    code_dir = tmp_path / today / CODE
    code_dir.mkdir(parents=True)
    (code_dir / "snapshots.parquet").touch()
    engine.parquet_dir.return_value = code_dir
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_first_trailing_single_price_book_intra_ms",
        return_value=151_030_000,
    ) as q:
        for _ in range(2):
            _first_trailing_single_price_book_hhmmssms(
                engine, code=CODE, date=today, source=SRC, session_close_ms=CLOSE,
                cache=engine.indicators_cache, today_kst=today,
            )
    assert q.call_count == 1, "오늘 TTL 창 내 2회째는 캐시 히트"


def test_today_missing_snapshots_none_is_not_cached(tmp_path: Path) -> None:
    """snapshots.parquet 부재로 인한 None은 TTL 창 안에 파일이 생기면 stale None이
    새 데이터를 가리므로 캐시하지 않는다 (fill_strength no-data 선례)."""
    engine = _engine(tmp_path)
    today = datetime.now(_KST).strftime("%Y%m%d")
    code_dir = tmp_path / today / CODE
    code_dir.mkdir(parents=True)  # snapshots.parquet 없음
    engine.parquet_dir.return_value = code_dir
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_first_trailing_single_price_book_intra_ms",
        return_value=151_030_000,
    ):
        a = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=today, source=SRC, session_close_ms=CLOSE,
            cache=engine.indicators_cache, today_kst=today,
        )
        # 파일이 뒤늦게 생겨도 stale None에 가리지 않아야 한다.
        (code_dir / "snapshots.parquet").touch()
        b = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=today, source=SRC, session_close_ms=CLOSE,
            cache=engine.indicators_cache, today_kst=today,
        )
    assert a is None
    assert b is not None, "파일 생성 후에는 재계산되어 새 결과를 반영"


# ── venue 축 (2026-08-11) ────────────────────────────────────────────────────
# 이 파일엔 venue 를 움직이는 테스트가 **한 건도 없었고**, 그 공백이 정확히
# b64036f5(ADR-0140) 가 안쪽 호출에서 venue 를 빠뜨린 것을 통과시킨 자리다.


def _venue_engine(tmp_path: Path, *, venues: tuple[str, ...]) -> MagicMock:
    """`engine.parquet_dir` 를 **실물처럼** 흉내 낸다 — 존재하는 venue 만 경로를 주고
    나머지는 `StockDateNotFound` 를 던진다.

    위 `_engine` 처럼 `return_value` 를 고정해 두면 어떤 venue 로 물어봐도 같은 경로가
    나와서, venue 를 통째로 빠뜨린 코드도 초록으로 통과한다. 결함이 살아남은 조건을
    테스트가 그대로 갖고 있었던 셈이라 여기서만은 `side_effect` 로 갈린다."""
    root = tmp_path / "parquet"
    for v in venues:
        d = root / TODAY / CODE / "kiwoom_live" / v
        d.mkdir(parents=True)
        (d / "snapshots.parquet").touch()

    def _dir(date: str, code: str, source: str, *, venue: str = "KRX") -> Path:
        d = root / date / code / source / venue
        if not d.exists():
            raise StockDateNotFound(f"{date}/{code}/{source}/{venue}")
        return d

    engine = MagicMock()
    engine.conn = object()
    engine.parquet_dir.side_effect = _dir
    engine.indicators_cache = PastIndicatorsCache(tmp_path)
    return engine


def test_nxt_premarket_without_krx_capture_dir_does_not_raise(tmp_path: Path) -> None:
    """막는 방향: 요청 venue 의 디렉터리가 있는데 **KRX 것이 없어서** 터지는 경로.

    NXT 프리마켓(08:00–09:00)에는 그날의 KRX 캡처 디렉터리가 아직 없다. 안쪽
    `_compute_*` 호출이 venue 를 빠뜨리면 기본값 KRX 로 떨어져 StockDateNotFound 가
    라우트까지 올라가고, /api/range?mode=sidecar 가 통째로 500 이 된다 —
    히트맵·매도벽·POC·증감이 한꺼번에 사라진 실제 증상이 이것이었다.

    이 테스트가 **못 보는 것**: 값이 맞는지는 검사하지 않는다(모의 쿼리라 어차피 상수).
    보는 것은 "어느 venue 디렉터리를 열었나" 하나다."""
    engine = _venue_engine(tmp_path, venues=("NXT", "UN"))
    with patch.object(
        bundle_mod.snapshots_tbl,
        "query_first_trailing_single_price_book_intra_ms",
        return_value=151_030_000,
    ):
        result = _first_trailing_single_price_book_hhmmssms(
            engine, code=CODE, date=TODAY, source="kiwoom_live", venue="NXT",
            session_close_ms=NXT_CLOSE, cache=engine.indicators_cache, today_kst=TODAY,
        )
    assert result is not None
    venues = {c.kwargs["venue"] for c in engine.parquet_dir.call_args_list}
    assert venues == {"NXT"}, f"요청 venue 밖을 열었다: {venues}"
