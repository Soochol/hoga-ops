"""ka20005 어댑터 (ADR-0129).

행 fixture 는 2026-07-29 실콜 응답에서 가져왔다 — 실콜 없이 포맷 회귀를 잡는다.
"""
from __future__ import annotations

import json

import httpx
import pytest

from hoga.live.kiwoom_index_candles import (
    BUCKET_SECONDS_TO_TIC_SCOPE,
    INDEX_ID_TO_KIWOOM_CODE,
    KiwoomIndexCandlesError,
    KiwoomIndexCandlesFetcher,
    index_id_to_kiwoom_code,
    parse_price,
    rows_to_result,
    supports_bucket_seconds,
)


class FakeTokenProvider:
    def get_token(self) -> str:
        return "T"


def row(cntr_tm: str, o: str, h: str, low: str, c: str, qty: str = "100") -> dict[str, str]:
    return {
        "cntr_tm": cntr_tm,
        "open_pric": o,
        "high_pric": h,
        "low_pric": low,
        "cur_prc": c,
        "trde_qty": qty,
    }


# --- 가격 파서 -------------------------------------------------------------


def test_parse_price_strips_sign_and_restores_decimal() -> None:
    """실콜 응답 형태: 부호 접두 + 소수점이 제거된 정수."""
    assert parse_price("-566324") == 5663.24
    assert parse_price("+566544") == 5665.44
    assert parse_price("566324") == 5663.24


def test_parse_price_handles_double_sign() -> None:
    """`pred_pre` 는 `--36042` 처럼 부호가 이중으로 붙는다."""
    assert parse_price("--36042") == 360.42


def test_parse_price_passes_through_explicit_decimal() -> None:
    """방어: 키움이 포맷을 바꿔 소수점을 주기 시작해도 100배 틀린 값을 만들지 않는다.

    (같은 지수 값을 ka20003 은 실제로 `-5663.24` 로 준다 — TR 마다 포맷이 다르다.)
    """
    assert parse_price("-5663.24") == 5663.24


def test_parse_price_rejects_empty() -> None:
    with pytest.raises(ValueError):
        parse_price("")


# --- 코드/버킷 매핑 --------------------------------------------------------


def test_index_code_mapping_is_the_measured_one() -> None:
    """⚠️ 701 은 이름과 달리 KRX100 이다. KOSDAQ150 은 150."""
    assert INDEX_ID_TO_KIWOOM_CODE["KOSPI"] == "001"
    assert INDEX_ID_TO_KIWOOM_CODE["KOSDAQ"] == "101"
    assert INDEX_ID_TO_KIWOOM_CODE["KOSPI200"] == "201"
    assert INDEX_ID_TO_KIWOOM_CODE["KOSDAQ150"] == "150"
    assert INDEX_ID_TO_KIWOOM_CODE["KRX100"] == "701"


def test_unknown_index_raises() -> None:
    with pytest.raises(KiwoomIndexCandlesError):
        index_id_to_kiwoom_code("NIKKEI")


def test_supported_buckets_map_to_display_bucket_itself() -> None:
    """집계 폴백을 두지 않는다 — 잔 소스로 접으면 depth 이점이 배수만큼 깎인다."""
    assert BUCKET_SECONDS_TO_TIC_SCOPE == {
        60: "1", 180: "3", 300: "5", 600: "10", 900: "15", 1800: "30",
    }
    assert supports_bucket_seconds(1800) is True
    assert supports_bucket_seconds(1200) is False, "미지원 버킷은 KIS 로 보낸다"


# --- 행 → 결과 -------------------------------------------------------------


def test_rows_to_result_parses_and_sorts_ascending() -> None:
    """키움 응답은 최신순 — 출력은 오름차순이어야 한다(lwc setData 계약)."""
    result = rows_to_result(
        [
            row("20260729153000", "+566544", "+566544", "+565882", "-566324"),
            row("20260729152000", "+566000", "+566600", "+565000", "+566500"),
        ],
        "20260729",
        "20260729",
    )
    assert [c.t_ms for c in result.candles] == sorted(c.t_ms for c in result.candles)
    assert [c.close for c in result.candles] == [5665.00, 5663.24]
    assert result.violations == []


def test_rows_to_result_uses_per_bar_volume_not_cumulative() -> None:
    """`trde_qty`(봉) 를 쓴다 — `acml_vol`(당일 누적)을 쓰면 거래량이 단조증가한다."""
    result = rows_to_result(
        [{**row("20260729153000", "100", "100", "100", "100", qty="55"), "acml_vol": "999999"}],
        "20260729",
        "20260729",
    )
    assert result.candles[0].volume == 55


def test_rows_outside_requested_range_are_dropped_silently() -> None:
    """900행 페이지는 요청 범위를 넘겨 오기 마련 — 그건 경고가 아니다."""
    result = rows_to_result(
        [
            row("20260729153000", "100", "100", "100", "100"),
            row("20260701153000", "100", "100", "100", "100"),
        ],
        "20260729",
        "20260729",
    )
    assert len(result.candles) == 1
    assert result.violations == []


def test_malformed_and_inconsistent_rows_become_violations() -> None:
    """경계 방어는 KIS 경로와 같은 reason 집합을 쓴다 (ADR-0129 D5)."""
    result = rows_to_result(
        [
            row("BAD", "100", "100", "100", "100"),
            row("20260729153000", "100", "90", "100", "100"),   # high < open
            row("20260729152000", "100", "100", "100", "0"),    # close <= 0
        ],
        "20260729",
        "20260729",
    )
    assert result.candles == []
    assert {v.reason for v in result.violations} == {
        "malformed_row", "ohlc_inconsistent", "close_nonpositive",
    }


def test_duplicate_timestamps_across_pages_are_deduped() -> None:
    """연속조회 페이지는 경계에서 겹칠 수 있다 — 먼저 본 행이 이긴다."""
    result = rows_to_result(
        [
            row("20260729153000", "100", "111", "100", "111"),
            row("20260729153000", "100", "222", "100", "222"),
        ],
        "20260729",
        "20260729",
    )
    assert len(result.candles) == 1
    assert result.candles[0].close == 1.11


# --- 연속조회 --------------------------------------------------------------


def _fetcher(handler, **kw) -> KiwoomIndexCandlesFetcher:
    return KiwoomIndexCandlesFetcher(
        FakeTokenProvider(),
        client=httpx.Client(
            base_url="https://api.kiwoom.com", transport=httpx.MockTransport(handler),
        ),
        page_pacing_s=0.0,
        sleep=lambda _s: None,
        **kw,
    )


def test_fetch_stops_once_the_page_covers_from_date() -> None:
    """목표 날짜를 덮으면 더 걷지 않는다 — 불필요한 페이지는 곧 유량 낭비다."""
    calls: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(dict(req.headers))
        return httpx.Response(200, json={
            "return_code": 0,
            "inds_min_pole_qry": [row("20260728153000", "100", "100", "100", "100")],
        }, headers={"cont-yn": "Y", "next-key": "K"})

    result = _fetcher(handler).fetch("KOSPI", "20260728", "20260729", bucket_seconds=60)

    assert len(calls) == 1, "첫 페이지가 이미 from 을 덮었다"
    assert len(result.candles) == 1


def test_fetch_walks_back_until_from_is_covered() -> None:
    pages = [
        ([row("20260729153000", "100", "100", "100", "100")], "Y"),
        ([row("20260728153000", "100", "100", "100", "100")], "Y"),
        ([row("20260727153000", "100", "100", "100", "100")], "N"),
    ]
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.headers.get("next-key", ""))
        rows, cont = pages[len(seen) - 1]
        return httpx.Response(200, json={"return_code": 0, "inds_min_pole_qry": rows},
                              headers={"cont-yn": cont, "next-key": f"K{len(seen)}"})

    result = _fetcher(handler).fetch("KOSPI", "20260727", "20260729", bucket_seconds=60)

    assert seen == ["", "K1", "K2"], "next-key 가 다음 요청으로 전달된다"
    assert len(result.candles) == 3


def test_fetch_stops_when_server_says_no_more_pages() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "return_code": 0,
            "inds_min_pole_qry": [row("20260729153000", "100", "100", "100", "100")],
        }, headers={"cont-yn": "N"})

    result = _fetcher(handler).fetch("KOSPI", "20260101", "20260729", bucket_seconds=60)
    assert len(result.candles) == 1, "from 을 못 덮어도 서버가 끝이라면 멈춘다"


def test_page_cap_surfaces_a_violation_instead_of_truncating_silently() -> None:
    """상한에 걸린 절단은 반드시 드러낸다 — 조용한 절단은 '데이터 없음'으로 오독된다."""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "return_code": 0,
            "inds_min_pole_qry": [row("20260729153000", "100", "100", "100", "100")],
        }, headers={"cont-yn": "Y", "next-key": "K"})

    result = _fetcher(handler, max_pages=3).fetch(
        "KOSPI", "20200101", "20260729", bucket_seconds=60,
    )
    assert [v.reason for v in result.violations] == ["out_of_range"]


def test_unsupported_bucket_raises_rather_than_guessing() -> None:
    def handler(req: httpx.Request) -> httpx.Response:  # pragma: no cover - 호출되면 실패
        raise AssertionError("should not reach the network")

    with pytest.raises(KiwoomIndexCandlesError):
        _fetcher(handler).fetch("KOSPI", "20260729", "20260729", bucket_seconds=1200)


def test_error_return_code_raises() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"return_code": 3, "return_msg": "권한 없음"})

    with pytest.raises(KiwoomIndexCandlesError, match="return_code=3"):
        _fetcher(handler).fetch("KOSPI", "20260729", "20260729", bucket_seconds=60)


def test_request_shape_matches_the_measured_contract() -> None:
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:

        captured["headers"] = dict(req.headers)
        captured["body"] = json.loads(req.content)
        captured["path"] = req.url.path
        return httpx.Response(200, json={
            "return_code": 0,
            "inds_min_pole_qry": [row("20260729153000", "100", "100", "100", "100")],
        }, headers={"cont-yn": "N"})

    _fetcher(handler).fetch("KOSDAQ150", "20260729", "20260729", bucket_seconds=1800)

    assert captured["path"] == "/api/dostk/chart"
    assert captured["headers"]["api-id"] == "ka20005"
    assert captured["headers"]["authorization"] == "Bearer T"
    assert captured["body"] == {"inds_cd": "150", "tic_scope": "30"}
