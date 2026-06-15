# TODOS

## Live (WS 파이프라인)

### 모의 appkey 시세 검증 → 13→26종목 확장 (spec §11)

**What:** 모의투자 appkey 시세를 실전과 비교(동일·무지연이면) 두 번째 WS 세션을 모의 WS(:31000)에 열어 Live Set을 13→26종목으로 무료 확장.

**Why:** KIS 41등록 한도(÷3TR=13종목)가 이 설계의 가장 아쉬운 제약. 같은 명의 모의 appkey로 비용 0원에 2배 확장 가능 — 단 모의 세션 시세의 신뢰성(지연·누락·장운영 차이)을 실측 검증한 뒤에만 채택.

**Context:** 정규장 fixture·스모크는 2026-06-08 완료. 평일 장중 한 세션에 실전·모의 동시 녹화로 시세 비교. 시간외(16–18시 단일가) 녹화는 의도적 캡처 회귀 구간이라 불필요(사용자 결정 2026-06-08).

**Effort:** M
**Priority:** P2
**Depends on:** 모의투자 appkey 발급 + 평일 09:00–15:30 KST

### #8 반장일 12:30 게이트 — 수동 반장일 캘린더 (self-contained)

**What:** ws_capture_window가 반장일(연말 등 12:30 조기 마감)에도 15:30까지 열려 12:30~15:30 유령 carry를 parquet에 영구화. **수동 반장일 캘린더**(KRX 반장일 = 연 몇 일, 사전 공지되는 짧은 목록)를 하드코딩/설정해 게이트 마감 시각을 당기는 작은 작업.

**Why:** KIS chk-holiday는 binary opnd_yn만 주고 조기마감 시각 데이터 소스가 없음(조사 2026-06-08 확정). 새 KIS 엔드포인트(blocked)가 아니라 수동 캘린더(medium·self-contained)가 정답 — advisor 재프레임.

**Context:** session_gate.py ws_capture_window/market_phase. 대안: 데이터소스-free 우회로 "전 코드 N분 무틱 시 carry 중단"(별도 설계). 프론트 sessionTime.ts는 이미 sessionCloseMs per-Stock-Date 수용(half-day-ready) — kis_live 게이트만 미인지.

**Effort:** M
**Priority:** P1
**Depends on:** 반장일 목록 소스 결정(하드코딩 vs 설정파일)

### #14 mixed-day fills — deploy 체크리스트 (코드 아님)

**What:** 컷오버일(오전 poller trades.parquet + 오후 WS fills.parquet 공존) bundle.py가 fills 단독 선택 → 오전 체결강도 미조회. **영구 read-path 병합 대신** off-hours 배포로 회피 + (발생 시) 일회성 trades→fills backfill.

**Why:** poller가 이 브랜치에서 삭제돼 post-merge엔 kis_live trades.parquet 쓰는 경로가 없음 → 비재발. 유일 발화점은 PR #43 장중 배포일. 영구 병합은 일회성·회피가능 transient에 과한 복잡도(advisor).

**Action:** PR #43을 **15:30 이후 또는 09:00 이전 배포**(머지 체크리스트). 만약 장중 머지됐으면 그날 trades→fills 일회성 backfill.

**Effort:** S (체크리스트) / 발생 시 backfill 스크립트
**Priority:** P1 (머지 게이트)
**Depends on:** PR #43 머지 타이밍

### 코드리뷰 잔여 — cleanup 클래스 (그 다음)

**What:** #3 30초 개장 sleep(게이트 닫힘 폴링 주기 단축), #10 브로커명 canonical(live/replay 식별자 분기), #9 거래원 궤적 15분 절단(ADR-0023 row-churn 재발 — 디스크 seam 필요), #13 update_codes 예외 동기화, 크로스 스택 seam 상수.

**Why:** 정합·UX cleanup — 데이터 손실 클래스보다 후순위.

**Effort:** M
**Priority:** P2
**Depends on:** 데이터 손실 클래스 먼저

### 캡처 헬스 pill 라벨 중복 (가시화 묶음 후속)

**What:** /live 상태바에 SSE 연결 span('LIVE●')과 캡처 헬스 pill('LIVE●')이 healthy 시 동일 문자열을 나란히 표시('LIVE● · LIVE●') — 글리치처럼 보임. pill 라벨을 구분(예: '캡처 LIVE●')하거나 두 표시를 한 컴포넌트로 통합.

**Why:** 두 신호는 다른 레이어(SSE = 브라우저↔백엔드, pill = 백엔드↔KIS 캡처)라 공존 의미는 있으나 동일 라벨이 혼동. 비차단 코스메틱(ch-review-5 Minor).

**Context:** SSE span은 LiveStatusBar.tsx:113, pill은 captureHealthPill.ts. SSE span 유지 정책과 얽힌 설계 판단.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Frontend

### 쿼리 재설계 (60초 리페치 다이어트 + 백필 델타화 + 점진 렌더)

**What:** 과거 불변 구간 쿼리 분리(staleTime ∞) + 스크롤 백필 델타 fetch + 받은 청크부터 점진 렌더 + AbortSignal 스레딩을 한 설계로.

**Why:** 60초마다 풀윈도(~65k봉, 수 MB) 재전송·재파싱·5패널 풀 setData가 남은 최대 프론트 비용 — 백엔드 병렬화·sessionPhaseAt 최적화 이후의 다음 덩어리.

**Context:** `useLiveBundle.ts:180-228`의 원자적 prepend 게이트(과거 viewport 순간이동 버그의 수정분)가 핵심 난점 — 쿼리 구조 변경 시 정확히 그 지점이 재발 위험. `/api/range`(지표)도 같은 풀윈도 패턴이라 함께 재설계해야 반쪽이 안 됨. 브라우저 실측 검증 필요.

**Effort:** L
**Priority:** P2
**Depends on:** v0.7.0.0 머지

### 백필 진행 표시

**What:** `isExtending` 상태를 "과거 데이터 불러오는 중…" UI로 노출.

**Why:** 깊은 스크롤 연속 채움 구간의 체감 개선 — 백엔드 가속 후 가치는 줄었으나 비용이 매우 낮음.

**Context:** 쿼리 재설계에 흡수 권장(로딩 UI가 거기서 다시 바뀜).

**Effort:** S
**Priority:** P3
**Depends on:** 쿼리 재설계와 함께

### /live 탭 keep-alive (B안) — 즉시·무플래시 전환

**What:** 탭마다 `LiveChartRoot` 인스턴스를 mount 유지(비활성 `display:none`), SSE는 활성 탭만 구독. 탭 전환을 show/hide로 만들어 viewport·줌·스크롤·그림을 네이티브로 보존하고 콜드 fetch 대기(cover)를 없앤다.

**Why:** A안(탭별 viewport 시간앵커 저장, plan-eng-review 2026-06-11 채택)이 "보던 위치 복원"은 이미 해결하지만, 전환마다 `/api/range`+past-candles 콜드 fetch 대기(cover ~0.5~2.5s)가 남는다. 여러 종목을 빠르게 오가는 감시 워크플로에서 이 대기가 실사용에 거슬리면 즉시전환 가치가 메모리 비용을 넘어선다 — **그 신호가 확인된 뒤에** 승격(reversibility).

**Context:** ADR-0069가 "탭 = cold-swap 뷰어"(차트 1개, 종목코드만 갈아끼움)를 의도적으로 택했고 warm 멀티구독을 기각했다. B는 구독은 active만 유지(ADR의 KIS 한도 제약 무위반)하되 **차트 DOM/인스턴스만 warm**으로 바꾸는 부분 이탈. 비용: 탭 생성이 무제한이므로 차트 N개를 그대로 warm으로 두면 메모리 비용이 사용자 탭 수에 비례해 커진다. 별도 warm-window 정책 없이는 각 lwc 캔버스 수MB, `display:none` 차트의 0-size 측정 함정(복귀 시 resize 필요), reveal/cover·useViewportBackfill 머신을 ×N 인스턴스로 복제한다. 1커밋 전(#72) 머지된 ADR을 재개봉하므로 blast radius 큼.

**Effort:** L
**Priority:** P3
**Depends on:** A안(탭별 viewport 앵커) 출시 + 실사용에서 전환 대기 체감 확인

## Completed

### v0.7.0.0 (2026-06-08) — KIS WS 전환 스냅샷
- WS 파이프라인 전체(Task 0a–13) + poller 은퇴
- 코드리뷰 상위 4건 수정 (gate to_thread·never-start·fill 정렬·active-set)
- past-candles 병렬 fetch + 싱글플라이트
- 안정성 3건 (EGW00201 가시화·워크백 조기 종료·장외 quotes 게이트)
- sessionPhaseAt 이진 탐색화

### 장중 녹화 + 통합 스모크 + 실측 (2026-06-08 정규장)
- Task 0b 녹화: fixture 커밋, recorded 테스트 4건 활성(stride 46 cnt=20까지 검증)
- Task 14 스모크: WS 연결→틱→JSONL→promote→parquet end-to-end 실계좌 확인
- past-candles 실측: A/B 8일 순차 5.03s→병렬 2.87s (1.75배), spec/PR 반영

### 캡처 헬스 가시화 (2026-06-08, 리뷰 #4·#7·#15 + ship 스킵분)
- ws_client 구독 ACK 추적 + _capture_health 단일 술어(7상태, recv-먼저)
- watchdog 공유(dead/stale만 재시작, sub_failed 가시화) + get_status capture_healthy/reason
- drain 일경계 리셋(R1 데일리 경고 제거 + 재개방 fill 라벨)
- 프론트 captureHealthPill(캡처 죽으면 빨강, closed 회색) — cycleLagPill 대체
- subagent-driven 6 Task, 백엔드 1325 + 프론트 1509 통과

### #11 flush 내구성 (2026-06-08, 리뷰 #11)
- flush가 흐름 합을 리셋 안 함 → commit_code(append 성공 후)가 '본 양'만 빼기
- subtract-on-commit: await 창 도착 틱 보존(zero-on-commit 회귀 방지)
- per-code 격리: 한 코드 OSError가 다른 코드 윈도 안 버림, 실패 합은 다음 윈도 롤
- 백엔드 1330 통과(await-창·실패보존·per-code 격리 인터리브 테스트)
