"""KIS WS TR별 필드 인덱스 — 공식 샘플(koreainvestment/open-trading-api
legacy/websocket/python/ws_domestic_stock.py · ws_domestic_overseas_all.py)에서
옮긴 단일 진실원. 인덱스가 KIS 쪽에서 바뀌면 여기 한 곳만 고친다."""

TR_ORDERBOOK = "H0STASP0"  # 호가
TR_TRADE = "H0STCNT0"  # 체결
TR_MEMBER = "H0STMBC0"  # 회원사(거래원)

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

# --- H0STCNT0 (체결) — 45필드 ---
CNT_FIELDS = 45
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
