"""키움 REST seam — 선언적 TR 스펙 테이블 + 단일 호출기 (ADR-0136 §2).

**KIS 계층을 복제하지 않는다.** KIS 가 큰 것(전용 파서 11개 / `kis_endpoints` 1,162줄)은
설계가 나빠서가 아니라 **와이어가 불균일**하기 때문이다 — TR 마다 path·tr_id·params·
파서가 다르다. 키움은 전부 같은 모양이다:

    POST <path>  +  헤더 api-id/cont-yn/next-key  →  {"return_code":0, <래퍼키>:[...]}

그래서 TR 하나가 **테이블 한 줄**이고 호출기는 하나면 된다. 조사 단계의 프로브가
8개 TR 을 84줄로 처리한 것이 이 설계의 프로토타입이다(#1006).

## 응답 모양이 두 갈래다

    list  래퍼 키에 행 배열      ka10080 → stk_min_pole_chart_qry
    flat  필드가 최상위에 평평   ka10001 → 봉투(return_code/msg) 밖 전부가 1행

프로브 첫 판이 `list` 만 봐서 `ka10001` 이 "필드 0" 으로 나왔다. 필드 커버리지가
조사의 핵심이었으므로 그대로 뒀으면 무용지물이었다 — 그래서 seam 이 둘 다 다룬다.

## 이 모듈이 하지 않는 것

유량 제어를 하지 않는다. 페이싱·우선순위·중복제거는 `kiwoom_capacity` 소관이고,
호출자는 `kiwoom_access.run_with_capacity` 를 통해 들어온다(테스트 시임도 거기다).
여기는 **순수 전송 + 파싱**이라 I/O 를 MockTransport 로 갈아끼우면 완전히 테스트된다.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from hoga.live import kiwoom_http
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomBatchLimitError,
    KiwoomRateLimitError,
    KiwoomRestError,
    KiwoomTerminalAuthError,
    KiwoomTransportError,
)

log = logging.getLogger(__name__)

BASE_REAL = "https://api.kiwoom.com"

# 확인된 경로 4종 (#1007 실측). 새 TR 은 대개 이 중 하나에 붙는다.
PATH_CHART = "/api/dostk/chart"
PATH_STKINFO = "/api/dostk/stkinfo"
PATH_SECT = "/api/dostk/sect"
PATH_RKINFO = "/api/dostk/rkinfo"
# 경로는 계열 이름으로 짐작하면 틀린다 — 벤더가 `1504:해당 URI에서는 지원하는 API ID가
# 아닙니다` 로 알려 주므로 실측이 유일한 근거다(2026-08-05, #1095·#1096). 프로그램매매는
# `rkinfo`·`stkinfo`·`sect`·`chart` 전부 거절하고 `mrkcond` 만 통과했고, "기관·외국인"
# 계열도 한 경로가 아니다: ka10131 은 `frgnistt`, ka90009 는 `rkinfo` 다.
PATH_MRKCOND = "/api/dostk/mrkcond"
PATH_FRGNISTT = "/api/dostk/frgnistt"

ResponseShape = Literal["list", "flat"]

# 봉투 필드 — flat 응답에서 '행' 을 셀 때 제외한다.
_ENVELOPE = frozenset({"return_code", "return_msg"})

# 유량 초과의 벤더 신호 두 가지. HTTP 429 가 1차 신호이고 return_code 5 는 확인용이다.
_HTTP_TOO_MANY = 429
_RC_RATE_LIMITED = 5
# 인증 실패 두 갈래. 둘 다 `KiwoomAuthError` 로 접는다 — 호출자에게는 "이 토큰으로는
# 못 간다" 하나의 사실이고, 거버너가 그 사실에 대해 하는 일(무효화·계정 격리·재큐)이
# 같기 때문이다.
#   1513  authorization 헤더 부재. 자격증명 미설정이 이 모양으로 온다.
#   8005  **토큰이 벤더 측에서 무효화됐다.** 만료와 다르다 — `expires_dt` 가 한참
#         남아 있어도 같은 앱키로 어딘가에서 재발급하면 이전 토큰이 죽는다.
#         만료만 보는 provider 캐시는 이걸 통과시키므로, 이 코드를 인증 실패로
#         승격하지 않으면 죽은 토큰을 만료 시각까지(≈하루) 계속 쓴다(2026-08-04 실측).
_RC_MSG_AUTH = ("1513", "8005")
#   8050  **지정단말기 인증 실패.** 위 둘과 달리 토큰이 아니라 단말기/IP 등록 문제라
#         토큰 무효화·재발급이 처방이 아니다. 그래서 `_RC_MSG_AUTH` 에 넣지 않고
#         별도 타입으로 올린다 — 자세한 근거는 `KiwoomTerminalAuthError` docstring.
_RC_MSG_TERMINAL_AUTH = "8050"
# **배치 크기 초과.** 벤더가 유량 초과(1700)와 똑같은 return_code 5 + 똑같은 한글
# 문구로 돌려주므로 대괄호 코드로만 구분된다(#1040 실측). 재시도 대상이 아니다.
_RC_MSG_BATCH_LIMIT = "1634"


@dataclass(frozen=True)
class TrSpec:
    """TR 하나의 전부. **새 TR 추가 = 이 테이블에 한 줄.**

    `rows_key` 가 None 이면 flat 응답으로 취급한다(봉투 밖 최상위가 1행).
    `cursor` 가 False 면 `cont-yn`/`next-key` 를 따라가지 않는다.
    """

    api_id: str
    path: str
    rows_key: str | None = None
    shape: ResponseShape = "list"
    cursor: bool = False
    required: tuple[str, ...] = ()
    """필수 파라미터 이름. 벤더도 `1511` 로 알려주지만 왕복 한 번을 아끼고
    오타를 코드 리뷰에서 잡기 위해 선언해 둔다."""


# === TR 스펙 테이블 =========================================================
# ADR-0136 §1 의 대응 매핑. 표면 이관 PR(#1039~#1045)이 여기에 줄을 더한다.
TR: dict[str, TrSpec] = {
    # 차트 — 전부 base_dt 랜덤 액세스 + 커서(#1008)
    "ka10080": TrSpec("ka10080", PATH_CHART, "stk_min_pole_chart_qry", cursor=True,
                      required=("stk_cd", "tic_scope", "upd_stkpc_tp")),
    "ka10081": TrSpec("ka10081", PATH_CHART, "stk_dt_pole_chart_qry", cursor=True,
                      required=("stk_cd", "base_dt", "upd_stkpc_tp")),
    "ka20005": TrSpec("ka20005", PATH_CHART, "inds_min_pole_qry", cursor=True,
                      required=("inds_cd", "tic_scope")),
    "ka20006": TrSpec("ka20006", PATH_CHART, "inds_dt_pole_qry", cursor=True,
                      required=("inds_cd", "base_dt")),
    # 지수 주/월봉 — KIS 는 FID_PERIOD_DIV_CODE 하나로 D/W/M 을 처리하지만 키움은
    # **TR 이 갈린다**. 라우팅을 빠뜨리면 주봉 자리에 일봉이 들어가 조용히 틀린다.
    "ka20007": TrSpec("ka20007", PATH_CHART, "inds_stk_pole_qry", cursor=True,
                      required=("inds_cd", "base_dt")),
    "ka20008": TrSpec("ka20008", PATH_CHART, "inds_mth_pole_qry", cursor=True,
                      required=("inds_cd", "base_dt")),
    "ka10064": TrSpec("ka10064", PATH_CHART, "opmr_invsr_trde_chart",
                      required=("stk_cd", "mrkt_tp", "amt_qty_tp", "trde_tp")),
    # 종목정보 — ka10001 만 flat 이다
    "ka10001": TrSpec("ka10001", PATH_STKINFO, None, shape="flat", required=("stk_cd",)),
    "ka10095": TrSpec("ka10095", PATH_STKINFO, "atn_stk_infr", required=("stk_cd",)),
    "ka10059": TrSpec("ka10059", PATH_STKINFO, "stk_invsr_orgn", cursor=True,
                      required=("stk_cd", "dt", "amt_qty_tp", "trde_tp", "unit_tp")),
    "ka10099": TrSpec("ka10099", PATH_STKINFO, "list", required=("mrkt_tp",)),
    # 업종·지수
    "ka20001": TrSpec("ka20001", PATH_SECT, "inds_cur_prc_tm", required=("inds_cd", "mrkt_tp")),
    "ka10051": TrSpec("ka10051", PATH_SECT, "inds_netprps",
                      required=("mrkt_tp", "amt_qty_tp", "base_dt", "stex_tp")),
    # 전업종지수 — 업종 값뿐 아니라 **등락종목수**(rising/fall/stdns/upl/lst)를 준다.
    # `inds_cd` 는 필수지만 응답은 그 시장 전체 행이다(001/101 종합 행 포함).
    "ka20003": TrSpec("ka20003", PATH_SECT, "all_inds_idex",
                      required=("mrkt_tp", "inds_cd")),
    # 시장 종합 — 프로그램매매(경로가 mrkcond 다) · 연속매매 · 시장 폭
    # ka90005/ka90010 은 래퍼·필드가 **동일하고 축만** 다르다(시각 vs 일자).
    # ⚠ 같은 이름의 `kospi200` 이 ka90005 는 ×100 정수, ka90010 은 소수점이다.
    "ka90005": TrSpec("ka90005", PATH_MRKCOND, "prm_trde_trnsn", cursor=True,
                      required=("date", "amt_qty_tp", "mrkt_tp", "min_tic_tp", "stex_tp")),
    "ka90010": TrSpec("ka90010", PATH_MRKCOND, "prm_trde_trnsn", cursor=True,
                      required=("date", "amt_qty_tp", "mrkt_tp", "min_tic_tp", "stex_tp")),
    "ka10131": TrSpec("ka10131", PATH_FRGNISTT, "orgn_frgnr_cont_trde_prst",
                      required=("dt", "mrkt_tp", "netslmt_tp", "stk_inds_tp",
                                "amt_qty_tp", "stex_tp")),
    # 시장 폭 — 둘 다 **카운트가 아니라 목록**이라 행을 세야 한다. ka10019 는 200행에서
    # 커서가 안 끝난다(절사 정책은 호출부 소관, #1099).
    # ka10016 은 실측(코스피 45행)에서 cont-yn=N 이었지만 **커서를 허용한다** —
    # 시장·조건에 따라 100행을 넘길 수 있고, `call` 로 1페이지만 세면 조용히
    # undercount 가 된다(카운트가 곧 화면 값이라 더 위험하다).
    "ka10016": TrSpec("ka10016", PATH_STKINFO, "ntl_pric", cursor=True,
                      required=("mrkt_tp", "ntl_tp", "high_low_close_tp", "stk_cnd",
                                "trde_qty_tp", "crd_cnd", "updown_incls", "dt", "stex_tp")),
    "ka10019": TrSpec("ka10019", PATH_STKINFO, "pric_jmpflu", cursor=True,
                      required=("mrkt_tp", "flu_tp", "tm_tp", "tm", "trde_qty_tp",
                                "stk_cnd", "crd_cnd", "pric_cnd", "updown_incls", "stex_tp")),
}


@dataclass
class Page:
    """한 페이지의 응답. `cont`/`next_key` 는 커서 추적용이다."""

    rows: list[dict[str, Any]]
    cont: bool
    next_key: str
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


PageFetch = Callable[["KiwoomRestClient"], Awaitable[Page]]
"""거버너가 고른 클라이언트를 받아 페이지 1장을 가져오는 팩토리."""

PageRunner = Callable[[PageFetch, int], Awaitable[Page]]
"""`(페이지 팩토리, 페이지 인덱스)` → 페이지. `walk` 의 페이싱 이음매다.

호출자가 이 자리에 `run_with_capacity` 를 끼우면 페이지마다 유량 대기표를 뽑는다.
인덱스는 중복제거 key 를 페이지 단위로 가르는 데 쓴다.
"""


def extract_rows(spec: TrSpec, body: dict[str, Any]) -> list[dict[str, Any]]:
    """응답에서 행 배열을 꺼낸다 — `list`/`flat` 두 갈래를 흡수한다."""
    if spec.shape == "flat":
        flat = {k: v for k, v in body.items() if k not in _ENVELOPE}
        return [flat] if flat else []
    rows = body.get(spec.rows_key or "")
    return rows if isinstance(rows, list) else []


def _raise_for_body(spec: TrSpec, status: int, body: dict[str, Any]) -> None:
    """벤더 응답을 도메인 예외로 정규화한다 — **HTTP 상태와 return_code 두 축**."""
    rc = body.get("return_code")
    msg = str(body.get("return_msg") or "")
    if _RC_MSG_BATCH_LIMIT in msg:
        # **유량 초과보다 먼저 본다** — rc·문구가 같아 순서를 뒤집으면 영구 실패를
        # 일시 실패로 오분류해 무한 재시도가 된다(#1040).
        raise KiwoomBatchLimitError(code=rc, msg=msg)
    if status == _HTTP_TOO_MANY or rc == _RC_RATE_LIMITED:
        raise KiwoomRateLimitError(msg or f"HTTP {status}", api_id=spec.api_id)
    if status != httpx.codes.OK:
        raise KiwoomApiError(code=f"HTTP/{status}", msg=msg or f"HTTP {status}")
    if rc != 0:
        if _RC_MSG_TERMINAL_AUTH in msg:
            # 토큰 계열 인증 실패보다 **먼저** 본다. 문구가 겹치지는 않지만, 순서를
            # 명시해 두어야 나중에 `_RC_MSG_AUTH` 에 8050 을 무심코 더하는 것을 막는다.
            raise KiwoomTerminalAuthError(code=rc, msg=msg)
        if any(code in msg for code in _RC_MSG_AUTH):
            raise KiwoomAuthError(msg)
        raise KiwoomApiError(code=rc, msg=msg)


class KiwoomRestClient:
    """키움 REST 전송 코어. **유량 제어를 하지 않는다** — `kiwoom_capacity` 소관.

    `transport` 주입이 seam 자체의 테스트 이음매다(기존 키움 3모듈의 `_transport`
    관례를 계승). 소비자 테스트는 이게 아니라 `kiwoom_access.run_with_capacity`
    한 곳을 몽키패치한다 — 2층 구조다(ADR-0136 §2).
    """

    def __init__(
        self,
        token_provider: Any,
        *,
        base_url: str = BASE_REAL,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._provider = token_provider
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            # 주입이 이긴다 — 테스트가 넣는 MockTransport 를 덮으면 안 된다.
            # 기본 transport 는 연결 재사용(keepalive)과 연결 단계 재시도를 함께
            # 쥔다. 왜 그 둘이 한 몸이어야 하는지, 그리고 `limits` 를 Client 가
            # 아니라 transport 에 주는 이유는 `kiwoom_http` 모듈 도크스트링.
            transport=transport or kiwoom_http.async_transport(),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def call(
        self,
        api_id: str,
        body: dict[str, Any],
        *,
        cont: bool = False,
        next_key: str = "",
    ) -> Page:
        """TR 한 페이지. 커서를 따라가지 않는다 — `walk` 를 쓰라."""
        spec = TR.get(api_id)
        if spec is None:
            raise KiwoomRestError(f"unknown api-id {api_id!r} — kiwoom_rest.TR 에 추가하라")
        missing = [k for k in spec.required if k not in body]
        if missing:
            # 벤더도 1511 로 알려주지만 왕복을 아끼고 호출부 오타를 즉시 드러낸다.
            raise KiwoomRestError(f"{api_id}: 필수 파라미터 누락 {missing}")

        headers = {
            "Content-Type": "application/json;charset=UTF-8",
            "authorization": f"Bearer {await self._token()}",
            "api-id": spec.api_id,
            "cont-yn": "Y" if cont else "N",
            "next-key": next_key,
        }
        try:
            resp = await self._client.post(spec.path, json=body, headers=headers)
        except httpx.TransportError as exc:
            # `kiwoom_http` 의 keepalive 만료를 튜닝하는 **유일한 신호**다.
            # 여기까지 왔다는 것은 transport 의 연결 재시도로도 못 살렸다는 뜻이라,
            # 이 줄이 늘기 시작하면 그 빈도가 서버 idle timeout 의 하한을 말한다.
            # 0 건이면 만료를 늘려도 안전하다.
            log.warning(
                "kiwoom.rest.transport_error api_id=%s kind=%s keepalive_s=%.1f msg=%s",
                api_id,
                type(exc).__name__,
                kiwoom_http.keepalive_s(),
                str(exc)[:200],
            )
            raise KiwoomTransportError(exc) from exc

        try:
            payload = resp.json()
        except ValueError as exc:
            raise KiwoomApiError(code=f"HTTP/{resp.status_code}", msg=resp.text[:200]) from exc
        _raise_for_body(spec, resp.status_code, payload)

        return Page(
            rows=extract_rows(spec, payload),
            cont=resp.headers.get("cont-yn") == "Y",
            next_key=resp.headers.get("next-key", ""),
            raw=payload,
        )

    async def walk(
        self,
        api_id: str,
        body: dict[str, Any],
        *,
        max_pages: int,
        stop: Any = None,
        run_page: PageRunner | None = None,
    ) -> tuple[list[dict[str, Any]], bool]:
        """커서를 따라 여러 페이지. ``(rows, truncated)`` 를 돌려준다.

        `stop(rows_so_far, page)` 가 True 면 조기 종료한다 — 호출자가 "목표 날짜를
        덮었다" 같은 **구조적 술어**를 넣는 자리다(ADR-0136 §3).

        `truncated=True` 는 `max_pages` 에 걸렸다는 뜻이다. **조용한 절단을 만들지
        않기 위해** 호출자에게 돌려주고, 호출자가 violation 으로 남긴다
        (`kiwoom_index_candles` 의 `out_of_range` 선례).

        ## `run_page` 는 유량 페이싱 이음매다 — 기본값으로 두면 안 된다

        이 루프는 **콜 1건이 아니라 최대 `max_pages` 건**이다. 거버너
        (`kiwoom_capacity`)는 `run_with_capacity` 진입 전에 버킷을 한 번만
        소비하므로, walk 전체가 한 submit 안에 있으면 버킷은 1 을, 벤더는
        페이지 수만큼 센다 — ka10095·ka10080·ka10051 을 차례로 무너뜨린 것과
        같은 결함이다(ADR-0137).

        그래서 **반복은 거버너 위, 실행은 거버너 안**이다. 호출자가
        `run_page(fetch_fn, page_idx)` 로 페이지 1장을 `run_with_capacity` 에
        태우면 페이지마다 대기표를 뽑는다. 이 이음매가 **코루틴 팩토리를 받는
        모양**인 것은 층을 지키기 위해서다: 클라이언트는 거버너를 모르고,
        호출자는 `api_id`·`body`·커서를 모른다. 팩토리가 받는 클라이언트는
        거버너가 고른 계정의 것이라(ADR-0138) `self` 가 아니라 **인자를 써야
        한다**.

        커서가 직전 응답에 의존하므로 여기서 얻는 것은 병렬이 아니라 **페이싱**
        뿐이다 — 순차인 것이 맞다.
        """
        spec = TR.get(api_id)
        if spec is None or not spec.cursor:
            raise KiwoomRestError(f"{api_id}: 커서를 지원하지 않는 TR 이다")
        out: list[dict[str, Any]] = []
        cont, next_key = False, ""
        for page_idx in range(max_pages):
            def _fetch(
                client: KiwoomRestClient, *, _cont: bool = cont, _nk: str = next_key
            ) -> Awaitable[Page]:
                # 기본인자 바인딩 — 러너가 지연 실행해도 그 시점의 커서를 쓴다.
                return client.call(api_id, body, cont=_cont, next_key=_nk)

            page = await (
                run_page(_fetch, page_idx) if run_page is not None else _fetch(self)
            )
            if not page.rows:
                return out, False
            out.extend(page.rows)
            if stop is not None and stop(out, page):
                return out, False
            if not page.cont or not page.next_key:
                return out, False
            cont, next_key = True, page.next_key
        return out, True

    async def invalidate_token(self) -> None:
        """이 계정의 캐시 토큰을 버린다 — 다음 `call` 이 재발급한다.

        **거버너가 부르는 자리다**(`kiwoom_capacity`). 재시도를 여기가 아니라 거버너에
        두는 것이 이 설계의 요점이다: 클라이언트가 몰래 한 번 더 쏘면 그 콜이 TR 버킷을
        거치지 않아 페이싱에서 보이지 않는다 — 청킹을 거버너 아래 둬서 페이싱이 무효가
        됐던 것과 같은 결함이다(ADR-0137).

        provider 가 없거나 `invalidate` 를 모르면 조용히 no-op 이다. 자격증명 없는
        dev 프로필(ADR-0134)과 토큰을 흉내만 내는 테스트 더블이 그 경로다.
        """
        invalidate = getattr(self._provider, "invalidate", None)
        if invalidate is None:
            return
        # provider 는 동기 API 다(디스크 unlink + threading.Lock). 루프에서 직접 부르면
        # 그 동안 프로세스 전체가 멈춘다.
        await asyncio.to_thread(invalidate)

    async def _token(self) -> str:
        try:
            # **to_thread 필수.** `get_token()` 은 캐시 히트일 땐 lock-and-return 이지만,
            # miss 면 lock 을 쥔 채 동기 httpx POST 를 한다(timeout 10s). async 경로에서
            # 직접 부르면 발급 한 번에 이벤트 루프가 최대 10초 멈춘다.
            return await asyncio.to_thread(self._provider.get_token)
        # 광범위 catch 는 의도적이다 — 토큰 provider 의 어떤 실패든 도메인 예외로
        # 정규화해 호출자가 벤더 내부 예외를 몰라도 되게 한다. re-raise 하므로
        # BLE001 은 발화하지 않는다.
        except Exception as exc:
            raise KiwoomAuthError(f"token issue failed: {exc}") from exc
