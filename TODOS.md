# TODOS

## Live (WS 파이프라인)

### 모의 appkey 시세 검증 → 13→26종목 확장 (spec §11)

**What:** 모의투자 appkey 시세를 실전과 비교(동일·무지연이면) 두 번째 WS 세션을 모의 WS(:31000)에 열어 Live Set을 13→26종목으로 무료 확장.

**Why:** KIS 41등록 한도(÷3TR=13종목)가 이 설계의 가장 아쉬운 제약. 같은 명의 모의 appkey로 비용 0원에 2배 확장 가능 — 단 모의 세션 시세의 신뢰성(지연·누락·장운영 차이)을 실측 검증한 뒤에만 채택.

**Context:** 정규장 fixture·스모크는 2026-06-08 완료. 평일 장중 한 세션에 실전·모의 동시 녹화로 시세 비교. 시간외(16–18시 단일가) 녹화는 의도적 캡처 회귀 구간이라 불필요(사용자 결정 2026-06-08).

**Effort:** M
**Priority:** P2
**Depends on:** 모의투자 appkey 발급 + 평일 09:00–15:30 KST

### 코드리뷰 잔여 — 데이터 손실 클래스 (다음 묶음, severity 우선)

**What:** 미수정 중 데이터 손실/정합 3건 우선 — #8 반장일 12:30 게이트(12:30~15:30 유령 carry가 parquet 영구화), #11 flush 내구성(OSError 시 10초 윈도 체결 합 영구 소실), #14 mixed-day fills 마스킹(컷오버일 오전 체결강도 미조회).

**Why:** 가시화 묶음(#4 rt_cd·#7 cycle_lag·#15 R1)이 끝나 캡처 장애가 화면에 보이므로, 이제 조용한 데이터 손실 클래스가 최우선. advisor가 severity 순서로 지목.

**Context:** findings 전문은 /home/dev/.claude/jobs 리뷰 기록 + v0.7.0.0 PR.

**Effort:** M
**Priority:** P1
**Depends on:** None

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
