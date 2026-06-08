# TODOS

## Live (WS 파이프라인)

### 시간외 녹화 + 모의 appkey 검증 (Task 0b 잔여)

**What:** 15:35 KST에 `record_kis_ws_frames.py` 재실행으로 시간외 프레임 수신 여부 확인 + 모의투자 appkey 시세를 실전과 비교(동일·무지연이면 13→26종목 무료 확장 — spec §11).

**Why:** 정규장 녹화·스모크는 2026-06-08에 완료(P0 해소). 시간외 거동과 모의 세션 신뢰성은 미검증 잔여.

**Context:** 정규장 fixture는 커밋됨(`tests/fixtures/kis_ws/`, recorded 테스트 4건 활성). 한산한 종목의 PINGPONG 간격(watchdog 120s 전제)도 이때 함께 관측.

**Effort:** S
**Priority:** P2
**Depends on:** 평일 15:35 KST / 모의투자 appkey 발급

### 코드리뷰 잔여 11건

**What:** 2026-06-07 멀티에이전트 리뷰 15건 중 미수정 11건 처리 (반장일 12:30 게이트, 30초 개장 지연, cycle_lag_ms UI 블라인드, 구독 ACK rt_cd 무검사, 브로커명 canonical, 거래원 궤적 15분 절단, flush 내구성, mixed-day fills 마스킹, R1 데일리 경고, update_codes 예외 동기화, 크로스 스택 seam 상수).

**Why:** 대부분 medium 심각도 — 관측 가능성·데이터 정합 클래스. 상위 4건은 0a67a3e로 수정 완료.

**Context:** findings 전문은 v0.7.0.0 PR 본문 및 리뷰 잡 기록 참조.

**Effort:** M
**Priority:** P1
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
