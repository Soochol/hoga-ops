"""키움 WS 실시간 FID 상수 — 실측(2026-07-16 실계좌)에서 옮긴 단일 진실원.

KIS(위치기반 ^구분)와 달리 키움 REAL 프레임은 이름표(FID) dict다:
  {"trnm":"REAL","data":[{"type":"0D","item":"005930","values":{"41":"+6500",...}}]}
FID 인덱스가 키움 쪽에서 바뀌면 여기 한 곳만 고친다. 파서(kiwoom_frames)는
이 상수로 KIS ws_frames와 **byte 동일한** WsTick payload를 만든다(포트 계약).

거래원(0F)·프로그램매매(0w)는 PR-4에서 추가(정규장 스모크로 payload 확정 후).
"""
from __future__ import annotations

# 실시간 타입 코드 (키움 REAL row의 "type").
TYPE_TRADE = "0B"  # 주식체결 → SnapshotKind.TRADE
TYPE_ORDERBOOK = "0D"  # 주식호가잔량 → SnapshotKind.OB
TYPE_MEMBER = "0F"  # 주식당일거래원 → BROKER (PR-4)
TYPE_PROGRAM = "0w"  # 종목프로그램매매 (PR-4)

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
