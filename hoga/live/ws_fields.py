"""KIS WS TR별 필드 인덱스 — 공식 샘플(koreainvestment/open-trading-api
legacy/websocket/python/ws_domestic_stock.py · ws_domestic_overseas_all.py)에서
옮긴 단일 진실원. 인덱스가 KIS 쪽에서 바뀌면 여기 한 곳만 고친다."""

TR_ORDERBOOK = "H0STASP0"  # KRX 호가
TR_TRADE = "H0STCNT0"  # KRX 체결
TR_MEMBER = "H0STMBC0"  # KRX 회원사(거래원)

# NXT(대체거래소) 실시간 TR — ADR-0096 후속 통합 venue 시분할(#524). 프레임 필드
# 레이아웃은 KRX 대응 TR과 byte-identical(공식 open-trading-api 대조 2026-07-09:
# H0NXCNT0 46필드·price=2·qty=12·side=21, H0NXASP0 호가 인덱스 전부 일치)이므로
# ws_frames 파서를 그대로 재사용한다. NXT 거래원(회원사) TR은 표시에 불요라 미구독.
TR_ORDERBOOK_NXT = "H0NXASP0"  # NXT 호가
TR_TRADE_NXT = "H0NXCNT0"  # NXT 체결

# 종목당 구독하는 실시간 TR 집합 — 사이징(live_session._PER_ACCOUNT_MAX)과 구독수
# (ws_client.sub_expected)의 단일 진실원. 한 곳만 고치면 양쪽이 동기화돼 드리프트 불가.
# TR을 빼면 연결당 등록 수가 줄어 더 많은 종목을 담을 수 있다(연결당 하드 상한 41 —
# OPSP0008 MAX SUBSCRIBE OVER, 2026-07-10 실측; ADR-0101).
TRS_KRX = (TR_ORDERBOOK, TR_TRADE, TR_MEMBER)
TRS_NXT = (TR_ORDERBOOK_NXT, TR_TRADE_NXT)  # NXT는 호가+체결만(거래원 미구독)
# 사이징은 worst-case(KRX 3 TR/종목) 기준. 정상상태는 한 venue만 구독하므로 종목당
# 3 TR이지만, venue 스왑(ws_client.ensure_venue)이 unregister-before-register라
# 전환 찰나 구 venue를 먼저 비운다 — 그래서 스왑 점유도 종목당 3을 넘지 않아 상한
# 41 안에 든다(register-first면 5로 초과했음, ADR-0101).
TRS = TRS_KRX

# tr_id → venue 태그. ws_frames가 WsTick.venue를 채우고 stream이 저장/표시 분기에 쓴다.
# 미지 tr_id는 KRX로 폴백(하위호환 — 태그 부재/구경로는 KRX 의미).
_TR_VENUE: dict[str, str] = {
    TR_ORDERBOOK: "KRX", TR_TRADE: "KRX", TR_MEMBER: "KRX",
    TR_ORDERBOOK_NXT: "NXT", TR_TRADE_NXT: "NXT",
}


def tr_venue(tr_id: str) -> str:
    return _TR_VENUE.get(tr_id, "KRX")


def trs_for_venue(venue: str) -> tuple[str, ...]:
    return TRS_NXT if venue == "NXT" else TRS_KRX

# --- H0STASP0 (호가) — 위치 기반 ---
ASP_CODE = 0
ASP_TIME_HHMMSS = 1
ASP_ASK_P = range(3, 13)  # 매도호가 1~10
ASP_BID_P = range(13, 23)  # 매수호가 1~10
ASP_ASK_Q = range(23, 33)  # 매도잔량 1~10
ASP_BID_Q = range(33, 43)  # 매수잔량 1~10
ASP_TOT_ASK_Q = 43
ASP_TOT_BID_Q = 44
ASP_MIN_FIELDS = 45

# --- H0STCNT0 (체결) — 46필드(마지막 idx 45 = 정적VI발동기준가) ---
CNT_FIELDS = 46
CNT_CODE = 0
CNT_TIME_HHMMSS = 1
CNT_PRICE = 2
CNT_QTY = 12  # 체결거래량
CNT_SIDE = 21  # 체결구분: '1'=매수, '5'=매도, '3'=장전

# --- H0STMBC0 (회원사) — 시간 필드 없음 ---
MBC_CODE = 0
MBC_SELL_NAMES = range(1, 6)
MBC_BUY_NAMES = range(6, 11)
MBC_SELL_QTYS = range(11, 16)
MBC_BUY_QTYS = range(16, 21)
MBC_MIN_FIELDS = 21
