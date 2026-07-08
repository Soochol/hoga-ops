# /study 분봉 청크 워크백 재사용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/study` 복기뷰의 분봉 로드가 PR #452(ADR-0091) fetch 예산과 상호작용해 **12거래일 초과 + 캐시 콜드** 조건에서 부분 캔들로 영구 박제되는 구멍을 막는다.

**결함 요약 (검증 완료):**
- [studyPastCandles.ts:44-53](frontend/src/api/studyPastCandles.ts) — 저장 기간 전체를 단일 호출 + `staleTime: Infinity` + `refetchInterval: false`.
- 백엔드 `_collect_for_venue`는 미캐시 12거래일 초과분을 `fetch_budget_exhausted`(blocking)로 유예.
- [useStudyReferenceBundle.ts](frontend/src/studyViews/useStudyReferenceBundle.ts)에는 blocking 경고 재시도 로직 없음 → 첫 응답이 부분이면 박제.

**Architecture — 재구현이 아니라 훅 교체:** `useLivePastCandles`([livePastCandles.ts:220-297](frontend/src/api/livePastCandles.ts))는 이미 이 문제의 완결 해법이다 — seed `(from, to)`를 주면 최신 15캘린더일 청크부터 seed from까지 **자동 워크백**(nudge), blocking 경고 응답은 **mergedRef에 비박제**(60s staleTime 재시도로 자가 회복), seed 도달 시 `servePrevious`로 쿼리 자체가 꺼진다. `/study`의 분봉 쿼리를 `useQuery(studyPastCandlesQueryOptions(...))`에서 이 훅으로 교체한다. 반환 shape(`data.candles/effective_sessions/data_warnings`, `isLoading`, `error`)이 기존 소비부와 호환됨을 확인했다. 부수 효과: 쿼리키가 `['live','past-candles',...]`로 통일돼 `/live`↔`/study` 크로스 페이지 클라이언트 캐시 공유.

**의도적 스코프 아웃:**
- 일봉(`past-daily-candles`): 예산은 분봉 오케스트레이터(`LiveMinuteCandleBackfill`) 소속이라 일봉엔 이 결함이 없음 — 무변경.
- `useWarmStudyReferenceTabQueries`(백그라운드 탭 프리페치, [useWarmStudyReferenceTabQueries.ts:64](frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts))의 단일-샷 minuteCandles 프리페치는 유지 — 본질 효과가 서버측 캐시 워밍(예산 내 12일 + read-ahead)이고, 활성 뷰가 청크 키를 쓰게 되면 클라이언트측 재사용만 줄어든다(무해). 청크화는 후속.
- UX: 워크백 중 차트가 점진 확장되는 것은 `/live`와 동일한 의도된 동작.

**Tech Stack:** React Query, vitest (`cd frontend && npx vitest run`), `npx tsc -b`. 브랜치는 **origin/main에서 신규 생성** (기존 세션 브랜치는 머지 완료).

---

### Task 1: useStudyReferenceBundle 배선 교체 + 배선 테스트

**Files:**
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.test.tsx` (mock 배선 갱신)

- [ ] **Step 1: 기존 테스트의 mock 구조 파악 후 실패 테스트 추가**

`useStudyReferenceBundle.test.tsx`는 `useQuery` 자체를 `useQueryMock`으로 대체한다(파일 상단 `vi.hoisted` 블록). 분봉 쿼리가 `useQuery`에서 빠지므로:

1. hoisted 블록에 `useLivePastCandlesMock: vi.fn()` 추가.
2. mock 선언 추가:

```tsx
vi.mock('../api/livePastCandles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/livePastCandles')>();
  return {
    ...actual,
    useLivePastCandles: useLivePastCandlesMock,
  };
});
```

3. 기존 각 테스트의 `useQueryMock` 반환 시퀀스에서 minuteCandles 슬롯 제거(4→3개: rangeHoga, rangeSidecars, rangeCandles, dailyCandles 순서 확인 후 조정 — dailyCandles는 useQuery 유지) 및 `useLivePastCandlesMock.mockReturnValue({ data: undefined, isLoading: false, error: null })` 기본값을 `beforeEach`에 추가.
4. 배선 잠금 테스트 추가:

```tsx
it('분봉은 useLivePastCandles(청크 워크백 훅)로 로드한다 — ADR-0091 예산 유예 박제 방지', () => {
  useLivePastCandlesMock.mockReturnValue({
    data: {
      code: '005930', from: '20260616', to: '20260618', venue: 'KRX',
      candles: [{ t_ms: 1_750_000_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      cached_dates: [], fresh_dates: [], data_warnings: [],
      effective_sessions: [],
    },
    isLoading: false,
    error: null,
  });
  const { result } = renderHook(() => useStudyReferenceBundle(save));
  // 분봉 timeframe(5m) save → 훅이 저장 기간 전체를 seed로 호출
  expect(useLivePastCandlesMock).toHaveBeenCalledWith(
    '005930', '20260616', '20260618', expect.anything(),
  );
  expect(result.current.bundle).not.toBeNull();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/studyViews/useStudyReferenceBundle.test.tsx`
Expected: 신규 테스트 FAIL (`useLivePastCandlesMock` 미호출)

- [ ] **Step 3: 훅 교체 구현**

`useStudyReferenceBundle.ts`:

```tsx
import { useLivePastCandles } from '../api/livePastCandles';
```

`const minuteCandles = useQuery(queryOptions.minuteCandles);` →

```tsx
  // ADR-0091: 저장 기간이 백엔드 fetch 예산(12거래일)을 넘으면 단일 호출은
  // fetch_budget_exhausted로 부분 응답이 온다. /live의 청크 워크백 훅을
  // 그대로 재사용해 seed까지 자동 전진 + blocking 응답 비박제로 회복한다.
  const minuteCandles = useLivePastCandles(
    inputs.minuteCandles.code,
    inputs.minuteCandles.from,
    inputs.minuteCandles.to,
    venue,
  );
```

소비부(`minuteCandles.data?.candles`, `.effective_sessions`, `.data_warnings`, `.isLoading`, `.error`)는 shape 호환이라 무변경. `studyReferenceQueryOptions` 결과에서 `minuteCandles`를 더는 구독하지 않으므로 `queryOptions.minuteCandles` 사용처가 이 파일에서 사라진다(옵션 빌더 자체는 warm 훅이 계속 사용 — 삭제 금지).

- [ ] **Step 4: 통과 확인 + 타입 게이트**

Run: `cd frontend && npx vitest run src/studyViews/useStudyReferenceBundle.test.tsx && npx tsc -b`
Expected: PASS / 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/studyViews/useStudyReferenceBundle.ts frontend/src/studyViews/useStudyReferenceBundle.test.tsx
git commit -m "fix(study): 복기뷰 분봉을 청크 워크백 훅으로 로드 — ADR-0091 예산 유예 부분-박제 방지"
```

### Task 2: 회귀 잠금 — 예산-유예 시나리오 통합 테스트

**Files:**
- Create: `frontend/src/studyViews/studyMinuteChunkWalkback.test.tsx`

- [ ] **Step 1: 통합 테스트 작성** (livePastCandles.test.tsx의 실 QueryClient + apiCall spy 패턴 재사용; 다른 쿼리(range 등) URL은 빈 응답으로 라우팅)

```tsx
/** /study 분봉 로드 × ADR-0091 예산: 12거래일 초과 콜드 기간이
 * 청크 워크백으로 전량 로드되고, budget 경고 응답이 박제되지 않는다. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastCandles, type LivePastCandlesResponse } from '../api/livePastCandles';
import * as client from '../api/client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('study 분봉 청크 워크백 (ADR-0091 예산 상호작용)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('복기뷰 저장 기간(30캘린더일)이 15일 청크로 나뉘어 seed까지 로드된다', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      return {
        code: params.get('code')!, from: params.get('from')!, to: params.get('to')!,
        venue: 'KRX', candles: [], cached_dates: [], fresh_dates: [], data_warnings: [],
      } satisfies LivePastCandlesResponse;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 복기뷰 저장 기간과 동일한 seed 사용 패턴 (useStudyReferenceBundle 배선과 동일 인자)
    renderHook(() => useLivePastCandles('005930', '20260608', '20260707', 'KRX'), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const urls = spy.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('from=20260623&to=20260707');
    expect(urls[1]).toContain('from=20260608&to=20260622');
  });

  it('첫 청크가 fetch_budget_exhausted를 실으면 박제하지 않는다 (data가 경고 응답으로 고정되지 않음)', async () => {
    let calls = 0;
    vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      calls += 1;
      const budgetHit = calls === 1;
      return {
        code: params.get('code')!, from: params.get('from')!, to: params.get('to')!,
        venue: 'KRX',
        candles: budgetHit ? [] : [{ t_ms: 1_750_000_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        cached_dates: [], fresh_dates: [],
        data_warnings: budgetHit
          ? [{ date: params.get('from')!, reason: 'fetch_budget_exhausted', msg: 'deferred' }]
          : [],
      } satisfies LivePastCandlesResponse;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260623', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    // blocking 응답은 이번 렌더에 서빙되지만 mergedRef에 박제되지 않는다 —
    // staleTime 경과 후 재요청이 정상 응답으로 회복 (여기서는 invalidate로 강제).
    await waitFor(() => expect(result.current.data).toBeDefined());
    await qc.invalidateQueries();
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1), { timeout: 3000 });
  });
});
```

- [ ] **Step 2: 실행**

Run: `cd frontend && npx vitest run src/studyViews/studyMinuteChunkWalkback.test.tsx`
Expected: 2 PASS (이 테스트는 훅 교체와 독립적으로 청크 머신 계약을 study 시나리오 인자로 잠금 — Task 1 이전에도 통과하는 것이 정상이며, 회귀 가드가 목적)

- [ ] **Step 3: 프론트 전체 게이트 + 커밋**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run build`
Expected: 기존 수치 대비 신규 실패 0 (eslint는 게이트 아님 — tests/component 기존 부채)

```bash
git add frontend/src/studyViews/studyMinuteChunkWalkback.test.tsx
git commit -m "test(study): ADR-0091 예산 시나리오 청크 워크백 회귀 잠금"
```

### Task 3: 수동 검증 (도그푸딩)

- [ ] 백엔드 콜드 기동(`HOGA_PERF_DEBUG=1`, :8001) 후 `/study`에서 30캘린더일 복기뷰 오픈 → 네트워크 탭에 `past-candles` 청크 2회 + 차트 좌측까지 캔들 채움 확인 (`/browse` 사용, CLAUDE.md 규약)
- [ ] 저장 뷰포트 복원이 워크백 점진 로드와 충돌하지 않는지 확인 (차트 점프/줌 플래시 여부 — [reference_lwc_setdata_preserves_logical_range] 유형 회귀 감시)
- [ ] `hoga_perf past_candles_collect`에서 청크별 `deferred_dates=0` 확인
