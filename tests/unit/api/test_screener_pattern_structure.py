"""구조 서명 게이트 (ADR-0166 결정 12).

이 파일이 닫는 방향:
* 서명이 **색·전고·전저 관계**를 그 순서로 읽는가(손으로 센 부호열과 대조).
* 부호가 **진폭에 불변**인가 — 같은 구조를 3배로 늘린 창이 전부 맞는다.
* 게이트가 **상관이 더 높은 잘못된 구조**를 실제로 떨어뜨리는가. 게이트 줄을 지우면
  이 테스트가 빨개진다 — 한 번도 빨개진 적 없는 가드는 아무것도 증명하지 못한다.
* 분포·베이스라인이 게이트에 **닿지 않는가**(길이 유연 병합의 전제).
* 유연 길이에서 **리샘플한 쿼리**의 서명이 늘려 심은 사본을 통과시키는가.
* 라우트가 새 키를 `response_model` 을 지나서도 내는가(끄면 null · 켜면 값).

못 보는 것: 실코퍼스에서의 히트 수(92 등)는 여기 없다 — 합성 픽스처만 쓴다.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import screener_pattern as sp, screener_pattern_structure as st
from hoga.api.models import PatternSaveWriteRequest, PatternSearchRequest
from hoga.api.screener import build_router

_START = dt.date(2024, 1, 1)


def _dates(n: int, start: dt.date = _START) -> list[dt.date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def _rows(code: str, bars, *, start=_START, volume=10**9):
    """명시적 OHLC 봉들 — 구조를 정확히 심으려면 종가 궤적으로는 부족하다(색이 못 갈린다)."""
    return [{"code": code, "date": d, "open": float(o), "high": float(h), "low": float(lo),
             "close": float(c), "volume": volume}
            for d, (o, h, lo, c) in zip(_dates(len(bars), start), bars, strict=True)]


def _bull_walk(n: int, base: float = 100.0):
    """무관한 배경 — 양봉만 이어지는 완만한 상승. 어떤 «음봉 뒤 돌파» 서명과도 안 맞는다."""
    out = []
    for k in range(n):
        c = base * (1 + 0.003 * k)
        out.append((c * 0.995, c * 1.004, c * 0.99, c))
    return out


def _write(tmp_path, rows):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows, schema={
        "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
        "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
    }).write_parquet(sdir / "daily_adjusted.parquet")
    codes = sorted({r["code"] for r in rows})
    pl.DataFrame([{"code": c, "name": f"종목{c}", "market": "KOSPI",
                   "is_etf": False, "is_halted": False} for c in codes]
                 ).write_parquet(sdir / "stocks.parquet")
    sp.reset_cache()
    return tmp_path


#: 그림의 구조 — 양봉 · 음봉(고가는 넘고 종가는 못 넘음) · 윗꼬리 실패 둘 · 신고점 양봉.
#: (open, high, low, close)
_STRUCT = [
    (100, 106, 99, 105),
    (105, 108, 103, 104),     # 음봉, 고가 108 > 106, 종가 104 < 106
    (104, 109, 102, 105),     # 윗꼬리 109 > 108, 종가 105 < 108
    (105, 110, 103, 106),     # 윗꼬리 110 > 109, 종가 106 < 109
    (106, 116, 105, 115),     # 신고점 116, 종가 115 > 110
]
_L = len(_STRUCT)


def _win(bars) -> np.ndarray:
    return np.log(np.array(bars, dtype=float).T)      # (4, L)


# ── 서명 자체 ────────────────────────────────────────────────────────────────

def test_signature_reads_color_and_running_extremes_in_declared_order():
    """손으로 센 부호열과 대조 — 관계 순서가 `relation_names` 와 같아야 화면이 이름을 붙인다."""
    bars = [(10, 12, 9, 11), (11, 13, 10, 10.5), (10.5, 14, 10.2, 13.5)]
    sig = st.query_signature(_win(bars))
    #        1봉색  2봉: 색 고>전고 종>전고 저>전저 종>전저   3봉: 색 고 종 저 종
    assert sig.tolist() == [1, -1, 1, -1, 1, 1, 1, 1, 1, 1, 1]
    assert st.relation_names(3) == [
        "1봉 색", "2봉 색", "2봉 고가 vs 전고", "2봉 종가 vs 전고", "2봉 저가 vs 전저",
        "2봉 종가 vs 전저", "3봉 색", "3봉 고가 vs 전고", "3봉 종가 vs 전고",
        "3봉 저가 vs 전저", "3봉 종가 vs 전저",
    ]
    assert len(sig) == st.relation_count(3) == 1 + 5 * 2


def test_ties_in_the_query_are_left_out_of_the_judgement():
    """쿼리에서 정확히 같은 값(3봉 고가 == 전고)은 부호 0 → 총수에서 빠진다.
    「같다」를 후보에 요구하면 실수 동률이라 아무도 못 맞춘다."""
    bars = [(10, 12, 9, 11), (11, 13, 10, 10.5), (10.5, 13, 10.2, 12.5)]
    sig = st.query_signature(_win(bars))
    assert sig[7] == 0                                 # 3봉 고가 vs 전고
    assert st.signature_total(sig) == len(sig) - 1


def test_matches_are_amplitude_free_and_count_every_flipped_relation():
    """같은 구조를 3배로 늘려도 전부 맞고, 2봉 색만 뒤집으면 정확히 하나 빠진다."""
    sig = st.query_signature(_win(_STRUCT))
    total = st.signature_total(sig)
    stretched = [(100 + 3 * (o - 100), 100 + 3 * (h - 100), 100 + 3 * (lo - 100), 100 + 3 * (c - 100))
                 for o, h, lo, c in _STRUCT]
    flipped = list(_STRUCT)
    flipped[1] = (104, 108, 103, 105)                   # 2봉을 양봉으로 — 고가·종가 관계는 그대로
    ch = np.concatenate([_win(stretched), _win(flipped)], axis=1)
    m = st.window_matches(ch, sig, _L)
    assert m[0] == total
    assert m[_L] == total - 1
    # 명시한 시작만 계산하는 경로도 같은 값을 낸다(`now` 가 쓰는 경로).
    assert st.window_matches(ch, sig, _L, np.array([0, _L])).tolist() == [total, total - 1]


# ── 검색과의 결합 ──────────────────────────────────────────────────────────────

def _corpus_with_two_candidates(tmp_path):
    """쿼리(000001) + 구조는 같지만 덜 닮은 A(000002) + 더 닮았지만 구조가 다른 B(000003).

    B 는 쿼리와 값이 거의 같고 2봉의 시·종가만 바꿔 **양봉**으로 만든 것 — 20값 중 둘만
    달라 상관 0.997. A 는 마지막 봉만 과장한 것(116→130 · 115→128) — 모든 관계의 부호는
    그대로인데 한 값이 분산을 먹어 상관 0.949. 난수를 쓰지 않는다: 노이즈는 0.6% 만 줘도
    「3봉 고가 > 2봉 고가」(108→109, 0.9% 차) 같은 촘촘한 관계를 뒤집는다(실측).
    """
    noisy = _STRUCT[:4] + [(106, 130, 105, 128)]
    b = list(_STRUCT)
    b[1] = (104, 108, 103, 105)
    bg = _bull_walk(40)
    rows = (_rows("000001", bg[:20] + _STRUCT + bg[20:])
            + _rows("000002", bg[:20] + noisy + bg[20:])
            + _rows("000003", bg[:20] + b + bg[20:]))
    c = sp.load_corpus(_write(tmp_path, rows))
    q = sp.query_vector(c, c.index_of("000001"), 20, _L)
    assert q is not None
    # 픽스처 전제를 테스트 안에서 재확인 — 깨지면 아래 단언이 무엇을 재는지 모르게 된다.
    sig = st.query_signature(sp._stack_window(c, c.index_of("000001"), 20, _L, ()))
    ch_a = sp._stack_window(c, c.index_of("000002"), 20, _L, ())
    assert (st.query_signature(ch_a) == sig).all(), "A 는 구조가 같아야 한다"
    return c, q, sig


def _history(c, q, *, gate=None):
    qi = c.index_of("000001")
    return sp.search_history(
        c, query=q, length=_L, query_series=qi, query_offset=20,
        min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False, struct=gate)


def test_gate_drops_the_higher_correlation_window_that_has_the_wrong_structure(tmp_path):
    """**게이트의 존재 이유.** 상관만으로는 B(구조 다름)가 1위인데, 허용 0 이면 B 가 사라지고
    A(구조 같음)만 남는다. `_gate_series` 의 마스크 줄을 지우면 빨개진다."""
    c, q, sig = _corpus_with_two_candidates(tmp_path)
    plain, _, _ = _history(c, q)
    by_code = {c.codes[m.series]: m for m in plain}
    assert by_code["000003"].score > by_code["000002"].score, "픽스처: B 가 더 닮아야 한다"

    gate = st.StructGate(matches=st.window_matches(c.ch, sig, _L),
                         need=st.signature_total(sig), total=st.signature_total(sig))
    gated, _, _ = _history(c, q, gate=gate)
    codes = [c.codes[m.series] for m in gated]
    assert "000003" not in codes
    assert "000002" in codes
    # 허용 1 이면 B(관계 하나 차이)가 돌아온다 — 단계가 실제로 뜻을 갖는다.
    loose = st.StructGate(matches=gate.matches, need=gate.total - 1, total=gate.total)
    back, _, _ = _history(c, q, gate=loose)
    assert "000003" in [c.codes[m.series] for m in back]


def test_gate_leaves_the_distribution_and_baseline_untouched(tmp_path):
    """분포·베이스라인은 **게이트 전 모집단**이다. 92개 안에서 p99.99 를 재면 최댓값이
    되어 길이 유연 병합(`corr − p99.99`)이 잡음이 된다."""
    c, q, sig = _corpus_with_two_candidates(tmp_path)
    _, scores_off, fwd_off = _history(c, q)
    gate = st.StructGate(matches=st.window_matches(c.ch, sig, _L),
                         need=st.signature_total(sig), total=st.signature_total(sig))
    _, scores_on, fwd_on = _history(c, q, gate=gate)
    assert len(scores_on) == len(scores_off) > 2
    np.testing.assert_array_equal(scores_on, scores_off)
    np.testing.assert_array_equal(fwd_on, fwd_off)
    # 히스토그램도 그 모집단을 센다 — 합이 후보창 수다.
    assert int(gate.hist.sum()) == len(scores_off)
    assert gate.hist[gate.total] >= 1                  # A 의 창


def test_resampled_query_signature_passes_the_stretched_copy_in_flex_lengths(tmp_path):
    """유연 길이에서 **기준 길이 서명을 그대로 쓰면** 이웃 블록이 거르지 않은 채 병합을
    채운다(공장값 ±2 라 기본 경로). 늘려 심은 사본이 그 길이의 게이트를 통과해야 한다."""
    # ⚠ **로그 공간에서** 늘린다 — 엔진의 리샘플이 중심화 로그가격을 보간하기 때문이다.
    #   가격 공간에서 보간하면 log 의 오목성 때문에 촘촘한 값들(109·110)의 순서가 바뀌어
    #   서명이 어긋난다(실제로 그렇게 짜서 한 번 빨갰다).
    src = np.linspace(0, _L - 1, 8)
    grid = np.arange(_L)
    arr = np.log(np.array(_STRUCT, dtype=float))
    stretched = list(zip(*[np.exp(np.interp(src, grid, arr[:, k])) for k in range(4)], strict=True))
    bg = _bull_walk(40)
    rows = _rows("000001", bg[:20] + _STRUCT + bg[20:]) + _rows("000002", bg[:20] + stretched + bg[20:])
    data = _write(tmp_path, rows)
    r = sp.run_pattern_search(data, PatternSearchRequest(
        code="000001", mode="history", **{"from": "20240129", "to": "20240202"},
        min_tv_eok=0, exclude_etf=False, no_overlap=False, forward_days=1,
        flex_bars=3, struct_tolerance=0))
    by_len = {b.length: b for b in r.results}
    assert 8 in by_len, "8봉 블록이 있어야 한다(5+3)"
    blk = by_len[8]
    hit = next((m for m in blk.matches if m.code == "000002"), None)
    assert hit is not None
    assert hit.struct_match == blk.struct_total
    assert hit.from_date == "20240129"


def test_now_gates_each_series_latest_window(tmp_path):
    """`now` 는 종목당 최신 창 하나 — 구조가 같은 종목만 남고 히스토그램은 자격 있는
    종목 수를 센다."""
    bg = _bull_walk(30)
    rows = (_rows("000001", bg[:25] + _STRUCT) + _rows("000002", bg[:25] + _STRUCT)
            + _rows("000003", bg[:30]))
    data = _write(tmp_path, rows)
    r = sp.run_pattern_search(data, PatternSearchRequest(
        code="000001", mode="now", lengths=[_L], min_tv_eok=0, exclude_etf=False,
        struct_tolerance=0))
    blk = r.results[0]
    assert [m.code for m in blk.matches] == ["000002"]
    assert blk.matches[0].struct_match == blk.struct_total
    assert sum(blk.struct_hist) == 2                    # 000002 · 000003 (쿼리 자신은 제외)
    assert blk.struct_hist[blk.struct_total] == 1


# ── wire ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path):
    bg = _bull_walk(40)
    rows = _rows("000001", bg[:20] + _STRUCT + bg[20:]) + _rows("000002", bg[:20] + _STRUCT + bg[20:])
    app = FastAPI()
    app.include_router(build_router(data_dir=_write(tmp_path, rows)))
    return TestClient(app)


def test_route_carries_struct_fields_null_when_off_and_values_when_on(client):
    """`response_model` 을 실제로 지나서 — 끄면 키는 있되 null, 켜면 값·히스토그램."""
    body = {"code": "000001", "mode": "history", "from": "20240129", "to": "20240202",
            "min_tv_eok": 0, "exclude_etf": False, "no_overlap": False, "forward_days": 1}
    off = client.post("/api/screener/pattern-search", json=body).json()["results"][0]
    assert off["struct_total"] is None and off["struct_hist"] is None
    assert off["matches"][0]["struct_match"] is None

    on = client.post("/api/screener/pattern-search",
                     json={**body, "struct_tolerance": 0}).json()["results"][0]
    assert on["struct_total"] == 1 + 5 * (_L - 1)
    assert len(on["struct_hist"]) == on["struct_total"] + 1
    assert on["matches"][0]["struct_match"] == on["struct_total"]


def test_request_rejects_out_of_range_tolerance():
    with pytest.raises(ValueError):
        PatternSearchRequest(code="000001", struct_tolerance=-1)
    with pytest.raises(ValueError):
        PatternSearchRequest(code="000001", struct_tolerance=99)


def test_saved_tolerance_is_absent_by_default_and_round_trips_when_given():
    """부재는 `None` 으로 남는다 — 공장값이 끄기라 오늘은 「끄기」와 같은 결과지만, 모델이
    값을 지어내지 않아야 공장값을 켜는 날 부재와 끄기를 분리할 수 있다."""
    base = {"name": "n", "code": "000001", "stock_name": "",
            "window": {"kind": "recent", "bars": 7},
            "conditions": {"mode": "history"}}
    assert PatternSaveWriteRequest.model_validate(base).conditions.struct_tolerance is None
    given = {**base, "conditions": {"mode": "history", "struct_tolerance": 1}}
    assert PatternSaveWriteRequest.model_validate(given).conditions.struct_tolerance == 1


# ── 불일치 인덱스와 기대 문구 (PR 3) ───────────────────────────────────────────

def test_relation_phrases_say_what_the_query_expects_in_order():
    """문구는 **쿼리가 기대하는 것**이다 — 「4봉 양봉」은 "쿼리는 양봉인데 이 창은 아니다".
    `query_signature` 와 같은 인덱스라 행의 불일치 인덱스가 이 목록을 가리킨다."""
    bars = [(10, 12, 9, 11), (11, 13, 10, 10.5), (10.5, 14, 10.2, 13.5)]
    sig = st.query_signature(_win(bars))
    names = st.relation_phrases(sig, 3)
    assert len(names) == st.relation_count(3)
    assert names[0] == "1봉 양봉"
    assert names[1] == "2봉 음봉"
    assert names[2] == "2봉 고가 > 전고"
    assert names[3] == "2봉 종가 < 전고"
    assert names[6] == "3봉 양봉"


def test_relation_phrases_keep_a_slot_for_ties_so_indices_stay_aligned():
    """판정에서 뺀 관계(부호 0)도 자리를 지킨다 — 빼면 행의 인덱스가 통째로 밀린다."""
    bars = [(10, 12, 9, 11), (11, 13, 10, 10.5), (10.5, 13, 10.2, 12.5)]
    sig = st.query_signature(_win(bars))
    names = st.relation_phrases(sig, 3)
    assert len(names) == st.relation_count(3) > st.signature_total(sig)
    assert names[7] == "3봉 고가 = 전고"


def test_mismatches_lists_exactly_the_relations_that_differ():
    """불일치 수 + `window_matches` 의 일치 수 = 판정 관계 총수."""
    sig = st.query_signature(_win(_STRUCT))
    total = st.signature_total(sig)
    flipped = list(_STRUCT)
    flipped[1] = (104, 108, 103, 105)          # 2봉을 양봉으로
    miss = st.mismatches(sig, _win(flipped))
    assert len(miss) == 1
    assert st.relation_phrases(sig, _L)[miss[0]] == "2봉 음봉"
    assert int(st.window_matches(_win(flipped), sig, _L)[0]) == total - len(miss)
    assert st.mismatches(sig, _win(_STRUCT)) == []


def test_route_carries_miss_indices_that_resolve_against_the_relation_list(client):
    """라우트가 두 필드를 함께 낸다 — 인덱스만 있으면 화면이 이름을 못 붙이고, 문구만
    있으면 어느 것이 틀렸는지 모른다."""
    body = {"code": "000001", "mode": "history", "from": "20240129", "to": "20240202",
            "min_tv_eok": 0, "exclude_etf": False, "no_overlap": False, "forward_days": 1}
    off = client.post("/api/screener/pattern-search", json=body).json()["results"][0]
    assert off["struct_relations"] is None
    assert off["matches"][0]["struct_miss"] is None

    on = client.post("/api/screener/pattern-search",
                     json={**body, "struct_tolerance": 3}).json()["results"][0]
    assert len(on["struct_relations"]) == 1 + 5 * (_L - 1)
    for row in on["matches"]:
        assert len(row["struct_miss"]) == on["struct_total"] - row["struct_match"]
        for i in row["struct_miss"]:
            assert on["struct_relations"][i]        # 인덱스가 문구를 가리킨다


# ── 기준선 방식 (PR 4) ────────────────────────────────────────────────────────

def test_fixed_anchor_holds_the_first_two_bars_line_while_running_climbs():
    """**두 기준의 차이가 드러나는 자리.** `_STRUCT` 는 3봉 고가(109)가 2봉(108)보다
    높아, running 은 4봉의 기준이 109 로 올라가고 first2 는 108 에 머문다.

    자리 수는 두 기준이 **같다**(1+5(L−1)) — 그래야 `relation_phrases` 의 인덱스가
    기준과 무관해진다.
    """
    win = _win(_STRUCT)
    run = st.query_signature(win)
    fix = st.query_signature(win, "first2")
    assert len(run) == len(fix) == st.relation_count(_L)
    # 4봉 고가(110)는 두 기준 모두 넘는다 — 갈리는 것은 «무엇을 넘었나» 다.
    # 3봉 저가(102)는 running 기준 min(lo0,lo1)=99 위, first2 도 99 위로 같다.
    # 실제로 갈리는 자리를 값으로 찾는다(픽스처가 바뀌면 여기서 드러난다).
    differing = [i for i in range(len(run)) if run[i] != fix[i]]
    assert differing, "두 기준이 같은 답을 내면 이 축이 아무 일도 안 한다"


def test_fixed_anchor_reproduces_the_hand_rule_level(tmp_path):
    """고정 기준의 존재 이유 — 「첫 두 봉이 만든 선을 뒤 봉들이 시험한다」.

    3봉이 2봉 고가를 넘어 running 기준을 끌어올린 창을 심는다. 그 창은 4봉이 **옛 선
    위·새 선 아래**라, 손 규칙(고정선)으로는 통과하지 못하고 running 으로는 통과한다.
    """
    # 4봉 고가 108.5 — 첫 두 봉 최고(108)는 넘지만 3봉 고가(109)는 못 넘는다.
    tricky = list(_STRUCT)
    tricky[3] = (105, 108.5, 103, 106)
    sig_fix = st.query_signature(_win(_STRUCT), "first2")
    sig_run = st.query_signature(_win(_STRUCT))
    m_fix = int(st.window_matches(_win(tricky), sig_fix, _L, None, "first2")[0])
    m_run = int(st.window_matches(_win(tricky), sig_run, _L)[0])
    # running 은 「4봉 고가 > 전고(109)」를 요구하는데 108.5 라 못 맞춘다.
    assert m_run < st.signature_total(sig_run)
    # 고정 기준은 「4봉 고가 > 첫2봉 최고(108)」라 108.5 가 맞춘다.
    assert m_fix == st.signature_total(sig_fix)


def test_phrases_name_the_anchor_so_the_meaning_does_not_drift():
    """⚠ 인덱스는 맞는데 **뜻이 어긋나는** 것을 막는다 — 고정 기준인데 「전고」라고 적으면
    사용자는 「직전 봉까지의 최고」로 읽는다."""
    win = _win(_STRUCT)
    run = st.relation_phrases(st.query_signature(win), _L)
    fix = st.relation_phrases(st.query_signature(win, "first2"), _L, "first2")
    assert len(run) == len(fix)
    assert any("전고" in p for p in run)
    assert not any("전고" in p for p in fix)
    assert any("첫2봉 최고" in p for p in fix)
    # 색 관계는 기준과 무관하므로 두 목록에서 같다 — 인덱스 정렬의 증거이기도 하다.
    assert run[0] == fix[0] == "1봉 양봉"


def test_route_carries_the_anchor_through_to_relations(client):
    body = {"code": "000001", "mode": "history", "from": "20240129", "to": "20240202",
            "min_tv_eok": 0, "exclude_etf": False, "no_overlap": False, "forward_days": 1,
            "struct_tolerance": 3}
    run = client.post("/api/screener/pattern-search", json=body).json()["results"][0]
    fix = client.post("/api/screener/pattern-search",
                      json={**body, "struct_anchor": "first2"}).json()["results"][0]
    assert any("전고" in p for p in run["struct_relations"])
    assert any("첫2봉 최고" in p for p in fix["struct_relations"])
    assert len(run["struct_relations"]) == len(fix["struct_relations"])


def test_request_rejects_unknown_anchor():
    with pytest.raises(ValueError):
        PatternSearchRequest(code="000001", struct_anchor="first3")
