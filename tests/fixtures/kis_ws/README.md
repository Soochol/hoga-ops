# KIS WebSocket 녹화 fixture

`scripts/record_kis_ws_frames.py`로 장중 녹화한 실제 KIS WS 프레임.
`tests/unit/live/test_ws_frames_recorded.py`가 이 파일들로 파서 인덱스·stride를
실프레임에 대해 검증한다(합성 fixture는 파서와 같은 상수로 생성돼 동어반복이라
레이아웃 진실 검증이 안 됨).

## 녹화 정보

- **녹화일(RECORD_DATE)**: 2026-06-08 (월), 정규장 11:47 KST ~
- **종목**: 005930 (삼성전자)
- **구간**: 180초
- **명령**: `set -a && source .env && set +a && uv run python scripts/record_kis_ws_frames.py 005930 180`

## 수신 통계

| TR | 프레임 | cnt 분포 | stride 검증 |
|----|--------|----------|-------------|
| H0STCNT0 (체결) | 851 | cnt 1~20 혼합 (멀티레코드 다수) | **stride 46, 위반 0** — cnt×46 정확 성립 |
| H0STASP0 (호가) | 837 | 전부 cnt=1 (62필드) | ASP_MIN_FIELDS=45 충족, cnt>1 미관측 |
| H0STMBC0 (회원사) | 3 | 전부 cnt=1 (78필드) | 주기가 길어 180초에 3건 |

## plan Task 0 Step 2 게이트 결과

- **cnt≥2 H0STCNT0 포함**: ✅ cnt=20까지 관측 — 멀티레코드 stride 46이 실전 검증됨 (이 게이트의 핵심).
- **H0STASP0/H0STMBC0 cnt>1**: 미관측(전부 cnt=1) — 파서의 단일 레코드 가정이 이 세션에서 성립. 향후 cnt>1이 관측되면 파서 보강 필요(plan 최종리뷰 I3-a).
- **PINGPONG 간격**: 180초간 0건. 삼성전자처럼 활발한 종목은 데이터 프레임이 끊임없이 와 `last_recv_ms`가 계속 갱신되므로 watchdog(120s 전제)와 무관. 한산한 종목·장 마감 후엔 PINGPONG이 liveness 신호가 되므로 별도 관측 필요.
- **15:35 시간외 재실행**: 미수행 (정규장 녹화만). 필요 시 15:35 재실행으로 시간외 수신 여부 확인.

## 주의

control.txt는 SUBSCRIBE 응답(rt_cd/msg_cd)만 포함 — approval_key 등 민감정보는
구독 *요청*에만 있고 수신 프레임엔 없다. 재녹화 시 RECORD_DATE를 갱신하고
이 표를 업데이트할 것.
