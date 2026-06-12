# 총잔량 급증(Quote Totals Surge) 마커 + 라이브 설정 좌측 패널 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live 총잔량 패널에 "직전 고가 +50% 초과(급증)" 마커를 매도/매수 독립으로 그려, 종목을 넘겨가며 신호를 평가할 수 있게 한다. 이어 라이브 설정 모달을 좌측 접이식 패널로 옮기고 급증 토글·감도를 노출한다.

**Architecture:** 순수 감지 함수 `detectSurges`(세션별 running max + 마진 초과, 마감 동시호가 제외)를 프론트가 이미 가진 `quote_ratio.points`로 돌려 마커를 만든다. 마커는 `RangeSeriesPane`에 추가하는 선택적 `markers` 프로젝터를 통해 lightweight-charts v5 `createSeriesMarkers`로 ask/bid 라인에 붙는다. 백엔드·신규 데이터 경로 없음. 설정은 기존 레지스트리(`CHART_TOGGLES`/`CHART_NUMERIC_PREFS`)에 항목을 추가하고, 모달 대신 좌측 패널이 카테고리별로 렌더한다.

**Tech Stack:** React + TypeScript, lightweight-charts ^5.2, zustand(chartPrefs), vitest.

> 스펙: `docs/superpowers/specs/2026-06-12-chongjanryang-breakout-live-marker-design.md`
> 사전: 워크트리 `frontend/`에서 최초 1회 `npm install` (node_modules 비어있음). 타입체크 권위 = `npx tsc -p tsconfig.app.json`(인자 없는 root tsconfig는 아무것도 안 봄). 테스트 = `npx vitest run <path>`.

---

## Phase A — 급증 마커 (기본 50%로 즉시 평가 가능)

### Task 1: `detectSurges` 순수 감지 모듈

**Files:**
- Create: `frontend/src/chart/surge/detectSurges.ts`
- Test: `frontend/src/chart/surge/detectSurges.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// frontend/src/chart/surge/detectSurges.test.ts
import { describe, it, expect } from 'vitest';
import { detectSurges } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

const P = (t: number, ask: number, bid: number): QuoteRatioPoint => ({ t, ask_total: ask, bid_total: bid });
const OPTS = { margin: 0.5, sessionOpens: [0], isClosingAuction: () => false };

describe('detectSurges', () => {
  it('직전 고가를 +50% 초과하면 발사(ask)', () => {
    const pts = [P(1, 100, 0), P(2, 120, 0), P(3, 160, 0)]; // 160 = 100×1.6 > 1.5
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toEqual([{ t: 3, prevPeak: 120, value: 160, pctOver: expect.closeTo(0.333, 2) }]);
    expect(r.bid).toEqual([]);
  });

  it('마진 미달이면 무발사', () => {
    const pts = [P(1, 100, 0), P(2, 140, 0)]; // +40% < 50%
    expect(detectSurges(pts, OPTS).ask).toEqual([]);
  });

  it('래칫 디바운스 — 발사 후 더 높은 고가를 또 초과해야', () => {
    const pts = [P(1, 100, 0), P(2, 170, 0), P(3, 200, 0)]; // 170 발사, 200<170×1.5=255 → 무발사
    expect(detectSurges(pts, OPTS).ask).toHaveLength(1);
  });

  it('연속 에스컬레이션 — 각자 직전 고가 +50% 초과 시 2회', () => {
    const pts = [P(1, 100, 0), P(2, 160, 0), P(3, 250, 0)]; // 160 발사(래칫→160), 250>160×1.5=240 발사
    expect(detectSurges(pts, OPTS).ask).toHaveLength(2);
  });

  it('세션 첫 관측은 비교 대상 없어 무발사(워밍업 불필요)', () => {
    const pts = [P(1, 999, 0), P(2, 1000, 0)]; // 첫값 999가 곧 peak, 1000<999×1.5
    expect(detectSurges(pts, OPTS).ask).toEqual([]);
  });

  it('멀티데이 — 세션 경계마다 running peak 리셋', () => {
    // 세션0: open 0, 세션1: open 100
    const pts = [P(1, 300, 0), P(101, 200, 0)]; // 전일 peak 300, 당일 200 — 비교 안 함
    const r = detectSurges(pts, { margin: 0.5, sessionOpens: [0, 100], isClosingAuction: () => false });
    expect(r.ask).toEqual([]); // 당일 첫 관측이라 무발사, 전일 300과 비교 안 함
  });

  it('마감 동시호가 구간은 발사·peak갱신 모두 제외', () => {
    const isClosingAuction = (t: number) => t >= 50; // 50 이후가 동시호가라 가정
    const pts = [P(1, 100, 0), P(60, 1000, 0), P(70, 160, 0)]; // 60은 제외(peak 갱신 X), 70은 100 기준 +60% 발사
    const r = detectSurges(pts, { margin: 0.5, sessionOpens: [0], isClosingAuction });
    expect(r.ask).toEqual([{ t: 70, prevPeak: 100, value: 160, pctOver: expect.closeTo(0.6, 2) }]);
  });

  it('ask/bid 독립', () => {
    const pts = [P(1, 100, 100), P(2, 160, 100)]; // ask만 급증
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toHaveLength(1);
    expect(r.bid).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/chart/surge/detectSurges.test.ts`
Expected: FAIL — "Cannot find module './detectSurges'".

- [ ] **Step 3: 구현 작성**

```ts
// frontend/src/chart/surge/detectSurges.ts
import type { QuoteRatioPoint } from '../../api/types';

export type SurgeSide = 'ask' | 'bid';
export type SurgeMarker = { t: number; prevPeak: number; value: number; pctOver: number };

export type DetectSurgesOpts = {
  /** 발사 문턱: value > prevPeak × (1 + margin). 기본 0.5. 전 종목 공통 비율. */
  margin: number;
  /** 각 Stock-Date 세션 시작(Unix ms), 오름차순. running peak를 세션마다 리셋. */
  sessionOpens: readonly number[];
  /** 마감 동시호가(15:20–15:30) 구간 술어. true면 발사·peak갱신 모두 제외. */
  isClosingAuction: (t: number) => boolean;
};

const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };

function detectSide(points: readonly QuoteRatioPoint[], side: SurgeSide, o: DetectSurgesOpts): SurgeMarker[] {
  const out: SurgeMarker[] = [];
  let runningMax = 0;
  let segIdx = 0;
  for (const p of points) {
    // 세션 경계 진입 → running peak 리셋 (멀티데이 정확성)
    while (segIdx + 1 < o.sessionOpens.length && p.t >= o.sessionOpens[segIdx + 1]) {
      segIdx += 1;
      runningMax = 0;
    }
    if (o.isClosingAuction(p.t)) continue; // 마감 동시호가 누적 제외
    const v = p[FIELD[side]];
    if (runningMax > 0 && v > runningMax * (1 + o.margin)) {
      out.push({ t: p.t, prevPeak: runningMax, value: v, pctOver: v / runningMax - 1 });
    }
    if (v > runningMax) runningMax = v; // 래칫
  }
  return out;
}

export function detectSurges(
  points: readonly QuoteRatioPoint[],
  opts: DetectSurgesOpts,
): Record<SurgeSide, SurgeMarker[]> {
  return { ask: detectSide(points, 'ask', opts), bid: detectSide(points, 'bid', opts) };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/chart/surge/detectSurges.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/chart/surge/detectSurges.ts frontend/src/chart/surge/detectSurges.test.ts
git commit -m "feat(surge): pure detectSurges (per-session ratchet + margin, auction-excluded)"
```

---

### Task 2: chartPrefs에 급증 설정 추가

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts` (CHART_TOGGLES 배열, CHART_NUMERIC_PREFS 배열)
- Test: `frontend/src/state/chartPrefs.test.ts` (없으면 생성)

> 주의: `CHART_NUMERIC_PREFS`는 **정수** 필드다(스토어 주석). margin은 분수라 안 맞으므로 **퍼센트 정수** `surgeMarginPct`(기본 50, 30–100)로 저장하고, 사용처에서 `/100` 한다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// frontend/src/state/chartPrefs.test.ts (없으면 신규; 있으면 아래 describe 추가)
import { describe, it, expect } from 'vitest';
import { DEFAULT_PREFS, CHART_TOGGLES, CHART_NUMERIC_PREFS } from './chartPrefs';

describe('surge prefs', () => {
  it('surgeMarkerEnabled 토글 기본 ON', () => {
    expect(DEFAULT_PREFS.surgeMarkerEnabled).toBe(true);
    expect(CHART_TOGGLES.some((t) => t.key === 'surgeMarkerEnabled' && t.category === 'surge')).toBe(true);
  });
  it('surgeMarginPct numeric 기본 50, enabledBy surgeMarkerEnabled', () => {
    expect(DEFAULT_PREFS.surgeMarginPct).toBe(50);
    const p = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeMarginPct');
    expect(p?.enabledBy).toBe('surgeMarkerEnabled');
    expect(p?.min).toBe(30);
    expect(p?.max).toBe(100);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/state/chartPrefs.test.ts`
Expected: FAIL — surgeMarkerEnabled undefined.

- [ ] **Step 3: 구현 — 레지스트리에 항목 추가**

`CHART_TOGGLES` 배열의 마지막 항목 뒤에 추가:

```ts
  {
    key: 'surgeMarkerEnabled',
    label: '총잔량 급증 마커',
    description: '매도/매수총잔량이 당일 직전 고가를 크게(기본 +50%) 넘어서는 순간 표시',
    default: true,
    category: 'surge',
  },
```

`CHART_NUMERIC_PREFS` 배열의 마지막 항목 뒤에 추가 (기존 `ratioOutlierThreshold` 항목의 필드 구조를 그대로 따른다):

```ts
  {
    key: 'surgeMarginPct',
    label: '급증 감도 — 직전 고가 대비(%)',
    default: 50,
    min: 30,
    max: 100,
    enabledBy: 'surgeMarkerEnabled',
  },
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/state/chartPrefs.test.ts`
Expected: PASS.

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit && cd ..
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.test.ts
git commit -m "feat(surge): chartPrefs surgeMarkerEnabled + surgeMarginPct (category 'surge')"
```

---

### Task 3: `RangeSeriesPane`에 선택적 `markers` 프로젝터 추가

**Files:**
- Modify: `frontend/src/chart/RangeSeriesPane.tsx` (SeriesSpec 타입, 라이프사이클 effect, 데이터 effect)
- Test: `frontend/src/chart/RangeSeriesPane.test.tsx` (마커 케이스 추가)

- [ ] **Step 1: 실패 테스트 작성** — markers 프로젝터가 있으면 createSeriesMarkers로 부착·갱신됨

기존 `RangeSeriesPane.test.tsx`의 lwc 모킹 패턴을 따른다. `lightweight-charts` 모듈 모킹에 `createSeriesMarkers`를 추가하고, markers 프로젝터를 가진 spec을 렌더해 `setMarkers`가 호출되는지 검증:

```ts
// RangeSeriesPane.test.tsx 상단 vi.mock('lightweight-charts', ...) 에 추가:
//   createSeriesMarkers: (...args: unknown[]) => markersApi,
// 파일 스코프:
const setMarkers = vi.fn();
const markersApi = { setMarkers, detach: vi.fn() };

it('markers 프로젝터가 있으면 createSeriesMarkers().setMarkers로 마커를 갱신한다', () => {
  const spec = {
    name: 'test', stretch: 1,
    series: [{
      type: {} as any, options: {},
      data: () => [{ time: 1 as any, value: 10 }],
      markers: () => [{ time: 1 as any, position: 'aboveBar', shape: 'circle', color: '#fff' }],
    }],
  };
  // 기존 테스트의 render 헬퍼로 <RangeSeriesPane spec={spec} .../> 렌더
  // (bundle/axis/chart 목은 기존 테스트 픽스처 재사용)
  expect(setMarkers).toHaveBeenCalledWith([{ time: 1, position: 'aboveBar', shape: 'circle', color: '#fff' }]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/chart/RangeSeriesPane.test.tsx -t markers`
Expected: FAIL — setMarkers 미호출.

- [ ] **Step 3: 구현**

`RangeSeriesPane.tsx` 변경:

1) import에 추가:
```ts
import { createSeriesMarkers, type ISeriesMarkersPluginApi, type SeriesMarker, type Time } from 'lightweight-charts';
```

2) `SeriesSpec` 타입에 선택 필드 추가:
```ts
export type SeriesSpec<Ctx = void> = {
  type: SeriesDefinition<SeriesType>;
  options: SeriesPartialOptionsMap[SeriesType];
  data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => SeriesDataItemTypeMap[SeriesType][];
  /** 선택: 이 시리즈에 붙일 마커. 데이터와 같은 effect에서 setMarkers로 갱신된다. */
  markers?: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => SeriesMarker<Time>[];
  afterAdd?: (series: ISeriesApi<SeriesType>) => void;
};
```

3) 마커 핸들 ref 추가(seriesRef 옆):
```ts
const markersRef = useRef<(ISeriesMarkersPluginApi<Time> | null)[]>([]);
```

4) 라이프사이클 effect에서 series 생성 직후 markers 핸들 생성:
```ts
const seriesList: ISeriesApi<any>[] = spec.series.map((s) => {
  const series = chart.addSeries(s.type, s.options, paneIndex);
  s.afterAdd?.(series);
  return series;
});
markersRef.current = spec.series.map((s, i) =>
  s.markers ? createSeriesMarkers(seriesList[i], []) : null);
```
정리(cleanup) 시 `removeSeries`가 primitive도 떼므로 별도 detach 불필요하지만, 명시적으로:
```ts
for (const m of markersRef.current) { try { m?.detach(); } catch { /* torn down */ } }
markersRef.current = [];
```
(removeSeries 루프 직전에 둔다.)

5) 데이터 effect에서 setData 뒤에 마커 갱신:
```ts
spec.series.forEach((s, i) => {
  if (!s.markers) return;
  markersRef.current[i]?.setMarkers(s.markers(bundle, axis, ctx));
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/chart/RangeSeriesPane.test.tsx`
Expected: PASS (마커 케이스 + 기존 케이스 전부).

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit && cd ..
git add frontend/src/chart/RangeSeriesPane.tsx frontend/src/chart/RangeSeriesPane.test.tsx
git commit -m "feat(chart): RangeSeriesPane optional per-series markers projector (lwc v5)"
```

---

### Task 4: `QUOTE_TOTALS_SPEC`에 급증 마커 배선

**Files:**
- Modify: `frontend/src/chart/projectors/quoteTotals.ts` (context 확장 + bid/ask 시리즈에 markers 추가)
- Test: `frontend/src/chart/projectors/quoteTotals.test.ts` (마커 프로젝터 케이스 추가)

> 현재 `useQuoteTotalsContext`는 `boolean`(auctionMask)을 반환하고 `PaneSpec<boolean>`이다. 급증 설정도
> 필요하므로 context를 객체로 바꾼다.

- [ ] **Step 1: 실패 테스트 작성** — markers 프로젝터가 detectSurges 결과를 SeriesMarker로 변환

```ts
// quoteTotals.test.ts 에 추가
import { askSurgeMarkers, bidSurgeMarkers } from './quoteTotals';

it('급증 마커 — ask 라인에 매도 급증 마커(텍스트 +N%)', () => {
  const bundle = { quote_ratio: { points: [
    { t: 1, ask_total: 100, bid_total: 0 }, { t: 2, ask_total: 160, bid_total: 0 },
  ] }, segments: [{ session_open_ms: 0, session_close_ms: 9e12 }] } as any;
  const axis = { /* 기존 테스트의 axis 목 */ } as any;
  const ctx = { auctionMask: false, surgeEnabled: true, surgeMarginPct: 50 };
  const m = askSurgeMarkers(bundle, axis, ctx);
  expect(m).toHaveLength(1);
  expect(m[0].text).toBe('+60%');
  expect(m[0].position).toBe('aboveBar');
});

it('surgeEnabled=false면 마커 없음', () => {
  const bundle = { quote_ratio: { points: [
    { t: 1, ask_total: 100, bid_total: 0 }, { t: 2, ask_total: 160, bid_total: 0 },
  ] }, segments: [{ session_open_ms: 0, session_close_ms: 9e12 }] } as any;
  expect(askSurgeMarkers(bundle, {} as any, { auctionMask: false, surgeEnabled: false, surgeMarginPct: 50 })).toEqual([]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.test.ts -t 급증`
Expected: FAIL — askSurgeMarkers export 없음.

- [ ] **Step 3: 구현**

`quoteTotals.ts` 변경:

1) import 추가:
```ts
import { detectSurges, type SurgeMarker } from '../surge/detectSurges';
import type { SeriesMarker, Time } from 'lightweight-charts';
```

2) context 타입·훅 교체(기존 `useQuoteTotalsContext: () => boolean` 자리):
```ts
export type QuoteTotalsCtx = { auctionMask: boolean; surgeEnabled: boolean; surgeMarginPct: number };
function useQuoteTotalsContext(): QuoteTotalsCtx {
  const auctionMask = useActivePrefs((p) => p.auctionWindowMask);
  const surgeEnabled = useActivePrefs((p) => p.surgeMarkerEnabled);
  const surgeMarginPct = useActivePrefs((p) => p.surgeMarginPct);
  return { auctionMask, surgeEnabled, surgeMarginPct };
}
```
(기존 `useActivePrefs` 사용 형태는 파일 상단 import·현행 호출을 그대로 따른다. auctionMask가 기존 data 프로젝터에서 boolean으로 쓰였다면 그 사용처를 `ctx.auctionMask`로 바꾼다.)

3) 급증 마커 프로젝터(공유 헬퍼 + side별 export):
```ts
const SURGE_COLOR = ask; // 매도 급증=파랑 라인색 / 매수=빨강. 토큰 재사용.
function toMarkers(rows: SurgeMarker[], axis: VirtualAxis, color: string): SeriesMarker<Time>[] {
  return rows.map((r) => ({
    time: axis.toVirtual(r.t) as Time,   // 패널 라인과 동일 좌표(기존 프로젝터의 시간 투영 헬퍼와 동일한 것을 쓴다)
    position: 'aboveBar',
    shape: 'circle',
    color,
    text: `+${Math.round(r.pctOver * 100)}%`,
  }));
}
function surgeFor(side: 'ask' | 'bid', bundle: RangeBundle, axis: VirtualAxis, ctx: QuoteTotalsCtx): SeriesMarker<Time>[] {
  if (!ctx.surgeEnabled) return [];
  const r = detectSurges(bundle.quote_ratio.points, {
    margin: ctx.surgeMarginPct / 100,
    sessionOpens: bundle.segments.map((s) => s.session_open_ms),
    isClosingAuction: (t) => ctx.auctionMask && axis.inClosingAuctionWindow(t),
  });
  return toMarkers(r[side], axis, side === 'ask' ? ask : bid);
}
export const askSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => surgeFor('ask', b, a, c);
export const bidSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => surgeFor('bid', b, a, c);
```
> 시간 투영: 라인 data 프로젝터가 쓰는 것과 **동일한** axis 시간 변환을 써야 마커가 라인에 정렬된다.
> 기존 `projectBidPoints`/`projectAskPoints` 내부의 `t→Time` 변환 헬퍼를 찾아 그대로 사용할 것
> (위 `axis.toVirtual`은 자리표시 — 실제 헬퍼명으로 교체).

4) `QUOTE_TOTALS_SPEC`의 bid 시리즈에 `markers: bidSurgeMarkers`, ask 시리즈에 `markers: askSurgeMarkers` 추가. `satisfies PaneSpec<boolean>` → `satisfies PaneSpec<QuoteTotalsCtx>` 로 변경.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.test.ts`
Expected: PASS (급증 케이스 + 기존 케이스).

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit && cd ..
git add frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/quoteTotals.test.ts
git commit -m "feat(surge): wire surge markers into QuoteTotalsPane (ask/bid)"
```

---

### Task 5: 빌드·실화면 평가 게이트 (Phase A 완료 확인)

**Files:** 없음(검증).

- [ ] **Step 1: 프론트 빌드 그린**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: 에러 0.

- [ ] **Step 2: 전체 단위테스트 그린**

Run: `cd frontend && npx vitest run src/chart/surge src/chart/projectors/quoteTotals.test.ts src/chart/RangeSeriesPane.test.tsx src/state/chartPrefs.test.ts`
Expected: PASS.

- [ ] **Step 3: 실화면 — 종목 넘기며 마커 확인**

CLAUDE.md의 dev 서버 2개(백엔드 uvicorn --reload, `cd frontend && npm run dev`) 기동 후 `/browse`로 `http://localhost:5173/live` 열기. 활발한 종목(예 089030 테크윙) 선택 → 총잔량 패널 파랑(매도)·빨강(매수) 라인 위에 `+N%` 마커가 직전 고가 +50% 초과 지점에 뜨는지 확인. 종목 전환 시 마커 재계산 확인. (마커 0건 종목도 정상 — 조용한 날.)

- [ ] **Step 4: 커밋 불필요(검증만)**. 문제 있으면 해당 Task로 회귀.

---

## Phase B — 라이브 설정 좌측 접이식 패널 (모달 교체)

> 사용자 확정: 패널 내부는 **기존 설정 UI를 그대로** 쓴다. 새로 만드는 건 좌측 패널 셸 + 열기/닫기뿐.
> 모달이 'chart' 카테고리만 렌더하던 것을 패널은 **전 카테고리**(chart·indicators·surge)를 섹션으로 렌더.

### Task 6: 설정 섹션 렌더를 공유 컴포넌트로 추출

**Files:**
- Create: `frontend/src/live/LiveSettingsSections.tsx` (모달 본문에서 토글/numeric 행 렌더 로직 추출)
- Modify: `frontend/src/live/LiveSettingsModal.tsx` (추출한 컴포넌트 사용, 단 전 카테고리 렌더)
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — 전 카테고리 섹션 + 급증 섹션 노출

```tsx
import { render, screen } from '@testing-library/react';
import { LiveSettingsSections } from './LiveSettingsSections';

it('chart·indicators·surge 전 카테고리 토글을 렌더한다', () => {
  render(<LiveSettingsSections />);
  expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  expect(screen.getByTestId('settings-toggle-fillStrengthCumulative')).toBeTruthy(); // indicators
  expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();     // surge
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/LiveSettingsSections.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — 모달의 본문(현 `LiveSettingsModal.tsx`의 `CHART_TOGGLES.filter(...).map(...)` 블록)을 그대로 `LiveSettingsSections`로 옮기되, **카테고리 필터 제거**하고 카테고리별로 그룹화:

```tsx
// LiveSettingsSections.tsx
import { Fragment } from 'react';
import { CHART_TOGGLES, CHART_NUMERIC_PREFS, categoryOf, useChartPrefsStore } from '../state/chartPrefs';
import { ToggleRow, NumericRow } from '../ui/...'; // 모달이 쓰던 동일 행 컴포넌트 import 경로를 그대로 사용

const CATEGORY_LABEL: Record<string, string> = { chart: '차트', indicators: '보조지표', surge: '총잔량 급증' };
const CATEGORY_ORDER = ['indicators', 'surge', 'chart'];

export function LiveSettingsSections() {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);
  const setNumericPref = useChartPrefsStore((s) => s.setNumericPref);
  return (
    <>
      {CATEGORY_ORDER.map((cat) => {
        const toggles = CHART_TOGGLES.filter((t) => categoryOf(t) === cat);
        if (toggles.length === 0) return null;
        return (
          <section key={cat} data-settings-category={cat}>
            <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
            {toggles.map((toggle) => {
              const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === toggle.key);
              return (
                <Fragment key={toggle.key}>
                  <ToggleRow
                    label={toggle.label}
                    description={toggle.description}
                    checked={prefs[toggle.key]}
                    onToggle={() => setToggle(toggle.key, !prefs[toggle.key])}
                    testId={`settings-toggle-${toggle.key}`}
                  />
                  {gatedNumerics.map((p) => (
                    <NumericRow key={p.key} pref={p} value={prefs[p.key]}
                      disabled={!prefs[toggle.key]}
                      onChange={(v) => setNumericPref(p.key, v)} />
                  ))}
                </Fragment>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
```
> `ToggleRow`/`NumericRow`의 실제 컴포넌트명·props는 현 `LiveSettingsModal.tsx`에서 쓰는 것을 그대로 복사한다(신규 디자인 금지). 모달은 `<LiveSettingsSections />`를 본문으로 쓰도록 축소.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/LiveSettingsSections.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit && cd ..
git add frontend/src/live/LiveSettingsSections.tsx frontend/src/live/LiveSettingsSections.test.tsx frontend/src/live/LiveSettingsModal.tsx
git commit -m "refactor(live): extract LiveSettingsSections (all categories incl. surge)"
```

---

### Task 7: 좌측 접이식 패널 셸 + 모달 교체

**Files:**
- Create: `frontend/src/live/LiveSettingsPanel.tsx` (좌측 aside 셸)
- Modify: `frontend/src/live/LiveWorkarea.tsx` (좌측 패널 배치), `frontend/src/live/LivePage.tsx` (모달→패널)
- Test: `frontend/src/live/LiveSettingsPanel.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

```tsx
import { render, screen } from '@testing-library/react';
import { LiveSettingsPanel } from './LiveSettingsPanel';

it('open=true면 설정 섹션을, false면 숨긴다', () => {
  const { rerender } = render(<LiveSettingsPanel open onClose={() => {}} />);
  expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  rerender(<LiveSettingsPanel open={false} onClose={() => {}} />);
  expect(screen.queryByTestId('settings-toggle-surgeMarkerEnabled')).toBeNull();
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/live/LiveSettingsPanel.test.tsx` → FAIL.

- [ ] **Step 3: 구현**

```tsx
// LiveSettingsPanel.tsx
import { LiveSettingsSections } from './LiveSettingsSections';

export function LiveSettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <aside aria-label="라이브 설정" data-testid="live-settings-panel"
      style={{ width: 'var(--sidebar-w)', flexShrink: 0, overflowY: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>설정</span>
        <button aria-label="설정 닫기" onClick={onClose}>×</button>
      </header>
      <LiveSettingsSections />
    </aside>
  );
}
```

`LiveWorkarea.tsx`: 최상위 `className="h-full flex"` div의 **첫 자식**으로 패널을 둔다(차트 왼편). `open` 상태는 `LivePage`의 `settingsOpen`을 prop으로 받아 전달:
```tsx
// LiveWorkarea props에 settingsOpen, onSettingsClose 추가; 렌더 최상단:
<LiveSettingsPanel open={settingsOpen} onClose={onSettingsClose} />
```

`LivePage.tsx`: `import LiveSettingsModal` 제거, `LiveWorkarea`에 `settingsOpen`/`onSettingsClose={() => setSettingsOpen(false)}` 전달. 라인 156의 `<LiveSettingsModal .../>` 삭제. 툴바 "설정" 버튼은 그대로 `setSettingsOpen(true)`.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/live/LiveSettingsPanel.test.tsx src/live/LiveWorkarea.test.tsx` → PASS.

- [ ] **Step 5: 타입체크 + 커밋**

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit && cd ..
git add frontend/src/live/LiveSettingsPanel.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/LivePage.tsx frontend/src/live/LiveSettingsPanel.test.tsx
git commit -m "feat(live): left collapsible settings panel replaces modal"
```

---

### Task 8: 모달 제거 + 테스트 이관

**Files:**
- Delete: `frontend/src/live/LiveSettingsModal.tsx`, `frontend/src/live/LiveSettingsModal.test.tsx`
- Modify: 모달을 참조하던 곳(있으면) 정리.

- [ ] **Step 1: 모달 참조 검색**

Run: `cd frontend && grep -rn "LiveSettingsModal" src/`
Expected: LivePage에서 이미 제거됨 → 잔존 참조 0이어야 함(있으면 제거).

- [ ] **Step 2: 모달 파일 삭제**

```bash
git rm frontend/src/live/LiveSettingsModal.tsx frontend/src/live/LiveSettingsModal.test.tsx
```

- [ ] **Step 3: 전체 테스트·빌드 그린**

Run: `cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: PASS, 빌드 그린.

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "refactor(live): remove settings modal (superseded by left panel)"
```

---

### Task 9: 실화면 최종 확인 (Phase B 완료)

**Files:** 없음(검증).

- [ ] **Step 1: 실화면 — 설정 버튼 → 좌측 패널 열림** — `/browse`로 /live 열고 툴바 "설정" 클릭 → 좌측 패널 열림, 보조지표/총잔량 급증/차트 섹션 표시.
- [ ] **Step 2: 급증 토글·감도 동작** — 급증 마커 토글 OFF → 마커 사라짐; 감도(%) 30→100 조정 시 마커 밀도 변화.
- [ ] **Step 3: 닫기 → 차트 폭 복원.**

---

## Self-Review 메모 (작성자 확인 완료)
- 스펙 커버리지: detectSurges(세션리셋·동시호가·마진·ask/bid 독립·워밍업불요) = Task1; 마커 렌더 = Task3/4; chartPrefs = Task2; 좌측 패널 = Task6/7/8. ✓
- 타입 일관성: `surgeMarkerEnabled`(toggle)·`surgeMarginPct`(numeric, 정수%) 전 태스크 동일; `detectSurges`/`SurgeMarker`/`QuoteTotalsCtx` 시그니처 Task1↔4 일치. ✓
- 미해결(구현자 확인 지점, 코드에 명시): (a) quoteTotals의 실제 시간 투영 헬퍼명(자리표시 `axis.toVirtual` 교체), (b) `ToggleRow`/`NumericRow` 실제 컴포넌트명(모달에서 복사), (c) RangeSeriesPane.test의 기존 lwc 모킹 픽스처 재사용.
