# 0103 — /live 분봉 백필: 선행 워밍 + read-ahead 제거 (온디맨드 복귀)

**Status:** accepted (2026-07-10)

**Related:**
- ADR-0090 (`0090-live-minute-backfill-warm-and-read-ahead.md`) — 이 ADR이 되돌리는 대상
- ADR-0100 — KIS REST 앱키별 독립 유량 재실측 (콜드 지연 전제 소멸의 근거)
- ADR-0095 — KIS 과거 분봉 캐시 memory-only 재확인 (재시작 후 콜드가 정상인 이유)
- ADR-0087 — Foreground 우선순위 두 계층 (워밍이 얹혀 있던 background 레인)

## Context

ADR-0090은 /live 분봉의 좌측 팬 지연을 없애려고 두 겹의 선행 캐시 채움을
추가했다: ① 종목 활성화 시 최근 60캘린더일을 background로 순차 워밍(POST
`/warm-past-candles`), ② `/past-candles` 서빙 직후 직전 동일 폭 구간(최대
15캘린더일)을 read-ahead 워밍. 근거는 "콜드 팬 1스텝 = KIS 왕복 1.5~2.6초"라는
실측이었는데, 이 수치는 **단일 계정 전역 15콜/초 클램프 시절**의 것이다.

그 사이 전제가 바뀌었다:

- **앱키별 독립 토큰버킷 복원**(ADR-0100)과 **백필 동시성 계정 비례**(#568)로
  4계정 합산 실측 ~53콜/s. 팬 1스텝(3거래일 ≈ ~10-12 KIS 콜)의 콜드 fetch는
  이론상 0.2~0.5초로, 사용자 요청은 `user_visible` 우선순위라 background 작업이
  양보한다.
- **좌측 팬 진행 칩 UX**(#533)가 이미 있어, 짧은 대기가 빈 화면이 아니라 진행
  표시로 보인다.
- 온디맨드 스텝 백필(useViewportBackfill 3a/3b: 빈공간 감지 → 고정 청크 요청 →
  settle-loop가 빈공간 재측정 → 채워지면 종료)이 이미 "빈공간 있을 때만, 스텝으로,
  다 채우면 종료"라는 사용자 기대 동작을 정확히 구현하고 있다.

한편 워밍의 비용은 명확하다. 종목을 열기만 해도(팬 없이) 활성화 워밍이 최근
60일(~40거래일 ≈ 종목당 최대 ~160 KIS 콜)을 투기적으로 소비한다. 캐시는
memory-only(ADR-0095)라 백엔드 재시작마다 다시 발생한다. 여러 종목을 훑는
세션에서는 대부분 쓰이지 않는 KIS 쿼터 지출이고, 500종목 확장(#570·ADR-0102)으로
일일 쿼터가 관심사가 된 지금 방향과 어긋난다.

## Decision

선행 워밍 2종을 전면 제거하고 온디맨드 스텝 백필로 일원화한다. 신규 코드는 없다 —
사용자 경로(인터랙션 백필)가 이미 원하는 동작이므로 순수 삭제다.

제거 대상:

1. **종목 활성화 워밍** — 프론트 `useWarmPastCandles` 훅과 호출,
   `POST /warm-past-candles` 라우트, `_WARM_PAST_CANDLES_CALENDAR_DAYS=60` 상수.
2. **read-ahead** — `/past-candles`의 `read_ahead=True`·`earliest_allowed` 인자,
   `collect_minute`의 read_ahead 로직, `_READ_AHEAD_MAX_SPAN_DAYS` 상수.
3. **워밍 인프라** — `warm_minute`/`_warm_run`/`_warm_tasks`, `stats_snapshot`의
   `warm_tasks` 카운터.

보존 대상:

- **`_fetch_past_shared`의 shield 조인** — 워밍이 사라져도 필요하다. 같은
  `(venue, code, date)`를 inflight dedup으로 공유하는 동시 사용자 요청 중 하나가
  취소(예: 타임프레임 전환 abort)될 때 다른 요청이 함께 죽는 걸 막는다. 트리거만
  warm latest-wins에서 일반 co-rider 취소로 재서술.
- **`_rate_limited_now`/`_mark_rate_limited`** — 온디맨드 콜드 fetch 경로가 공유.

## Alternatives considered

- **워밍(60일)만 삭제, read-ahead(15일) 유지**: read-ahead는 사용자가 실제로 팬
  중일 때만 발화해 투기성이 낮다. 그러나 계정 비례 동시성 이후 read-ahead가
  숨기는 지연 자체가 작아졌고, `warm_minute` 인프라를 남기는 유지 비용이 이득보다
  크다. 기각(전면 삭제).
- **워밍 창만 60→축소**: 파라미터 튜닝은 투기적 소비의 성격을 바꾸지 못한다.
  근본적으로 "팬할 가능성"에 선지불하는 구조가 남는다. 기각.
- **현상 유지**: ADR-0090의 콜드 지연 전제가 ADR-0100으로 소멸했으므로 유지
  근거가 약하다. 기각.

## Consequences

- 콜드 구간 팬 시 스텝당 짧은 KIS 대기가 다시 노출된다(이론상 0.2~0.5초/스텝,
  진행 칩이 덮음). **장중 실사용 팬 지연은 실장 검증 필요** — 장중 부하가 높을 때
  더 길어질 수 있다.
- 백엔드 재시작 직후 딥 스크롤은 전부 콜드다(캐시 memory-only). ADR-0090 시절
  재시작 후 첫 종목이 자동 복구되던 편의는 사라지지만, 이는 온디맨드 철학과 일치.
- 종목 활성화당 최대 ~160 KIS 콜 절약. 종목을 여러 개 훑는 세션에서 수천 콜
  차이이고, 일일 쿼터 압박(ADR-0102)을 완화한다.
- ADR-0090의 read-ahead 억제 픽스처(`_live_read_ahead_warm`/`_suppress_read_ahead_warm`)와
  워밍 전용 테스트 18종, `/warm-past-candles` 라우트 테스트가 함께 제거된다.
- 되돌림 트리거: 장중 실측에서 콜드 팬 지연이 체감상 문제로 확인되면, 전면 복원이
  아니라 **read-ahead만 선별 재도입**(투기성 낮음)을 먼저 검토한다.
