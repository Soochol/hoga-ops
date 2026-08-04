"""키움 REST seam 테스트 — MockTransport 로 실제 파싱·커서·에러 분류를 돌린다.

2층 이음매의 아래층이다(ADR-0136 §2). 소비자 테스트는 이게 아니라
`kiwoom_access.run_with_capacity` 한 곳을 몽키패치한다.
"""
from __future__ import annotations

import httpx
import pytest

from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomRateLimitError,
    KiwoomRestError,
    KiwoomTransportError,
)
from hoga.live.kiwoom_rest import TR, KiwoomRestClient, extract_rows


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


def _ok(rows_key: str, rows: list[dict], *, cont: str = "N", nk: str = "") -> httpx.Response:
    return httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", rows_key: rows},
        headers={"cont-yn": cont, "next-key": nk},
    )


# === 응답 모양 두 갈래 =======================================================

async def test_list_shape_extracts_wrapper_rows() -> None:
    c = _client(lambda _r: _ok("stk_min_pole_chart_qry", [{"cntr_tm": "1"}, {"cntr_tm": "2"}]))
    page = await c.call("ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"})
    assert [r["cntr_tm"] for r in page.rows] == ["1", "2"]
    await c.aclose()


async def test_flat_shape_treats_envelope_free_top_level_as_one_row() -> None:
    """ka10001 은 필드를 최상위에 평평하게 싣는다.

    프로브 첫 판이 list 만 봐서 이 TR 이 '행 0 / 필드 0' 으로 나왔다 — 필드
    커버리지 조사가 통째로 무용지물이 될 뻔했다(#1006). 그 회귀를 봉인한다.
    """
    body = {"return_code": 0, "return_msg": "정상", "cur_prc": "70000", "bps": "50000"}
    c = _client(lambda _r: httpx.Response(200, json=body))
    page = await c.call("ka10001", {"stk_cd": "005930"})
    assert len(page.rows) == 1
    assert page.rows[0] == {"cur_prc": "70000", "bps": "50000"}
    await c.aclose()


def test_extract_rows_flat_with_only_envelope_yields_no_rows() -> None:
    assert extract_rows(TR["ka10001"], {"return_code": 0, "return_msg": "정상"}) == []


# === 에러 분류: HTTP 상태와 return_code **두 축** ============================

async def test_http_429_is_rate_limit_even_though_body_shape_is_normal() -> None:
    """유량 초과만 HTTP 레벨로 온다. return_code 만 보면 놓친다 — 조사 중 실제로
    이 함정을 밟아 429 중단을 '커서가 끝났다' 로 오독했다(#1015)."""
    body = {"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다"
                                            "[1700:... 유량=5, API ID=ka10080]"}
    c = _client(lambda _r: httpx.Response(429, json=body))
    with pytest.raises(KiwoomRateLimitError) as ei:
        await c.call("ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"})
    assert ei.value.quota == 5, "벤더가 알려준 유량을 파싱해야 거버너가 자가 교정한다"
    assert ei.value.api_id == "ka10080"
    await c.aclose()


async def test_missing_authorization_maps_to_auth_error() -> None:
    body = {"return_code": 2,
            "return_msg": "입력 값 오류입니다[1513:Http Header에 authorization 필드가 "
                          "설정되어 있어야 합니다]"}
    c = _client(lambda _r: httpx.Response(200, json=body))
    with pytest.raises(KiwoomAuthError):
        await c.call("ka10001", {"stk_cd": "A"})
    await c.aclose()


async def test_nonzero_return_code_is_api_error() -> None:
    body = {"return_code": 3, "return_msg": "잘못된 요청입니다[1504:...]"}
    c = _client(lambda _r: httpx.Response(200, json=body))
    with pytest.raises(KiwoomApiError) as ei:
        await c.call("ka10001", {"stk_cd": "A"})
    assert ei.value.code == 3
    await c.aclose()


async def test_transport_error_is_normalized_and_classified_retryable() -> None:
    def _boom(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    c = _client(_boom)
    with pytest.raises(KiwoomTransportError) as ei:
        await c.call("ka10001", {"stk_cd": "A"})
    assert ei.value.retryable is True
    assert isinstance(ei.value, KiwoomApiError), "기존 except KiwoomApiError 팔이 흡수해야 한다"
    await c.aclose()


async def test_read_timeout_is_not_retryable() -> None:
    def _slow(_r: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    c = _client(_slow)
    with pytest.raises(KiwoomTransportError) as ei:
        await c.call("ka10001", {"stk_cd": "A"})
    assert ei.value.retryable is False
    await c.aclose()


# === 스펙 테이블 계약 ========================================================

async def test_unknown_api_id_fails_fast() -> None:
    c = _client(lambda _r: _ok("x", []))
    with pytest.raises(KiwoomRestError, match="unknown api-id"):
        await c.call("ka99999", {})
    await c.aclose()


async def test_missing_required_param_fails_before_any_request() -> None:
    """벤더도 1511 로 알려주지만 왕복을 아끼고 호출부 오타를 즉시 드러낸다."""
    sent: list[httpx.Request] = []

    def _rec(r: httpx.Request) -> httpx.Response:
        sent.append(r)
        return _ok("stk_min_pole_chart_qry", [])

    c = _client(_rec)
    with pytest.raises(KiwoomRestError, match="필수 파라미터 누락"):
        await c.call("ka10080", {"stk_cd": "A"})
    assert sent == [], "요청을 보내지 않아야 한다"
    await c.aclose()


def test_every_cursor_spec_declares_a_rows_key() -> None:
    """커서를 따라가려면 행을 꺼낼 수 있어야 한다 — 테이블 자기 정합성."""
    for api_id, spec in TR.items():
        if spec.cursor:
            assert spec.rows_key, f"{api_id}: cursor=True 인데 rows_key 가 없다"
            assert spec.shape == "list", f"{api_id}: flat 응답은 커서를 가질 수 없다"


# === 커서 =====================================================================

async def test_walk_follows_cursor_and_reports_truncation() -> None:
    pages = [
        _ok("stk_min_pole_chart_qry", [{"i": 1}], cont="Y", nk="k1"),
        _ok("stk_min_pole_chart_qry", [{"i": 2}], cont="Y", nk="k2"),
        _ok("stk_min_pole_chart_qry", [{"i": 3}], cont="Y", nk="k3"),
    ]
    it = iter(pages)
    c = _client(lambda _r: next(it))
    rows, truncated = await c.walk(
        "ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"}, max_pages=3
    )
    assert [r["i"] for r in rows] == [1, 2, 3]
    assert truncated is True, "max_pages 도달은 호출자에게 알려야 한다 — 조용한 절단 금지"
    await c.aclose()


async def test_walk_stops_on_structural_predicate() -> None:
    """호출자가 '목표를 덮었다' 는 구조적 술어를 넣는 자리(ADR-0136 §3)."""
    pages = [
        _ok("stk_min_pole_chart_qry", [{"i": 1}], cont="Y", nk="k1"),
        _ok("stk_min_pole_chart_qry", [{"i": 2}], cont="Y", nk="k2"),
    ]
    it = iter(pages)
    seen: list[int] = []

    def _h(_r: httpx.Request) -> httpx.Response:
        seen.append(1)
        return next(it)

    c = _client(_h)
    rows, truncated = await c.walk(
        "ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"},
        max_pages=5, stop=lambda acc, _p: len(acc) >= 1,
    )
    assert len(seen) == 1, "술어가 참이면 더 걷지 않는다"
    assert truncated is False
    await c.aclose()


async def test_walk_rejects_non_cursor_tr() -> None:
    c = _client(lambda _r: _ok("atn_stk_infr", []))
    with pytest.raises(KiwoomRestError, match="커서를 지원하지 않는"):
        await c.walk("ka10095", {"stk_cd": "A"}, max_pages=2)
    await c.aclose()


async def test_walk_routes_every_page_through_the_injected_runner() -> None:
    """**페이지 N장이면 러너도 N번 불린다** — 유량 페이싱의 전제다.

    거버너(`kiwoom_capacity`)는 `run_with_capacity` 진입 전에 버킷을 한 번만
    소비한다. walk 전체가 한 submit 안에 있으면 버킷은 1 을, 벤더는 페이지 수만큼
    센다 — ka10095·ka10080·ka10051 을 차례로 무너뜨린 것과 같은 결함이다(ADR-0137).
    """
    pages = [
        _ok("stk_min_pole_chart_qry", [{"i": 1}], cont="Y", nk="k1"),
        _ok("stk_min_pole_chart_qry", [{"i": 2}], cont="Y", nk="k2"),
        _ok("stk_min_pole_chart_qry", [{"i": 3}], cont="N", nk=""),
    ]
    it = iter(pages)
    c = _client(lambda _r: next(it))
    seen_idx: list[int] = []

    async def _run_page(fetch_fn, page_idx):
        seen_idx.append(page_idx)
        return await fetch_fn(c)

    rows, truncated = await c.walk(
        "ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"},
        max_pages=5, run_page=_run_page,
    )

    assert seen_idx == [0, 1, 2], "페이지마다 대기표 1장 — 여기가 계약이다"
    assert [r["i"] for r in rows] == [1, 2, 3]
    assert truncated is False
    await c.aclose()


async def test_injected_runner_receives_the_client_it_should_call() -> None:
    """러너가 넘겨주는 클라이언트로 호출해야 한다 — `self` 가 아니다.

    계정은 거버너가 고르므로(ADR-0138) 팩토리가 받는 클라이언트가 곧 그 계정의
    것이다. `self` 로 부르면 계정 분산이 조용히 무력해진다.
    """
    used: list[str] = []

    def _h(tag: str):
        def _inner(_r: httpx.Request) -> httpx.Response:
            used.append(tag)
            return _ok("stk_min_pole_chart_qry", [{"i": 1}], cont="N", nk="")
        return _inner

    owner = _client(_h("owner"))
    picked = _client(_h("picked"))

    async def _run_page(fetch_fn, _idx):
        return await fetch_fn(picked)   # 거버너가 고른 계정

    await owner.walk(
        "ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"},
        max_pages=2, run_page=_run_page,
    )

    assert used == ["picked"], "walk 는 self 가 아니라 러너가 준 클라이언트를 쓴다"
    await owner.aclose()
    await picked.aclose()


async def test_cursor_advances_across_paced_pages() -> None:
    """페이싱을 끼워도 커서는 그대로 전진한다 — 지연 실행이 커서를 얼리지 않는다."""
    sent: list[str] = []

    def _h(r: httpx.Request) -> httpx.Response:
        sent.append(r.headers.get("next-key", ""))
        idx = len(sent)
        return _ok("stk_min_pole_chart_qry", [{"i": idx}],
                   cont="Y" if idx < 3 else "N", nk=f"k{idx}" if idx < 3 else "")

    c = _client(_h)

    async def _run_page(fetch_fn, _idx):
        return await fetch_fn(c)

    await c.walk(
        "ka10080", {"stk_cd": "A", "tic_scope": "1", "upd_stkpc_tp": "1"},
        max_pages=5, run_page=_run_page,
    )

    assert sent == ["", "k1", "k2"], "각 페이지가 직전 응답의 next-key 를 쓴다"
    await c.aclose()
