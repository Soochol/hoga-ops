# 0091 — /live 분봉 fetch 예산 + 청크 워크백 (기아 해소)

**Status:** accepted (2026-07-08)

**Related:**
- ADR-0087 — Foreground 우선순위 두 계층 (공유 KIS 15/s 토큰버킷)
- ADR-0090 — /live 분봉 백필: 선행 워밍 + read-ahead (이 ADR이 read_ahead 폭을 캡)
- PR #451 — 일시 장애 응답이 델타 기준에 박제되던 영구 구멍 수정 (이 ADR이 재사용하는 blocking-warning 메커니즘)

## Context

/live 분봉이 간헐적으로 (a) 초기 7일만 뜨고 멈추거나, (b) 초기 로드조차 실패하거나,
(c) 수십 초씩 걸렸다. 2026-07-07 조사로 근본원인이 프론트 델타 설계 × 백엔드 무제한
수집 × 캐시 용량의 3중 결합임을 확인했다(dev 서버 `hoga_perf past_candles_collect`
실측).

1. **전체-윈도우 재요청.** 델타 최적화 기준선(`mergedRef`)은 컴포넌트 메모리에만 있어
   리마운트(탭 전환·새로고침)나 `to`(=오늘) 롤오버 시 소실된다. 깊게 팬해둔 탭
   (`historicalFromDate` 영속)은 기준선이 사라지면 [from..오늘] 수백 일을 통째로 재요청.
   실측: 43→243일로 5일씩 자라는 거대 collect 37건, 최장 25.3분(139일 fresh ≈ 560 KIS콜),
   전부 foreground 우선순위.
2. **read_ahead 자기증폭.** collect_minute가 "요청창 폭 전체"를 추가 워밍 → 243일 요청이
   또 243일 워밍을 유발.
3. **LRU 512키 초과 churn.** 과거 캐시 512키 한도 — 한 종목 반년 워크백이면 초과. 깊은
   walk가 최근 날짜를 축출 → 60초 refetch가 매번 재fetch(같은 날짜 39회 실측).
4. **결과 = 기아.** 공유 15/s 토큰버킷·세마포어(3)·스케줄러 큐가 포화 → EGW00201 폭풍
   (183회) + httpx 10s 타임아웃 에러 → 콜드 종목 초기 로드가 60s+ 대기(034220 3연속 재현).

"7일 이후 영구 안 나옴"의 주범이던 델타 기준선 박제는 PR #451에서 이미 수정됐다. 이 ADR은
나머지 3개 원인(전체-윈도우/증폭/churn)과 무한 로딩을 다룬다.

## Decision

4겹 방어를 `fetch_budget_exhausted`라는 한 blocking 사유로 일관 연결한다.

1. **백엔드 미캐시-일수 예산.** `LiveMinuteCandleBackfill._collect_for_venue`가 요청당
   KIS에서 새로 가져올 날짜를 `max_fresh_dates_per_collect`(기본 12거래일)까지만 fetch하고,
   초과분(과거쪽부터)은 `fetch_budget_exhausted` 경고로 유예한다. blocking 사유이므로
   read_ahead 스킵(`_fallback_blocking_warning_dates`)·비-KRX→KRX 폴백 covered 처리·프론트
   비박제(`BLOCKING_WARNING_REASONS`)가 함께 걸린다.
2. **read_ahead 폭 캡.** 선행 워밍 폭을 `_READ_AHEAD_MAX_SPAN_DAYS`(15캘린더일)로 캡.
3. **LRU 증설.** 과거 분봉 캐시 512→2048(250일×2종목+워밍 여러 종목 공존).
4. **프론트 청크 워크백.** 기준선이 없거나 델타가 넓으면 `PAST_CHUNK_CALENDAR_DAYS`
   (15캘린더일 ≈ 11거래일 < 예산 12) 청크로 최신부터 자동 워크백한다(응답 pin마다 리렌더
   nudge로 다음 청크 즉시 발사).
5. **프론트 타임아웃 백스톱.** past-candles 요청에 30s 타임아웃(`AbortSignal.any` +
   `AbortSignal.timeout`) — abort 시 React Query 재시도/refetchInterval이 이어받는다.

### 상수 결합 (반드시 유지)

- 프론트 청크(15캘린더일 ≈ 최대 11거래일) < 백엔드 예산(12거래일) → 한 청크는 항상 예산
  안에서 완결. 이 아래로 예산을 낮추면 청크가 예산 경고를 받아 60s 주기로만 전진한다
  (기능 유지, 속도 저하).
- read_ahead 캡(15) ≥ 프론트 팬 스텝 `stepChunkDays`(minute=5캘린더일) → 다음 좌측 팬
  청크가 항상 캐시 히트. 15는 헤드룸(`STEP_TRADING_DAYS` 증가 대비).
- 워크백 자기재시작은 `mergePastCandleResponses`가 merged `to`를 seed `to`(=max)에
  고정하는 데 의존한다(`sameIdentity`가 `previous.to === to`로 키). 이 max를 낮추면 워크백
  체인이 리셋된다.

## Consequences

- 어떤 단일 요청도 KIS를 ~48콜(12일×4콜) 이상 foreground로 독점하지 못한다.
- 깊은 복원은 즉시가 아니라 청크 단위 점진 로드(15일/사이클, 응답 도착 즉시 다음 청크 —
  240일 복원 ≈ 16사이클).
- 비-KRX 정책은 primary+KRX 폴백이 각자 예산을 가져 최악 2×예산.
- 레거시/외부 클라이언트가 거대 창을 요청해도 서버 예산이 막는다.
- **알려진 한계 — 백엔드 clamp 시 stall(스톰 아님).** 백엔드가 요청 `from`보다 앞선
  `from`을 돌려주면(더 오래된 데이터 부재로 forward-clamp) merged `from`이 seed 위에서
  plateau → 워크백이 seed에 못 미쳐 멈춘다. 다만 queryKey가 안정돼 refetch 스톰은 없고
  (staleTime 60s + React Query dedupe), 가장 오래된 청크만 ~60s마다 재시도한다. 백엔드가
  `from ≤ requestFrom`을 돌려주면 정상 종료. 데이터가 나중에 생길 수 있으므로 재시도는
  대체로 바람직하다.
- **잔존(스코프 밖).** 별개 프론트 결함(extending 게이트가 폴백 3종 미참조 → warning/
  preferHogaplay에서 팬 프리펜드가 깨지는 문제)은 이 ADR과 무관하며 별도 작업으로 남긴다.
