"""키움 WS 실시간 FID 상수 — 실측(2026-07-16 실계좌)에서 옮긴 단일 진실원.

KIS(위치기반 ^구분)와 달리 키움 REAL 프레임은 이름표(FID) dict다:
  {"trnm":"REAL","data":[{"type":"0D","item":"005930","values":{"41":"+6500",...}}]}
FID 인덱스가 키움 쪽에서 바뀌면 여기 한 곳만 고친다. 파서(kiwoom_frames)는
이 상수로 WsTick payload를 만든다 — KIS ws_frames 계약 키를 **전부 보존**하되,
키움만 주는 필드는 additive 로 덧붙인다(포트 계약; kiwoom_frames 헤더 참조).

프로그램매매(0w)는 수급 FID(202~213) 의미 확정 후 추가(플랜 2026-07-20 §PR-F3).
"""
from __future__ import annotations

# 실시간 타입 코드 (키움 REAL row의 "type").
TYPE_TRADE = "0B"  # 주식체결 → SnapshotKind.TRADE
TYPE_ORDERBOOK = "0D"  # 주식호가잔량 → SnapshotKind.OB
TYPE_MEMBER = "0F"  # 주식당일거래원 → SnapshotKind.BROKER
TYPE_PROGRAM = "0w"  # 종목프로그램매매 → 프로그램 사이드카 latch (PR-F4)
# VI발동/해제 — **시장 전체 구독**(REG item=[""], 종목 슬롯 무관)이라 종목 파이프라인이
# 아니라 관측 캡처(kiwoom_vi_capture) 전용이다. 9068 발동구분·9069 발동방향·9075
# 장전구분의 코드값 legend 가 어떤 문서에도 없어 실이벤트 raw 채록으로만 확정 가능 —
# legend 확정 전까지 파서(kiwoom_frames)는 이 타입을 소비하지 않는다.
TYPE_VI = "1h"

# --- 1h VI발동/해제 FID (요약 로그용 — 저장은 raw 전체) ---
VI_CODE = "9001"  # 종목코드
VI_TRIGGER_PRICE = "1221"  # 발동가격
VI_KIND = "1225"  # 적용구분 — 공식 예제상 "정적" 한글 리터럴(코드값 아님)
VI_TRIGGER_DIR = "9069"  # 발동방향 — legend 미해독(캡처 목적 필드)

# --- 0D 주식호가잔량 FID ---
# 실측 확인(2026-07-16): 41-50 매도호가 오름차순(best=41), 51-60 매수호가 내림차순(best=51),
# 61-70 매도잔량, 71-80 매수잔량, 121/125 총잔량. 애프터마켓 단일가엔 3호가만 채워지고
# 4~10단계는 "-0"(=0)으로 온다 — abs(int("-0"))=0이라 빈 단계가 자연히 0으로 매핑된다.
OB_TIME = "21"  # 호가시간 HHMMSS
OB_ASK_PRICE = [str(f) for f in range(41, 51)]  # 매도호가 1~10
OB_BID_PRICE = [str(f) for f in range(51, 61)]  # 매수호가 1~10
OB_ASK_QTY = [str(f) for f in range(61, 71)]  # 매도잔량 1~10
OB_BID_QTY = [str(f) for f in range(71, 81)]  # 매수잔량 1~10
OB_TOTAL_ASK_QTY = "121"
OB_TOTAL_BID_QTY = "125"

# --- 0B 주식체결 FID ---
# FID 15(체결량)의 부호가 체결 방향: +매수 / -매도 / 0(동시호가 등). KIS side(1/5→±1)와
# 동형. FID 10(현재가)의 부호는 등락방향이라 가격은 abs로 크기만 취한다.
# NOTE: FID 15 부호=체결방향 규약은 정규장 스모크(계획 §6)에서 최종 확인 대상.
CNT_TIME = "20"  # 체결시간 HHMMSS
CNT_PRICE = "10"  # 현재가(체결가), 부호=등락방향
CNT_QTY = "15"  # 체결량, 부호=체결방향(+매수/-매도)
# 전일대비(부호 유의미 — abs 금지). 전일종가 = abs(CNT_PRICE) - CNT_DELTA 로 유도해
# 리스트 등락률의 기준가를 키움만으로 얻는다(KIS 폴링 의존 제거). 실측 검증:
# 2026-07-20 정규장 0B 6,880프레임 전건에 존재했고, 역산 전일종가가 KIS
# previous_close 와 5종목 전부 일치했다(tests/fixtures/kiwoom_t2/).
# FID 12(등락률)는 키움이 소수 2자리로 이미 반올림한 문자열이라 쓰지 않는다 —
# 10/11 에서 직접 계산해야 정밀도·반올림 규칙을 우리가 통제한다.
CNT_DELTA = "11"  # 전일대비(원), 부호=등락방향
# 당일 시가/고가/저가. 부호는 등락방향이라 _price 로 abs 만 취한다(CNT_PRICE 와 동형).
# 폴링(KIS 멀티시세 inter2_oprc/hgpr/lwpr)이 주던 값과 같은 의미 — 히트맵 행이 쓴다.
# 실측(2026-07-20 000660): 시가 1,745,000 · 고가 1,892,000 · 저가 1,735,000 로
# 저가 ≤ 현재가 ≤ 고가 관계가 성립했다.
CNT_OPEN = "16"
CNT_HIGH = "17"
CNT_LOW = "18"
# 종목 요약 지표 — 0B 43개 FID 중 그동안 버리던 것들. 이미 수신 중이라 슬롯·유량
# 비용이 0 이다(등록 단위는 종목이고 타입 무관 — kiwoom-ws-limits-measured).
# 의미는 골든 프레임 3종목 전건 산술 검산 + 키움 공식 GitHub 필드표 이중 확정:
#   228 = 1031(매수체결량)/1030(매도체결량)×100  → 100.61·120.42·94.41 소수 2자리 일치
#   30  = 13/(13−26)×100 (오늘 누적 ÷ 전일 전량)  → 43.85·37.24·32.53, 부호는 증감방향
#   620 = 14×1e6/13                              → 오차 0.0001% (14 가 백만원임을 이중 증명)
# ⚠️ 금액 단위가 한 프레임 안에서 3종 혼재한다: 14=백만원 · 29=원 · 1313=천원.
#    키움은 어떤 FID 에도 단위를 문서화하지 않으므로 새 금액 FID 소비 시 반드시 검산할 것.
CNT_FILL_STRENGTH = "228"  # 체결강도 %, 소수 2자리
CNT_VS_PREV_VOL_PCT = "30"  # 전일거래량 대비 비율 %, 부호=증감방향(크기만 소비)
CNT_CUM_VOLUME = "13"  # 누적거래량, 단위 1주
CNT_CUM_VALUE = "14"  # 누적거래대금, **백만원** — 검산 620=14×1e6/13 으로 단위 이중 증명
CNT_VWAP = "620"  # 당일거래평균가, 원

# --- 0F 주식당일거래원 FID ---
# 실측 확정(2026-07-20 T2 채록, docs/research/2026-07-20-kiwoom-0f-0w-t2-capture.md):
# 5쌍 구조 — 이름 141-145(매도)/151-155(매수), 당일 누적수량 161-165/171-175.
# 이름은 한글 텍스트로 내부 공백이 유의미하다("삼  성") — 양끝만 strip.
# 시각 FID 가 없어 t_ms 는 수신 시각(now_ms)을 쓴다(ADR-0111 REST 합성 경로와 동일 규약).
# 미소비: 146-160(회원사코드)·166-180(증감)·261-268(외국계 합 추정)·271-285(외국계,
# 국내사는 "!!!!" 센티넬)·337(갱신구분 추정) — 의미 미확정이거나 표시 요구 없음
# (플랜 2026-07-20 §PR-F1: BROKER 계약 shape-compat 최소만).
MEM_SELL_NAME = [str(f) for f in range(141, 146)]  # 매도 거래원 이름 1~5위
MEM_BUY_NAME = [str(f) for f in range(151, 156)]  # 매수 거래원 이름 1~5위
MEM_SELL_QTY = [str(f) for f in range(161, 166)]  # 매도 누적수량 1~5위
MEM_BUY_QTY = [str(f) for f in range(171, 176)]  # 매수 누적수량 1~5위

# --- 0w 종목프로그램매매 FID ---
# 실측 확정(2026-07-20 F3 검산 — 원본 205건 시계열, research 문서 §0w 표 참조):
# 순매수 산식 210=206−202·212=208−204 각 205/205 성립, 수량×주가≈금액 교차검증.
# **금액(204/208/212)은 백만원 단위** — KIS REST(원 단위)와 스케일이 달라 소비 전
# ×1,000,000 정규화 필수(EOD 실측: REST 399,887,415,500원 vs 0w 397,701백만원).
# 211/213(순매수 증감, 이벤트분)은 재전송·유실에 취약해 미소비 — 증감이 필요하면
# 누적 필드의 flush 간 diff 로 파생한다(F3 권고).
# 시각 FID 없음 → 수신 시각 사용(0F 와 동일 규약).
PRG_SELL_QTY = "202"  # 프로그램 매도수량 (누적, 주)
PRG_SELL_AMT = "204"  # 프로그램 매도금액 (누적, 백만원)
PRG_BUY_QTY = "206"  # 프로그램 매수수량 (누적, 주)
PRG_BUY_AMT = "208"  # 프로그램 매수금액 (누적, 백만원)
PRG_NET_QTY = "210"  # 순매수수량 (= 206-202)
PRG_NET_AMT = "212"  # 순매수금액 (= 208-204, 백만원)

# 구독 코드 venue 접미 → venue 태그. 키움은 0D payload에 거래소 필드가 없어(0B엔 9081
# 있음) 호가 venue를 **구독한 코드 접미**로 부여한다(실측 2026-07-16). _NX=NXT 확정.
# _AL(통합)은 정규장 스모크로 KRX·NXT 구분 방식 확정 전까지 PR-1에서 미사용.
VENUE_SUFFIX: dict[str, str] = {"_NX": "NXT"}


def split_venue(item: str) -> tuple[str, str]:
    """REAL row의 item("005930" 또는 "005930_NX") → (bare_code, venue).

    알려진 venue 접미가 없으면 KRX. item은 키움이 구독 코드를 그대로 에코한 값이다.
    """
    for suffix, venue in VENUE_SUFFIX.items():
        if item.endswith(suffix):
            return item[: -len(suffix)], venue
    return item, "KRX"


def apply_venue(code: str, venue: str) -> str:
    """bare code + venue → 구독 wire 코드(split_venue 역). NXT면 _NX 접미, 그 외 무접미.

    매니저가 target_ws_venue로 파생한 venue를 구독 코드에 실어 시간대 스왑한다
    (ADR-0118 §2 — venue 태깅 = 구독 코드 접미). apply_venue∘split_venue = 항등.
    """
    return f"{code}_NX" if venue == "NXT" else code
