"""KRX 세션 게이트 — poller에서 이주(은퇴 대비, 그릴링 Q2).

market_phase: 시계 기반 위상. should_run_now: 캘린더 게이트 포함(ADR-0064).
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Literal

from .kis_client import KST


def market_phase(t_ms: int) -> Literal["regular", "after_hours_closing", "closed"]:
    """KRX session phase by clock alone (no calendar awareness).

    regular: 09:00-15:30 KST
    after_hours_closing: 15:30-16:00 KST
    closed: everything else

    Calendar-aware gating (holidays, weekends) lives in :func:`should_run_now`
    so the phase predicate stays pure and reusable from non-poller contexts.
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    h, m = kst.hour, kst.minute
    if h == 15 and m >= 30:  # noqa: PLR2004
        return "after_hours_closing"
    if 9 <= h < 16:  # noqa: PLR2004
        return "regular"
    return "closed"


# 동시호가(단일가매매) 창 — **venue 마다 다르다**. 예상체결가/량(0D FID 23/24) 표시
# 게이트. 값>0 만으론 부족함이 실측으로 확인됐다: NXT 는 연속/애프터마켓 접속매매
# 중에도 예상체결값을 계산해 흘려 평시에도 노출됐다(2026-07-22). 이 시계 창을 AND 로
# 걸어 창 밖 프레임의 예상체결을 버린다.
#
#   KRX     장전 08:30–09:00 · 장마감 15:20–15:30
#   NXT     애프터마켓 시가단일가 15:30–15:40   ← 그 하나뿐이다
#   UN(_AL) 위 셋 전부 (병합 스트림이라 어느 쪽 단일가든 실릴 수 있다)
#
# NXT 시각의 근거(증권사 안내 4곳 일치, 2026-08-07 확인): 08:00–08:50 프리마켓과
# 15:40–20:00 애프터마켓은 **접속매매**라 단일가가 없고, 08:50–09:00:30 · 15:20–15:30
# 은 KRX 단일가 동안 NXT 가 거래정지다. 15:30–15:40 만 "호가접수만 가능, 체결은 15:40
# 부터" 인 단일가 구간이다 — KRX 동시호가와 동형(접수 창 → 종료 시점 체결)이라 그
# 10분이 예상체결이 나오는 유일한 NXT 구간이다.
#
# 이 표가 생기기 전엔 NXT 를 venue 블랙리스트로 통째 막았다(ADR-0140 §6.1: "단일가
# 국면 시각을 우리가 모른다"). 그래서 NXT·통합 사용자는 15:30–15:40 예상체결을 **한
# 번도 못 봤다** — 체결이 없는 창이라 예상체결이 유일한 신호인데도 화면이 비었다.
# 시각을 알아낸 지금은 venue 축이 아니라 이 시계 표가 그 역할을 대신한다.
#
# ⚠ 장중 VI 단일가는 불규칙 시각이라 이 스케줄 창에 없다 — 필요 시 VI 이벤트로 별도
#   판정. (NXT 에는 VI 자체가 없다 — ADR-0140 §6.1 실물 확인.)
_PREOPEN_AUCTION_MIN = (8 * 60 + 30, 9 * 60)              # [08:30, 09:00)  KRX 시가
_CLOSING_AUCTION_MIN = (15 * 60 + 20, 15 * 60 + 30)       # [15:20, 15:30)  KRX 종가
_NXT_AFTER_AUCTION_MIN = (15 * 60 + 30, 15 * 60 + 40)     # [15:30, 15:40)  NXT 애프터 시가

_AUCTION_WINDOWS_BY_VENUE: dict[str, tuple[tuple[int, int], ...]] = {
    "KRX": (_PREOPEN_AUCTION_MIN, _CLOSING_AUCTION_MIN),
    "NXT": (_NXT_AFTER_AUCTION_MIN,),
    "UN": (_PREOPEN_AUCTION_MIN, _CLOSING_AUCTION_MIN, _NXT_AFTER_AUCTION_MIN),
}


def is_auction_window(t_ms: int, venue: str) -> bool:
    """이 venue 의 동시호가(단일가) 시각인지 — 순수 KST 시계(캘린더 무관, TZ 안전).

    market_phase 는 09:00–15:30 을 통째로 'regular' 로 보고 08:30–09:00 을 'closed' 로
    봐 동시호가를 구분하지 못하므로, 예상체결 게이트 전용의 별도 술어를 둔다.

    ``venue`` 는 필수 인자다. 기본값을 두면 인자를 잊은 호출부가 조용히 KRX 시계로
    판정돼 NXT 창이 도로 닫힌다 — 폐지된 기본값이 지뢰가 된 #1201 과 같은 형태.

    모르는 venue 는 **False**(닫힘)다. 단일가 시각을 모르는 시장에 창을 열면 NXT 가
    그랬듯 접속매매 중의 예상체결값이 화면에 샌다 — 새 venue 를 추가하면 그 시장의
    단일가 시각을 확인해 위 표에 넣어야 신호가 켜진다.
    """
    windows = _AUCTION_WINDOWS_BY_VENUE.get(venue)
    if not windows:
        return False
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    minutes = kst.hour * 60 + kst.minute
    return any(lo <= minutes < hi for lo, hi in windows)


# 시간외 단일가매매 창 — **KRX 전용 제도**다(ADR 없음, 2026-08-14 조사).
#
#     15:40–16:00  장후 시간외 **종가**매매 — 당일 종가 단일 가격, 시간우선 체결.
#                  가격이 하나라 **호가 사다리라는 개념이 없다**.
#     16:00–18:00  시간외 **단일가**매매 — 10분 주기 단일가. 여기엔 호가가 접수된다.
#
# 이 창이 필요한 이유는 그 구간에 **WS 가 침묵하기 때문**이다(실측: `0D` 는 15:30 에,
# `0B` 는 16:00 에 끊긴다 — `docs/research/2026-08-14-kiwoom-after-hours-orderbook-
# sources.md`). 유일한 소스가 REST `ka10087` 이고, 그걸 창 밖에서 치면 장중 유량을
# 태우므로 라우트가 이 술어로 먼저 막는다.
#
# 거래일 판정을 **얹지 않는다** — `_quote_phase`·순위 TR 게이트가 이미 시계만 쓰는
# 선례이고(캘린더는 동기 KIS HTTP 재도입), 평일 공휴일의 드문 헛콜은 수용 가능하다.
# 벤더가 빈 호가를 답하고 라우트가 그대로 "볼 것 없음" 으로 흘린다.
_AFTER_HOURS_SINGLE_PRICE_MIN = (16 * 60, 18 * 60)  # [16:00, 18:00)


def is_after_hours_single_price_window(t_ms: int) -> bool:
    """시간외 단일가매매(16:00–18:00 KST) 시각인가 — 순수 시계(주말만 배제).

    주말은 KRX 세션이 아예 없어 짧게 끊는다 — 평일 공휴일과 달리 캘린더 없이도
    확실하고, 토·일 내내 폴링이 도는 것은 명백한 낭비다.
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    if kst.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return False
    lo, hi = _AFTER_HOURS_SINGLE_PRICE_MIN
    return lo <= (kst.hour * 60 + kst.minute) < hi


def is_trading_day_now(t_ms: int) -> bool:
    """거래일 여부 — **시계 무관** 순수 캘린더 술어(주말 단축 후 chk-holiday).

    ``should_run_now``·``ws_connection_window`` 저장 게이트가
    공유하는 SSOT. '거래일'의 정의를 한 곳에 봉인해 소비자별 재구현이 표류하지 않게
    한다 — 이 함수가 도입되기 전 레코더는 ``market_phase``(시계만)로만 게이트해
    비거래일(주말/휴장) 09:00–15:30에도 호가를 캡처·저장했다(ADR-0099가 주장한 WS
    저장 파리티 위반).

    Weekends are short-circuited by weekday before any KIS call, so a weekend stays
    closed even when KIS is unreachable. Lenient on missing calendar data — when
    ``is_trading_session_today`` returns None (KRX creds missing, chk-holiday flaked),
    ``live_session_allowed_today`` defers to treating today as a session; losing live
    capture for a transient KRX outage is a worse failure than a brief burst of empty
    fetches on a stale day.

    ⚠ BLOCKING: ``live_session_allowed_today``가 캐시 미스 시 동기 KIS HTTP 가능 —
    이벤트 루프에서 직접 호출 금지. 코루틴은 ``asyncio.to_thread``로 감싸라
    (``ws_capture_window`` blocking 계약과 동일).
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    if kst.weekday() >= 5:  # Saturday/Sunday — never a KRX session  # noqa: PLR2004
        return False
    from hoga.api.calendar_policy import live_session_allowed_today  # noqa: PLC0415
    return live_session_allowed_today(kst.strftime("%Y%m%d"))


def should_run_now(t_ms: int) -> bool:
    """Calendar + clock gate: True only when KRX is *probably* trading right now.

    ADR-0064: the trading-day check uses :func:`calendar.is_trading_session_today`
    (backed by the KIS chk-holiday calendar, which lists today from the session
    open), NOT a daily-OHLCV proxy. The old proxy returned False for a live trading day
    early in the session — today's bar isn't published yet — and once that False
    was cached the poller silently halted capture for the whole process. The
    business-day calendar marks today as a session from the open.

    거래일 판정은 :func:`is_trading_day_now`(SSOT)에 위임한다.
    """
    if market_phase(t_ms) == "closed":
        return False
    return is_trading_day_now(t_ms)


def ws_capture_window(now_ms: int) -> bool:
    """WS 수집 게이트(advisor B 결정 2026-06-05): 거래일 && 정규장(09:00–15:30)만.

    poller 시절의 장후 시간외(15:30–16:00, overtime TR) 캡처는 **의도적 회귀** —
    가격 고정 구간이라 정보가치 낮고 hogaplay 일배치가 post-hoc per-tick 보완
    (spec §11). 정규 TR만 구독하므로 15:30 이후엔 틱이 없어, 게이트를 열어두면
    다운샘플러 carry가 유령 스냅샷만 쓴다 — 그래서 15:30에 닫는다.

    ⚠ BLOCKING: should_run_now → is_trading_session_today(캘린더/chk-holiday)가 캐시
    미스 시 동기 KIS HTTP를 칠 수 있다. **이벤트 루프에서 직접 호출 금지** — 코루틴은
    ``ws_capture_window_async``를 await하라. 유일한 합법적 sync 사용처는 소비자가 스스로
    to_thread로 감싸는 gate_fn 클로저(KisWsClient가 ``await to_thread(gate_fn)`` 처리).
    """
    return should_run_now(now_ms) and market_phase(now_ms) == "regular"


async def ws_capture_window_async(now_ms: int) -> bool:
    """ws_capture_window의 non-blocking 진입점 — to_thread를 한 곳에 봉인한다.

    blocking 계약을 시그니처(async)에 박아 미래 호출자가 캘린더 I/O로 이벤트 루프를
    동결시키지 못하게 한다(systems-over-heroes). 코루틴 호출부는 모두 이걸 await.
    """
    return await asyncio.to_thread(ws_capture_window, now_ms)


# ── #524 통합 venue 시분할: 연결 게이트(저장 게이트와 분리) ─────────────────────

# 연결 창 = 거래일 && 08:00–20:00 KST. NXT 확장 세션(장전 08:00·장후 ~20:00)을
# 포함해 시분할 스왑이 KRX↔NXT 구독을 유지할 수 있게 한다. **저장(캡처)은
# ws_capture_window(정규장)가 별도 게이트** — 연결 창 확대가 저장 창을 넓히지 않는다.
_CONN_OPEN_MIN = 8 * 60         # 08:00 KST
_CONN_CLOSE_MIN = 20 * 60       # 20:00 KST


def _within_connection_clock(t_ms: int) -> bool:
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    return _CONN_OPEN_MIN <= (kst.hour * 60 + kst.minute) < _CONN_CLOSE_MIN


def ws_connection_window(now_ms: int) -> bool:
    """WS **연결** 게이트: 거래일 && 08:00–20:00 KST. ws_capture_window(저장,
    정규장)와 분리 — NXT 시분할 시간대에도 연결을 유지/재수립한다.

    should_run_now(캘린더)는 market_phase=='closed'(정규장 밖)면 False라 08~09·15:30~20을
    못 담으므로 여기서 별도로 거래일(주말/휴장 배제)만 검사하고 시계는 08~20으로 연다.

    ⚠ BLOCKING: ws_capture_window와 동일하게 캘린더 캐시 미스 시 동기 KIS HTTP 가능 —
    이벤트 루프에서 직접 호출 금지, 코루틴은 ``ws_connection_window_async``를 await.
    """
    if not _within_connection_clock(now_ms):
        return False
    return is_trading_day_now(now_ms)  # 거래일 판정 SSOT(주말/휴장 배제)


async def ws_connection_window_async(now_ms: int) -> bool:
    """ws_connection_window의 non-blocking 진입점 — to_thread 봉인(blocking 계약)."""
    return await asyncio.to_thread(ws_connection_window, now_ms)


# ── venue 별 **저장** 창 (ADR-0140 §3, PR-G) ──────────────────────────────────
#
# 저장 게이트가 하나(정규장 09:00–15:30)에서 **venue 별**로 갈린다:
#
#     KRX    09:00 ─ 15:30   정규장 그대로 — 기존 캡처와 byte-for-byte 동일
#     NXT·UN 08:00 ─ 20:00   연결 창 전체 — 프리·애프터마켓이 처음으로 디스크에 남는다
#
# KRX 창을 안 넓힌 이유: 15:30 이후 KRX 는 **틱이 없다**. 게이트를 열어 두면
# 다운샘플러 carry 가 유령 스냅샷만 쓴다(`ws_capture_window` docstring 이 15:30 에
# 닫는 이유로 든 바로 그것). NXT 는 반대로 그 시간에 진짜 거래가 있다.
#
# ⚠ 연결 창이 이제 **진짜 상한**이다. 08:00–20:00 은 구독 스왑 스케줄로 들어온 값이지
# 검증된 NXT 운영시간이 아니다(ADR-0140 열린 항목). 이 창 밖 틱은 저장 이전에 수신
# 자체가 안 된다.


def venue_capture_windows(now_ms: int) -> frozenset[str]:
    """이 시각에 **저장**이 열린 venue 집합. 비거래일이면 빈 집합.

    `ws_capture_window` 의 venue 인식판이다. 그 함수는 KRX 전용 답을 주는 것으로
    남는다 — hogaplay 워커·달력이 계속 쓴다.

    ⚠ BLOCKING: `ws_capture_window` 와 같은 이유(캘린더 캐시 미스 시 동기 HTTP)로
    이벤트 루프에서 직접 호출 금지. 코루틴은 `venue_capture_windows_async` 를 await.
    """
    open_venues: set[str] = set()
    # KRX: **`ws_capture_window` 를 그대로 위임**한다 — 조건을 다시 쓰지 않는다.
    # `should_run_now` 만으로는 부족하다: 그건 `market_phase != "closed"` 일 뿐이라
    # 장전 동시호가(08:30–09:00)에도 True 다. 기존 KRX 캡처와 byte-for-byte 동일하려면
    # 판정이 한 곳에서 나와야 한다.
    if ws_capture_window(now_ms):
        open_venues.add("KRX")
    # NXT·UN: 연결 창 전체. `should_run_now` 는 정규장 밖이면 False 라 08~09·15:30~20 을
    # 못 담는다 — 그래서 거래일 판정을 따로 하는 `ws_connection_window` 를 쓴다.
    if ws_connection_window(now_ms):
        open_venues.update(("NXT", "UN"))
    return frozenset(open_venues)


async def venue_capture_windows_async(now_ms: int) -> frozenset[str]:
    """venue_capture_windows 의 non-blocking 진입점 — to_thread 봉인."""
    return await asyncio.to_thread(venue_capture_windows, now_ms)


# ── 파생(선물·옵션) 수집 창 ──────────────────────────────────────────────────
#
# **주식보다 15분 늦게 닫는다** — KRX 파생 정규장은 09:00–15:45 다(주식 15:30).
# `ws_capture_window` 를 그대로 쓰면 마감 15분이 통째로 빈다. 그 15분은 버려도 되는
# 구간이 아니다: 최종 정산에 걸리는 포지션 조정이 몰리는 자리라 투자자 수급의 하루
# 마지막 모양이 거기서 바뀐다.
#
# `should_run_now` 를 못 쓰는 이유는 `ws_connection_window` 와 같다 — 그 함수는
# `market_phase`(주식 시계)가 'closed' 면 False 라 15:30~15:45 를 못 담는다. 그래서
# 거래일 판정만 SSOT 에서 받고 시계는 여기서 연다.
#
# 최종거래일(월물 만기)의 조기 마감은 반영하지 않는다 — 그날은 15:45 이후 표본이
# 안 올 뿐이고, 없는 표본은 커버리지가 그대로 드러낸다(억지로 메우지 않는 것이
# investor-flow 계약이다).
#: **밑줄 없는 public 상수다** — 커버리지 분모(`deriv_flow_store.SESSION_MINUTES`)와
#: 응답의 x축(`/api/market/deriv-flow`)이 같은 창을 말해야 하는데, 두 곳에 숫자를
#: 다시 적으면 창을 조정할 때 조용히 갈린다. 게이트가 SSOT 다.
DERIV_OPEN_MIN = 9 * 60             # 09:00 KST
DERIV_CLOSE_MIN = 15 * 60 + 45      # 15:45 KST


def _within_deriv_clock(t_ms: int) -> bool:
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    return DERIV_OPEN_MIN <= (kst.hour * 60 + kst.minute) < DERIV_CLOSE_MIN


def deriv_capture_window(now_ms: int) -> bool:
    """파생 수집 게이트: 거래일 && 09:00–15:45 KST.

    ⚠ BLOCKING: 거래일 판정이 캐시 미스 시 동기 KIS HTTP 를 칠 수 있다 — 이벤트
    루프에서 직접 호출 금지, 코루틴은 ``deriv_capture_window_async`` 를 await.
    """
    if not _within_deriv_clock(now_ms):
        return False
    return is_trading_day_now(now_ms)


async def deriv_capture_window_async(now_ms: int) -> bool:
    """deriv_capture_window 의 non-blocking 진입점 — to_thread 봉인."""
    return await asyncio.to_thread(deriv_capture_window, now_ms)


def deriv_after_close(now_ms: int) -> bool:
    """거래일인데 파생 정규장이 **이미 끝났는가**.

    수집 창과 짝이다: 창이 닫힌 뒤에도 벤더는 그날 누적을 계속 답하므로, 창만 보고
    멈추면 **그날이 통째로 사라진다**(파생엔 일별 확정 TR 이 없어 소급 경로가 0이다).
    마감 후 1회 스냅샷의 게이트가 이 술어다.

    ⚠ BLOCKING: 거래일 판정이 캐시 미스 시 동기 KIS HTTP 를 칠 수 있다 — 코루틴은
    ``deriv_after_close_async`` 를 await.
    """
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KST)
    if (kst.hour * 60 + kst.minute) < DERIV_CLOSE_MIN:
        return False
    return is_trading_day_now(now_ms)


async def deriv_after_close_async(now_ms: int) -> bool:
    """deriv_after_close 의 non-blocking 진입점 — to_thread 봉인."""
    return await asyncio.to_thread(deriv_after_close, now_ms)


# ── 투자자 수급(ka10051) 수집 창 ─────────────────────────────────────────────
#
# **주식 정규장보다 늦게 닫는다.** `ws_capture_window`(15:30)를 쓰면 그날의 마지막
# 모양을 통째로 놓친다 — 종가 단일가(15:20–15:30)는 **체결이 15:30 에 일괄로** 나는데
# 게이트는 그 직전에 닫히기 때문이다. 증상은 "수집이 멈춘 것" 처럼 보이지 않아서 더
# 나쁘다: 15:20 이후 접속매매가 없어 벤더 값이 동결되므로 `rows_equal` 이 폴을 전부
# 스킵하고, 파일의 마지막 쓰기가 매일 15:22 로 찍힌다(2026-08-11 실측 — 8/5·8/7·8/10·
# 8/11 네 날 모두 15:22).
#
# 그 결손의 크기를 실측했다(2026-08-10 확정본 대비 장중 마지막 표본):
#
#     코스피 기관   장중 +6,619억 → 확정 +3,635억   (45% 차이)
#     코스피 개인   장중 +8,772억 → 확정 +10,549억  (20% 차이)
#
# 마감 후에도 벤더는 그날 누적을 계속 답한다(2026-08-11 16:04 실측: 코스피 외국인이
# 15:22 표본의 3,750억에서 2,089억으로 갱신돼 있었다). **묻기만 하면 살릴 수 있는
# 값**이라 창을 여는 것으로 충분하다.
#
# ⚠ `ws_capture_window` 를 늘려서 해결하지 않는다. 저쪽 15:30 은 호가 도메인의
# load-bearing 경계다 — 정규 TR 은 15:30 이후 틱이 없어 창을 열면 다운샘플러 carry 가
# 유령 스냅샷만 쓴다(그 함수 docstring). 도메인이 다르면 게이트도 따로 둔다.
#
# 왜 확정본(17:00 배치)으로 대신하지 않는가: 그때까지 **두 시간을 틀린 값으로 서빙**한다
# (실측 확정 시각 17:21). 그렇다고 확정을 앞당기는 것은 더 위험하다 — 확정 파일의
# **존재 자체가 멱등 마커**라(#1115) 벤더가 아직 잠정치를 주는 시점에 쓰면 그 값이
# 영구히 굳고 재조회 경로가 없다. 장중 표본은 잠정이라 그 위험이 없고, 남은 드리프트는
# 17:00 확정이 그대로 덮는다.
#
# ── 여는 쪽도 정규장이 아니다 (2026-08-12 실측) ──────────────────────────────
#
# 09:00 은 검토를 거친 값이 아니라 "주식 정규장 시작" 이라는 기본값으로 들어왔다.
# 닫는 쪽만 위 절이 다뤘고, 여는 쪽은 한 번도 재본 적이 없다. 재보니 **장전에도
# 벤더는 답한다** — 08:1x 부터 값이 있고 실시간으로 움직인다(코스피, 2026-08-12):
#
#     08:17  외국인   -616  기관 +149
#     08:27         -693       +326
#     08:47        -1280       +519      ← NXT 프리마켓·장전 대량매매 체결분
#     08:52~09:00  -1262       +475      ← 동결(NXT 프리마켓이 08:50 에 끝난다)
#
# **09:00 에 리셋되지 않는다.** 수집기가 09:00:25 에 찍은 그날 첫 표본이 이미
# 외국인 -1260 · 기관 +475 로 장전 누적을 그대로 승계하고 있었고, 개장 체결은 그
# 위에 쌓였다(09:01:57 에 -1106 · -89). 즉 **장전 값은 지금도 화면에 실려 있다** —
# 09:00 한 점에 뭉쳐서. 이 창이 여는 것은 없던 데이터가 아니라 **그 한 점이 어떻게
# 쌓였는가** 이고, 그 경로는 소급 조회가 불가능해 찍어 두지 않으면 영원히 없다.
#
# 08:00 인 이유는 `ws_connection_window` 와 같다 — NXT 확장 세션이 그때 열린다.
# 그 창이 매일 08:00 에 같은 거래일 술어로 돌고 있으므로 개장 전 판정은 이미 검증돼
# 있다. 대가는 저장량과 유량인데 둘 다 작다: 2콜/30초가 60분 늘어 +240콜/일이고
# 이는 `(앱키, TR)` 5 req/s 버킷의 1.4% 다. 장전은 체결이 드물어 `rows_equal` dedup
# 이 자주 걸리므로 실제 저장 증가분은 창 비율(13%)보다 작다.
#
# **파생(`DERIV_OPEN_MIN`)은 따라 열지 않는다.** 그쪽은 장전 세션 자체가 없다 —
# 같은 날 08:23 실측에서 KOSPI200 선물이 `session:"closed"` · `volume:0` 이었다.
# 창만 넓히면 담을 값 없이 폴만 늘고 커버리지 분모가 부풀어 완결성 신호가 흐려진다.
#
#: **밑줄 없는 public 상수다** — 커버리지 분모(`_investor_flow_payload`)와 응답의
#: x축(`session_start_sec`·`session_end_sec`)이 같은 창을 말해야 하는데, 숫자를 세
#: 곳에 적으면 창을 조정할 때 조용히 갈린다. 게이트가 SSOT 다(`DERIV_CLOSE_MIN` 과
#: 같은 규율). ⚠ 프론트는 이 파생을 **끝만** 읽고 있었다 — 시작을 옮기려면
#: `SessionLinesChart`·`SessionAxisLabels` 가 `session_start_sec` 를 실제로 소비해야
#: 한다(안 그러면 장전 표본이 x축 왼쪽 끝에 겹쳐 쌓인다).
INVESTOR_FLOW_OPEN_MIN = 8 * 60             # 08:00 KST — NXT 프리마켓 개시
INVESTOR_FLOW_CLOSE_MIN = 16 * 60 + 30      # 16:30 KST


def _within_investor_flow_clock(t_ms: int) -> bool:
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KST)
    return INVESTOR_FLOW_OPEN_MIN <= (kst.hour * 60 + kst.minute) < INVESTOR_FLOW_CLOSE_MIN


def investor_flow_capture_window(now_ms: int) -> bool:
    """투자자 수급 수집 게이트: 거래일 && 08:00–16:30 KST.

    `should_run_now` 를 못 쓰는 이유는 `deriv_capture_window` 와 같다 — 그 함수는
    `market_phase`(주식 시계)가 'closed' 면 False 라 정규장 **양쪽 밖**을 못 담는다.
    그래서 거래일 판정만 SSOT 에서 받고 시계는 여기서 연다.

    ⚠ BLOCKING: 거래일 판정이 캐시 미스 시 동기 KIS HTTP 를 칠 수 있다 — 이벤트
    루프에서 직접 호출 금지, 코루틴은 ``investor_flow_capture_window_async`` 를 await.
    """
    if not _within_investor_flow_clock(now_ms):
        return False
    return is_trading_day_now(now_ms)


async def investor_flow_capture_window_async(now_ms: int) -> bool:
    """investor_flow_capture_window 의 non-blocking 진입점 — to_thread 봉인."""
    return await asyncio.to_thread(investor_flow_capture_window, now_ms)


# ── 시분할 구독은 폐지됐다 (ADR-0140 §2, PR-F) ────────────────────────────────
#
# 여기 있던 `target_ws_venue(now)` · `in_krx_warmup_window(now)` · `AUTO_VENUE` 는
# **"한 시각엔 한 venue 만 구독한다"**는 전제 위에 서 있었다:
#
#     08:00─08:50 NXT │ 08:50─15:31 KRX │ 15:31─20:00 NXT
#
# 그 전제가 필요했던 이유는 슬롯이 아니라 **저장 성역**이었다 — NXT 틱이 KRX 정규장
# 캡처에 새지 않게 하려고 아예 구독을 갈아 끼웠다. ADR-0140 이 저장에 venue 축을
# 주면서(PR-D) 두 시장이 서로 다른 디렉터리로 가게 됐고, 격리를 구독 시각으로 흉내
# 낼 이유가 사라졌다.
#
# 이제 구독 파생은 **시각이 아니라 종목**이 정한다 — `live.coverage.subscription_venues`.
# 저장 창(venue 별 09:00–15:30 / 08:00–20:00)은 PR-G 가 별도로 다룬다.
