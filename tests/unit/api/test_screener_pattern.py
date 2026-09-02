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
    assert set(body) == {"code", "name", "mode", "results"}
    result = body["results"][0]
    assert set(result) == {"length", "query", "ma_periods", "universe", "dist",
                           "matches", "baseline", "elapsed_ms"}
    assert set(result["dist"]) == {"p50", "p95", "p99", "p99_99", "sample"}
    row = result["matches"][0]
    assert set(row) == {"code", "name", "from_date", "to_date", "corr", "bars",
                        "tail", "forward_pct", "ma"}
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
