# Live Quote Overlay 딥닝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, 2파일이라 경량) 또는 subagent-driven-development. 스텝은 `- [ ]` 체크박스.

**Goal:** 흩어진 "Live Quote 오버레이"(코드→시세 Map + phase + 갱신시각)를 단일 deep 모듈 `useLiveQuoteOverlay`로 모으고, `useQuoteByCode`를 그 thin view로, 관심맵을 그 훅으로 전환해 인라인 Map 중복을 제거한다.

**Architecture:** `useQuotes`(쿼리 primitive)는 그대로. 그 위에 `useLiveQuoteOverlay`가 Map 조립 + 메타(phase/updatedAt)를 한 인터페이스로 노출. `useQuoteByCode`(Map만 필요한 콜러)는 `useLiveQuoteOverlay(codes).quoteByCode` 한 줄로 축약 → 기존 콜러(WatchlistDrawer·LiveStatusBar·Screener) 시그니처 무변경. 관심맵만 오버레이 훅으로 전환.

**Tech Stack:** React 18, @tanstack/react-query 5, vitest + @testing-library/react.

**Branch:** `live-quote-deepening` (히트맵 브랜치 4320d69 위에 스택; 히트맵 PR 머지 후 리베이스 전제).

**Decision record:** plan-eng-review D1=A(오버레이 훅 + thin view). 후보2(포맷 통합)는 **드롭** — CandleTooltip의 색/텍스트 불일치 "버그"가 `PriceRow`(라인 47-59)에서 이미 반올림-후-채색으로 해결돼 있어(주석 명시) 정당화 소멸 + 5표면 합성이 의도적으로 달라 통합 이득 < over-engineering 위험. 후보3(visibleFolderGroups)도 no-op(히트맵 표시 정책이라 grouping.ts로 안 옮김).

**Test runner:** `cd frontend && npx vitest run <path>`. 타입: `npx tsc -b 2>&1 | grep -E "liveQuotes|pages/Heatmap" || echo CLEAN`(pre-existing 무관 에러 제외). 커밋 훅: `git add` / `git commit -m` 별도 줄, `&&` 금지.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `frontend/src/api/liveQuotes.ts` | `useLiveQuoteOverlay`(신규 deep) + `useQuoteByCode`(thin view로 축약) | 변경 |
| `frontend/src/api/liveQuotes.test.tsx` | 오버레이 훅 테스트 추가 | 변경 |
| `frontend/src/pages/Heatmap.tsx` | 오버레이 훅으로 전환(인라인 Map·useQuotes 직접호출 제거) | 변경 |
| `frontend/src/pages/Heatmap.test.tsx` | mock을 `useLiveQuoteOverlay`로 전환 | 변경 |

---

## Task 1: `useLiveQuoteOverlay` 신설 + `useQuoteByCode` thin view

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts`
- Test: `frontend/src/api/liveQuotes.test.tsx`

- [ ] **Step 1: 실패 테스트 추가**

`frontend/src/api/liveQuotes.test.tsx` 에 추가(기존 import/하네스 재사용; 없으면 파일 상단 패턴 따름):
```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as client from './client';
import { useLiveQuoteOverlay, useQuoteByCode } from './liveQuotes';

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

it('useLiveQuoteOverlay: quoteByCode + phase + dataUpdatedAt 노출', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'open',
    quotes: [{ code: '005930', price: 70000, change_pct: 5, change_won: 3000 }],
  } as never);
  const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper: wrap });
  await waitFor(() => expect(result.current.quoteByCode.size).toBe(1));
  expect(result.current.quoteByCode.get('005930')?.price).toBe(70000);
  expect(result.current.phase).toBe('open');
  expect(typeof result.current.dataUpdatedAt).toBe('number');
});

it('useQuoteByCode: 오버레이의 quoteByCode와 동일 Map(thin view)', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'open', quotes: [{ code: '000660', price: 200000, change_pct: -2, change_won: -4000 }],
  } as never);
  const { result } = renderHook(() => useQuoteByCode(['000660']), { wrapper: wrap });
  await waitFor(() => expect(result.current.get('000660')?.change_pct).toBe(-2));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/api/liveQuotes.test.tsx`
Expected: FAIL — `useLiveQuoteOverlay` export 없음.

- [ ] **Step 3: 구현 — `liveQuotes.ts`**

기존 `useQuoteByCode`(useQuotes로 Map 빌드하던 훅)를 아래로 교체하고, 위에 `useLiveQuoteOverlay`를 추가. `useQuotes`/`LiveQuote`/`LiveQuotesResponse`/`useMemo`는 이미 이 파일에 있음.
```ts
export interface LiveQuoteOverlay {
  /** 코드→Live Quote 조회. 없는 코드는 .get → undefined. */
  quoteByCode: Map<string, LiveQuote>;
  /** 시세 단계(pre_open/open/closed). 미도착 시 undefined. */
  phase: LiveQuotesResponse['phase'] | undefined;
  /** react-query dataUpdatedAt(ms). 미도착 시 0. */
  dataUpdatedAt: number;
}

/** Live Quote 오버레이(ADR-0056 단일 merge seam)의 deep 접근자: codes 의 현재가
 *  오버레이를 {quoteByCode, phase, dataUpdatedAt} 한 인터페이스로 노출. Map 조립과
 *  메타를 한 곳에 모아, 셋 다 필요한 소비자(관심맵)가 인라인으로 Map 을 다시 만들지
 *  않게 한다. Map 만 필요하면 useQuoteByCode(thin view)를 쓴다. */
export function useLiveQuoteOverlay(codes: string[]): LiveQuoteOverlay {
  const q = useQuotes(codes);
  const quoteByCode = useMemo(
    () => new Map<string, LiveQuote>((q.data?.quotes ?? []).map((x) => [x.code, x])),
    [q.data],
  );
  return { quoteByCode, phase: q.data?.phase, dataUpdatedAt: q.dataUpdatedAt };
}

/** codes 의 Live Quote 를 코드→quote Map 으로. useLiveQuoteOverlay 의 thin view —
 *  Map 만 필요한 관심종목/스크리너 패널·라이브 상태바가 쓴다(시그니처·동작 불변). */
export function useQuoteByCode(codes: string[]): Map<string, LiveQuote> {
  return useLiveQuoteOverlay(codes).quoteByCode;
}
```
주의: 기존 `useQuoteByCode` 본문(useQuotes + useMemo Map)을 삭제하고 위 thin view로 대체. 기존 JSDoc/주석은 위 내용으로 갱신.

- [ ] **Step 4: 통과 확인 + 기존 테스트 회귀**

Run: `cd frontend && npx vitest run src/api/liveQuotes.test.tsx`
Expected: PASS(기존 + 신규 2건). 기존 `useQuoteByCode` 테스트도 그대로 통과(동작 불변).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/api/liveQuotes.ts frontend/src/api/liveQuotes.test.tsx
git commit -m "refactor(live): useLiveQuoteOverlay deep 훅 + useQuoteByCode thin view"
```

---

## Task 2: 관심맵을 오버레이 훅으로 전환

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.test.tsx`

- [ ] **Step 1: 테스트 mock 전환(실패 유도)**

`frontend/src/pages/Heatmap.test.tsx` 의 `vi.mock('../api/liveQuotes', ...)` 블록을 `useLiveQuoteOverlay` 모킹으로 교체(현재는 `useQuotes` 모킹):
```tsx
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open',
    dataUpdatedAt: 0,
  })),
}));
```
나머지 테스트(렌더·jump·정렬토글·배너·범례)는 그대로 — 셀렉터가 동일.

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: FAIL — 페이지가 아직 `useQuotes`를 부르므로 mock 한 `useLiveQuoteOverlay`가 안 쓰여 quoteByCode 비어 행이 안 뜸(또는 phase 미정).

- [ ] **Step 3: 구현 — `Heatmap.tsx` 전환**

import 교체: `import { useQuotes, type LiveQuote } from '../api/liveQuotes';` → `import { useLiveQuoteOverlay } from '../api/liveQuotes';`
훅 사용부 교체(현재 `quotesQ`/`quoteByCode`/`phase`/`updated`):
```tsx
  const { quoteByCode, phase, dataUpdatedAt } = useLiveQuoteOverlay(codes);
```
그리고 `quoteByCode` useMemo 블록 삭제, `phase`/`updated` 를 아래로:
```tsx
  const updated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
```
(`phase`는 위 구조분해로 이미 확보 — 기존 `const phase = quotesQ.data?.phase;` 줄 삭제.) `LiveQuote` 타입 import 제거(미사용). `useMemo`는 entries/folders/codes/groups 에서 계속 쓰므로 유지.

- [ ] **Step 4: 통과 + 타입 + 회귀**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx src/pages/Heatmap.newgroup.test.tsx`
Expected: 전부 PASS.
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "liveQuotes|pages/Heatmap" || echo CLEAN`
Expected: CLEAN.
Run: `cd frontend && npx eslint src/api/liveQuotes.ts src/pages/Heatmap.tsx` → 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx
git commit -m "refactor(heatmap): 관심맵을 useLiveQuoteOverlay로 전환(인라인 Map 제거)"
```

---

## Task 3: 전체 회귀(오버레이 소비자 무영향 확인)

- [ ] **Step 1: Live Quote 소비자 전 테스트**

기존 `useQuoteByCode` 소비자(관심종목/스크리너 패널·라이브 상태바)가 thin view 전환에 영향 없음을 확인:
Run: `cd frontend && npx vitest run src/api/liveQuotes.test.tsx src/watchlist src/screener src/heatmap src/pages 2>&1 | tail -6`
Expected: 전부 PASS.

- [ ] **Step 2: (커밋 없음 — 회귀 확인용)** 실패 시 해당 태스크로 복귀.

---

## Self-Review

- **Spec 커버리지**: 후보1 = T1(오버레이 훅+thin view) + T2(관심맵 전환) + T3(회귀). 후보2/3 드롭 사유 명시(헤더 Decision record). 누락 없음.
- **Placeholder**: 없음 — 모든 스텝에 실제 코드·명령·기대.
- **타입 일관성**: `LiveQuoteOverlay`{quoteByCode, phase, dataUpdatedAt} ← T2 구조분해와 일치. `useQuoteByCode` 반환 `Map<string, LiveQuote>` 불변(기존 콜러 무영향). `LiveQuotesResponse['phase']` 는 기존 export 타입.
- **referential stability**: thin view 가 오버레이의 memoized quoteByCode 를 그대로 반환 → 기존 useQuoteByCode 의 [data] 메모 동작과 동일(불필요 리렌더 없음).
