"""봉 패턴 검색 엔진 (ADR-0166).

**합성 parquet 픽스처로만 돈다** — 실코퍼스(137MB)를 읽으면 다른 머신에서 실패하고,
데이터가 갱신될 때마다 단언이 흔들린다.

이 파일이 닫는 방향:
* 커널이 **정말 그 패턴을 찾는가**(아핀 사본을 심고 그 위치를 되찾는다).
* 정규화가 **채널 공유**인가 — 이게 갈리면 캔들 매칭이 조용히 「4개 라인 매칭」이 된다.
  못 보는 것: 두 방식이 **같은 답을 내는** 입력에서는 이 가드가 침묵한다. 그래서
  픽스처가 꼬리 길이만 다른 후보를 일부러 넣는다.
* 로더가 못 쓰는 봉(정합성 위반·비양수·평탄)을 거르는가.
* 라우트가 `response_model` 을 **실제로 지나** wire 키를 그대로 내는가.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import screener_pattern as sp
from hoga.api.models import PatternSearchRequest
from hoga.api.screener import build_router

_START = dt.date(2024, 1, 1)


def _dates(n: int, start: dt.date = _START) -> list[dt.date]:
    """주말을 건너뛴 연속 거래일 — 달력 정확도는 이 엔진의 관심사가 아니다(봉 인덱스로 돈다)."""
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def _series(code: str, closes, *, wick=0.01, body=0.6, volume=10**9, start=_START):
    """종가 궤적에서 OHLC 를 만든다.

    `wick` 이 이 헬퍼의 요점이다 — 종가 궤적이 같아도 꼬리 길이가 다르면 **다른 캔들**이고,
    공유 스케일 정규화만 그 차이를 본다.
    """
    rows = []
    for d, c in zip(_dates(len(closes), start), closes, strict=True):
        o = c * (1 - body * 0.01)
        hi = max(o, c) * (1 + wick)
        lo = min(o, c) * (1 - wick)
        rows.append({"code": code, "date": d, "open": o, "high": hi, "low": lo,
                     "close": float(c), "volume": volume})
    return rows


def _flat(code: str, n: int, price: float = 50.0, start=_START):
    """단일가 계열 — 정지 종목의 모양이다. `_series` 로는 만들 수 없다(몸통·꼬리가 생긴다)."""
    return [{"code": code, "date": d, "open": price, "high": price, "low": price,
             "close": price, "volume": 10**9} for d in _dates(n, start)]


def _write(tmp_path, rows, *, stocks=None):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows, schema={
        "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
        "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
    }).write_parquet(sdir / "daily_adjusted.parquet")
    codes = sorted({r["code"] for r in rows})
    stocks = stocks or [{"code": c, "name": f"종목{c}", "market": "KOSPI",
                         "is_etf": False, "is_halted": False} for c in codes]
    pl.DataFrame(stocks).write_parquet(sdir / "stocks.parquet")
    sp.reset_cache()
    return tmp_path


#: 기준 패턴 — 오르내림이 뚜렷해 우연히 재현되지 않는다.
_PATTERN = [100, 108, 104, 112, 106, 115, 110]
_LEN = len(_PATTERN)


@pytest.fixture
def corpus(tmp_path):
    n = 60
    rng = np.random.default_rng(7)
    noise = 100 + np.cumsum(rng.normal(0, 1.5, n))
    rows: list[dict] = []
    # A = 쿼리 종목. 계열 **끝**이 기준 패턴이다.
    rows += _series("000001", list(noise[: n - len(_PATTERN)]) + _PATTERN)
    # B = 같은 패턴의 **사본**을 offset 20 에 심었다(가격대가 3배여도 잡혀야 한다).
    #     ⚠ 곱셈만 쓴다 — 상관계수가 불변인 것은 **로그 공간의 아핀**이고, 가격에
    #     상수를 더하면(v*3+500) 로그에서 비율이 압축돼 모양이 실제로 달라진다.
    b = list(noise[:n])
    b[20 : 20 + len(_PATTERN)] = [v * 3.0 for v in _PATTERN]
    rows += _series("000002", b)
    # C = 단일가(정지) 계열 — O=H=L=C 라 창 표준편차가 0 이고 상관계수가 정의되지 않는다.
    rows += _flat("000003", n)
    # D = 무관한 계열.
    rows += _series("000004", list(100 + np.cumsum(rng.normal(0, 1.5, n))))
    return _write(tmp_path, rows)


def _query(c, code="000001", length=_LEN):
    i = c.index_of(code)
    assert i is not None, f"픽스처에 {code} 가 없다"
    off = c.series_len(i) - length
    return i, off, sp.query_vector(c, i, off, length)


def test_planted_affine_copy_is_found_at_its_offset(corpus):
    """red-check 의 원형 — 심은 사본을 **그 위치로** 되찾지 못하면 커널이 틀린 것이다."""
    c = sp.load_corpus(corpus)
    qi, off, q = _query(c)
    hits, _, _ = sp.search_history(
        c, query=q, length=len(_PATTERN), query_series=qi, query_offset=off,
        min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False)
    best = hits[0]
    assert c.codes[best.series] == "000002"
    assert best.offset == 20
    assert best.score == pytest.approx(1.0, abs=1e-9)


def test_query_is_invariant_to_affine_transform(corpus):
    """가격대·변동폭이 달라도 같은 모양이면 같은 답 — 정규화가 하는 일 그 자체."""
    c = sp.load_corpus(corpus)
    qi, off, q = _query(c)
    scaled = sp._znorm(sp._window(c, qi, off, len(_PATTERN)) * 3.0 + 5.0)
    for query in (q, scaled):
        hits, _, _ = sp.search_history(
            c, query=query, length=len(_PATTERN), query_series=qi, query_offset=off,
            min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False)
        assert (c.codes[hits[0].series], hits[0].offset) == ("000002", 20)


def test_normalization_is_shared_across_channels_not_per_channel(tmp_path):
    """**이 파일에서 가장 중요한 가드.**

    세 계열의 종가 궤적이 **완전히 같고 꼬리 길이만 다르다**. 채널별로 정규화하면
    O·H·L·C 각 계열의 모양만 보므로 셋이 구별되지 않는다(전부 corr≈1). 창 전체를
    한 스케일로 눌러야 꼬리가 긴 봉이 다른 캔들로 읽힌다.
    """
    rows = (_series("000001", _PATTERN * 4, wick=0.005)
            + _series("000002", _PATTERN * 4, wick=0.005)     # 같은 꼬리 → 닮아야
            + _series("000003", _PATTERN * 4, wick=0.15))     # 긴 꼬리 → 덜 닮아야
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c)
    now, _ = sp.search_now(c, query=q, length=len(_PATTERN), skip=qi,
                           min_tv_eok=0, exclude_etf=False)
    by_code = {c.codes[m.series]: m.score for m in now}
    assert by_code["000002"] == pytest.approx(1.0, abs=1e-9)
    # 꼬리만 다른 계열은 **뚜렷하게** 낮아야 한다. 채널별 정규화였다면 여기도 1.0 이다.
    assert by_code["000003"] < 0.98
    assert by_code["000002"] - by_code["000003"] > 0.02


def test_volume_axis_splits_series_that_have_identical_candles(tmp_path):
    """**거래량 축의 판별 픽스처.**

    세 계열의 캔들이 **완전히 같고 거래량 궤적만 다르다**. `volume_weight=0` 이면
    셋이 동점이고(가격만 보므로), 켜면 갈린다. 이 대칭이 깨지면 가중 합산의 부호나
    스케일이 틀린 것이다.

    못 보는 것: 거래량 축이 «좋은» 답을 내는지는 여기서 안 잰다 — 그건 취향이고,
    이 테스트는 그 축이 **실제로 관여하는가**만 본다.
    """
    vols = {"000001": [1, 5, 1, 5, 1, 5, 1], "000002": [1, 5, 1, 5, 1, 5, 1],
            "000003": [5, 1, 5, 1, 5, 1, 5]}
    rows: list[dict] = []
    for code, v in vols.items():
        base = _series(code, _PATTERN * 4)
        for k, row in enumerate(base):
            row["volume"] = v[k % len(v)] * 10**8
        rows += base
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c)
    vq = sp._volume_query(c, qi, off, _LEN)
    assert vq is not None

    def scores(weight):
        res, _ = sp.search_now(c, query=q, length=_LEN, skip=qi, min_tv_eok=0,
                               exclude_etf=False, volume_query=vq, volume_weight=weight)
        return {c.codes[m.series]: m.score for m in res}

    off_axis = scores(0.0)
    assert off_axis["000002"] == pytest.approx(off_axis["000003"], abs=1e-9)
    on_axis = scores(0.3)
    # 같은 거래량 궤적이 앞선다.
    assert on_axis["000002"] > on_axis["000003"]
    # ★ **값을 직접 잰다.** 순서만 보면 `w` 와 `1-w` 를 뒤집어도 통과한다(반대 위상은
    #   어느 가중에서도 여전히 뒤라서다). 000003 은 가격 +1 · 거래량 -1 이므로
    #   0.7×1 + 0.3×(-1) = 0.4 여야 하고, 뒤집힌 구현이면 -0.4 가 나온다.
    assert on_axis["000002"] == pytest.approx(1.0, abs=1e-6)
    assert on_axis["000003"] == pytest.approx(0.4, abs=0.02)


def test_volume_weight_keeps_self_match_at_one(corpus):
    """자기 구간은 가격도 거래량도 일치하므로 **가중을 켜도 1.0** 이다.

    이 단언이 가중 합산의 부호·스케일 실수를 잡는다(예: `w` 와 `1-w` 를 뒤집으면
    1.0 이 안 나온다).
    """
    c = sp.load_corpus(corpus)
    qi, off, q = _query(c)
    vq = sp._volume_query(c, qi, off, _LEN)
    hits, _, _ = sp.search_history(
        c, query=q, length=_LEN, query_series=qi, query_offset=-1,
        min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False,
        volume_query=vq, volume_weight=0.3)
    assert hits[0].score == pytest.approx(1.0, abs=1e-9)


def test_flat_series_is_excluded(corpus):
    """정지·단일가 구간은 표준편차가 0 이라 상관계수가 정의되지 않는다."""
    c = sp.load_corpus(corpus)
    qi, off, q = _query(c)
    now, _ = sp.search_now(c, query=q, length=len(_PATTERN), skip=qi,
                           min_tv_eok=0, exclude_etf=False)
    assert "000003" not in {c.codes[m.series] for m in now}


def test_loader_drops_non_positive_and_inconsistent_ohlc(tmp_path):
    """`close > 0` 만으로 부족하다 — 정합성 위반 봉은 **존재할 수 없는 모양**이다."""
    rows = _series("000001", _PATTERN * 3)
    rows[5]["close"] = 0.0                       # 비양수 → log 가 -inf
    rows[9]["low"] = rows[9]["high"] * 2         # 저가 > 고가
    rows[12]["close"] = rows[12]["high"] * 3     # 종가가 고저 범위 밖
    c = sp.load_corpus(_write(tmp_path, rows))
    assert c.series_len(0) == len(rows) - 3
    assert np.isfinite(c.ch).all()


def test_liquidity_filter_uses_window_mean(tmp_path):
    """거래대금 하한은 **창 평균**이다(rolling min 이면 3배 느리다 — ADR-0166 결정 4)."""
    rows = _series("000001", _PATTERN * 4) + _series("000002", _PATTERN * 4, volume=1)
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c)
    kept, _ = sp.search_now(c, query=q, length=len(_PATTERN), skip=qi,
                            min_tv_eok=0, exclude_etf=False)
    filtered, _ = sp.search_now(c, query=q, length=len(_PATTERN), skip=qi,
                                min_tv_eok=1.0, exclude_etf=False)
    assert "000002" in {c.codes[m.series] for m in kept}
    assert "000002" not in {c.codes[m.series] for m in filtered}


def test_now_skips_series_that_stopped(tmp_path):
    """상장폐지·장기정지로 계열이 멈춘 종목은 '지금' 이 없다."""
    rows = (_series("000001", _PATTERN * 4)
            + _series("000002", _PATTERN * 4, start=dt.date(2020, 1, 1)))
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c)
    now, _ = sp.search_now(c, query=q, length=len(_PATTERN), skip=qi,
                           min_tv_eok=0, exclude_etf=False)
    assert "000002" not in {c.codes[m.series] for m in now}


def test_per_code_keeps_several_matches_per_series_with_exclusion(tmp_path):
    """`per_code` 는 한 종목에서 그 패턴이 나온 자리를 여러 개 남긴다.

    ⚠ 겹침 배제가 없으면 한 칸씩 밀린 같은 자리가 상위를 도배한다 — 이웃 창은 봉
    하나만 달라 점수가 거의 같다. 그래서 두 매치의 간격이 창 길이의 절반을 넘어야 한다.
    """
    rng = np.random.default_rng(3)
    noise = list(100 + np.cumsum(rng.normal(0, 1.5, 80)))
    # 같은 패턴을 한 계열의 **두 자리**에 심는다(멀리 떨어뜨려 배제 구역과 무관하게).
    for at in (10, 50):
        noise[at : at + _LEN] = [v * 2.0 for v in _PATTERN]
    rows = _series("000001", noise) + _series("000002", list(100 + np.cumsum(rng.normal(0, 1.5, 80))))
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c, "000001")

    def run(per_code):
        hits, _, _ = sp.search_history(
            c, query=q, length=_LEN, query_series=qi, query_offset=off,
            min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False,
            per_code=per_code)
        return [(c.codes[m.series], m.offset) for m in hits]

    one = run(1)
    assert len([x for x in one if x[0] == "000001"]) == 1
    many = run(3)
    mine = sorted(off for code, off in many if code == "000001")
    assert len(mine) >= 2                       # 두 자리를 모두 찾았다
    # 겹침 배제 — 두 매치가 창 길이의 절반보다 가깝지 않다.
    assert all(b - a > _LEN // 2 for a, b in zip(mine, mine[1:], strict=False))


def test_flex_finds_the_same_shape_stretched_over_more_bars(tmp_path):
    """**길이 유연 검색의 존재 이유.**

    7봉 패턴을 10봉에 걸쳐 전개해 심는다. 7봉으로만 찾으면 그 자리는 앞 7봉만 보이므로
    상관이 낮고, 쿼리를 10봉으로 리샘플하면 정확히 되찾는다. DTW 를 만들지 않는 근거다.

    못 보는 것: **국소 신축**(앞은 빠르고 뒤는 느린)은 이 방식이 원리적으로 못 잡는다.
    """
    rng = np.random.default_rng(17)
    noise = list(100 + np.cumsum(rng.normal(0, 1.5, 90)))
    # 균일 신축 사본 — 7봉 패턴을 10칸에 펼친다.
    src = np.linspace(0, _LEN - 1, 10)
    stretched = np.interp(src, np.arange(_LEN), np.array(_PATTERN, dtype=float))
    noise[30:40] = list(stretched)
    rows = _series("000001", _PATTERN * 4) + _series("000002", noise)
    c = sp.load_corpus(_write(tmp_path, rows))
    qi, off, q = _query(c)

    def top_of(length):
        query = q if length == _LEN else sp.resample_query(q, length)
        hits, _, _ = sp.search_history(
            c, query=query, length=length, query_series=qi, query_offset=off,
            min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False)
        best = next((m for m in hits if c.codes[m.series] == "000002"), None)
        return best

    at_seven = top_of(_LEN)
    at_ten = top_of(10)
    assert at_ten is not None
    assert at_ten.offset == 30
    # 리샘플한 길이가 **더 잘** 맞아야 이 기능이 값을 한다.
    assert at_ten.score > (at_seven.score if at_seven else 0)
    # 완전한 1.0 은 아니다 — 픽스처가 **종가만** 신축하고 OHLC 는 그 종가에서 만들어져
    # 몸통·꼬리 비율이 미세하게 어긋난다. 실데이터에서도 같은 이유로 1.0 은 안 나온다.
    assert at_ten.score == pytest.approx(1.0, abs=1e-3)


def test_resample_keeps_normalisation_and_shape(tmp_path):
    """리샘플은 시간축만 바꾼다 — 채널 수와 정규화(평균 0·표준편차 1)는 그대로다."""
    c = sp.load_corpus(_write(tmp_path, _series("000001", _PATTERN * 4)))
    _, _, q = _query(c)
    for out in (5, 7, 12):
        r = sp.resample_query(q, out)
        assert r.shape == (4, out)
        assert r.mean() == pytest.approx(0.0, abs=1e-9)
        assert r.std() == pytest.approx(1.0, abs=1e-9)


@pytest.mark.parametrize("base, flex, expected", [
    (7, 0, [7]),
    (7, 2, [5, 6, 7, 8, 9]),
    (5, 2, [5, 6, 7]),          # 하한에서 잘린다
    (29, 2, [27, 28, 29, 30]),  # 상한에서 잘린다
])
def test_flex_lengths_clamp_to_the_allowed_window(base, flex, expected):
    """응답 시간을 바운드하는 상하한 안으로만 펼친다."""
    assert sp.flex_lengths(base, flex) == expected


def test_flex_does_not_multiply_with_the_length_scrubber(client):
    """`lengths`(각 길이의 최신 창)와 flex(한 쿼리의 리샘플)는 **다른 축**이다.

    곱하면 11 × 5 = 55회가 돌고, 기준 7봉 질의에서 15봉 매치가 상위에 오른다(실측).
    유연이 켜지면 스크럽을 접고 **첫 길이만** 편다.
    """
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7, 8, 9, 10],
                          "flex_bars": 1, "min_tv_eok": 0, "exclude_etf": False})
    # 7 ± 1 뿐 — 8·9·10 의 최신 창은 돌지 않는다.
    assert [x["length"] for x in r.json()["results"]] == [6, 7, 8]


def test_flex_keeps_the_query_window_at_the_base_length(client):
    """리샘플한 것은 **비교에 쓰는 벡터**이지 사용자가 그은 구간이 아니다.

    응답의 `query` 는 기준 길이 그대로여야 화면의 「기준 봉」 이 흔들리지 않는다.
    """
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7], "flex_bars": 2,
                          "min_tv_eok": 0, "exclude_etf": False})
    results = r.json()["results"]
    assert [x["length"] for x in results] == [5, 6, 7, 8, 9]
    assert {x["query"]["length"] for x in results} == {7}


def test_since_narrows_the_candidate_pool_not_the_result_list(tmp_path):
    """`since` 는 **후보 모집단**을 바꾼다 — 결과를 자르는 것이 아니다.

    그 차이가 이 기능의 설계선이다: 기간을 좁히면 그 안에서 **다시 상위를 뽑으므로**,
    좁힌 뒤에도 목록이 꽉 찬다(실측: 2025-09 이후로 제한해도 40행). 유사도 하한·결과
    수는 반대로 이미 뽑은 결과를 자르며 **프론트가** 한다.
    """
    rng = np.random.default_rng(11)
    noise = list(100 + np.cumsum(rng.normal(0, 1.5, 120)))
    for at in (10, 60, 100):
        noise[at : at + _LEN] = [v * 2.0 for v in _PATTERN]
    c = sp.load_corpus(_write(tmp_path, _series("000001", noise)))
    qi, off, q = _query(c)

    def run(since):
        hits, _, _ = sp.search_history(
            c, query=q, length=_LEN, query_series=qi, query_offset=off,
            min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False,
            per_code=5, since=since)
        return [c.date_at(m.series, m.offset) for m in hits]

    everything = run(None)
    assert min(everything) < dt.date(2024, 4, 1)
    cut = dt.date(2024, 4, 1)
    narrowed = run(np.datetime64(cut.isoformat(), "D"))
    assert narrowed, "기간을 좁혔다고 결과가 사라지면 안 된다 — 그 안에서 다시 뽑는다"
    assert all(d >= cut for d in narrowed)


def test_since_that_excludes_everything_returns_empty_not_error(client):
    """모든 창을 걸러내는 기간은 **빈 결과**다 — 500 이 아니다.

    조건이 셋이면 사용자가 빈 조합을 만들 수 있고(짧은 기간 + 동시대 제외),
    그때 화면은 안내를 띄워야지 에러를 띄우면 안 된다.
    """
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "history", "lengths": [7],
                          "since": "20991231", "min_tv_eok": 0, "exclude_etf": False})
    assert r.status_code == 200
    assert r.json()["results"] == []


def test_no_overlap_drops_windows_sharing_dates_with_query(corpus):
    """동시대 매치를 빼는 스위치 — 안 빼면 같은 장세를 겪은 종목이 상위를 지배한다."""
    c = sp.load_corpus(corpus)
    qi, off, q = _query(c)
    q_from = c.date_at(qi, off)
    hits, _, _ = sp.search_history(
        c, query=q, length=len(_PATTERN), query_series=qi, query_offset=off,
        min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=True)
    for m in hits:
        assert c.date_at(m.series, m.offset + len(_PATTERN) - 1) < q_from


def test_cache_is_invalidated_when_corpus_is_rewritten(tmp_path):
    """`derive_adjusted` 가 파일을 **통째로 재작성**하므로 mtime 무효화가 계약이다."""
    c1 = sp.load_corpus(_write(tmp_path, _series("000001", _PATTERN * 4)))
    assert sp.load_corpus(tmp_path) is c1                       # 같은 파일 → 같은 객체
    _write(tmp_path, _series("000001", _PATTERN * 6))           # 재작성
    c2 = sp.load_corpus(tmp_path)
    assert c2 is not c1
    assert c2.series_len(0) > c1.series_len(0)


def test_bars_at_round_trips_to_original_prices(corpus):
    """썸네일 원가격은 중심화 상수로 되돌린다 — parquet 재스캔을 없앤 자리다."""
    c = sp.load_corpus(corpus)
    i = c.index_of("000001")
    assert i is not None
    got = np.array(sp.bars_at(c, i, c.series_len(i) - len(_PATTERN), len(_PATTERN)))
    assert got[:, 3] == pytest.approx(_PATTERN, rel=1e-12)


# ── 라우트 계약 ────────────────────────────────────────────────────────────────

@pytest.fixture
def client(corpus):
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    return TestClient(app)


def test_route_response_passes_response_model_with_wire_keys(client):
    """**함수 직접 호출이 아니라 TestClient** 로 — `response_model` 은 선언되지 않은
    키를 500 없이 **조용히 버린다**(CLAUDE.md). 그 단계를 실제로 지나야 잡힌다."""
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7], "top": 3,
                          "min_tv_eok": 0, "exclude_etf": False})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"code", "name", "mode", "timeframe", "results",
                         "empty_reason", "coverage_from", "coverage_to"}
    # 결과가 있으면 이유는 null 이지만 **키는 남는다** — 부재와 null 이 다른 계약이라
    # 이 라우트에 `response_model_exclude_none` 을 걸면 안 된다(CLAUDE.md).
    assert body["empty_reason"] is None
    # 커버리지는 결과 유무와 무관하게 실린다. 값이 있어야 화면이 「그럼 어디를 그으면
    # 되나」에 답할 수 있다 — 여기서 조용히 스트립되면 그 문장이 통째로 사라진다.
    assert body["coverage_from"] and body["coverage_to"]
    result = body["results"][0]
    assert set(result) == {"length", "query", "ma_periods", "universe", "dist",
                           "matches", "baseline", "partial_last_bucket_days",
                           "struct_total", "struct_hist", "elapsed_ms"}
    assert set(result["dist"]) == {"p50", "p95", "p99", "p99_99", "sample"}
    row = result["matches"][0]
    assert set(row) == {"code", "name", "from_date", "to_date", "corr", "bars",
                        "tail", "forward_pct", "ma", "struct_match"}
    assert len(row["bars"][0]) == 4                    # [open, high, low, close]


def test_now_carries_null_baseline_rather_than_dropping_it(client):
    """`now` 에 baseline 이 없다고 **키를 지우면** `forward_pct` 의 정당한 null 과
    구별이 사라진다 — 그래서 `response_model_exclude_none` 을 안 쓴다."""
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7],
                          "min_tv_eok": 0, "exclude_etf": False})
    result = r.json()["results"][0]
    assert "baseline" in result and result["baseline"] is None
    assert result["matches"][0]["tail"] is None


def test_history_carries_baseline_and_tail(client):
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "history", "lengths": [7],
                          "min_tv_eok": 0, "exclude_etf": False,
                          "no_overlap": False, "forward_days": 3})
    result = r.json()["results"][0]
    assert set(result["baseline"]) == {"fwd_median_pct", "fwd_win_rate_pct", "sample"}
    assert len(result["matches"][0]["tail"]) == 3


def test_now_returns_one_result_per_requested_length(client):
    """봉수 스크럽의 전제 — 길이 여러 개가 **한 요청**에 온다(ADR-0166 결정 3)."""
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [5, 7, 10],
                          "min_tv_eok": 0, "exclude_etf": False})
    assert [x["length"] for x in r.json()["results"]] == [5, 7, 10]


def test_from_to_wire_keys_are_accepted_and_define_the_length(client):
    """`from` 은 파이썬 예약어라 alias 다 — **wire 키를 직접 재지 않으면**
    alias 를 지워도 파이썬은 멀쩡히 돈다(CLAUDE.md)."""
    days = _dates(60)
    frm, to = days[30].strftime("%Y%m%d"), days[38].strftime("%Y%m%d")
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7],
                          "from": frm, "to": to, "min_tv_eok": 0, "exclude_etf": False})
    assert r.status_code == 200
    result = r.json()["results"][0]
    # 날짜 구간이 길이를 정한다 — `lengths` 의 7 이 아니라 구간의 봉 수 9 다.
    assert result["length"] == 9
    assert (result["query"]["from_date"], result["query"]["to_date"]) == (frm, to)


def test_dated_range_is_capped_because_lengths_validation_does_not_apply(client):
    """**날짜 경로는 `lengths` 검증을 안 탄다** — 길이를 요청이 말하지 않기 때문이다.

    그래서 `PATTERN_CEILING` 이 따로 지킨다. 없으면 드래그로 그은 200봉이 그대로 돌고,
    실측에서 33봉 구간이 사용자 서버에서 24.7초를 썼다.
    """
    days = _dates(60)
    over = days[sp.PATTERN_CEILING + 5].strftime("%Y%m%d")
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7],
                          "from": days[0].strftime("%Y%m%d"), "to": over,
                          "min_tv_eok": 0, "exclude_etf": False})
    # 요청 자체는 유효하다(lengths 는 7 이라 통과) — 막는 것은 구간의 **실제 길이**다.
    assert r.status_code == 200
    assert r.json()["results"] == []


@pytest.mark.parametrize("payload", [
    {"lengths": []},
    {"lengths": [4]},                         # PATTERN_MIN_BARS 미만
    {"lengths": [31]},                        # PATTERN_MAX_BARS 초과
    {"lengths": [7, 7]},                      # 중복
    {"lengths": list(range(5, 17))},          # PATTERN_MAX_LENGTHS 초과
    {"from": "20240101"},                     # to 없이 from 만
])
def test_request_validation_rejects_bad_lengths_and_half_ranges(client, payload):
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [7], **payload})
    assert r.status_code == 422


def test_unknown_code_returns_empty_results_not_error(client):
    """코퍼스에 없는 종목은 빈 결과다 — 신규 상장이 500 을 내면 안 된다."""
    r = client.post("/api/screener/pattern-search",
                    json={"code": "999999", "mode": "now", "lengths": [7]})
    assert r.status_code == 200
    assert r.json()["results"] == []


def test_missing_corpus_returns_empty_results(tmp_path):
    """무자격·미시드 환경은 dev 와 e2e 의 **정상 경로**다 — 여기서 깨지면 그 환경이 전부 500."""
    sp.reset_cache()
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    r = TestClient(app).post("/api/screener/pattern-search",
                             json={"code": "000001", "mode": "now", "lengths": [7]})
    assert r.status_code == 200
    assert r.json()["results"] == []


def test_request_model_exposes_from_as_wire_alias():
    """모델 층에서도 alias 를 직접 재둔다 — 라우트를 안 지나는 소비자를 위해서다."""
    req = PatternSearchRequest.model_validate(
        {"code": "000001", "lengths": [7], "from": "20240101", "to": "20240110"})
    assert req.from_ == "20240101"
    assert "from" in req.model_dump(by_alias=True)


# ── 이평 채널 (ADR-0166 결정 11) ────────────────────────────────────────────

def _ma_corpus(tmp_path):
    """정배열 하나 · 역배열 하나 · 같은 캔들 모양을 양쪽에 심는다.

    끝 7봉의 **종가 궤적이 셋 다 같다** — 그래서 캔들만 보는 검색은 셋을 가르지 못하고,
    이평 채널만 「어느 추세 위에 얹혔는가」를 본다. 앞 구간의 기울기가 그 차이를 만든다.
    """
    n = 90
    tail = [100, 108, 104, 112, 106, 115, 110]
    up = list(np.linspace(60, 100, n - len(tail)))      # 오름세 뒤 → 5일선이 20일선 위
    down = list(np.linspace(150, 100, n - len(tail)))   # 내림세 뒤 → 20일선이 5일선 위
    rows: list[dict] = []
    rows += _series("000001", up + tail)                 # 기준: 정배열
    rows += _series("000002", up + tail)                 # 같은 배열 · 같은 캔들
    rows += _series("000003", down + tail)               # **역배열** · 같은 캔들
    return _write(tmp_path, rows)


def _run(tmp_path, **kw):
    req = PatternSearchRequest(code="000001", mode="now", lengths=[7],
                               min_tv_eok=0, exclude_etf=False, top=10, **kw)
    return sp.run_pattern_search(tmp_path, req).results[0]


def test_ma_off_carries_no_periods_and_no_lines(tmp_path):
    r = _run(_ma_corpus(tmp_path))
    assert r.ma_periods == []
    assert r.query.ma is None
    assert all(m.ma is None for m in r.matches)


def test_ma_preset_carries_one_line_per_period_in_declared_order(tmp_path):
    r = _run(_ma_corpus(tmp_path), ma_preset="short")
    assert r.ma_periods == [5, 20]
    # 바깥 리스트가 `ma_periods` 순서이고 안쪽이 봉수만큼 — 프론트가 이 계약으로 그린다.
    assert r.query.ma is not None
    assert [len(line) for line in r.query.ma] == [7, 7]
    assert [len(line) for line in r.matches[0].ma] == [7, 7]
    # 5일선이 20일선보다 최근값에 가깝다 = 원가격으로 되돌아왔다는 뜻(로그값이 아니다).
    assert all(v > 1 for line in r.query.ma for v in line)


def test_ma_channel_separates_the_two_arrangements(tmp_path):
    """같은 캔들이라도 **정배열과 역배열은 갈린다**.

    캔들만 보면 둘 다 상위에 온다(종가 궤적이 같으니 당연하다). 이평을 넣으면 역배열이
    아래로 밀린다 — 실측에서 상위 20 이 20/20 같은 순서로 나온 그 성질이다.
    """
    corpus = _ma_corpus(tmp_path)
    plain = {m.code: m.corr for m in _run(corpus).matches}
    # 같은 캔들이므로 캔들만 보는 검색은 둘을 거의 못 가른다.
    assert abs(plain["000002"] - plain["000003"]) < 0.05

    plain_gap = abs(plain["000002"] - plain["000003"])
    with_ma = {m.code: m.corr for m in _run(corpus, ma_preset="short").matches}
    ma_gap = with_ma["000002"] - with_ma["000003"]
    # 순서만이 아니라 **격차의 자릿수**가 달라져야 한다 — 이평이 실제로 축이 된 것이다.
    assert ma_gap > 0.1, f"역배열이 충분히 밀리지 않았다: {with_ma}"
    assert ma_gap > plain_gap * 5, f"캔들만({plain_gap:.4f}) 대비 벌어지지 않았다({ma_gap:.4f})"


def test_flat_series_is_not_revived_by_a_sloping_average(tmp_path):
    """평탄 판정은 **가격 채널만** 본다.

    이평을 섞어 재면 7봉 내내 멎은 종목이 「MA 가 기울어서」 표준편차를 얻어 되살아난다
    (실측: 모집단 2,675 → 2,713). 정지 종목은 캔들이 없으므로 매치가 아니다.
    """
    n = 90
    tail = [100, 108, 104, 112, 106, 115, 110]
    rows = _series("000001", list(np.linspace(60, 100, n - len(tail))) + tail)
    # 90봉을 오르다가 **마지막 7봉만** 한 가격에 멎었다 → MA5·MA20 은 여전히 기울어 있다.
    stalled = _series("000002", list(np.linspace(60, 100, n)))
    for row in stalled[-7:]:
        row["open"] = row["high"] = row["low"] = row["close"] = 100.0
    rows += stalled
    # 멎지 않은 후보 하나 — 없으면 결과가 통째로 비어 「배제됐다」와 구별되지 않는다.
    rows += _series("000003", list(np.linspace(60, 100, n - len(tail))) + tail)
    corpus = _write(tmp_path, rows)
    for preset in ("off", "short"):
        codes = [m.code for m in _run(corpus, ma_preset=preset).matches]
        assert codes, f"{preset}: 후보가 통째로 비었다 — 픽스처가 잘못됐다"
        assert "000002" not in codes, f"{preset}: 멎은 계열이 매치로 올라왔다"


def test_warmup_windows_are_dropped_from_the_candidate_pool(tmp_path):
    """이평이 아직 없는 앞 구간은 0 으로 채워 둔 자리다 — **후보에서 빠져야** 한다.

    ⚠ 「매치 상위에 안 온다」로는 이걸 못 잰다. 0 으로 채워진 창은 정규화 뒤 모양이
    극단적이라 어차피 상위에 못 오고, 그래서 마스킹을 지워도 상위 목록이 그대로다
    (실측으로 확인했다 — 처음 쓴 테스트가 그 함정에 걸렸다). 마스킹이 실제로 하는 일은
    **후보창을 줄이는 것**이므로 그 개수를 센다.
    """
    n, length = 60, 7
    rows = _series("000001", list(np.linspace(60, 100, n)))
    rows += _series("000002", list(np.linspace(60, 100, n)))
    c = sp.load_corpus(_write(tmp_path, rows))
    qi = c.index_of("000001")

    def pool(periods):
        _, scores, _ = sp.search_history(
            c, query=sp.query_vector(c, qi, n - length, length, periods),
            length=length, query_series=qi, query_offset=n - length,
            min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False,
            ma_periods=periods,
        )
        return len(scores)

    # MA20 의 워밍업은 19봉. 종목이 둘이므로 후보창이 정확히 38개 줄어든다.
    assert pool(()) - pool((5, 20)) == 19 * 2


def test_unknown_preset_falls_back_to_off_rather_than_erroring(tmp_path):
    # 요청이 답을 못 바꾸게 한다 — 모르는 이름은 이평 없음이다.
    assert sp.ma_periods_for("nope") == ()
    assert sp.ma_periods_for("short") == (5, 20)


# ── 정지 구간과 수치 붕괴 ────────────────────────────────────────────────────
#
# `test_flat_series_is_excluded` 는 **`search_now` 만** 잰다. now 는 표준편차를
# `.std()`(2-pass)로 재므로 정지 창의 값이 참값 그대로 0 이고, 그래서 그 가드는
# 통과했다 — **결함이 있던 경로는 `search_history`** 다. 거기서는 `_win_sd` 가
# cumsum 차분이라 계열이 길수록 파국적 상쇄가 커지고, 참값이 1e-16 인 창이 1e-8~1e-6
# 대의 표준편차로 되살아난다. 그 작은 수로 나눈 상관계수는 **1 을 넘었다**(실코퍼스
# 실측 1.250 — 참값 0.652).


def _long_series_with_flat_tail(tmp_path, n_pre: int = 500, n_flat: int = 120):
    """앞쪽 변동 구간 + 뒤쪽 **완전 정지** 구간.

    ⚠ **길이가 이 픽스처의 전부다.** 짧은 계열(50봉)에서는 cumsum 누적이 작아 오차가
    정확히 0 이라 결함이 재현되지 않는다 — 500봉이면 5e-08 이 된다(실측). 이 값을
    줄이면 아래 가드가 아무것도 증명하지 못한다.
    """
    rng = np.random.default_rng(3)
    px = [float(max(v, 10.0)) for v in 100 + np.cumsum(rng.normal(0, 1.5, n_pre))]
    rows = _series("000009", px)
    rows += _flat("000009", n_flat, price=50.0, start=_dates(n_pre + n_flat)[n_pre])
    # 쿼리가 될 무관한 계열 — 자기 자신만 있으면 검색할 대상이 없다.
    rows += _series("000001", _PATTERN * 20)
    return _write(tmp_path, rows)


def _history(c, code="000001", **kw):
    """(매치, **전 후보창 점수**). 뒤의 것이 「그 창이 후보에 들었는가」를 말해 준다."""
    qi, off, q = _query(c, code)
    matches, scores, _ = sp.search_history(
        c, query=q, length=_LEN, query_series=qi, query_offset=off,
        min_tv_eok=0, exclude_etf=False, min_after=0, no_overlap=False, **kw)
    return matches, scores


def test_flat_sd_sits_above_the_cumsum_error_floor(tmp_path):
    """`_FLAT_SD` 는 `_win_sd` 자신의 오차보다 **위**에 있어야 한다.

    이 가드가 닫는 방향: 상수가 오차 아래로 내려가는 것. 그러면 참값이 0 인 창이
    「표준편차가 있는 창」으로 통과하고, 그 작은 수로 나눈 상관계수가 1 을 넘는다
    (실코퍼스 실측 1.250 — 참값 0.652).

    못 보는 것: 실코퍼스의 오차 상한(2.4e-06)은 여기서 안 잰다 — 이 픽스처는 짧아
    5e-08 대다. 그 값은 상수의 주석이 근거를 든다.
    """
    c = sp.load_corpus(_long_series_with_flat_tail(tmp_path))
    i = c.index_of("000009")
    assert i is not None
    s, lo, hi = int(c.starts[i]), 500, 500 + 120 - _LEN
    # 참값은 부동소수 바닥이지 정확한 0 이 아니다 — 창의 값들은 전부 같다.
    assert float(c.ch[:, s + lo : s + lo + _LEN].std()) < 1e-15
    err = float(sp._win_sd(c, i, _LEN)[lo:hi].max())
    assert err > 1e-9, "픽스처가 짧아져 상쇄가 사라졌다 — n_pre 를 늘릴 것"
    assert err < sp._FLAT_SD, f"정지 창의 오차 {err:.2e} 가 _FLAT_SD 를 통과한다"


def test_flat_windows_leave_the_candidate_pool(tmp_path, monkeypatch):
    """정지 구간의 창은 **후보에서 빠진다**.

    순위로 재지 않는 이유: 정지 창은 쿼리와의 내적이 0 근처라 상관계수가 낮고, 그래서
    상위 목록에 애초에 안 온다 — 「결과에 없다」는 단언은 상수를 되돌려도 통과한다.
    후보창 **수**가 그 배제를 직접 말해 준다.
    """
    c = sp.load_corpus(_long_series_with_flat_tail(tmp_path))
    i = c.index_of("000009")
    assert i is not None
    # 옛 값을 통과하는 정지 창의 수 — 픽스처를 바꿔도 이 식이 따라온다.
    # (전부는 아니다. 오차가 정확히 0 인 창은 어느 임계값에서도 배제된다.)
    flat = sp._win_sd(c, i, _LEN)[500 : 500 + 120 - _LEN]
    leak = int((flat > 1e-9).sum())
    assert leak > 50, "픽스처가 결함을 재현하지 못한다 — n_pre 를 늘릴 것"

    _, kept = _history(c)
    monkeypatch.setattr(sp, "_FLAT_SD", 1e-9)          # 옛 값 — 자기 오차 아래
    _, leaked = _history(c)
    assert len(leaked) - len(kept) == leak


def test_history_drops_windows_whose_correlation_exceeds_the_ceiling(corpus, monkeypatch):
    """상한을 넘는 상관계수는 버린다 — 수학적으로 1 을 넘을 수 없기 때문이다.

    ⚠ **1 을 넘는 값을 합성으로 만들 수 없어** 상한을 낮춰 그 배제가 실제로 걸리는지
    잰다. 실코퍼스에서 그 값이 나오는 조건(참 sd 2.0e-07 을 cumsum 이 절반으로 계산)은
    부동소수 오차의 미묘한 자리에 있어 픽스처로 재현되지 않는다(시도했고, 합성 창은
    비가 0.985~1.000 이거나 정확히 0 이었다).

    그래서 이 가드가 증명하는 것은 **메커니즘이 걸린다**는 것이지 상한값이 옳다는
    것이 아니다. 값의 근거는 `_CORR_CEILING` 의 주석에 있다.
    """
    c = sp.load_corpus(corpus)
    before, _ = _history(c)
    assert before, "픽스처에 매치가 없으면 이 가드는 아무것도 재지 못한다"
    assert max(m.score for m in before) > 0.5

    monkeypatch.setattr(sp, "_CORR_CEILING", 0.5)
    after, _ = _history(c)
    assert all(m.score <= 0.5 for m in after)


# ── 주봉 파생 ────────────────────────────────────────────────────────────────
#
# 종목 주봉을 주는 벤더 경로가 **없어서**(키움 W/M TR 은 지수 전용) 일봉 parquet 에서
# 파생한다. 그래서 이 절이 닫는 방향은 하나다: **파생 규칙이 화면과 같은가.**
# 프론트는 `calendarBucketKey`(`aggregateCandles.ts`)로 주를 나누므로 그 규칙이 갈리면
# ADR-0166 이 내세운 「화면의 봉과 검색 대상이 같은 데이터」가 조용히 거짓이 된다.
#
# 못 보는 것: 프론트가 실제로 그 함수를 부르는지는 여기서 안 잰다(그쪽 테스트의 몫).
# 여기서는 **백엔드가 같은 답을 내는가**만 값으로 잰다.

_MON = dt.date(2026, 8, 10)   # 월요일
#: 실제 달력 — 2026-08-17(월)은 **휴일**이라 그 주는 화요일에 시작한다. 주봉의 7.6%가
#: 이 모양이고, 키(월)와 첫 거래일(화)이 갈리는 유일한 자리다.
_WEEK_DAYS = [
    dt.date(2026, 8, 10), dt.date(2026, 8, 11), dt.date(2026, 8, 12),
    dt.date(2026, 8, 13), dt.date(2026, 8, 14),                        # 1주: 월~금 5일
    dt.date(2026, 8, 18), dt.date(2026, 8, 19), dt.date(2026, 8, 20),
    dt.date(2026, 8, 21),                                              # 2주: 화~금 4일 ★
    dt.date(2026, 8, 24), dt.date(2026, 8, 25), dt.date(2026, 8, 26),
    dt.date(2026, 8, 27), dt.date(2026, 8, 28),                        # 3주: 월~금 5일
]


def _daily_rows(code: str, days, closes, volume=10**8):
    """날짜를 **직접** 준다 — `_series` 의 `_dates` 는 주말만 건너뛰어 휴일을 못 만든다."""
    return [
        {"code": code, "date": d, "open": c * 0.99, "high": c * 1.02,
         "low": c * 0.97, "close": float(c), "volume": volume}
        for d, c in zip(days, closes, strict=True)
    ]


def _weekly(tmp_path, rows):
    return sp.load_corpus(_write(tmp_path, rows), "W")


def test_weekly_bucket_key_is_the_monday_of_that_week(tmp_path):
    """버킷 키는 **그 주의 월요일**이다 — 프론트 `calendarBucketKey` 와 같은 규칙.

    red-check: 오프셋을 `weekday` 로 두면(월요일이 0 이 아니라 1 이 되면) 키가 일요일로
    밀려 이 단언이 깨진다.
    """
    c = _weekly(tmp_path, _daily_rows("000001", _WEEK_DAYS, range(100, 114)))
    i = c.index_of("000001")
    assert i is not None
    assert c.series_len(i) == 3          # 3주
    keys = [c.date_at(i, k) for k in range(3)]
    assert keys == [dt.date(2026, 8, 10), dt.date(2026, 8, 17), dt.date(2026, 8, 24)]
    assert all(k.weekday() == 0 for k in keys), "키가 월요일이 아니다"


def test_weekly_key_differs_from_the_first_trading_day_when_monday_is_a_holiday(tmp_path):
    """⚠ **키 ≠ 첫 거래일** — 이 비대칭이 주봉의 7.6%이고 두 방향으로 샌다.

    나가는 쪽: 응답이 키(휴일 월요일)를 실으면 차트에 그 날 캔들이 없어 착지 밴드가
    아무 데도 안 걸린다. 들어오는 쪽: 프론트가 보내는 날짜는 첫 거래일이라 키로
    비교하면 그 버킷이 통째로 빠진다.
    """
    c = _weekly(tmp_path, _daily_rows("000001", _WEEK_DAYS, range(100, 114)))
    i = c.index_of("000001")
    assert i is not None
    assert c.date_at(i, 1) == dt.date(2026, 8, 17)        # 키 = 월요일(휴일)
    assert c.first_day_at(i, 1) == dt.date(2026, 8, 18)   # 첫 거래일 = 화요일
    assert c.last_day_at(i, 1) == dt.date(2026, 8, 21)
    assert int(c.bucket_days[int(c.starts[i]) + 1]) == 4  # 그 주는 4거래일
    # 휴일이 없는 주는 셋이 같다.
    assert c.date_at(i, 0) == c.first_day_at(i, 0) == dt.date(2026, 8, 10)


def test_weekly_ohlc_takes_first_max_min_last_of_the_week(tmp_path):
    """OHLC 집계 규칙. 정합성은 구성상 보장되므로 **값**을 직접 잰다."""
    closes = [100, 130, 90, 120, 110,  200, 210, 190, 205,  300, 310, 290, 305, 301]
    assert len(closes) == len(_WEEK_DAYS)
    c = _weekly(tmp_path, _daily_rows("000001", _WEEK_DAYS, closes))
    i = c.index_of("000001")
    assert i is not None
    first_week = bars_of(c, i, 0)
    assert first_week["open"] == pytest.approx(100 * 0.99)   # 첫 봉의 시가
    assert first_week["high"] == pytest.approx(130 * 1.02)   # 주간 최고
    assert first_week["low"] == pytest.approx(90 * 0.97)     # 주간 최저
    assert first_week["close"] == pytest.approx(110)         # 마지막 봉의 종가


def bars_of(c, i, offset):
    o, h, low, cl = sp.bars_at(c, i, offset, 1)[0]
    return {"open": o, "high": h, "low": low, "close": cl}


def test_weekly_turnover_is_the_daily_mean_not_the_sum(tmp_path):
    """⚠ 거래대금은 **일평균**이다 — 합으로 두면 「50억 이상」이 주봉에서 실질 일 10억이 된다.

    red-check: `pl.col("tv").sum()` 으로 바꾸면 5일 버킷이 5배가 되어 이 단언이 깨진다.
    """
    # 종가 100 · 거래량 10^8 이면 일 거래대금은 (0.99+1.02+0.97+1)/4 × 100 × 10^8.
    c = _weekly(tmp_path, _daily_rows("000001", _WEEK_DAYS, [100] * len(_WEEK_DAYS)))
    i = c.index_of("000001")
    assert i is not None
    s = int(c.starts[i])
    daily_tv = (0.99 + 1.02 + 0.97 + 1.0) / 4 * 100 * 10**8
    for k, days in enumerate((5, 4, 5)):
        assert c.tv[s + k] == pytest.approx(daily_tv), \
            f"{k}번째 주({days}일)의 거래대금이 일평균이 아니다"


def test_daily_corpus_is_unchanged_by_the_timeframe_axis(tmp_path):
    """일봉은 버킷이 곧 그 날 — 세 날짜가 같고 `bucket_days` 는 1 이다."""
    c = sp.load_corpus(_write(tmp_path, _daily_rows("000001", _WEEK_DAYS, range(100, 114))), "D")
    i = c.index_of("000001")
    assert i is not None
    assert c.series_len(i) == len(_WEEK_DAYS)
    assert c.date_at(i, 1) == c.first_day_at(i, 1) == c.last_day_at(i, 1)
    assert set(np.unique(c.bucket_days)) == {1}
    # 상주를 아끼려고 **같은 객체**를 가리킨다(8.9M봉에서 143MB 차이다).
    assert c.first_days is c.dates and c.last_days is c.dates


def test_unknown_timeframe_falls_back_to_daily(tmp_path):
    """모르는 값은 `"D"` 로 떨어진다 — 요청이 답을 못 바꾼다(`ma_periods_for` 와 같은 규칙)."""
    d = _write(tmp_path, _daily_rows("000001", _WEEK_DAYS, range(100, 114)))
    assert sp.load_corpus(d, "1m").timeframe == "D"
    assert sp.load_corpus(d, "").timeframe == "D"
    # 코퍼스가 있는 값은 그대로 산다 — 폴백이 유효한 요청까지 삼키면 안 된다.
    assert sp.load_corpus(d, "M").timeframe == "M"


def test_cache_keeps_both_timeframes_of_the_same_snapshot(tmp_path):
    """같은 스냅샷의 일봉·주봉은 **함께 상주**한다.

    이 가드가 닫는 방향: timeframe 을 번갈아 쓸 때마다 재빌드가 나는 것(일봉 1.9s —
    사용자가 느끼는 지연이다). 옛 정책(`_cache.clear()`)이면 두 번째 호출이 첫 코퍼스를
    버려 객체 동일성이 깨진다.
    """
    d = _write(tmp_path, _daily_rows("000001", _WEEK_DAYS, range(100, 114)))
    daily, weekly = sp.load_corpus(d, "D"), sp.load_corpus(d, "W")
    assert daily is sp.load_corpus(d, "D"), "주봉을 만들면서 일봉 캐시를 버렸다"
    assert weekly is sp.load_corpus(d, "W")
    assert daily is not weekly


def _week_days(n_weeks: int, *, holiday_week: int | None = None, start=dt.date(2026, 6, 1)):
    """`n_weeks` 주의 거래일. `holiday_week` 번째 주는 **월요일이 휴일**이라 화요일에 연다."""
    assert start.weekday() == 0, "월요일에서 시작해야 주 경계가 자명하다"
    out: list[dt.date] = []
    for w in range(n_weeks):
        first = 1 if w == holiday_week else 0
        out += [start + dt.timedelta(days=w * 7 + k) for k in range(first, 5)]
    return out


def test_response_dates_are_trading_days_not_the_bucket_key(tmp_path, monkeypatch):
    """⚠ 응답의 `from_date`/`to_date` 는 **그 버킷의 거래일**이지 키가 아니다.

    이 가드가 닫는 방향: 키(월요일)를 그대로 실어 보내는 것. 그 날이 휴일이면 차트에
    캔들이 없어 **착지 밴드가 아무 데도 걸리지 않는다** — 화면에는 「밴드가 안 보인다」로
    나타나 원인이 응답 날짜라는 것을 숨긴다(주봉의 7.6%).

    라우트를 관통해서 잰다. `_ymd_from` 을 직접 부르면 그 함수가 **응답 조립에 실제로
    쓰이는지**는 증명하지 못한다.
    """
    days = _week_days(9, holiday_week=3)
    rows = _daily_rows("000001", days, [100 + (k * 7) % 23 for k in range(len(days))])
    rows += _daily_rows("000002", days, [100 + (k * 5) % 19 for k in range(len(days))])
    weekly = sp.load_corpus(_write(tmp_path, rows), "W")
    i = weekly.index_of("000001")
    assert i is not None
    holiday_key = dt.date(2026, 6, 22)                      # 4번째 주의 월요일
    assert weekly.date_at(i, 3) == holiday_key
    assert weekly.first_day_at(i, 3) == holiday_key + dt.timedelta(days=1)

    monkeypatch.setattr(sp, "load_corpus", lambda _d, tf="D": weekly)
    res = sp.run_pattern_search(tmp_path, PatternSearchRequest(
        code="000001", mode="now", lengths=[5], top=5, min_tv_eok=0, exclude_etf=False))
    assert res.results, "픽스처가 결과를 못 내면 이 가드는 아무것도 재지 못한다"
    q = res.results[0].query
    # 최근 5주 창의 시작은 5번째 전 주(=휴일 주 다음다음)이므로 여기서는 키=첫 거래일이다.
    # 휴일 주가 창에 들어가는 것은 `to_date` 쪽이 아니라 아래 직접 단언으로 잰다.
    assert q.from_date == weekly.first_day_at(i, weekly.series_len(i) - 5).strftime("%Y%m%d")
    assert q.to_date == weekly.last_day_at(i, weekly.series_len(i) - 1).strftime("%Y%m%d")
    # ★ 휴일 주를 **직접** 잰다 — 키(월)와 첫 거래일(화)이 갈리는 유일한 자리다.
    assert sp._ymd_from(weekly, i, 3) == "20260623"
    assert sp._ymd_to(weekly, i, 3) == "20260626"
    assert weekly.date_at(i, 3).strftime("%Y%m%d") == "20260622"    # 키는 다르다


def test_request_dates_select_buckets_by_trading_day_range(tmp_path):
    """⚠ 들어오는 날짜도 **거래일 범위로** 버킷을 고른다 — (b)의 나머지 절반이다.

    프론트가 보내는 날짜는 화면 봉의 타임스탬프 = 그 버킷의 **첫 거래일**이다
    (`aggregateCalendar` 가 Gap 회피 때문에 그렇게 잡는다). 월요일이 휴일이면 그 값이
    서버 키(월)보다 **뒤**라서, 키로 비교하면 사용자가 그은 첫 주가 통째로 빠진다.

    red-check: `_resolve_window` 를 `c.dates` 비교로 되돌리면 offset 이 한 주 밀린다.

    못 보는 것: 프론트가 정말 그 값을 보내는지는 여기서 안 잰다(그쪽 계약이다).
    """
    days = _week_days(9, holiday_week=3)
    c = sp.load_corpus(
        _write(tmp_path, _daily_rows("000001", days,
                                     [100 + (k * 7) % 23 for k in range(len(days))])), "W")
    i = c.index_of("000001")
    assert i is not None
    holiday_first = dt.date(2026, 6, 23)                    # 휴일 주의 첫 거래일(화)
    assert c.first_day_at(i, 3) == holiday_first
    assert c.date_at(i, 3) == dt.date(2026, 6, 22)          # 키는 월요일

    # 그 주부터 5주를 그은 셈 — 프론트는 **첫 거래일**을 실어 보낸다.
    win = sp._resolve_window(c, i, 5, "20260623", c.last_day_at(i, 7).strftime("%Y%m%d"))
    assert win is not None
    offset, span = win
    assert (offset, span) == (3, 5), "휴일 주가 빠져 창이 밀렸다"


# ── timeframe wire ──────────────────────────────────────────────────────────


def _weekly_client(tmp_path, monkeypatch, *, n_weeks=12, holiday_week=3):
    """주봉 코퍼스를 물린 TestClient. 라우트를 **관통해서** 재기 위한 것이다."""
    days = _week_days(n_weeks, holiday_week=holiday_week)
    rows: list[dict] = []
    for k, code in enumerate(("000001", "000002", "000003")):
        rows += _daily_rows(code, days, [100 + (i * (7 + k)) % 23 for i in range(len(days))])
    d = _write(tmp_path, rows)
    app = FastAPI()
    app.include_router(build_router(data_dir=d))
    return TestClient(app), sp.load_corpus(d, "W")


def test_timeframe_selects_the_weekly_corpus_through_the_route(tmp_path, monkeypatch):
    """요청의 `timeframe` 이 코퍼스를 고른다 — 그리고 응답이 그 값을 되싣는다.

    이 가드가 닫는 방향: 라우트가 `req.timeframe` 을 **무시하고** 늘 일봉을 읽는 것.
    그러면 화면은 주봉을 그리는데 결과는 일봉 패턴이 되어, #1715 가 고친 것과 **같은
    유형의 조용한 오답**이 wire 를 통해 돌아온다.
    """
    client, weekly = _weekly_client(tmp_path, monkeypatch)
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [5], "top": 3,
                          "min_tv_eok": 0, "exclude_etf": False, "timeframe": "W"})
    assert r.status_code == 200
    body = r.json()
    assert body["timeframe"] == "W"
    q = body["results"][0]["query"]
    # 주봉 5개는 **날짜로 5주**를 덮는다 — 일봉 코퍼스였다면 5거래일(한 주)이다.
    frm = dt.date.fromisoformat(f"{q['from_date'][:4]}-{q['from_date'][4:6]}-{q['from_date'][6:]}")
    too = dt.date.fromisoformat(f"{q['to_date'][:4]}-{q['to_date'][4:6]}-{q['to_date'][6:]}")
    assert (too - frm).days >= 25, f"{frm}~{too} 는 5주가 아니다 — 일봉 코퍼스를 읽었다"
    assert q["from_date"] == weekly.first_day_at(
        weekly.index_of("000001"), weekly.series_len(weekly.index_of("000001")) - 5
    ).strftime("%Y%m%d")


def test_timeframe_defaults_to_daily_when_absent(tmp_path, monkeypatch):
    """**부재는 `"D"`** 다 — 기존 저장·기존 클라이언트가 그대로 산다."""
    client, _ = _weekly_client(tmp_path, monkeypatch)
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [5], "top": 3,
                          "min_tv_eok": 0, "exclude_etf": False})
    assert r.json()["timeframe"] == "D"


def test_unknown_timeframe_is_rejected_by_the_request_model(tmp_path, monkeypatch):
    """모르는 값은 **422** 다 — 코퍼스 로더의 폴백에 기대지 않는다.

    로더도 모르는 값을 `"D"` 로 떨어뜨리지만(방어), 요청 단계에서 거절하는 편이
    「주봉을 달라고 했는데 일봉이 왔다」를 만들지 않는다.
    """
    client, _ = _weekly_client(tmp_path, monkeypatch)
    r = client.post("/api/screener/pattern-search",
                    json={"code": "000001", "mode": "now", "lengths": [5], "timeframe": "1m"})
    assert r.status_code == 422


def _partial_tail_client(tmp_path):
    """마지막 주가 **3일**뿐인 코퍼스 — 수요일에 검색한 셈이다."""
    days = _week_days(10)[:-2]
    rows = _daily_rows("000001", days, [100 + (i * 7) % 23 for i in range(len(days))])
    rows += _daily_rows("000002", days, [100 + (i * 5) % 19 for i in range(len(days))])
    d = _write(tmp_path, rows)
    app = FastAPI()
    app.include_router(build_router(data_dir=d))
    return TestClient(app), sp.load_corpus(d, "W")


def test_partial_last_bucket_is_reported_so_the_screen_can_say_it(tmp_path, monkeypatch):
    """미완성 마지막 봉을 **담되 말한다**.

    빼면 `now` 가 사용자가 보고 있지 않은 질문에 답하고(화면은 그 봉을 그린다), 말하지
    않으면 모든 매치의 마지막 봉이 같은 방식으로 왜곡된 채 비교된다.

    못 보는 것: 화면이 그 값을 실제로 라벨로 쓰는지는 여기서 안 잰다(프론트의 몫).
    """
    client, _ = _partial_tail_client(tmp_path)

    def ask(tf: str):
        return client.post("/api/screener/pattern-search",
                           json={"code": "000001", "mode": "now", "lengths": [5], "top": 3,
                                 "min_tv_eok": 0, "exclude_etf": False,
                                 "timeframe": tf}).json()["results"][0]

    assert ask("W")["partial_last_bucket_days"] == 3
    # 일봉은 버킷이 곧 그 날이라 «미완성» 이라는 개념이 없다.
    assert ask("D")["partial_last_bucket_days"] is None


def test_history_does_not_claim_a_partial_bucket(tmp_path):
    """`history` 의 창은 과거라 전부 완성이다 — 그 모드에서 이 값을 실으면 거짓이다.

    ⚠ **픽스처의 마지막 주가 미완성이어야** 이 가드가 산다. 완성 주로 만들면 `now` 도
    null 이라 모드 구별이 애초에 드러나지 않는다(처음 그렇게 썼다가 red-check 에서
    잡혔다 — 모드 게이트를 지워도 통과했다).
    """
    client, weekly = _partial_tail_client(tmp_path)
    i = weekly.index_of("000001")
    assert i is not None
    assert int(weekly.bucket_days[int(weekly.ends[i]) - 1]) == 3, "마지막 주가 완성이면 무의미"

    def ask(mode: str, **extra):
        return client.post("/api/screener/pattern-search",
                           json={"code": "000001", "mode": mode, "lengths": [5], "top": 3,
                                 "min_tv_eok": 0, "exclude_etf": False, "timeframe": "W",
                                 **extra}).json()["results"]

    assert ask("now")[0]["partial_last_bucket_days"] == 3          # 대조군
    for res in ask("history", forward_days=1, no_overlap=False):
        assert res["partial_last_bucket_days"] is None


# ── 월봉 ─────────────────────────────────────────────────────────────────────

_MONTH_DAYS = [
    *[dt.date(2026, 1, d) for d in (5, 6, 7, 8, 9, 12, 13, 14, 15, 16)],
    *[dt.date(2026, 2, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13)],
    *[dt.date(2026, 3, d) for d in (2, 3, 4, 5, 6, 9, 10, 11, 12, 13)],
]


def test_monthly_bucket_key_is_the_first_of_that_month(tmp_path):
    """달력 월 — 주와 달리 시작일 모호성이 없다."""
    c = sp.load_corpus(
        _write(tmp_path, _daily_rows("000001", _MONTH_DAYS,
                                     range(100, 100 + len(_MONTH_DAYS)))), "M")
    i = c.index_of("000001")
    assert i is not None
    assert c.series_len(i) == 3
    assert [c.date_at(i, k) for k in range(3)] == [
        dt.date(2026, 1, 1), dt.date(2026, 2, 1), dt.date(2026, 3, 1)]
    # 키는 달의 1일이지만 응답이 싣는 것은 **거래일**이다.
    assert c.first_day_at(i, 0) == dt.date(2026, 1, 5)
    assert c.last_day_at(i, 0) == dt.date(2026, 1, 16)


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        (dt.date(2026, 2, 1), dt.date(2026, 2, 28)),     # 평년 2월
        (dt.date(2024, 2, 1), dt.date(2024, 2, 29)),     # 윤년
        (dt.date(2026, 12, 1), dt.date(2026, 12, 31)),   # 연말 — 월 넘김
        (dt.date(2026, 4, 1), dt.date(2026, 4, 30)),     # 30일 달
    ],
)
def test_month_end_handles_leap_years_and_year_rollover(key, expected):
    assert sp._month_end(key) == expected


def _partial_client(tmp_path, days, codes=("000001", "000002")):
    rows: list[dict] = []
    for k, code in enumerate(codes):
        rows += _daily_rows(code, days, [100 + (i * (7 + k)) % 23 for i in range(len(days))])
    d = _write(tmp_path, rows)
    app = FastAPI()
    app.include_router(build_router(data_dir=d))
    return TestClient(app)


def _ask_partial(client, timeframe: str, length: int = 5):
    body = client.post("/api/screener/pattern-search", json={
        "code": "000001", "mode": "now", "lengths": [length], "top": 3,
        "min_tv_eok": 0, "exclude_etf": False, "timeframe": timeframe}).json()
    assert "results" in body, f"라우트가 거절했다: {body}"
    return body["results"][0]["partial_last_bucket_days"]


def test_partial_asks_a_different_question_per_timeframe(tmp_path):
    """⚠ **미완성 판정의 질문이 봉마다 다르다** — 통일하려다 한쪽을 망가뜨리기 쉽다.

    * 주봉은 「며칠짜리인가」다(5일이 규범). 달력(일요일)으로 물으면 거래일이 금요일까지뿐이라
      **완성 주도 늘 미완성**이 된다.
    * 월봉은 18~23일로 규범이 없어 일수로 답이 안 나온다 — 「이번 달이 안 끝났는가」다.

    red-check: `_partial_days` 의 두 분기를 서로 바꾸면 양쪽 단언이 함께 깨진다.
    """
    # 주봉 — 마지막 주가 3일뿐이다(수요일에 검색한 셈).
    weekly_days = _week_days(8)[:-2]
    assert _ask_partial(_partial_client(tmp_path / "w", weekly_days), "W") == 3
    # ★ **대조군** — 5일을 채운 주가 마지막이면 완성이다. 달력으로 물었다면 거래일이
    #   금요일까지뿐이라 일요일에 못 닿아 **이것도 미완성**이 된다. 이 단언이 없으면
    #   두 판정이 같은 답을 내는 입력만 재는 셈이라 red-check 이 죽는다.
    assert _ask_partial(_partial_client(tmp_path / "full", _week_days(8)), "W") is None
    # 같은 코퍼스의 일봉은 「미완성」이라는 개념 자체가 없다.
    assert _ask_partial(_partial_client(tmp_path / "w2", weekly_days), "D") is None


def test_monthly_partial_is_about_the_calendar_not_the_day_count(tmp_path):
    """월봉은 **그 달이 끝났는가**로 묻는다 — 거래일이 10일뿐이어도 말일까지면 완성이다."""
    # 각 달 10거래일씩 6달. 마지막 달은 말일(3/31) 직전까지.
    months = [
        *[dt.date(2025, mo, d) for mo in (10, 11, 12) for d in (5, 6, 7, 8, 9, 12, 13, 14, 15, 16)],
        *[dt.date(2026, mo, d) for mo in (1, 2) for d in (5, 6, 7, 8, 9, 12, 13, 14, 15, 16)],
    ]
    # ① 마지막 달의 마지막 거래일이 **말일 전** → 아직 열려 있다.
    open_month = [*months, *[dt.date(2026, 3, d) for d in (2, 3, 4, 5, 6)]]
    assert _ask_partial(_partial_client(tmp_path / "open", open_month), "M") == 5
    # ② 말일까지 있으면 **완성**이다 — 거래일이 6일뿐이어도 그렇다.
    closed = [*months, *[dt.date(2026, 3, d) for d in (2, 3, 4, 5, 6, 31)]]
    assert _ask_partial(_partial_client(tmp_path / "closed", closed), "M") is None


def test_since_keeps_the_bucket_it_falls_inside(tmp_path):
    """⚠ `since` 가 버킷 **중간**이면 그 버킷은 살아야 한다.

    프론트가 보내는 값은 「오늘 − N년」이라 버킷 중간일 확률이 높다(주봉 6/7 ·
    월봉 ~29/30). 키로 비교하면 그 주/달이 **통째로** 빠진다 — 경계 하나라 눈에 잘
    띄지 않고, 그래서 주봉을 넣을 때 함께 들어온 결함이다.

    red-check: 비교 대상을 `c.dates`(키)로 되돌리면 2월 버킷이 사라진다.
    """
    c = sp.load_corpus(
        _write(tmp_path, _daily_rows("000001", _MONTH_DAYS,
                                     range(100, 100 + len(_MONTH_DAYS)))
               + _daily_rows("000002", _MONTH_DAYS,
                             range(200, 200 + len(_MONTH_DAYS)))), "M")
    qi, off, q = _query(c, "000001", 2)
    mid_february = np.datetime64("2026-02-06", "D")   # 2월 버킷(2/2~2/13) 한가운데
    _, scores, _ = sp.search_history(
        c, query=q, length=2, query_series=qi, query_offset=off, min_tv_eok=0,
        exclude_etf=False, min_after=0, no_overlap=False, since=mid_february)
    # 창은 둘뿐이다: [1월,2월] 과 [2월,3월]. 쿼리 자신(000001)은 겹침으로 빠지므로
    # 000002 의 창 둘만 후보이고, 그중 1월 시작 창은 since 로 정당하게 잘린다.
    # **키로 비교하면 2월 시작 창까지 빠져 0 이 된다** — 그 한 칸이 이 가드다.
    assert len(scores) == 1, f"2월 버킷이 빠졌다 (후보창 {len(scores)})"


# ── 빈 응답의 «이유» (조사 2026-09-04) ────────────────────────────────────────────
#
# 이 절이 닫는 방향: 서버가 빈 결과를 낼 때 **왜** 비었는지를 응답이 말하는가.
#
# 왜 필요했나: 빈 응답 하나에 실패 경로 **넷**이 뭉쳐 있었고, 프론트는 그것을
# 「그은 구간에 해당하는 일봉이 없다」 한 문장으로 번역했다. 그중 기간으로 풀리는 것은
# `no_candidates` 하나뿐인데 화면은 어느 것인지 말할 수 없었다 — 사용자는 조건을
# 아무리 바꿔도 같은 문장을 봤다.
#
# 못 보는 것: 이 테스트들은 **이유의 값**을 재지 그 이유가 화면에 어떤 문장으로
# 나오는지는 재지 않는다. 그쪽은 `frontend/src/pattern/PatternDrawer.test.tsx` 다.


def _reason(tmp_path, **kw):
    """빈 응답 하나를 돌려준다 — `results` 와 `empty_reason` 을 함께 단언하기 위해.

    기본값은 **전부 덮어쓸 수 있다**. 이 절의 테스트들이 저마다 다른 축 하나(코드·구간·
    필터·모드)만 움직여 이유를 가르므로, 고정 인자로 박으면 그 축이 막힌다.
    """
    req = PatternSearchRequest(**{"code": "000001", "mode": "now", "lengths": [7],
                                  "min_tv_eok": 0, "exclude_etf": False, "top": 10, **kw})
    return sp.run_pattern_search(tmp_path, req)


def test_missing_code_says_so_and_carries_no_coverage(corpus):
    """코퍼스에 계열이 없다 — **커버리지의 부재가 곧 그 정보**다."""
    res = _reason(corpus, code="999999")
    assert res.results == []
    assert res.empty_reason == "code_missing"
    assert res.coverage_from is None and res.coverage_to is None


def test_range_outside_coverage_says_window_and_names_the_searchable_span(corpus):
    """**이 PR 의 요점.** 차트에는 캔들이 보이는데 코퍼스가 그 시기를 안 담는 경우.

    `coverage_*` 가 「그럼 어디를 그으면 되나」에 답한다 — 그게 없으면 사용자는 기간·
    모드·봉수를 바꿔 가며 같은 빈 화면을 반복해서 본다(실측: 두산·CJ대한통운은 차트에
    2019년 봉이 보이는데 코퍼스는 2024-01-02 부터다).
    """
    res = _reason(corpus, **{"from": "20190107"}, to="20190114")
    assert res.results == []
    assert res.empty_reason == "window"
    # 커버리지가 실려야 하고, **그은 구간이 그 밖**이어야 이 필드가 값을 한다.
    assert res.coverage_from is not None and res.coverage_to is not None
    assert res.coverage_from > "20190114", "그은 구간이 커버리지 안이면 이 가드는 헛돈다"


def test_flat_series_says_flat_not_window(corpus):
    """단일가 계열 — 창은 잡히는데 비교할 모양이 없다(`query_vector` → None).

    `window` 로 뭉뚱그리면 화면이 커버리지 문장을 띄우는데, 커버리지는 멀쩡하므로
    사용자가 「구간 안인데 왜?」에 갇힌다.
    """
    res = _reason(corpus, code="000003")
    assert res.results == []
    assert res.empty_reason == "flat"
    assert res.coverage_from is not None


def test_no_candidates_when_filters_leave_nothing(corpus):
    """후보가 전멸 — **넷 중 유일하게 기간·조건으로 풀리는 이유**다."""
    res = _reason(corpus, mode="history", lengths=[7], min_tv_eok=10**6)
    assert res.results == []
    assert res.empty_reason == "no_candidates"


def test_successful_search_has_no_reason_but_still_reports_coverage(corpus):
    """이유는 빈 응답에만 붙는다. 커버리지는 **결과 유무와 무관하게** 늘 붙는다."""
    res = _reason(corpus)
    assert res.results, "픽스처가 결과를 못 내면 이 가드는 아무것도 재지 못한다"
    assert res.empty_reason is None
    assert res.coverage_from is not None and res.coverage_to is not None


def test_multi_length_scrub_reports_the_furthest_failure_not_the_first(tmp_path):
    """⚠ **먼저 만난 이유를 채택하면 안 된다.**

    `now` 는 여러 봉수를 한 응답에 담으므로 길이마다 다른 이유로 죽을 수 있다. 먼저
    만난 것을 고르면 사용자가 손댈 수 없는 축을 보고하게 된다 — `no_candidates` 는
    기간·거래대금을 풀면 되살아나지만 `flat` 은 어떤 조건으로도 안 풀린다.

    ⚠ **픽스처가 두 규칙을 실제로 가르는지가 이 가드의 전부다.** 여기까지 오는 데
    가짜 초록을 두 번 지났다:
    * 8봉 단일가 계열 — 짧은 길이가 «먼저»이자 «가장 멀리» 간다(`_resolve_window` 가
      `n >= length` 라 window 실패는 늘 긴 쪽=뒤쪽이다). 두 규칙의 답이 같다.
    * 마지막 5봉의 **종가만** 같게 둔 계열 — `_series` 는 봉 하나 안에서 O/H/L/C 가
      다르므로 창 표준편차가 0 이 아니다. `flat` 이 아예 안 난다.

    가르는 입력은 마지막 5봉이 **O=H=L=C** 인 계열이다: 5봉 창은 표준편차 0 이라
    `flat`, 6봉 이상은 창이 서서 검색까지 갔다가 `no_candidates` 로 죽는다.
    """
    closes = list(100 + np.cumsum(np.random.default_rng(3).normal(0, 1.5, 55)))
    rows = _series("000001", closes)
    # ★ 단일가 꼬리 — `_flat` 은 자기 날짜를 처음부터 만들어서 이어 붙일 수 없다.
    rows += [{"code": "000001", "date": d, "open": 120.0, "high": 120.0,
              "low": 120.0, "close": 120.0, "volume": 10**9} for d in _dates(60)[55:]]
    rows += _series("000002", closes[::-1] + [99.0] * 5)
    # 거래대금 하한이 후보를 전멸시킨다 — 6봉 이상이 `no_candidates` 로 죽는 경로다.
    res = sp.run_pattern_search(_write(tmp_path, rows), PatternSearchRequest(
        code="000001", mode="now", lengths=[5, 6, 7, 10], min_tv_eok=10**6,
        exclude_etf=False, top=10))
    assert res.results == []
    assert res.empty_reason == "no_candidates", "첫 길이(flat)를 채택하면 여기서 갈린다"
