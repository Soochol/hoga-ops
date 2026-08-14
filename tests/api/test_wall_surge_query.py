"""호가벽 급증(query_wall_surge) — 프로토타입에서 검증된 성질을 합성 픽스처로 못박는다.

설계: docs/superpowers/specs/2026-08-14-sell-wall-surge-indicator-design.md

프로토타입이 실데이터로 네 번 개정하며 확정한 규칙을 여기서 결정적으로 재현한다.
실데이터 앵커(20260812 028050 12:34:48 · 49,200 · 8,271주 pierce/consumed)는 환경
의존이라 테스트에 넣지 않고, 같은 **구조**를 합성 픽스처로 세운다.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from hoga.tables.snapshots import (
    ORDERBOOK_LEVELS,
    Orderbook,
    WallSurgeRow,
    query_wall_surge,
    write_parquet,
)
from hoga.tables.trades import Trade, write_parquet as write_trades

# 세션 경계는 **native HHMMSSmmm** 이다 — 술어가 안에서 선형으로 바꾼다. 선형 ms 를
# 넘기면 경계가 통째로 엉뚱해져 결과가 0건이 된다(구현 중 실제로 밟은 함정).
OPEN_NATIVE = 90000000  # 09:00:00.000
CLOSE_NATIVE = 152000000  # 15:20:00.000
TICK = 50


def _hhmmssms(h: int, m: int, s: int, ms: int = 0) -> int:
    return h * 10_000_000 + m * 100_000 + s * 1000 + ms


def _book(
    ts: int,
    seq: int,
    *,
    ask_top: int,
    ask_qs: list[int],
    bid_top: int,
    bid_qs: list[int],
) -> Orderbook:
    """10단 호가창 하나. 가격은 top 에서 TICK 씩 벌어지고 잔량만 인자로 받는다.

    4~10단을 0 이 아닌 값으로 채우는 것이 중요하다 — 공용 술어(_DEEP_BOOK_SQL)가
    deep 합 > 0 을 요구하므로, 0 으로 두면 단일가로 간주돼 통째로 배제된다.
    """
    n = ORDERBOOK_LEVELS
    ask_p = tuple(ask_top + TICK * i for i in range(n))
    bid_p = tuple(bid_top - TICK * i for i in range(n))
    aq = tuple(ask_qs + [100] * (n - len(ask_qs)))
    bq = tuple(bid_qs + [100] * (n - len(bid_qs)))
    zeros = tuple([0] * n)
    return Orderbook(
        ts_ms=ts, seq=seq,
        ask_p=ask_p, ask_q=aq, ask_d=zeros,
        bid_p=bid_p, bid_q=bq, bid_d=zeros,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=sum(bq), tot_bid_d=0,
    )


def _run(
    tmp_path: Path, books: list[Orderbook], trades: list[Trade] | None = None
) -> list[WallSurgeRow]:
    snap = tmp_path / "snapshots.parquet"
    write_parquet(books, snap)
    tr_path: Path | None = None
    if trades is not None:
        tr_path = tmp_path / "trades.parquet"
        write_trades(trades, tr_path)
    return query_wall_surge(
        duckdb.connect(), path=snap, trades_path=tr_path,
        session_open_ms=OPEN_NATIVE, session_close_ms=CLOSE_NATIVE,
    )


def _quiet_prelude(start_s: int = 0, n: int = 40) -> list[Orderbook]:
    """워밍업(개장 후 30분)을 채우고 러닝 평균을 세우는 잔잔한 구간."""
    return [
        _book(
            _hhmmssms(9, 0, start_s + i), i + 1,
            ask_top=50000, ask_qs=[100, 100, 100], bid_top=49950, bid_qs=[100, 100, 100],
        )
        for i in range(n)
    ]


def _fill_before(h: int, m: int, s: int, seq0: int, *, ask_top: int, bid_top: int,
                 n: int = 5) -> list[Orderbook]:
    """사건 직전 1초 간격으로 채운다.

    창(10초) 안 표본이 MIN_SAMPLES(3) 미만이면 판정 자체가 열리지 않는다 — 캡처 갭
    직후를 막는 가드라, 픽스처에서도 이걸 채워야 사건이 보인다.
    """
    # ⚠ 총 초로 역산한다. `s - n + i` 를 그대로 쓰면 s < n 일 때 **음수 초**가 되어
    # HHMMSSmmm 인코딩이 깨지고, 그 스냅샷은 통째로 무효가 된다 — 부정형 단언
    # (발동하지 않음)은 그래도 통과해 버려서 테스트가 조용히 무의미해진다.
    base = h * 3600 + m * 60 + s
    return [
        _book(
            _hhmmssms((base - n + i) // 3600, (base - n + i) // 60 % 60, (base - n + i) % 60),
            seq0 + i,
            ask_top=ask_top, ask_qs=[100, 100, 100],
            bid_top=bid_top, bid_qs=[100, 100, 100],
        )
        for i in range(n)
    ]


def test_pierce_fires_when_wall_appears_on_the_opposite_side_slot(tmp_path: Path) -> None:
    """반대측 자리였던 가격에 매도벽이 서면 baseline 0 확정 → pierce.

    실데이터 앵커(49,200 이 매수 1호가였다가 매도 1호가가 되며 8,271주 등장)와 같은 구조다.
    """
    books = _quiet_prelude()
    # 09:31 — 49,950 이 매수 1호가인 평온한 상태
    for i in range(5):
        books.append(
            _book(_hhmmssms(9, 31, i), 100 + i,
                  ask_top=50000, ask_qs=[100, 100, 100],
                  bid_top=49950, bid_qs=[100, 100, 100])
        )
    # 09:31:10 — 가격이 한 틱 내려가며 49,950 이 **매도 1호가**가 되고 큰 물량이 걸린다
    books.append(
        _book(_hhmmssms(9, 31, 10), 200,
              ask_top=49950, ask_qs=[9000, 100, 100],
              bid_top=49900, bid_qs=[100, 100, 100])
    )
    rows = _run(tmp_path, books)
    fired = [r for r in rows if r.side == "ask" and r.price == 49950]
    assert len(fired) == 1, rows
    ev = fired[0]
    assert ev.kind == "pierce"
    assert ev.jump == 9000  # baseline 0 이므로 증가량 = 잔량 전체
    assert ev.blind_ms is None


def test_reappear_uses_last_seen_value_and_carries_blind_time(tmp_path: Path) -> None:
    """시야 밖에 나갔다 돌아온 벽은 **당일 마지막 관측 대비**로 판정하고 체류시간을 싣는다."""
    books = _quiet_prelude()
    # 09:31 — 50,400 이 ask 사다리 안(9번째 단)에 800주로 보인다
    books.append(
        _book(_hhmmssms(9, 31, 0), 300,
              ask_top=50000, ask_qs=[100] * 8 + [800], bid_top=49950, bid_qs=[100])
    )
    # 09:32~09:33 — 가격이 크게 내려가 50,400 이 10단 밖으로 사라진다(2분 공백)
    for i in range(20):
        books.append(
            _book(_hhmmssms(9, 32, i * 3), 400 + i,
                  ask_top=49000, ask_qs=[100, 100, 100], bid_top=48950, bid_qs=[100])
        )
    # 09:34 — 가격이 되올라와 50,400 이 다시 보이는데 9,000주로 불어 있다
    # ⚠ 낮은 사다리로 채운다 — ask_top=50000 이면 50,400 이 8단에 들어와
    # 창 안 관측이 생기고 kind 가 grow 로 바뀐다(재등장 경로를 못 탄다).
    books.extend(_fill_before(9, 34, 0, 480, ask_top=49000, bid_top=48950))
    books.append(
        _book(_hhmmssms(9, 34, 0), 500,
              ask_top=50000, ask_qs=[100] * 8 + [9000], bid_top=49950, bid_qs=[100])
    )
    rows = _run(tmp_path, books)
    fired = [r for r in rows if r.side == "ask" and r.price == 50400]
    assert len(fired) == 1, rows
    ev = fired[0]
    assert ev.kind == "reappear"
    assert ev.jump == 9000 - 800  # 마지막으로 본 값 대비
    assert ev.blind_ms is not None and ev.blind_ms > 60_000  # 2분 남짓 시야 밖


def test_same_size_reappear_does_not_fire(tmp_path: Path) -> None:
    """같은 크기로 돌아온 벽은 발동하지 않는다 — 급증이 아니라 잔존의 영역이다(사용자 결정)."""
    books = _quiet_prelude()
    books.append(
        _book(_hhmmssms(9, 31, 0), 300,
              ask_top=50000, ask_qs=[100] * 8 + [9000], bid_top=49950, bid_qs=[100])
    )
    for i in range(20):
        books.append(
            _book(_hhmmssms(9, 32, i * 3), 400 + i,
                  ask_top=49000, ask_qs=[100, 100, 100], bid_top=48950, bid_qs=[100])
        )
    # 돌아왔는데 **같은 9,000주**
    # ⚠ 낮은 사다리로 채운다 — ask_top=50000 이면 50,400 이 8단에 들어와
    # 창 안 관측이 생기고 kind 가 grow 로 바뀐다(재등장 경로를 못 탄다).
    books.extend(_fill_before(9, 34, 0, 480, ask_top=49000, bid_top=48950))
    books.append(
        _book(_hhmmssms(9, 34, 0), 500,
              ask_top=50000, ask_qs=[100] * 8 + [9000], bid_top=49950, bid_qs=[100])
    )
    rows = _run(tmp_path, books)
    assert [r for r in rows if r.price == 50400] == []


def test_warmup_is_relative_to_session_open_not_wall_clock(tmp_path: Path) -> None:
    """워밍업은 session_open 기준 오프셋이다 — 벽시계 09:30 이 아니다.

    개장이 10:00 으로 지연된 날, 10:10 의 사건은 아직 워밍업 안이라 발동하지 않아야
    한다. 벽시계를 박았다면 09:30 을 이미 지났으므로 발동해 버린다.
    """
    books = [
        _book(_hhmmssms(10, 0, i), i + 1,
              ask_top=50000, ask_qs=[100, 100, 100], bid_top=49950, bid_qs=[100])
        for i in range(40)
    ]
    books.extend(_fill_before(10, 10, 0, 150, ask_top=50000, bid_top=49950))
    books.append(
        _book(_hhmmssms(10, 10, 0), 200,
              ask_top=49950, ask_qs=[9000, 100, 100], bid_top=49900, bid_qs=[100])
    )
    late_open = _hhmmssms(10, 0, 0)
    snap = tmp_path / "snapshots.parquet"
    write_parquet(books, snap)
    rows = query_wall_surge(
        duckdb.connect(), path=snap, trades_path=None,
        session_open_ms=late_open, session_close_ms=CLOSE_NATIVE,
    )
    assert rows == []


def test_outcome_is_none_when_tracking_window_runs_past_data_end(tmp_path: Path) -> None:
    """추적 창이 데이터 끝을 넘으면 결말은 **미정(None)** 이다 — held 가 아니다."""
    books = _quiet_prelude()
    books.extend(_fill_before(9, 31, 10, 150, ask_top=50000, bid_top=49950))
    books.append(
        _book(_hhmmssms(9, 31, 10), 200,
              ask_top=49950, ask_qs=[9000, 100, 100], bid_top=49900, bid_qs=[100])
    )
    rows = _run(tmp_path, books)
    fired = [r for r in rows if r.side == "ask" and r.price == 49950]
    assert len(fired) == 1
    assert fired[0].outcome is None, "데이터가 곧 끝나므로 버텼다고 단정할 수 없다"


def test_consumed_counts_only_the_attacking_side(tmp_path: Path) -> None:
    """매도벽 소화는 **매수 공격(side=+1)** 체결만 센다 — 반대 부호를 세면 부풀려진다."""
    books = _quiet_prelude()
    books.extend(_fill_before(9, 31, 10, 150, ask_top=50000, bid_top=49950))
    books.append(
        _book(_hhmmssms(9, 31, 10), 200,
              ask_top=49950, ask_qs=[9000, 100, 100], bid_top=49900, bid_qs=[100])
    )
    # 벽이 사라지고, 데이터는 추적 창을 넘어 이어진다
    for i in range(1, 40):
        books.append(
            _book(_hhmmssms(9, 31, 10 + i * 5), 300 + i,
                  ask_top=49950, ask_qs=[10, 100, 100], bid_top=49900, bid_qs=[100])
        )
    trades = [
        Trade(ts_ms=_hhmmssms(9, 31, 12), seq=1, price=49950, change_pct=0.0,
              qty=8000, side=1, cum_vol=8000, cum_trades=1, low_so_far=49950,
              high_so_far=49950, net_pressure=0, unknown_14=0, unknown_16=0.0,
              unknown_17=0.0, unknown_18=0.0),
    ]
    rows = _run(tmp_path, books, trades)
    fired = [r for r in rows if r.side == "ask" and r.price == 49950]
    assert len(fired) == 1
    assert fired[0].outcome == "consumed"
    assert fired[0].filled_qty == 8000


@pytest.mark.parametrize("side_sign", [1, -1])
def test_wrong_side_fills_do_not_count_as_consumed(tmp_path: Path, side_sign: int) -> None:
    """같은 픽스처에서 체결 부호만 뒤집으면 소화 판정이 갈린다."""
    books = _quiet_prelude()
    books.extend(_fill_before(9, 31, 10, 150, ask_top=50000, bid_top=49950))
    books.append(
        _book(_hhmmssms(9, 31, 10), 200,
              ask_top=49950, ask_qs=[9000, 100, 100], bid_top=49900, bid_qs=[100])
    )
    for i in range(1, 40):
        books.append(
            _book(_hhmmssms(9, 31, 10 + i * 5), 300 + i,
                  ask_top=49950, ask_qs=[10, 100, 100], bid_top=49900, bid_qs=[100])
        )
    trades = [
        Trade(ts_ms=_hhmmssms(9, 31, 12), seq=1, price=49950, change_pct=0.0,
              qty=8000, side=side_sign, cum_vol=8000, cum_trades=1, low_so_far=49950,
              high_so_far=49950, net_pressure=0, unknown_14=0, unknown_16=0.0,
              unknown_17=0.0, unknown_18=0.0),
    ]
    rows = _run(tmp_path, books, trades)
    fired = [r for r in rows if r.side == "ask" and r.price == 49950]
    assert len(fired) == 1
    if side_sign == 1:
        assert fired[0].outcome == "consumed"
    else:
        # 매도 공격은 매도벽을 먹지 않는다 — 체결이 있어도 소화가 아니다
        assert fired[0].outcome == "pulled"
        assert fired[0].filled_qty == 0


def test_sparse_source_needs_a_wider_window(tmp_path: Path) -> None:
    """저장 간격이 넓은 소스(kiwoom_live 10초)는 창을 넓혀야 이벤트가 나온다.

    실측 사고: `/api/range` 가 kiwoom_live 를 고르는데 창이 10초라 창 안 표본이 중앙값
    2개뿐이었고, MIN_SAMPLES(3)를 못 넘겨 **이벤트가 통째로 0건**이었다(캐시에 빈
    리스트까지 저장됐다). 슬라이스가 소스를 보고 창을 정하는 것이 그 처방이다.
    """
    # 10초 간격 — 10초 창에는 자기 자신 포함 2개뿐이라 판정이 열리지 않는다.
    # ⚠ 초를 그대로 곱하면 60 을 넘어 HHMMSSmmm 인코딩이 깨진다 — 총 초로 환산한다.
    books = [
        _book(
            _hhmmssms(9, (i * 10) // 60, (i * 10) % 60), i + 1,
            ask_top=50000, ask_qs=[100, 100, 100], bid_top=49950, bid_qs=[100, 100, 100],
        )
        for i in range(240)
    ]
    books.append(
        _book(_hhmmssms(9, 40, 0), 900,
              ask_top=49950, ask_qs=[9000, 100, 100], bid_top=49900, bid_qs=[100])
    )
    snap = tmp_path / "snapshots.parquet"
    write_parquet(books, snap)

    def run(window_ms: int) -> list[WallSurgeRow]:
        return query_wall_surge(
            duckdb.connect(), path=snap, trades_path=None,
            session_open_ms=OPEN_NATIVE, session_close_ms=CLOSE_NATIVE,
            window_ms=window_ms,
        )

    assert run(10_000) == [], "10초 창에서는 표본 부족으로 판정이 열리지 않는다"
    assert [r for r in run(60_000) if r.price == 49950], "60초 창이면 잡힌다"
