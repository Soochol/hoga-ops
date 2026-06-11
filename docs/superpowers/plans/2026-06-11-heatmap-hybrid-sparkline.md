# 관심맵 리디자인 (섹터 온도 스트립 + 종목 스파크라인) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/heatmap`(관심맵)에 상단 섹터 온도 스트립과 종목별 since-open 스파크라인을 추가해, 한 화면에서 시장 온도 스캔 + 종목 모멘텀 정독을 동시에 한다.

**Architecture:** 기존 신문형 카드 보드를 유지하고 (1) 스크롤 컨테이너 바깥에 `SectorTempStrip`(가시 섹터 평균 등락칩, 표시 전용 뜨거운 순, 클릭→카드 스크롤)을 얹고, (2) 각 종목 행에 1px SVG `Sparkline`을 추가한다. 스파크라인 데이터는 기존 10초 시세 폴(`useLiveQuoteOverlay`)을 모듈 레벨 Zustand 스토어(`sparklineStore`)에 누적해 만든다(백엔드 무변경). 색은 스파크라인 자기 기울기(연 이후 방향) 부호로 칠한다.

**Tech Stack:** React + TypeScript, Zustand(`create`), Vitest + @testing-library/react, Tailwind 토큰(`var(--price-up)`/`--price-down`/`--fg-dim`), 인라인 SVG.

**Spec:** `docs/superpowers/specs/2026-06-11-heatmap-hybrid-sparkline-design.md` (Approved). **승인 목업:** `docs/superpowers/designs/2026-06-11-heatmap-hybrid-sparkline.html`.

**테스트 명령:** 이 레포는 `npm test` 스크립트가 없다. 단일 파일은 `npx vitest run <path>`(프로젝트 루트 `frontend/`에서), 워치는 `npx vitest <path>`. 모든 명령은 `frontend/`에서 실행한다.

---

## File Structure

신규 (4 + 3 테스트):
- `frontend/src/state/sparklineStore.ts` — since-open 시계열 누적 store(코드→number[]). + `frontend/src/heatmap/useSparklineSeries.ts` (얇은 셀렉터 훅).
- `frontend/src/heatmap/Sparkline.tsx` — `number[]` → 1px SVG path, 기울기 부호로 색.
- `frontend/src/heatmap/SectorTempStrip.tsx` — 가시 섹터 평균 등락칩(뜨거운 순), 클릭→카드 스크롤.
- 테스트: `frontend/src/state/sparklineStore.test.ts`, `frontend/src/heatmap/Sparkline.test.tsx`, `frontend/src/heatmap/SectorTempStrip.test.tsx`.

변경:
- `frontend/src/heatmap/HeatmapRow.tsx` — 그리드 3→4칼럼, 스파크라인 셀 + `series?` prop. (+ `HeatmapRow.test.tsx` 보강)
- `frontend/src/heatmap/HeatmapFolder.tsx` — `seriesByCode?` 전달, 카드 루트에 스크롤 앵커 `id`.
- `frontend/src/heatmap/HeatmapBoard.tsx` — `seriesByCode?` 전달. (+ `HeatmapBoard.test.tsx` 보강)
- `frontend/src/pages/Heatmap.tsx` — 누적 effect + 스트립 렌더 + 정직 캡션 + 스크롤 핸들러. (+ `Heatmap.test.tsx` 보강)
- `DESIGN.md` — "방향성 스파크라인 선" 규칙 1줄.

각 파일은 단일 책임이다. 누적 상태는 `sparklineStore` 한 곳에만 산다(컴포넌트 state 아님 — 인앱 네비게이션 생존, 풀 리로드·KST 날짜롤오버 리셋).

---

## Task 1: sparklineStore — since-open 시계열 누적 store

**Files:**
- Create: `frontend/src/state/sparklineStore.ts`
- Create: `frontend/src/heatmap/useSparklineSeries.ts`
- Test: `frontend/src/state/sparklineStore.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/state/sparklineStore.test.ts`:
```ts
import { it, expect, beforeEach } from 'vitest';
import { useSparklineStore, MAX_POINTS } from './sparklineStore';

// KST 날짜는 unixMsToKSTDate(ms)=new Date(ms+9h). UTC 01:00 → KST 10:00 같은 날.
const DAY1 = Date.UTC(2026, 5, 10, 1, 0, 0); // 20260610 10:00 KST
const DAY2 = Date.UTC(2026, 5, 11, 1, 0, 0); // 20260611 10:00 KST

beforeEach(() => useSparklineStore.getState().reset());

it('append: 코드별로 값이 시계열로 쌓인다', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 2 }], DAY1);
  expect(useSparklineStore.getState().series.get('A')).toEqual([1, 2]);
});

it('cap: MAX_POINTS를 넘으면 가장 오래된 점이 밀린다', () => {
  const { appendBatch } = useSparklineStore.getState();
  for (let i = 0; i < MAX_POINTS + 5; i++) appendBatch([{ code: 'A', value: i }], DAY1);
  const arr = useSparklineStore.getState().series.get('A')!;
  expect(arr.length).toBe(MAX_POINTS);
  expect(arr[arr.length - 1]).toBe(MAX_POINTS + 4); // 마지막 값 보존
  expect(arr[0]).toBe(5);                            // 0..4 evict
});

it('KST 날짜 롤오버: 다음 거래일이면 시계열 초기화', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 9 }], DAY2);
  expect(useSparklineStore.getState().series.get('A')).toEqual([9]);
});

it('prune: 이번 배치에 없는 코드는 사라진다(watchlist 축소)', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }, { code: 'B', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: 2 }], DAY1);
  const s = useSparklineStore.getState().series;
  expect(s.has('A')).toBe(true);
  expect(s.has('B')).toBe(false);
});

it('carry-forward: 값 null이면 점은 안 늘리고 기존 시계열 보존', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: 1 }], DAY1);
  appendBatch([{ code: 'A', value: null }], DAY1);  // 일시적 결측(여전히 watchlist)
  expect(useSparklineStore.getState().series.get('A')).toEqual([1]); // [1,1] 아님
});

it('carry-forward: 첫 폴부터 null이면 빈 배열로 Map을 오염시키지 않는다', () => {
  const { appendBatch } = useSparklineStore.getState();
  appendBatch([{ code: 'A', value: null }], DAY1);
  expect(useSparklineStore.getState().series.has('A')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/sparklineStore.test.ts`
Expected: FAIL — `Cannot find module './sparklineStore'`.

- [ ] **Step 3: Write the store**

`frontend/src/state/sparklineStore.ts`:
```ts
import { create } from 'zustand';
import { unixMsToKSTDate } from '../util/time';

/** since-open 시계열 누적 store. 풀 리로드(인메모리)·KST 날짜롤오버에 리셋된다 —
 *  "보드를 연 이후"에 가까운 롤링 동작(spec 2026-06-11 §4). cap=롤링 최근 MAX_POINTS점
 *  (=10초폴×40≈6.7분): 개장 후 cap분까지는 글자그대로 since-open, 이후 트레일링 창.
 *  점수는 QA 튜닝 대상(spec §Risks). 진짜 풀 since-open은 서버 옵션 b(Out-of-Scope). */
export const MAX_POINTS = 40;

export interface SparkPoint { code: string; value: number | null; }

interface Store {
  series: Map<string, number[]>;
  /** 마지막 append의 KST yyyymmdd. 롤오버 판정용. */
  lastDate: string | null;
  /** 한 폴의 전 종목 값을 일괄 append. nowMs로 KST 날짜 판정(롤오버 시 clear).
   *  새 Map을 이번 배치 코드들로만 구성 → watchlist에서 빠진 코드는 자연 prune. */
  appendBatch: (points: SparkPoint[], nowMs: number) => void;
  reset: () => void;
}

export const useSparklineStore = create<Store>((set, get) => ({
  series: new Map(),
  lastDate: null,
  appendBatch: (points, nowMs) => {
    const date = unixMsToKSTDate(nowMs);
    const prev = get();
    const rollover = prev.lastDate !== null && prev.lastDate !== date;
    const base = rollover ? new Map<string, number[]>() : prev.series;
    const next = new Map<string, number[]>();
    for (const { code, value } of points) {
      const arr = base.get(code) ?? [];
      if (value === null) {
        // carry-forward: 이번 폴에 값 결측이어도 기존 시계열을 보존(점은 안 늘림).
        // 빈 배열은 set하지 않아 Map 오염을 막는다(rollover/첫 폴 결측). watchlist에
        // 남아 있으면 보존되고, 배치에서 빠진 코드만 prune된다(아래 next 미포함).
        if (arr.length > 0) next.set(code, arr);
        continue;
      }
      const grown = arr.length >= MAX_POINTS
        ? [...arr.slice(arr.length - MAX_POINTS + 1), value]
        : [...arr, value];
      next.set(code, grown);
    }
    set({ series: next, lastDate: date });
  },
  reset: () => set({ series: new Map(), lastDate: null }),
}));
```

`frontend/src/heatmap/useSparklineSeries.ts`:
```ts
import { useSparklineStore } from '../state/sparklineStore';

/** 코드→since-open 시계열 Map(읽기 전용 뷰). 폴마다 새 Map 참조라 소비자가
 *  재렌더되지만 폴 주기=10초라 비용 무해(spec §Risks). */
export function useSparklineSeries(): Map<string, number[]> {
  return useSparklineStore((s) => s.series);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/sparklineStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/sparklineStore.ts frontend/src/heatmap/useSparklineSeries.ts frontend/src/state/sparklineStore.test.ts
git commit -m "feat(heatmap): sparkline since-open 누적 store + 셀렉터 훅"
```

---

## Task 2: Sparkline — 1px SVG path, 기울기 부호로 색

**Files:**
- Create: `frontend/src/heatmap/Sparkline.tsx`
- Test: `frontend/src/heatmap/Sparkline.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/src/heatmap/Sparkline.test.tsx`:
```tsx
import { render } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Sparkline } from './Sparkline';

it('상승 추세(연 이후 last>first) → stroke = --price-up(적)', () => {
  const { container } = render(<Sparkline series={[1, 1.5, 3]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
});

it('하락 추세 → stroke = --price-down(청)', () => {
  const { container } = render(<Sparkline series={[3, 2, 1]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
});

it('평탄(|Δ|<EPS) → stroke = --fg-dim(중립)', () => {
  const { container } = render(<Sparkline series={[5, 5, 5]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--fg-dim)');
});

it('점 <2 → 렌더 없음(그리드 칸은 부모가 비움)', () => {
  const { container } = render(<Sparkline series={[1]} />);
  expect(container.querySelector('svg')).toBeNull();
});

it('series undefined → 렌더 없음', () => {
  const { container } = render(<Sparkline series={undefined} />);
  expect(container.querySelector('svg')).toBeNull();
});

it('path 점 개수 = series 길이(L 커맨드 n-1개 + M 1개)', () => {
  const { container } = render(<Sparkline series={[1, 2, 3, 4]} />);
  const d = container.querySelector('path')!.getAttribute('d')!;
  expect((d.match(/[ML]/g) ?? []).length).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/heatmap/Sparkline.test.tsx`
Expected: FAIL — `Cannot find module './Sparkline'`.

- [ ] **Step 3: Write the component**

`frontend/src/heatmap/Sparkline.tsx`:
```tsx
import { memo } from 'react';

export interface SparklineProps {
  /** since-open 시계열(상대 등락률 또는 가격; 모양 동일). undefined/<2점이면 미렌더. */
  series: number[] | undefined;
  width?: number;
  height?: number;
}

/** 평탄 임계(단위 %p — series가 change_pct이므로 slope = Δ일간등락 %p).
 *  |Δ| < EPS_PP 면 중립색. 0.05%p ≈ 롤링 창의 '추세 없음' 바닥선(1틱 ≈0.1~0.3%p
 *  미만의 미동을 방향신호로 오독 방지). closed 시 series 평탄 → slope 0 < EPS_PP → 중립 정지(의도). */
const EPS_PP = 0.05;

/** since-open 시계열 → 1px SVG 스파크라인. 색 = 기울기(last−first) 부호:
 *  상승 --price-up(적) · 하락 --price-down(청) · 평탄 --fg-dim.
 *  DESIGN.md: heat.ts가 가격방향을 배경으로 확장하듯, 이 컴포넌트는 1px stroke로 확장한다.
 *  색은 일간 등락칩과 다를 수 있다(다른 시간창 = 모멘텀 정보; spec invariant impact). */
export const Sparkline = memo(function Sparkline({ series, width = 56, height = 16 }: SparklineProps) {
  if (!series || series.length < 2) return null;
  const slope = series[series.length - 1] - series[0];
  const stroke = Math.abs(slope) < EPS_PP
    ? 'var(--fg-dim)'
    : slope > 0 ? 'var(--price-up)' : 'var(--price-down)';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;       // 평탄이면 1로 나눠 중앙선
  const pad = 1.5;
  const h = height - pad * 2;
  const n = series.length;
  const d = series
    .map((v, i) => {
      const x = (i / (n - 1)) * width;
      const y = pad + (1 - (v - min) / span) * h; // SVG y 반전: 큰 값=위(작은 y)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const lastY = pad + (1 - (series[n - 1] - min) / span) * h;
  return (
    <svg className="srow-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeOpacity={0.9} strokeWidth={1}
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={Number(lastY.toFixed(1))} r={1.2} fill={stroke} />
    </svg>
  );
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/heatmap/Sparkline.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/heatmap/Sparkline.tsx frontend/src/heatmap/Sparkline.test.tsx
git commit -m "feat(heatmap): Sparkline — 기울기 부호로 색칠하는 1px SVG"
```

---

## Task 3: HeatmapRow — 스파크라인 셀 추가(그리드 3→4칼럼)

**Files:**
- Modify: `frontend/src/heatmap/HeatmapRow.tsx`
- Test: `frontend/src/heatmap/HeatmapRow.test.tsx`

- [ ] **Step 1: Write the failing test (append to existing file)**

`frontend/src/heatmap/HeatmapRow.test.tsx` 끝에 추가:
```tsx
it('series 있으면 스파크라인 셀 렌더(상승=적)', () => {
  row({ series: [1, 2, 3] });
  const path = document.querySelector('.srow-spark path');
  expect(path?.getAttribute('stroke')).toBe('var(--price-up)');
});

it('series 없으면 스파크라인 svg 없음(칸은 유지)', () => {
  row();
  expect(document.querySelector('.srow-spark')).toBeNull();
  // 결측 '—' 개수는 그대로 2(가격·등락) — 빈 스파크 셀이 '—'를 만들지 않는다
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: FAIL — `series` prop이 없어 타입/렌더 실패(`.srow-spark` 미존재).

- [ ] **Step 3: Modify HeatmapRow**

`frontend/src/heatmap/HeatmapRow.tsx`:

(a) 상단 import 추가:
```tsx
import { Sparkline } from './Sparkline';
```

(b) `HeatmapRowProps`에 `series` 추가 (기존 `pct` 아래):
```tsx
  pct: number | null;
  /** since-open 시계열(없으면 빈 스파크 셀). 부모가 seriesByCode.get(code)로 주입. */
  series?: number[];
```

(c) 구조분해에 `series` 추가:
```tsx
export function HeatmapRow({
  name, price, pct, series, onClick, ariaLabel, testId,
  sortableRef, sortableStyle, dragListeners, dragging,
}: HeatmapRowProps) {
```

(d) 그리드 클래스 `grid-cols-[minmax(4rem,1fr)_3.2rem_4.25rem]` → 4칼럼:
```tsx
      className={`grid grid-cols-[minmax(4rem,1fr)_3.5rem_3.2rem_4.25rem] gap-1.5 px-2 py-0.5 items-center text-sm border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] ${draggable ? 'cursor-grab select-none touch-none active:cursor-grabbing' : 'cursor-pointer'}`}
```

(e) 종목명 `<span>` 바로 뒤에 스파크 셀 삽입(가격 span 앞):
```tsx
      <span className="truncate text-xs text-fg-dim">{name}</span>
      {/* 스파크라인 셀 — Sparkline이 null이어도 이 span이 칼럼을 점유해 정렬 유지. */}
      <span className="flex items-center justify-center overflow-hidden"><Sparkline series={series} /></span>
      <span className="text-right font-mono tabular-nums text-fg">
```

(f) `SortableHeatmapRow`가 `series`를 통과시키도록 props·전달 추가:
```tsx
function SortableHeatmapRow(props: {
  code: string; name: string; price: number | null; pct: number | null;
  series?: number[]; onPick: () => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.code });
  return (
    <HeatmapRow
      name={props.name}
      price={props.price}
      pct={props.pct}
      series={props.series}
      onClick={props.onPick}
```
(나머지 SortableHeatmapRow 본문 불변.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: PASS — 신규 2 + 기존 6 전부 통과(기존 테스트는 series 미전달이라 영향 없음).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/heatmap/HeatmapRow.tsx frontend/src/heatmap/HeatmapRow.test.tsx
git commit -m "feat(heatmap): HeatmapRow에 스파크라인 셀(그리드 4칼럼)"
```

---

## Task 4: HeatmapFolder + HeatmapBoard — seriesByCode 전달 + 스크롤 앵커

**Files:**
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx`
- Modify: `frontend/src/heatmap/HeatmapBoard.tsx`
- Test: `frontend/src/heatmap/HeatmapBoard.test.tsx`

- [ ] **Step 1: Write the failing test (append to existing file)**

`frontend/src/heatmap/HeatmapBoard.test.tsx` 끝에 추가:
```tsx
it('폴더 카드에 스크롤 앵커 id가 있다(스트립 점프 대상)', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="change" onPick={() => {}} />);
  expect(document.getElementById('heatmap-folder-f1')).toBeTruthy();
});

it('seriesByCode를 전달하면 해당 종목 행에 스파크라인이 그려진다', () => {
  render(<HeatmapBoard groups={groups} quoteByCode={new Map<string, LiveQuote>()}
    sortMode="change" onPick={() => {}} seriesByCode={new Map([['005930', [1, 2, 3]]])} />);
  expect(document.querySelector('.srow-spark path')?.getAttribute('stroke')).toBe('var(--price-up)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/heatmap/HeatmapBoard.test.tsx`
Expected: FAIL — `seriesByCode` prop 미존재 + 앵커 id 미존재.

- [ ] **Step 3a: Modify HeatmapFolder**

`frontend/src/heatmap/HeatmapFolder.tsx`:

(a) `HeatmapFolderProps`에 추가 (기존 `onReorder?` 위/아래):
```tsx
  /** 코드→since-open 시계열. 행에 그대로 흘려보낸다(없으면 빈 스파크 셀). */
  seriesByCode?: Map<string, number[]>;
```

(b) 구조분해에 `seriesByCode` 추가:
```tsx
export function HeatmapFolder({ folder, entries, quoteByCode, seriesByCode, sortMode, onPick, onReorder }: HeatmapFolderProps) {
```

(c) `rows` 매핑에서 두 분기 모두 `series` 전달:
```tsx
    return draggable ? (
      <SortableHeatmapRow key={e.code} code={e.code} name={e.name}
        price={q?.price ?? null} pct={q?.change_pct ?? null} series={seriesByCode?.get(e.code)}
        onPick={() => onPick(e.code)} />
    ) : (
      <HeatmapRow key={e.code} name={e.name} price={q?.price ?? null} pct={q?.change_pct ?? null}
        series={seriesByCode?.get(e.code)}
        onClick={() => onPick(e.code)} ariaLabel={`${e.name} ${e.code} 차트 열기`}
        testId={`heatmap-row-${e.code}`} />
    );
```

(d) 카드 루트 `<div>`에 스크롤 앵커 id 추가:
```tsx
    <div id={`heatmap-folder-${folder.id}`} className="break-inside-avoid bg-bg-card border border-border rounded mb-2 overflow-hidden">
```

- [ ] **Step 3b: Modify HeatmapBoard**

`frontend/src/heatmap/HeatmapBoard.tsx`:

(a) `HeatmapBoardProps`에 추가:
```tsx
  /** 코드→since-open 시계열. 페이지가 useSparklineSeries로 주입. */
  seriesByCode?: Map<string, number[]>;
```

(b) 구조분해 + 폴더에 전달:
```tsx
export function HeatmapBoard({ groups, quoteByCode, seriesByCode, sortMode, onPick, onReorder }: HeatmapBoardProps) {
```
```tsx
          <HeatmapFolder
            key={g.folder!.id}
            folder={g.folder!}
            entries={g.entries}
            quoteByCode={quoteByCode}
            seriesByCode={seriesByCode}
            sortMode={sortMode}
            onPick={onPick}
            onReorder={onReorder}
          />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/heatmap/HeatmapBoard.test.tsx`
Expected: PASS — 신규 2 + 기존 1.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapBoard.tsx frontend/src/heatmap/HeatmapBoard.test.tsx
git commit -m "feat(heatmap): seriesByCode 전달 + 폴더 카드 스크롤 앵커"
```

---

## Task 5: SectorTempStrip — 섹터 온도 스트립(뜨거운 순, 클릭 점프)

**Files:**
- Create: `frontend/src/heatmap/SectorTempStrip.tsx`
- Test: `frontend/src/heatmap/SectorTempStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/src/heatmap/SectorTempStrip.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { SectorTempStrip } from './SectorTempStrip';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';

const entry = (code: string, folderId: string | null, order = 0) => ({
  code, name: code, registered_at_kst_date: '20260101',
  last_success_date: null, folder_id: folderId, order,
});

const groups: FolderGroup[] = [
  { folder: { id: 'f1', name: '반도체', order: 0 }, entries: [entry('005930', 'f1')] }, // +1
  { folder: { id: 'f2', name: '로봇', order: 1 }, entries: [entry('111', 'f2')] },       // +4
  { folder: { id: 'f3', name: '통신', order: 2 }, entries: [entry('222', 'f3')] },       // -2
  { folder: { id: 'f4', name: '빈폴더', order: 3 }, entries: [] },                        // 제외(빈)
  { folder: { id: 'f5', name: '결측', order: 4 }, entries: [entry('333', 'f5')] },       // 제외(avg null)
];
const quoteByCode = new Map<string, LiveQuote>([
  ['005930', { code: '005930', price: 1, change_pct: 1, change_won: 0 }],
  ['111', { code: '111', price: 1, change_pct: 4, change_won: 0 }],
  ['222', { code: '222', price: 1, change_pct: -2, change_won: 0 }],
  // 333 없음 → 결측 섹터 avg null
]);

it('가시 섹터를 뜨거운 순(avg 내림차순)으로, 빈/결측 섹터는 제외', () => {
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={() => {}} />);
  const chips = screen.getAllByRole('button').map((c) => c.textContent ?? '');
  expect(chips.length).toBe(3);
  expect(chips[0]).toMatch(/로봇/);   // +4
  expect(chips[1]).toMatch(/반도체/); // +1
  expect(chips[2]).toMatch(/통신/);   // -2
});

it('칩 클릭 → onJump(folderId)', () => {
  const onJump = vi.fn();
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={onJump} />);
  fireEvent.click(screen.getAllByRole('button')[0]); // 로봇 = f2
  expect(onJump).toHaveBeenCalledWith('f2');
});

it('상승 칩 배경 = 적(--price-up rgb), 하락 칩 = 청', () => {
  render(<SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={() => {}} />);
  const up = screen.getAllByRole('button')[0];   // 로봇 +4
  const down = screen.getAllByRole('button')[2]; // 통신 -2
  expect(up.getAttribute('style') ?? '').toMatch(/220,\s*38,\s*38/);
  expect(down.getAttribute('style') ?? '').toMatch(/37,\s*99,\s*235/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/heatmap/SectorTempStrip.test.tsx`
Expected: FAIL — `Cannot find module './SectorTempStrip'`.

- [ ] **Step 3: Write the component**

`frontend/src/heatmap/SectorTempStrip.tsx`:
```tsx
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import { avgPct, heatBg } from './heat';
import { visibleFolderGroups } from './visibleGroups';

/** 스트립 칩 배경 농도(작은 칩이라 행 칩보다 옅게, 헤더 밴드보단 진하게). */
const STRIP_ALPHA = 0.55;

export interface SectorTempStripProps {
  groups: FolderGroup[];
  quoteByCode: Map<string, LiveQuote>;
  /** 칩 클릭 시 호출(해당 섹터 카드로 스크롤). */
  onJump: (folderId: string) => void;
}

/** 가시 섹터의 평균 등락칩을 한 줄(wrap)로 — 시장 온도 한눈 스캔.
 *  정렬은 **뜨거운 순(avg 내림차순) · 표시 전용**이며 카드 본문 sortMode/order를
 *  바꾸지 않는다(spec invariant: 정렬 계약 보존). 빈 폴더·avg 결측 섹터는 제외. */
export function SectorTempStrip({ groups, quoteByCode, onJump }: SectorTempStripProps) {
  const pctOf = (code: string) => quoteByCode.get(code)?.change_pct ?? null;
  const chips = visibleFolderGroups(groups)
    .map((g) => ({ folder: g.folder!, avg: avgPct(g.entries, pctOf) }))
    .filter((c): c is { folder: NonNullable<FolderGroup['folder']>; avg: number } => c.avg !== null)
    .sort((a, b) => b.avg - a.avg);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1.5 bg-bg-subtle border-b border-border-strong flex-none"
      aria-label="섹터 온도">
      {/* 칩 = 점프 버튼. role="list/listitem"을 button에 얹지 않는다(role 충돌) —
          접근성은 각 버튼의 aria-label(섹터명+평균)로 충분하고, 테스트는 role 'button'으로 쿼리. */}
      {chips.map(({ folder, avg }) => (
        <button
          key={folder.id}
          type="button"
          onClick={() => onJump(folder.id)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-dim hover:text-fg outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
          style={{ background: heatBg(avg, STRIP_ALPHA) }}
          aria-label={`${folder.name} 평균 ${avg > 0 ? '+' : ''}${avg.toFixed(1)}% — 카드로 이동`}
        >
          <span className="truncate max-w-[7rem]">{folder.name}</span>
          <span className="font-mono tabular-nums">{avg > 0 ? '+' : ''}{avg.toFixed(1)}%</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/heatmap/SectorTempStrip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/heatmap/SectorTempStrip.tsx frontend/src/heatmap/SectorTempStrip.test.tsx
git commit -m "feat(heatmap): SectorTempStrip — 섹터 온도 스트립(뜨거운 순·클릭 점프)"
```

---

## Task 6: pages/Heatmap — 누적 effect + 스트립 + 캡션 + 스크롤 핸들러

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.test.tsx`

- [ ] **Step 1: Update the existing page test + add strip tests**

`frontend/src/pages/Heatmap.test.tsx`:

(a) 첫 번째 테스트의 `findByText('반도체')`는 스트립 칩 + 폴더 헤더로 **중복**되므로 `findAllByText`로 바꾸고 스트립 존재를 명시한다. 기존:
```tsx
it('폴더·종목·phase 배지·색 범례 렌더', async () => {
  renderPage();
  expect(await screen.findByText('반도체')).toBeInTheDocument();
```
→ 변경:
```tsx
it('폴더·종목·phase 배지·색 범례 렌더', async () => {
  renderPage();
  // 스트립 칩 + 폴더 헤더 둘 다 '반도체' → 2개 이상
  expect((await screen.findAllByText('반도체')).length).toBeGreaterThanOrEqual(2);
```
(같은 테스트의 나머지 줄 — 삼성전자·/장중/·색 범례 — 불변.)

(a2) **세 번째 테스트(`기본 manual=order 순…`)도 76행 `await screen.findByText('반도체');`가 스트립 칩+헤더로 중복 폭발** → `await screen.findAllByText('반도체');`로 변경(이 줄은 단지 렌더 완료 대기용이라 개수 단정 불필요). 같은 테스트의 `getAllByText(/삼성전자|SK하이닉스/)`는 스트립이 섹터명만 칩으로 쓰므로 영향 없음(불변).

(b) `beforeEach`에 jsdom 미구현 `scrollIntoView` 스텁 추가(스트립 점프가 호출):
```tsx
beforeEach(() => {
  setActiveCode.mockClear();
  useHeatmapPrefsStore.setState({ sortMode: 'manual' });
  useSparklineStore.getState().reset();              // 누적 store 격리(테스트 간 누수 차단)
  Element.prototype.scrollIntoView = vi.fn();         // jsdom 미구현 — 스트립 점프 호출 대비
  // 매 테스트 open 기본값으로 리셋 — per-test mockReturnValue 가 다음 테스트로 누수되지 않게.
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open', dataUpdatedAt: 0,
  } as ReturnType<typeof useLiveQuoteOverlay>);
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
});
```
(import 추가: `import { useSparklineStore } from '../state/sparklineStore';`, `import { useLiveQuoteOverlay } from '../api/liveQuotes';`, 그리고 RTL에서 `waitFor` 추가 — `import { render, screen, fireEvent, waitFor } from '@testing-library/react';`. 기존 `vi.mock('../api/liveQuotes', …)`의 `useLiveQuoteOverlay: vi.fn(...)`는 그대로 두면 `vi.mocked(...).mockReturnValue`가 동작.)

(c) 파일 끝에 스트립 테스트 2개 추가:
```tsx
it('섹터 온도 스트립 칩 렌더(반도체 평균 +1.5%)', async () => {
  renderPage();
  // 005930 -2%, 000660 +5% → 평균 +1.5%
  expect(await screen.findByRole('button', { name: /반도체 평균 \+1\.5% — 카드로 이동/ })).toBeInTheDocument();
});

it('스트립 칩 클릭 → 해당 카드로 scrollIntoView', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /반도체 평균/ }));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
    expect.objectContaining({ behavior: 'smooth' }),
  );
});

it('open 폴(dataUpdatedAt≠0)이 since-open store에 누적된다', async () => {
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open', dataUpdatedAt: 1_700_000_000_000,
  } as ReturnType<typeof useLiveQuoteOverlay>);
  renderPage();
  await screen.findAllByText('반도체');
  await waitFor(() => expect(useSparklineStore.getState().series.get('005930')).toEqual([-2]));
  expect(useSparklineStore.getState().series.get('000660')).toEqual([5]);
});

it('closed phase면 누적 안 함 — spec §4 "신규 점 없음"(평탄점 오염 차단)', async () => {
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }]]),
    phase: 'closed', dataUpdatedAt: 1_700_000_000_000,  // dataUpdatedAt≠0이라 phase절만 격리 검증
  } as ReturnType<typeof useLiveQuoteOverlay>);
  renderPage();
  await screen.findAllByText('반도체');
  expect(useSparklineStore.getState().series.size).toBe(0);
});

it('정직 캡션 — since-open 단정 없이 "장중 추세"', async () => {
  renderPage();
  expect(await screen.findByText('스파크라인 = 장중 추세')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/Heatmap.test.tsx`
Expected: FAIL — 스트립 미구현(`반도체 평균 …` 버튼 없음).

- [ ] **Step 3: Modify Heatmap.tsx**

`frontend/src/pages/Heatmap.tsx`:

(a) import 변경 — `useEffect` 추가 + 신규 모듈:
```tsx
import { useEffect, useMemo, useState } from 'react';
```
```tsx
import { HeatmapBoard } from '../heatmap/HeatmapBoard';
import { SectorTempStrip } from '../heatmap/SectorTempStrip';
import { useSparklineStore } from '../state/sparklineStore';
import { useSparklineSeries } from '../heatmap/useSparklineSeries';
```

(b) 컴포넌트 본문, `onReorder` 정의 부근에 누적/스크롤 배선 추가:
```tsx
  const appendBatch = useSparklineStore((s) => s.appendBatch);
  const seriesByCode = useSparklineSeries();

  // 매 폴(dataUpdatedAt 변경)마다 전 종목 등락률을 누적 — phase==='open'에만(eng-review).
  // closed는 _last_quotes를 600s 하트비트로 동일 non-null change_pct 재서빙(liveQuotes 주석)
  // → null 필터로 못 막아 평탄점이 쌓인다. phase 게이트가 spec §4 "closed: 신규 점 없음"을 보장.
  // 결측(null)은 store가 carry-forward(기존 시계열 보존). filter 없이 전 codes를 넘겨,
  // watchlist에 있으면 보존·빠지면 store가 prune(전치 #3 결정). deps=dataUpdatedAt만(phase는
  // 동일 useQuotes 결과라 항상 동시 변경 → stale closure 불가).
  useEffect(() => {
    if (phase !== 'open' || !dataUpdatedAt) return;
    const points = codes.map((code) => ({ code, value: quoteByCode.get(code)?.change_pct ?? null }));
    if (points.length) appendBatch(points, dataUpdatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  const scrollToFolder = (folderId: string) => {
    document.getElementById(`heatmap-folder-${folderId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
```

(c) 렌더 — `<LiveStateBanner .../>` 다음, 정직 캡션 + 스트립 추가하고 `HeatmapBoard`에 `seriesByCode` 전달:
```tsx
      <LiveStateBanner primary={banner.primary} stack={banner.stack} />
      <div className="px-3 py-1 text-xs text-fg-dim flex-none">스파크라인 = 장중 추세</div>
      <SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={scrollToFolder} />
      {showNewGroup && (
```
```tsx
      <HeatmapBoard groups={groups} quoteByCode={quoteByCode} seriesByCode={seriesByCode}
        sortMode={sortMode} onPick={onPick} onReorder={onReorder} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/pages/Heatmap.test.tsx`
Expected: PASS — 기존(업데이트 포함) + 신규 2.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx
git commit -m "feat(heatmap): 페이지 배선 — 스파크라인 누적·섹터 온도 스트립·캡션"
```

---

## Task 7: DESIGN.md 규칙 1줄 + 전체 검증

**Files:**
- Modify: `DESIGN.md`

- [ ] **Step 1: DESIGN.md에 방향성 스파크라인 규칙 추가**

`DESIGN.md`의 "Price-direction heat ramp (히트맵 보드 전용)" 항목 **바로 아래**에 추가:
```markdown
- **Price-direction sparkline (관심맵 행 전용):** `frontend/src/heatmap/Sparkline.tsx` 가
  `heat.ts` 의 히트 램프를 *1px stroke* 로 확장한다(배경 확장의 선 버전). stroke 색 =
  since-open 시계열 기울기 부호 — 상승 `--price-up`(적)·하락 `--price-down`(청)·평탄
  `--fg-dim`. 이 색은 *연 이후* 추세라 *일간* 등락칩 색과 다를 수 있다(서로 다른 시간창 =
  의도된 모멘텀 신호). 가격 방향 카테고리 준수(새 색 없음).
```

- [ ] **Step 2: Commit doc**

```bash
git add DESIGN.md
git commit -m "docs(design): 방향성 스파크라인 선 규칙(가격방향 카테고리 확장)"
```

- [ ] **Step 3: 전체 히트맵 테스트 통과 확인**

Run: `npx vitest run src/heatmap src/state/sparklineStore.test.ts src/pages/Heatmap.test.tsx`
Expected: PASS — 전 파일 그린.

- [ ] **Step 4: 타입체크 + 린트 + 빌드**

Run: `npx tsc -b && npm run lint && npm run build`
Expected: 타입 에러 0, lint 0, 빌드 성공.

- [ ] **Step 5: 수동 검증 (`/heatmap`, 개발 서버)**

`frontend/`에서 `npm run dev`(또는 기존 dev 태스크). 브라우저 `http://localhost:5173/heatmap`:
- 상단 **섹터 온도 스트립**: 가시 섹터가 뜨거운 순 칩으로, 색이 평균 등락 방향/농도.
- 칩 클릭 → 해당 섹터 카드로 부드럽게 스크롤.
- 행에 **스파크라인**: 갓 로드 시엔 선 없음(캡션과 일치) → 장중 수 분 두면 채워짐. 빨간 칩 + 파란 선(괴리) 케이스가 정상 — 일간 상승·연 이후 약화.
- 행 클릭 → `/live` 점프(기존 동작).
- 정렬 토글(등락률↓/수동)은 카드 본문만 바꾸고 스트립 순서엔 영향 없음.
- (closed 시) 선이 마지막 시세에서 정지.

- [ ] **Step 6: Commit (검증 메모, 변경 있으면)**

검증 중 수정이 없으면 생략. 있으면 해당 파일별 커밋.

---

## Self-Review (작성자 체크 — 완료)

**Spec coverage:** §1 레이아웃→Task6(스트립/캡션 배선), §2 컴포넌트→Task1–6, §4 누적 store→Task1, §5 스트립 정렬/점프→Task5+6, §6 색 규칙 A→Task2+7, §7 행 그리드→Task3, Testing→각 Task Step1·Task7 Step3, Out-of-scope→플랜 미포함(밀도토글/인덱스레일/옵션b/접기). 갭 없음.

**Placeholder scan:** TBD/TODO/"적절히 처리" 없음 — 모든 코드·테스트·명령 완전 기술.

**Type consistency:** `appendBatch(points: SparkPoint[], nowMs)` (Task1, `SparkPoint.value: number|null`) ↔ 호출 `appendBatch(points, dataUpdatedAt)` (Task6) 일치. `series?: number[]`/`seriesByCode?: Map<string,number[]>` 명칭 Task3·4·6 일관. `useSparklineSeries(): Map<string,number[]>` (Task1) ↔ 사용 (Task6) 일치. `SectorTempStripProps{groups,quoteByCode,onJump}` (Task5) ↔ 호출 (Task6) 일치. `Sparkline` className `srow-spark` (Task2) ↔ 쿼리 (Task3·4) 일치. `EPS_PP`(Task2) 단일 정의.

---

## 🔒 Eng-Review Lock-in (2026-06-11) — 9개 그릴링 결정 반영 완료

`/grill-with-docs` + `/plan-eng-review`(코드기반 리뷰 + 반론검증 2단계, 18 에이전트)로 9개 결정을 확정해 위 태스크에 **이미 인라인 반영**했다. 추적용 요약:

| # | 결정 | 반영 위치 |
|---|---|---|
| 1 window | 롤링 cap **MAX_POINTS=40 유지**(48 기각), 캡션 "장중 추세"(거짓 "개장 이후" 제거) | Task1 주석·Task6 캡션·캡션 테스트 |
| 2 phase-gating | 누적 effect `if (phase!=='open' \|\| !dataUpdatedAt) return;` (closed 600s 재서빙·spec §4) | Task6 Step3(b) + closed 회귀 테스트 |
| 3 prune-null | **버그 수정** — `SparkPoint.value: number\|null`, null→carry-forward(빈 배열 set 금지), 폴 누락 코드만 prune | Task1 appendBatch + store 테스트 2건 |
| 4 value-source | **change_pct** 확정(price 금지), prune 동반수정 필수(#3) | Task1·Task6 |
| 5 empty-first | 점<2 → 미렌더 유지, dot 시드 거부 | Task2 (불변) |
| 6 flat-eps | `EPS 0.02 → EPS_PP 0.05` (%p 단위 명시) | Task2 |
| 7 perf | prop-drill 유지(per-code 구독 불필요·YAGNI), 근거 "unnecessary(≠ineffective)"로 정정 | spec §Risks |
| 8 strip | role="list/listitem" 충돌 제거(버튼 aria-label로 a11y), **test3 L76 `findByText('반도체')` 중복도 수정** | Task5 컴포넌트·Task6 Step1(a2)·스트립 테스트 쿼리 |
| 9 test-coverage | store단위 + 페이지 통합(누적 와이어·closed 게이트) 추가, 와이어는 폴 간 값 변화/빈배열 set 금지 | Task1·Task6 Step1 |

**충돌 정합화**: #3(conf5, 전용 결정)의 `appendBatch(points, nowMs)` **2-인자 + value:number|null** 형이, #9가 인용한 3-인자(liveCodes) 형을 **대체**한다(null carry-forward가 liveCodes 역할을 흡수). 모든 태스크는 2-인자 형으로 통일.

**실패 1건(무해)**: `final:flat-eps` 에이전트가 API Stream idle timeout으로 실패 → 동일 항목의 1차 REVIEW(conf4) 결과를 채택(EPS_PP=0.05). 별개로, 한 리뷰 에이전트가 워크트리 `frontend/`에 node_modules가 없어 임시 `__roleprobe.test.tsx`로 vitest 실행을 시도하다 실패(자가 정리 완료, 잔존 없음) — **실제 구현 전 `cd frontend && npm install` 필요**(Task 실행 전제).
