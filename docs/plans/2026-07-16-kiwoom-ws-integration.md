# 키움 WS 통합 플랜 — 실시간 커버리지 76 → 876종목

작성: 2026-07-16 · 상태: **설계 확정, 스모크 1건 잔여, 미착수**
근거 실측: 2026-07-16 장중, 키움 실계좌 앱키 4개 전부 검증 완료

## 0. 목표

KIS 4앱키 체제에 키움증권 REST API 4계좌를 추가해 **WS push 실시간 커버리지를 최대화**한다
(해상도 개선은 부산물). WS 우선, REST 해상도는 차순위 — 사용자 확정.

## 1. 실측 결과 (설계의 근거)

키움 커뮤니티 통설("97건, 종목×타입당 카운트")은 실측으로 반증됨.

| 항목 | 실측값 |
|---|---|
| WS 등록 상한 | **연결당 총 200종목** (rc=105118 그룹당 / rc=105115 연결 총합, grp_no 늘려도 200 불변) |
| 카운트 단위 | **종목당 1건, 타입 무관** — `0B+0D` 쌍 등록해도 200종목 |
| 앱키당 세션 | **1개** — 동일 앱키 2번째 LOGIN이 기존 세션을 킥 (close 1000 'Bye') |
| 앱키 간 독립 | **확정** — 4앱키 동시 각 200종목, disjoint 800종목 동시 REAL 수신 |
| REG 유량 | 별도 제한 ~5 REG/s per 연결 (rc=105110) — 배치 50종목/REG로 회피, 800종목 재등록 실측 17초 |
| 0D 페이로드 | 10호가+잔량(FID 41-80)+총잔량(121/125)+예상체결(23/24) — 히트맵 요건 충족 |
| 0B 페이로드 | 현재가·체결량·누적량·시각 + **FID 9081 거래소구분("KRX")** |
| NXT | **`_NX` 접미 코드로 수신 확정** (애프터마켓 005930_NX 0D 2,217틱/2분). `_AL`(통합) 표기 존재 |
| 일반코드 | KRX 전용 (KRX 마감 후 틱 0) |
| 분봉 REST (ka10080) | **900봉/콜** + 연속키 (KIS FHKST03010230은 ~120봉/콜) |
| 키움 REST 유량 | TR(api-id)당 ~1/s — 폴링 엔진 불가 |
| 토큰 | POST /oauth2/token → `token`, 만료 익일 동시각 |

용량 결론: 키움 4앱키 = 호가+체결 **800종목** (KIS WS 76의 10배 이상, 앱키당 200 vs 19).

## 2. 확정 정책 (사용자 결정)

### 2.1 WS 분담

| 대상 | 담당 | 규모 |
|---|---|---|
| 관심종목 (호가+체결+NXT) | **KIS WS** | 76종목 (19×4) — venue 스왑·유실 사다리 검증 자산 유지 |
| 히트맵 (호가+체결+거래원+프로그램) | **키움 WS** | 800종목 (200×4), 타입 `["0B","0D","0F","0w"]` |
| 그 외 열람 종목 (낯선 종목) | **키움 WS 온디맨드** | 열람 시 잔여 슬롯 등록 → 닫으면 REMOVE |

- 한 종목의 실시간 소유자는 항상 하나 (disjoint).
- 히트맵 거래원(`0F`)·프로그램매매(`0w`)는 **신규 기능** (현행은 관심종목만 보유) —
  "타입 무관 종목당 1건" 실측 덕분에 슬롯 비용 0.
- 온디맨드 종목은 **표시 전용 경로** (LiveBuffer publish만, writer 금지 — 반쪽 캡처가
  완결성 판정 오염. `rest_buffer_build` 선례). KIS 2s 폴러는 침묵 폴백 잔류.

### 2.2 REST 분담

| 기능 | 담당 | 비고 |
|---|---|---|
| 과거 분봉 딥 백필 | **키움** (ka10080) | 유일한 이관. 10일치 32콜→5콜. 키움우선→KIS폴백 사다리 (ADR-0109 문법) |
| 일봉 walk-back·스크리너 EOD 배치 | KIS | 대량 배치 = 유량(15/s×4) 필수. 키움 1/s면 퇴보 |
| 거래원 30s·프로그램 30s (관심종목) | KIS | 현행 유지 |
| 표시용 2s 폴러 | KIS | 온디맨드 WS의 침묵 폴백으로 잔류 |
| 호가 10s 폴링 (rest30) | KIS | **평시 대상 0** (히트맵이 키움 WS로 이동). 코드는 휴면 잔류 |
| 멀티현재가·지수·투자자·캘린더·심볼·토큰 | KIS | 무변경 |
| 주문 | 키움 (미래 예약) | 현재 토큰 발급만 |

### 2.3 장애·용량 대응 (사용자 확정)

**키움 계좌 추가로 대응.** KIS rest30 폴백 열화 정책(상위 500 선별+램프업)은 만들지 않는다.
브로커 전체 장애는 계정 수와 무관(운명 공동체)임을 인지하고 수용함.
rest30·2s 폴러 코드는 삭제하지 않고 휴면 (대상 빈 집합 = 호출 0, 유지비 0).

## 3. 아키텍처

### 3.1 패턴

**Ports & Adapters.** 포트 = `WsTick` + `LiveStream.on_tick` (hoga/live/stream.py:307,
소스 무관 단일 진입점). 코어(표시·저장·지표)는 브로커를 모른다.

- 지금(N=2): **Adapter만** (`kiwoom_frames.py`). 브로커 공통 인터페이스 추출 금지.
- 3번째 증권사 때(N=3): `LiveCollector` Protocol(Strategy) + waterfall 배분(Chain of
  Responsibility) 추출 — **Rule of Three**. 그 전 추출은 두 사례 우연에 과적합.
- 상속 베이스(Template Method) 금지 — 킥 vs 거부, 배치 REG vs 개별 TR로 골격이 다름.

### 3.2 지금 지킬 규율 (미래 추출을 싸게)

1. `kis_*` ↔ `kiwoom_*` 상호 import 금지
2. 공유 코드에 브로커명 분기 금지 — 주입(파라미터)만
3. 관측성 shape 통일: LiveStatus에 `collectors: {source: {state, registered, tick_rate, incidents}}`
4. `WsTick` 계약 테스트 공용 픽스처화 (모든 수집기가 같은 계약 테스트 통과)
5. 설정·계정 풀은 KIS 관례 복제 (`KIWOOM_APP_KEY`, `_2`..`_4` / SECRET)

### 3.3 모듈 맵

신설 (전부 `hoga/live/`, KIS 파일과 1:1 대칭):

| 파일 | 역할 |
|---|---|
| `kiwoom_runtime.py` | env 발견, configured_account_ids |
| `kiwoom_token_provider.py` | 토큰 발급/캐시 (만료 익일, 매요청 재발급 금지) |
| `kiwoom_account_pool.py` | 계정 lease + 이중 기동 킥 핑퐁 방지 락 |
| `kiwoom_frames.py` | **FID → WsTick 매핑 (통합의 심장)** — 0B/0D/0F/0w 파서 |
| `kiwoom_ws_client.py` | 세션 상태머신 + 배치 REG + 전량 재등록 + 워치독 |
| `kiwoom_coverage.py` | 키움 몫 플랜 (KIS ws_targets 이후 나머지, 200×계정 캡, disjoint 분할) |
| `kiwoom_client.py` | REST (분봉 ka10080 + 토큰), TR별 1/s 토큰버킷 |

변경 (최소 침습):

| 파일 | 변경 |
|---|---|
| `hoga/live/coverage.py` plan_storage_targets | `LiveStorageTargets.kiwoom_targets` 추가 |
| `hoga/api/sources.py` | `SourceName`에 `"kiwoom_live"` + `_POLICY_ORDER` |
| `hoga/live/stream.py` LiveStream | 생성자 `source` 라벨 주입 (현행 "ws" 하드코딩 제거). on_tick 로직 무변경 |
| `hoga/live/lifecycle.py` :319 부근 | 키움 계정별 LiveStream+KiwoomWsClient 평행 생성 루프 |
| `hoga/live/storage_runtime.py` sync | 키움 클라이언트 set_targets 전파 |
| `hoga/live/settings.py` | `kiwoom_enabled` 킬스위치 (기본 off) |
| `hoga/live/live_candle_backfill.py` | 분봉 소스 선택: 키움 우선 → KIS 폴백 |

### 3.4 KiwoomWsClient 상태머신

```
DISCONNECTED → CONNECTING → AUTHED → REGISTERING → LIVE
     ↑_____________________________________________|
          킥(close 1000) / 오류 → 지수 백오프 재접속
```

- 기대집합 `_expected: set[code]`가 SSOT. 등록은 세션 소멸 시 전량 소멸 → 재접속 = 전량 배치 REG
- rc 구분 처리: 105110(유량)=백오프 재시도 / 105115·105118(슬롯)=상한 / 기타=오류
- N회 연속 킥 → `kicked_by_peer` 정지 + LiveStatus 노출 (이중 기동 핑퐁 차단)
- **틱 유입 워치독**: REG ACK는 코드 유효성 비검사(쓰레기도 rc=0) → 등록 후 무틱 종목 감지

## 4. 구현 함정 (실측 유래 — 어댑터에서 흡수할 것)

1. 값에 등락부호 접두 (`"+6500"`, `"-659000"`) → strip 필수
2. **0D에 venue 필드(9081) 없음** → 구독 코드 접미(`_NX`)로 어댑터가 venue 부여 (0B에는 9081 있음)
3. venue별 등록 = 별도 슬롯 (일반+`_NX` = 2슬롯)
4. 시각 포맷 HHMMSS (FID 20/21) 정규화
5. 볼륨: 76→876은 틱 ~10배. 0D 139개 FID 중 필요 ~45개만 파싱(전체 dict 생성 금지),
   계측(초당 틱·파싱 지연·드랍 카운터)을 첫날부터
6. 분봉 이관 시 수정주가(`upd_stkpc_tp`)·이력 깊이를 KIS와 패리티 대조 (스크리너 64% 전례)

## 5. PR 분할 (각각 독립 머지 가능)

| PR | 범위 | 합격 기준 |
|---|---|---|
| ~~**PR-0**~~ ✅ | 플랜 + ADR-0116 (커밋 32211c4c) | — |
| ~~**PR-1**~~ ✅ | kiwoom_fields/frames/ws_client/token_provider/runtime (커밋 42281847) | 골든 테스트(실측 payload)·byte-parity·fake소켓 상태머신·**실 API NXT 애프터마켓 367틱 검증**·20 tests·ruff/pyright clean |
| ~~**PR-2**~~ ✅ | sources.py `kiwoom_live` + disk_state/screener_depth/meta_backfill 소스 튜플 (커밋 b9fca6e0) | 소스 계약 테스트 갱신·1278 api/live tests·promote 무변경(source:str) |
| ~~**PR-3**~~ ✅ | coverage `kiwoom_targets` 라우팅 + `kiwoom_enabled` 킬스위치(데이터모델·operator 제어) (커밋 c3879648) | off=plan byte-identical 골든·partition·settings backcompat·1077 live tests |
| ~~**PR-3b**~~ ✅ | promote_kiwoom_today + KiwoomSessionManager + storage_runtime/lifecycle/promoter/app 배선 (커밋 e902aaf0) | promote 골든·매니저 5종·라우팅 2종·1084 live+15 startup·실API 매니저 배선·**저장 flush 장중 도그푸딩 내일** |
| ~~**PR-4a**~~ ✅ | 관측성 — LiveStatus.kiwoom(status snapshot) (커밋 cc76b603) | 매니저 status·get_status 노출·1088 live tests |
| **PR-4b** | 온디맨드 표시전용 WS(뷰-구독 통합, 낯선 종목) | 장중: 낯선 종목 열람 시 키움 임시구독·닫으면 해제 |
| **PR-4c** | 0F/0w 어댑터(거래원·프로그램) — **정규장 스모크로 실측 FID 확정 후** | payload parity(추측 FID 금지) |
| ~~**PR-5**~~ ✅ | kiwoom_client ka10080 REST + KisCandle 어댑터 (커밋 543722f6) | 어댑터·walk-back·until_date·dedup 7종(MockTransport 실응답 재현) |
| **PR-5b** | 백필 hot-path 통합(키움우선→KIS폴백) — ka10080 날짜앵커링 스모크 확인 후 | 동일 구간 양소스 패리티·per-date vs walk-back 매핑 |
| ~~**PR-6**~~ ✅ | 프론트: 설정 키움 카드(토글+상태줄)·하단바 커버리지 칩 (커밋 c0efa285) | 칩 3종·토글/상태줄 4종·3746 tests·build |
| **PR-6b** | 종목별 화질 도트(`●`/`◐`) — 백엔드 per-code 소스 귀속 노출 후 | CollectionDot 패턴 재사용 |

UX 원칙: 사용자에겐 브로커명이 아니라 **화질 등급**(실시간●/폴링◐)으로 노출.
장애는 토스트가 아니라 커버리지 칩 숫자 하락으로.

## 6. 착수 전 잔여 검증 (정규장 09:00~15:20, ~10분)

1. **`_AL` 0B**: KRX·NXT 체결을 9081로 구분해 한 스트림으로 주는가
   → 맞으면 UN 통합이 키움 `_AL` 1슬롯으로 해결, "NXT=KIS 전담" 재평가 (설계 단순화 기회)
2. **`_NX` 0D**: 정규장에 10호가 다 오는가 (애프터마켓은 3호가만 확인됨)
3. **`0F`/`0w`**: 실수신 + 4타입 동시 등록 시 슬롯 카운트 불변 + payload 필드 확보
   (ADR-0111 BROKER WsTick shape 매핑용)

스모크 스크립트 (읽기 전용, 시세 구독만): 세션 스크래치패드 `kiwoom_ws_smoke.py` /
`kiwoom_ws_capacity.py` / `kiwoom_ws_groups.py` / `kiwoom_ws_multikey.py` / `kiwoom_ws_nxt2.py`
— PR-1에서 pytest 통합 픽스처로 승격 예정.

## 7. 후속 옵션 (1차 안정 후, 비범위)

- 관심종목 76의 거래원·프로그램을 키움 WS 0F/0w로 실시간 승격 (ADR-0111이 KIS 슬롯 부족으로
  포기했던 것의 복원) — 종목 소유권에 데이터종류 차원 추가 필요
- `_AL` 결과에 따라 KIS WS 역할 재평가 (순수 이중화 보험으로 축소 가능성)
- 남은 KIS REST 여유로 잔여 폴링 간격 단축 (10s → 6s)

## 8. 순서

```
정규장 스모크(§6) → ADR 작성("키움 WS 병행 도입 — 고정 역할 공존") → PR-1 → … → PR-6
```
