import datetime as dt
import logging

import duckdb

from hoga.live.quote_change_resolver import QuoteChangeResolver
from hoga.live.quote_models import Quote


def _write_adjusted_daily(path, rows):
    with duckdb.connect(":memory:") as con:
        con.execute(
            "CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)"
        )
        con.executemany(
            "INSERT INTO d VALUES (?,?,?,?,?,?,?)",
            [
                (code, dt.date.fromisoformat(date_s), open_, high, low, close, volume)
                for code, date_s, open_, high, low, close, volume in rows
            ],
        )
        con.execute(f"COPY d TO '{path}' (FORMAT parquet)")


def test_uses_adjusted_baseline_when_kis_change_rate_disagrees(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("049080", "2026-06-26", 9930, 9930, 9930, 9930, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="049080", price=7770, change_pct=682.48, change_won=None)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == -21.75
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 9930
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_uses_kis_previous_close_before_adjusted_daily(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=111, change_pct=99.0, change_won=99, previous_close=110)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 0.91
    assert out.change_won == 1
    assert out.change_pct_source == "kis"
    assert out.baseline_price == 110
    assert out.baseline_date is None
    assert out.warnings == []


def test_uses_adjusted_baseline_without_warning_when_kis_matches(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_recomputes_change_rate_from_adjusted_baseline_even_when_kis_diff_is_small(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 5.0
    assert out.change_won == 5
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_hides_change_rate_when_adjusted_baseline_scale_mismatches_quote(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("049080", "2026-06-26", 993, 993, 993, 993, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(
        code="049080",
        price=6290,
        change_pct=533.43,
        change_won=5297,
        open=7550,
        high=7660,
        low=6080,
    )
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "unavailable"
    assert out.baseline_price == 993
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == ["adjusted_baseline_scale_mismatch"]


def test_hides_change_rate_when_adjusted_baseline_is_stale_for_today(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 30))

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "unavailable"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == ["adjusted_baseline_stale"]


def test_friday_adjusted_baseline_is_valid_on_monday(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 29))

    assert out.change_pct == 5.0
    assert out.change_won == 5
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_ignores_same_day_adjusted_row_when_selecting_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [
            ("005930", "2026-06-29", 100, 100, 100, 100, 100),
            ("005930", "2026-06-30", 105, 105, 105, 105, 100),
        ],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=110, change_pct=1.0, change_won=1)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 30))

    assert out.change_pct == 10.0
    assert out.change_won == 10
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-29"
    assert out.warnings == []


def test_missing_adjusted_file_falls_back_to_kis_without_warning(tmp_path):
    resolver = QuoteChangeResolver(adjusted_daily_path=tmp_path / "missing.parquet")

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == []


def test_unreadable_adjusted_file_is_logged_not_swallowed(tmp_path, caplog):
    """읽기 실패는 "unavailable" 로만 나가면 원인을 못 알아본다.

    change_pct_source 의 "unavailable" 은 "코퍼스에 그 종목이 없음"(정상)과
    "parquet 읽기가 터짐"(고장)을 구분하지 못한다. 후자만 로그로 갈라진다.
    """
    daily = tmp_path / "daily_adjusted.parquet"
    daily.write_bytes(b"not a parquet file")
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
    with caplog.at_level(logging.WARNING, logger="hoga.live.quote_change_resolver"):
        out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct_source == "unavailable"  # 응답은 여전히 죽지 않는다
    records = [r for r in caplog.records if "baseline read failed" in r.getMessage()]
    assert len(records) == 1
    assert "005930" in records[0].getMessage()
    assert records[0].exc_info is not None  # 원인 예외가 붙어 있어야 손댈 수 있다


def test_unreadable_adjusted_file_logs_once_per_code(tmp_path, caplog):
    """_baseline_for 의 (code, today) 캐시가 로그 폭주를 막는다는 전제를 고정한다.

    이 캐시가 없으면 시세 폴링 주기마다 종목 수만큼 스택트레이스가 쏟아진다 —
    그러면 다음 사람이 로그를 지우게 되고, 진단 능력이 조용히 사라진다.
    """
    daily = tmp_path / "daily_adjusted.parquet"
    daily.write_bytes(b"not a parquet file")
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
    with caplog.at_level(logging.WARNING, logger="hoga.live.quote_change_resolver"):
        for _ in range(5):
            resolver.resolve_quote(q, phase="open")

    assert sum("baseline read failed" in r.getMessage() for r in caplog.records) == 1


def test_missing_adjusted_file_does_not_cache_absent_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
    before = resolver.resolve_quote(q, phase="open")
    assert before.change_pct is None
    assert before.change_pct_source == "unavailable"

    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )

    after = resolver.resolve_quote(q, phase="open")
    assert after.change_pct == 3.0
    assert after.change_won == 3
    assert after.baseline_price == 100
    assert after.baseline_date == "2026-06-26"
    assert after.change_pct_source == "adjusted_daily"


def test_invalid_baseline_falls_back_to_kis_and_marks_warning(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 0, 0, 0, 0, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == ["adjusted_baseline_unavailable"]


def test_pre_open_hides_change_fields_even_with_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="pre_open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "hidden_pre_open"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


# ---------------------------------------------------------------------------
# prime_baselines — 배치 기준가 프라임 (트랙 3, 2026-08-16)
#
# `resolve_quote` 는 종목마다 `_baseline_for` 를 부르고 캐시 미스면 DuckDB 쿼리가
# 종목당 1건씩 났다(N+1). `/api/live/quotes` 는 히트맵 화면에서 한 요청에 296종목을
# 받고 전 경로가 `async def` 인데 `to_thread` 가 없어, 그 시간 동안 **이벤트 루프
# 전체가 멎었다**(`--workers` 금지 구조 #998).
#
# 실측(실데이터 133.9MB, 실히트맵 296종목, 콜드): 1,538 ms → 37 ms (41.7배), 반환값 일치.
#
# 여기서 재는 것은 속도가 아니라 **의미론 동등성**이다 — 배치가 종목별 경로와 다른
# 답을 내면 빨라진 것이 아니라 틀린 것이다.
# ---------------------------------------------------------------------------


def _prime_fixture(tmp_path):
    """의미론 경계를 담은 픽스처.

    `_load_baseline` 의 SQL 은 `WHERE close > 0 AND date < ? ORDER BY date DESC LIMIT 1`
    이다 — **종가 0 인 날은 건너뛰고** 그 이전 양수 종가를 집는다. (히트맵 그룹플로우의
    `_load_prev_closes` 는 정반대 계약이라 두 경로를 합치면 안 된다.)
    """
    path = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        path,
        [
            # 평범 — 직전 거래일.
            ("000001", "2026-06-16", 1.0, 1.0, 1.0, 1000.0, 1),
            ("000001", "2026-06-17", 1.0, 1.0, 1.0, 1100.0, 1),
            # ⚠ 직전 행이 0 → **건너뛰고** 그 이전 양수(2200)를 집는다.
            ("000002", "2026-06-16", 1.0, 1.0, 1.0, 2200.0, 1),
            ("000002", "2026-06-17", 1.0, 1.0, 1.0, 0.0, 1),
            # today 당일 행은 배제(`date < today`).
            ("000003", "2026-06-17", 1.0, 1.0, 1.0, 3300.0, 1),
            ("000003", "2026-06-18", 1.0, 1.0, 1.0, 9999.0, 1),
            # 전부 0 → 기준가 없음(None).
            ("000004", "2026-06-17", 1.0, 1.0, 1.0, 0.0, 1),
        ],
    )
    return path


_PRIME_CODES = ["000001", "000002", "000003", "000004", "999999"]
_TODAY = dt.date(2026, 6, 18)


def test_prime_baselines_matches_per_code_path(tmp_path):
    path = _prime_fixture(tmp_path)

    per_code = QuoteChangeResolver(adjusted_daily_path=path)
    expected = {c: per_code._baseline_for(c, today=_TODAY) for c in _PRIME_CODES}

    batched = QuoteChangeResolver(adjusted_daily_path=path)
    batched.prime_baselines(_PRIME_CODES, today=_TODAY)
    actual = {c: batched._baseline_for(c, today=_TODAY) for c in _PRIME_CODES}

    assert actual == expected
    # 값 자체도 못박는다 — 둘이 **같은 방식으로 틀리는** 경우를 배제한다.
    assert actual["000001"].close == 1100
    assert actual["000002"].close == 2200, "종가 0 인 날은 건너뛰고 그 이전 양수를 집는다"
    assert actual["000003"].close == 3300, "today 당일 행은 배제"
    assert actual["000004"] is None, "전부 0 이면 기준가 없음"
    assert actual["999999"] is None, "코퍼스에 없는 종목"


def test_prime_baselines_caches_absence_so_missing_codes_do_not_requery(tmp_path):
    """부재도 캐시해야 한다 — 안 하면 없는 종목이 매 폴링마다 쿼리를 다시 태운다."""
    path = _prime_fixture(tmp_path)
    r = QuoteChangeResolver(adjusted_daily_path=path)
    r.prime_baselines(_PRIME_CODES, today=_TODAY)
    key = ("999999", _TODAY.isoformat())
    assert key in r._baseline_cache
    assert r._baseline_cache[key] is None


def test_prime_baselines_skips_codes_already_cached(tmp_path):
    """이미 캐시된 코드는 쿼리에 넣지 않는다(웜 캐시에서 프라임이 공짜여야 한다)."""
    path = _prime_fixture(tmp_path)
    r = QuoteChangeResolver(adjusted_daily_path=path)
    r.prime_baselines(_PRIME_CODES, today=_TODAY)
    before = dict(r._baseline_cache)
    r.prime_baselines(_PRIME_CODES, today=_TODAY)   # 두 번째 호출은 no-op 이어야
    assert r._baseline_cache == before


def test_prime_baselines_respects_corpus_generation(tmp_path):
    """코퍼스가 바뀌면 프라임이 **새 세대로** 캐시를 갈아야 한다.

    이 검사가 없으면 프라임이 스테일 세대의 캐시에 새 값을 섞어 넣는 형태로 조용히
    틀릴 수 있다 — `_baseline_for` 와 같은 정렬(`_sync_cache_generation`)을 쓰는지가 요지.
    """
    path = _prime_fixture(tmp_path)
    r = QuoteChangeResolver(adjusted_daily_path=path)
    r.prime_baselines(["000001"], today=_TODAY)
    assert r._baseline_for("000001", today=_TODAY).close == 1100

    _write_adjusted_daily(
        path,
        [("000001", "2026-06-17", 1.0, 1.0, 1.0, 7777.0, 1)],
    )
    r.prime_baselines(["000001"], today=_TODAY)
    assert r._baseline_for("000001", today=_TODAY).close == 7777


def test_prime_baselines_is_a_noop_without_corpus(tmp_path):
    """코퍼스가 없으면 조용히 물러난다 — dev·워크트리의 정상 경로다(무자격 관례)."""
    r = QuoteChangeResolver(adjusted_daily_path=None)
    r.prime_baselines(["000001"], today=_TODAY)
    assert r._baseline_cache == {}

    missing = QuoteChangeResolver(adjusted_daily_path=tmp_path / "nope.parquet")
    missing.prime_baselines(["000001"], today=_TODAY)
    assert missing._baseline_cache == {}


def test_prime_baselines_failure_falls_back_to_per_code_path(tmp_path, caplog):
    """프라임이 터져도 **동작은 종전과 같아야** 한다(느릴 뿐).

    부분 결과를 캐시하면 실패 시점에 따라 어떤 종목만 기준가가 비는 비결정적 응답이 된다.
    """
    path = _prime_fixture(tmp_path)
    r = QuoteChangeResolver(adjusted_daily_path=path)
    path.write_bytes(b"not a parquet file")
    with caplog.at_level(logging.WARNING):
        r.prime_baselines(["000001"], today=_TODAY)
    assert r._baseline_cache == {}, "실패 시 아무것도 캐시하지 않는다"
    assert "prime failed" in caplog.text
