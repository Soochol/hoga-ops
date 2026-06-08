# TODOS

## Live (WS 파이프라인)

### 모의 appkey 시세 검증 → 13→26종목 확장 (spec §11)

**What:** 모의투자 appkey 시세를 실전과 비교(동일·무지연이면) 두 번째 WS 세션을 모의 WS(:31000)에 열어 Live Set을 13→26종목으로 무료 확장.

**Why:** KIS 41등록 한도(÷3TR=13종목)가 이 설계의 가장 아쉬운 제약. 같은 명의 모의 appkey로 비용 0원에 2배 확장 가능 — 단 모의 세션 시세의 신뢰성(지연·누락·장운영 차이)을 실측 검증한 뒤에만 채택.

**Context:** 정규장 fixture·스모크는 2026-06-08 완료. 평일 장중 한 세션에 실전·모의 동시 녹화로 시세 비교. 시간외(16–18시 단일가) 녹화는 의도적 캡처 회귀 구간이라 불필요(사용자 결정 2026-06-08).

**Effort:** M
**Priority:** P2
**Depends on:** 모의투자 appkey 발급 + 평일 09:00–15:30 KST

### #8 반장일 12:30 게이트 — WONTFIX (수용, 2026-06-08 사용자 결정)

**결정:** 고치지 않는다. 반장일(12/30·설/추석 전 영업일) 12:30~15:30 구간에
호가/거래원 평선 + 체결강도 0 carry가 parquet에 기록되지만 — 연 2~4일,
**장 마감 후 미관측 구간**, 데이터 *오염*(손실 아님, 캔들 가격은 정상), replay
사후 분석 시에만 보임 — 수용 가능하다고 사용자가 판단(2026-06-08).

**되살릴 트리거:** 반장일 12:30~15:30 보조지표를 사후 분석하거나, 자동매매/알림이
그 구간 데이터를 신뢰하게 되면 재개. 그때 해법 = **carry-timeout**("Live Set 전체
N분 무틱→carry 중단", 작은 수정·캘린더 불요).

**조사 결론(재조사 불요):** KIS chk-holiday 6필드 전부 binary — 조기마감 시각
없음(공식 koreainvestment/open-trading-api 예제 confirm). 자동 소스 불가. 프론트
sessionTime.ts는 half-day-ready(과거 parser TSV close_ms), kis_live 실시간 게이트만 미인지.

**Priority:** WONTFIX (트리거 시 재평가)

### #14 mixed-day fills — deploy 체크리스트 (코드 아님)

**What:** 컷오버일(오전 poller trades.parquet + 오후 WS fills.parquet 공존) bundle.py가 fills 단독 선택 → 오전 체결강도 미조회. **영구 read-path 병합 대신** off-hours 배포로 회피 + (발생 시) 일회성 trades→fills backfill.

**Why:** poller가 이 브랜치에서 삭제돼 post-merge엔 kis_live trades.parquet 쓰는 경로가 없음 → 비재발. 유일 발화점은 PR #43 장중 배포일. 영구 병합은 일회성·회피가능 transient에 과한 복잡도(advisor).

**Action:** PR #43은 2026-06-08 **장중(15:01) 머지됨**(사용자 결정 — 머지≠배포). **배포는 off-hours(15:30 후/09:00 전) 필수.** ⚠️ 오늘 운영 서버가 오전에 구 poller(v0.6.5.3)로 돌았다면 그날 kis_live에 오전 trades.parquet + (배포 후)오후 fills.parquet 공존 → trades→fills 일회성 backfill 확인.

**Effort:** S (체크리스트) / 발생 시 backfill 스크립트
**Priority:** P1 (배포 게이트)
**Depends on:** PR #43 배포 타이밍

### 코드리뷰 잔여 — cleanup 잔여 (#3·#10·#13 완료, #9·seam 남음)

**What:** #9 거래원 궤적 15분 절단(ADR-0023 row-churn 재발 — 디스크 seam 신설 필요, 큼), 크로스 스택 seam 상수(range.ts 5min/15min/promote env 동기화 검증). #3(개장 sleep)·#10(브로커 canonical)·#13(refresh 순서)은 2026-06-08 완료(Completed 참조).

**Why:** #9는 디스크 seam이 필요해 작은 묶음에서 분리. seam 상수는 검증 위주.

**Effort:** L (#9) / S (seam 검증)
**Priority:** P2
**Depends on:** None

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

### #11 flush 내구성 (2026-06-08, 리뷰 #11)
- flush가 흐름 합을 리셋 안 함 → commit_code(append 성공 후)가 '본 양'만 빼기
- subtract-on-commit: await 창 도착 틱 보존(zero-on-commit 회귀 방지)
- per-code 격리: 한 코드 OSError가 다른 코드 윈도 안 버림, 실패 합은 다음 윈도 롤
- 백엔드 1330 통과(await-창·실패보존·per-code 격리 인터리브 테스트)

### P2 cleanup 3건 (2026-06-08, 리뷰 #3·#10·#13)
- #3 게이트 닫힘 폴링 30초→1초(_GATE_CLOSED_POLL_S) — 매 거래일 개장 30초 유실 제거
- #10 _parse_member 거래원명 canonical — live=replay 식별자 통일(읽기 canonical 양방향 확정), unknown_alias 계측 복원
- #13 refresh_live_stream failure-domain 순서 — durable _state·carry 정리 먼저, ws send/drop best-effort
- 백엔드 1334 + 프론트 330(live) 통과. #9 거래원 궤적·seam 상수는 P2 잔여
