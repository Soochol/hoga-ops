# 일봉 이동평균선 (Daily MA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일봉 종가 SMA를 분봉 차트에 거래일-계단으로 투영하는 「일봉 이동평균선」 보조지표를 「지표」 모달의 별도 페이지로 추가한다.

**Architecture:** 기존 현재봉 `MovingAverageOverlay` 시스템(ADR-0046)을 미러링한 self-contained 오버레이 + 독립 react-query 일봉 fetch(ADR-0073, useLiveBundle 비침투). 일봉 데이터는 `/api/live/past-daily-candles`(ADR-0048)를 분봉 프레임에서도 `today`+`PAST_CANDLES_MAX_DAYS` 고정 lookback으로 fetch해 pre-cached superset을 만들고, 각 분봉 캔들을 `axis.findByReal→segment.date`로 그 거래일의 일봉 MA값에 매핑한다. 영속·UI는 현재봉 MA 슬라이스를 평행 복제(`dailyMovingAverages`).

**Tech Stack:** React + TypeScript, zustand(`useLivePageStore`), @tanstack/react-query, lightweight-charts v5(`LineSeries`), vitest + @testing-library/react.

**참조:** spec `docs/superpowers/specs/2026-06-13-daily-moving-average-indicator-design.md`, ADR-0073, CONTEXT.md 「일봉 이동평균선 (Daily MA)」.

**테스트 실행:** 모든 vitest 명령은 `frontend/`에서 `npx vitest run <path>`. 타입체크는 `frontend/`에서 `npx tsc -b`.

**커밋 주의:** 이 repo의 커밋 훅이 **heredoc·`&&`-체이닝 git commit을 오탐 차단**한다([[hoga-ops-block-no-verify-commit-hook]]). 커밋은 본 계획의 단일 `git commit -m "..."` 형태를 그대로 쓰고, heredoc/`&&`로 바꾸지 말 것(`git add`와 `git commit`은 별도 줄로 실행).

---

## Prerequisites

- [ ] **신선한 워크트리는 node_modules가 비어 있다** — vitest/tsc/build 전에 1회:

Run: `cd frontend && npm install`
Expected: 의존성 설치 완료(`vite`/`vitest` 실행 가능).

---

## File Structure

| 파일 | 책임 | 작업 |
|------|------|------|
| `frontend/src/chart/projectors/movingAverage.ts` | `selectSource` 시그니처 확장(OHLC 수용) | Modify |
| `frontend/src/chart/projectors/dailyMovingAverage.ts` | 거래일→일봉 SMA 맵 순수함수 | Create |
| `frontend/src/state/liveIndicatorsPersistence.ts` | `dailyMovingAverages` 영속 타입·기본값·검증 | Modify |
| `frontend/src/state/livePage.ts` | daily 슬라이스 셀렉터/세터·snapshot·re-export | Modify |
| `frontend/src/live/indicators/DailyMovingAverageConfig.tsx` | 일봉 MA 설정 페이지(현재봉 Row 재사용) | Create |
| `frontend/src/live/indicators/DailyMovingAverageOverlay.tsx` | 일봉 MA 투영 LineSeries 오버레이 | Create |
| `frontend/src/live/indicators/IndicatorPanel.tsx` | 「일봉 이동평균선」 카테고리 추가 | Modify |
| `frontend/src/live/LiveChartRoot.tsx` | 오버레이 마운트 | Modify |

---

## Task 1: `selectSource` 시그니처를 OHLC 수용형으로 확장

**Files:**
- Modify: `frontend/src/chart/projectors/movingAverage.ts:8`
- Test: `frontend/src/chart/projectors/movingAverage.test.ts`

`selectSource`는 `open/high/low/close`만 읽으므로, 파라미터 타입을 `Candle`에서 `Pick<Candle,'open'|'high'|'low'|'close'>`로 넓혀 `LivePastDailyCandle`(필드명 동일, `ts_ms`/`vol_a` 없음)도 어댑터 없이 통과시킨다. `Candle`은 그대로 assignable이라 기존 호출부 무수정(ADR-0073).

- [ ] **Step 1: Write the failing test** — `movingAverage.test.ts`의 `describe('selectSource', ...)` 블록 끝(라인 29 `});` 직전)에 추가:

```ts
  it('accepts an OHLC-only object (daily candle shape — no ts_ms/vol_a)', () => {
    const d = { open: 10, high: 14, low: 6, close: 12 };
    expect(selectSource(d, 'close')).toBe(12);
    expect(selectSource(d, 'hl2')).toBe(10);
    expect(selectSource(d, 'ohlc4')).toBe(10.5);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/projectors/movingAverage.test.ts`
Expected: FAIL — 타입 에러(`{ open, high, low, close }`가 `Candle`에 `ts_ms`/`vol_a`/`vol_b` 누락) 또는 vitest가 타입을 안 보면 통과할 수 있으니, **Step 3 후 `npx tsc -b`로 타입 게이트 확인**.

- [ ] **Step 3: Widen the parameter type** — `movingAverage.ts:8`의 함수 시그니처만 변경:

```ts
export function selectSource(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>, source: MASource): number {
```

(본문·`import type { Candle }`는 그대로.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd frontend && npx vitest run src/chart/projectors/movingAverage.test.ts && npx tsc -b`
Expected: PASS (테스트 + 타입체크 0 에러).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/movingAverage.ts frontend/src/chart/projectors/movingAverage.test.ts
git commit -m "feat(live): selectSource를 OHLC 수용형으로 확장 (일봉 MA projector 재사용, ADR-0073)"
```

---

## Task 2: `computeDailyMaByDate` 순수함수 projector

**Files:**
- Create: `frontend/src/chart/projectors/dailyMovingAverage.ts`
- Test: `frontend/src/chart/projectors/dailyMovingAverage.test.ts`

- [ ] **Step 1: Write the failing test** — `dailyMovingAverage.test.ts` 생성:

```ts
import { describe, it, expect } from 'vitest';
import { computeDailyMaByDate } from './dailyMovingAverage';
import { unixMsToKSTDate } from '../../util/time';
import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';

const DAY = 86_400_000;
const D0 = 1779235200000; // 2026-05-20 09:00 KST (00:00 UTC)

function daily(closes: number[]): LivePastDailyCandle[] {
  return closes.map((c, i) => ({ t_ms: D0 + i * DAY, open: c, high: c, low: c, close: c, volume: 0 }));
}

describe('computeDailyMaByDate', () => {
  it('keys by the 09:00-KST-anchored trading date', () => {
    const m = computeDailyMaByDate(
      [{ t_ms: 1781222400000, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      1, 'close', '20260101', null,
    );
    expect(m.has('20260612')).toBe(true); // 1781222400000 → 2026-06-12 KST
  });

  it('returns SMA per date with leading nulls dropped from the map', () => {
    const m = computeDailyMaByDate(daily([10, 20, 30, 40]), 3, 'close', '20260101', null);
    const d = [0, 1, 2, 3].map((i) => unixMsToKSTDate(D0 + i * DAY));
    expect(m.has(d[0])).toBe(false);
    expect(m.has(d[1])).toBe(false);
    expect(m.get(d[2])).toBe(20); // (10+20+30)/3
    expect(m.get(d[3])).toBe(30); // (20+30+40)/3
  });

  it('overrides today row value with live close when daily includes today', () => {
    const todayDate = unixMsToKSTDate(D0 + DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 2, 'close', todayDate, 50);
    expect(m.get(todayDate)).toBe(30); // values [10,50] → SMA(2) last = 30
  });

  it('appends a synthetic today row when daily lacks today', () => {
    const todayDate = unixMsToKSTDate(D0 + 2 * DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 3, 'close', todayDate, 30);
    expect(m.get(todayDate)).toBe(20); // values [10,20,30] → SMA(3) last = 20
  });

  it('does not override when todayLiveClose is null', () => {
    const todayDate = unixMsToKSTDate(D0 + DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 1, 'close', todayDate, null);
    expect(m.get(todayDate)).toBe(20);
  });

  it('sorts daily ascending before computing (defensive)', () => {
    const m = computeDailyMaByDate(daily([10, 20, 30]).slice().reverse(), 2, 'close', '20260101', null);
    expect(m.get(unixMsToKSTDate(D0 + DAY))).toBe(15);     // (10+20)/2
    expect(m.get(unixMsToKSTDate(D0 + 2 * DAY))).toBe(25); // (20+30)/2
  });

  it('returns empty map when period exceeds row count', () => {
    expect(computeDailyMaByDate(daily([10, 20]), 5, 'close', '20260101', null).size).toBe(0);
  });

  it('honors source (hl2)', () => {
    const m = computeDailyMaByDate(
      [{ t_ms: D0, open: 10, high: 14, low: 6, close: 12, volume: 0 }],
      1, 'hl2', '20260101', null,
    );
    expect(m.get(unixMsToKSTDate(D0))).toBe(10); // (14+6)/2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/projectors/dailyMovingAverage.test.ts`
Expected: FAIL — `Cannot find module './dailyMovingAverage'`.

- [ ] **Step 3: Create the projector** — `dailyMovingAverage.ts`:

```ts
import { computeSMA, selectSource, type MASource } from './movingAverage';
import { unixMsToKSTDate } from '../../util/time';
import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';

/**
 * 거래일(YYYYMMDD KST) → 일봉 SMA값 맵. (일봉 이동평균선 projector, ADR-0073)
 *
 * - `daily`는 방어적으로 t_ms 오름차순 정렬 후 계산.
 * - 키는 `unixMsToKSTDate(t_ms)` — 일봉 t_ms는 09:00 KST 앵커라 거래일과 일치
 *   (실데이터 검증 2026-06-13; 회귀 테스트로 고정).
 * - `todayLiveClose != null`이면 오늘 in-progress 봉 반영: daily 마지막 행이
 *   `todayDate`면 그 값을 override, 아니면 `todayDate` 합성 행을 append. 오늘 값은
 *   현재가 close 프록시 — source가 close가 아니어도 close를 쓰며 마감 시 종가로 수렴.
 * - `period` 미달 구간(SMA=null)은 맵에 없음 → 그 거래일은 라인 미표시.
 */
export function computeDailyMaByDate(
  daily: readonly LivePastDailyCandle[],
  period: number,
  source: MASource,
  todayDate: string,
  todayLiveClose: number | null,
): Map<string, number> {
  const rows = [...daily]
    .sort((a, b) => a.t_ms - b.t_ms)
    .map((d) => ({ date: unixMsToKSTDate(d.t_ms), value: selectSource(d, source) }));

  if (todayLiveClose != null) {
    const last = rows[rows.length - 1];
    if (last && last.date === todayDate) {
      last.value = todayLiveClose;
    } else {
      rows.push({ date: todayDate, value: todayLiveClose });
    }
  }

  const sma = computeSMA(rows.map((r) => r.value), period);
  const map = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = sma[i];
    if (v != null) map.set(r.date, v);
  });
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/projectors/dailyMovingAverage.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/dailyMovingAverage.ts frontend/src/chart/projectors/dailyMovingAverage.test.ts
git commit -m "feat(live): computeDailyMaByDate — 거래일→일봉 SMA 맵 projector (ADR-0073)"
```

---

## Task 3: 영속 + 스토어 slice (`dailyMovingAverages`)

> PersistedIndicators 타입 변경이 `snapshotIndicators` 타입체크를 깨므로 영속(`liveIndicatorsPersistence.ts`)과 스토어(`livePage.ts`)를 **한 커밋**으로 묶어 green을 유지한다.

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts` (기존 1건 갱신 + 신규)
- Test: `frontend/src/state/livePage.dailyMa.test.ts` (신규)

- [ ] **Step 1: Write the failing tests**

(1a) `liveIndicatorsPersistence.test.ts`의 `returns defaults for undefined input` 테스트(라인 6-21)의 expected 객체에 daily 3필드 추가:

```ts
  it('returns defaults for undefined input', () => {
    expect(mergeLiveIndicatorPrefs(undefined)).toEqual({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      movingAverageEnabled: true,
      foreignNetEnabled: false,
      institutionNetEnabled: false,
      volumeEnabled: true,
      movingAverageHidden: false,
      askPeakEnabled: false,
      askPeakColor: '#1D4ED8',
      askPeakLineWidth: 2,
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
      dailyMovingAverageEnabled: false,
      dailyMovingAverageHidden: false,
    });
  });
```

그리고 같은 파일 import에 `DEFAULT_DAILY_MAS` 추가:

```ts
import { mergeLiveIndicatorPrefs, DEFAULT_DAILY_MAS, type PersistedIndicators } from './liveIndicatorsPersistence';
```

(1b) `liveIndicatorsPersistence.test.ts` 끝에 daily 전용 describe 추가:

```ts
describe('mergeLiveIndicatorPrefs — daily MA', () => {
  it('빈 입력 → 1 슬롯(period 20) + enabled false(opt-in)', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.dailyMovingAverages).toEqual(DEFAULT_DAILY_MAS.map((x) => ({ ...x })));
    expect(m.dailyMovingAverageEnabled).toBe(false);
    expect(m.dailyMovingAverageHidden).toBe(false);
  });
  it('enabled는 === true만 ON', () => {
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverageEnabled: true }).dailyMovingAverageEnabled).toBe(true);
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverageEnabled: 'yes' as unknown as boolean }).dailyMovingAverageEnabled).toBe(false);
  });
  it('손상 daily 슬롯 필터, 전부 무효면 기본값', () => {
    const valid = { id: 'dma-1', enabled: true, period: 60, color: '#ffffff', lineWidth: 2, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverages: [valid, { id: 'x' }] } as never).dailyMovingAverages).toEqual([valid]);
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverages: [{}, { id: 1 }] } as never).dailyMovingAverages)
      .toEqual(DEFAULT_DAILY_MAS.map((x) => ({ ...x })));
  });
});
```

(1c) `livePage.dailyMa.test.ts` 생성:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore, DEFAULT_DAILY_MAS } from './livePage';

describe('daily MA store setters', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
      dailyMovingAverageEnabled: false,
      dailyMovingAverageHidden: false,
    });
  });

  it('setDailyMovingAverage patches a slot (period clamped to int)', () => {
    const id = useLivePageStore.getState().dailyMovingAverages[0].id;
    useLivePageStore.getState().setDailyMovingAverage(id, { period: 60 });
    expect(useLivePageStore.getState().dailyMovingAverages[0].period).toBe(60);
  });

  it('addDailyMovingAverage appends a slot', () => {
    useLivePageStore.getState().addDailyMovingAverage();
    expect(useLivePageStore.getState().dailyMovingAverages.length).toBe(2);
    expect(useLivePageStore.getState().dailyMovingAverages[1].id).toMatch(/^dma-/);
  });

  it('removeDailyMovingAverage removes by id (keeps ≥1)', () => {
    useLivePageStore.getState().addDailyMovingAverage();
    const id = useLivePageStore.getState().dailyMovingAverages[1].id;
    useLivePageStore.getState().removeDailyMovingAverage(id);
    expect(useLivePageStore.getState().dailyMovingAverages.length).toBe(1);
  });

  it('enabled/hidden setters flip flags', () => {
    useLivePageStore.getState().setDailyMovingAverageEnabled(true);
    useLivePageStore.getState().setDailyMovingAverageHidden(true);
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
    expect(useLivePageStore.getState().dailyMovingAverageHidden).toBe(true);
  });

  it('daily setter does NOT clobber current-bar movingAverages (single source)', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setDailyMovingAverageEnabled(true);
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.dailyMa.test.ts`
Expected: FAIL — `DEFAULT_DAILY_MAS` export 없음 / 세터 없음.

- [ ] **Step 3a: `liveIndicatorsPersistence.ts` 수정**

(i) `PersistedIndicators` 타입(라인 73 `fillStrengthEnabled: boolean;` 뒤)에 추가:

```ts
  /** 일봉 이동평균선 슬롯(현재봉 movingAverages와 별개, ADR-0073). */
  dailyMovingAverages: LiveMAConfig[];
  /** 일봉 MA 마스터 토글. opt-in(기본 false). */
  dailyMovingAverageEnabled: boolean;
  /** 일봉 MA 눈(숨김), config 보존. 기본 false. */
  dailyMovingAverageHidden: boolean;
```

(ii) `DEFAULT_LIVE_MAS` 정의(라인 42 `]) as readonly LiveMAConfig[];`) 바로 뒤에 추가:

```ts
/** 일봉 이동평균선 기본 슬롯 — period 20 단일. 색 #EAB308(--ma-7, yellow)은
 *  현재봉 기본 슬롯(EC4899/F97316/22C55E/F8FAFC)과 구분된다(MA_PALETTE와 일치). */
export const DEFAULT_DAILY_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'dma-1', enabled: true, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' },
]) as readonly LiveMAConfig[];
```

(iii) `mergeLiveIndicatorPrefs` 안에서 askPeak 필드 계산 블록(라인 110-114) 바로 뒤에 daily 필드 계산 추가:

```ts
  // daily MA — opt-in(기본 false), 슬롯은 검증·cap·기본값 전략 movingAverages와 동일.
  const dEnabled = obj?.dailyMovingAverageEnabled === true;
  const dHidden = obj?.dailyMovingAverageHidden === true;
  const dRaw = obj?.dailyMovingAverages;
  const dKept = Array.isArray(dRaw)
    ? (dRaw.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[])
    : [];
  const dMas = dKept.length > 0 ? dKept : DEFAULT_DAILY_MAS.map((m) => ({ ...m }));
```

(iv) `build` 함수의 return 객체(라인 119-132)에 3필드 추가(맨 끝 `fillStrengthEnabled: fill,` 뒤):

```ts
    fillStrengthEnabled: fill,
    dailyMovingAverages: dMas,
    dailyMovingAverageEnabled: dEnabled,
    dailyMovingAverageHidden: dHidden,
  });
```

(build의 시그니처·호출부는 변경하지 않는다 — daily 필드는 askPeak처럼 closure로 참조.)

- [ ] **Step 3b: `livePage.ts` 수정**

(i) 재-export 블록(라인 18-23)에 `DEFAULT_DAILY_MAS` 추가, import(라인 3-11)에도 추가:

```ts
// import 블록:
import {
  mergeLiveIndicatorPrefs,
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type LiveMAConfig,
  type PersistedIndicators,
} from './liveIndicatorsPersistence';

// re-export 블록:
export {
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
};
```

(ii) `Store` 타입(라인 110-122 setter 선언부)에 5 세터 추가(`setFillStrengthEnabled` 줄 뒤):

```ts
  setDailyMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addDailyMovingAverage: () => void;
  removeDailyMovingAverage: (id: string) => void;
  setDailyMovingAverageEnabled: (enabled: boolean) => void;
  setDailyMovingAverageHidden: (hidden: boolean) => void;
```

(iii) `snapshotIndicators`(라인 161-177)의 return에 3필드 추가(`fillStrengthEnabled: s.fillStrengthEnabled,` 뒤):

```ts
    fillStrengthEnabled: s.fillStrengthEnabled,
    dailyMovingAverages: s.dailyMovingAverages,
    dailyMovingAverageEnabled: s.dailyMovingAverageEnabled,
    dailyMovingAverageHidden: s.dailyMovingAverageHidden,
  };
```

(iv) `nextSlotId`(라인 192-201)에 prefix 파라미터 추가:

```ts
function nextSlotId(existing: readonly LiveMAConfig[], prefix = 'ma'): string {
  const used = new Set(existing.map((m) => m.id));
  for (let i = 1; i <= MA_SLOT_LIMIT * 2; i++) {
    const id = `${prefix}-${i}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}
```

(v) 스토어 구현부에서 `setFillStrengthEnabled` 세터(라인 315-318) 뒤에 daily 세터 5종 추가:

```ts
  setDailyMovingAverage: (id, patch) => {
    const current = get().dailyMovingAverages;
    const idx = current.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const cur = current[idx];
    const next: LiveMAConfig = { ...cur, ...patch };
    if (patch.period !== undefined) {
      const p = Number(patch.period);
      if (!Number.isFinite(p)) return;
      next.period = clamp(Math.floor(p), MA_PERIOD_MIN, MA_PERIOD_MAX);
    }
    const nextArr = current.slice();
    nextArr[idx] = next;
    set({ dailyMovingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  addDailyMovingAverage: () => {
    const current = get().dailyMovingAverages;
    if (current.length >= MA_SLOT_LIMIT) return;
    const last = current[current.length - 1];
    const period = last ? clamp(last.period * 2, MA_PERIOD_MIN, MA_PERIOD_MAX) : 20;
    const next: LiveMAConfig = {
      id: nextSlotId(current, 'dma'),
      enabled: true,
      period,
      color: nextSlotColor(current),
      lineWidth: 2,
      source: 'close',
    };
    set({ dailyMovingAverages: [...current, next] });
    persistIndicators(snapshotIndicators(get));
  },

  removeDailyMovingAverage: (id) => {
    const current = get().dailyMovingAverages;
    if (current.length <= 1) return;
    const nextArr = current.filter((m) => m.id !== id);
    if (nextArr.length === current.length) return;
    set({ dailyMovingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  setDailyMovingAverageEnabled: (enabled) => {
    set({ dailyMovingAverageEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setDailyMovingAverageHidden: (hidden) => {
    set({ dailyMovingAverageHidden: hidden });
    persistIndicators(snapshotIndicators(get));
  },
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.dailyMa.test.ts && npx tsc -b`
Expected: PASS (모든 persistence + daily 세터 테스트, 타입 0 에러).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.ts frontend/src/state/livePage.dailyMa.test.ts
git commit -m "feat(live): dailyMovingAverages 영속 슬라이스 + 스토어 세터 5종 (ADR-0073)"
```

---

## Task 4: `DailyMovingAverageConfig` 설정 페이지

**Files:**
- Create: `frontend/src/live/indicators/DailyMovingAverageConfig.tsx`
- Test: `frontend/src/live/indicators/DailyMovingAverageConfig.test.tsx`

현재봉 `MovingAverageConfig`를 미러링하되 daily 셀렉터/세터 사용. `MovingAverageRow`(prop-driven)를 그대로 재사용.

- [ ] **Step 1: Write the failing test** — `DailyMovingAverageConfig.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import { useLivePageStore, DEFAULT_DAILY_MAS, MA_SLOT_LIMIT } from '../../state/livePage';

describe('DailyMovingAverageConfig', () => {
  beforeEach(() => {
    useLivePageStore.setState({ dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })) });
  });

  it('renders one row per slot (period spinbutton)', () => {
    render(<DailyMovingAverageConfig />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(DEFAULT_DAILY_MAS.length);
  });

  it('"기간 추가" appends a daily slot', () => {
    render(<DailyMovingAverageConfig />);
    fireEvent.click(screen.getByRole('button', { name: /기간 추가/ }));
    expect(useLivePageStore.getState().dailyMovingAverages).toHaveLength(DEFAULT_DAILY_MAS.length + 1);
  });

  it('"기간 추가" disabled at MA_SLOT_LIMIT', () => {
    while (useLivePageStore.getState().dailyMovingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addDailyMovingAverage();
    }
    render(<DailyMovingAverageConfig />);
    expect((screen.getByRole('button', { name: /기간 추가/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('header + 분봉 전용 안내 표시', () => {
    render(<DailyMovingAverageConfig />);
    expect(screen.getByText('일봉 이동평균선')).toBeTruthy();
    expect(screen.getByText(/분봉 차트에서만 표시/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/indicators/DailyMovingAverageConfig.test.tsx`
Expected: FAIL — `Cannot find module './DailyMovingAverageConfig'`.

- [ ] **Step 3: Create the component** — `DailyMovingAverageConfig.tsx`:

```tsx
import { useLivePageStore, MA_SLOT_LIMIT } from '../../state/livePage';
import MovingAverageRow from './MovingAverageRow';

/** 일봉 이동평균선 설정 페이지. 현재봉 MovingAverageConfig를 미러링하되 daily
 *  슬라이스를 쓴다. MovingAverageRow(prop-driven)를 그대로 재사용. ADR-0073. */
export default function DailyMovingAverageConfig() {
  const configs = useLivePageStore((s) => s.dailyMovingAverages);
  const setMA = useLivePageStore((s) => s.setDailyMovingAverage);
  const addMA = useLivePageStore((s) => s.addDailyMovingAverage);
  const removeMA = useLivePageStore((s) => s.removeDailyMovingAverage);
  const atLimit = configs.length >= MA_SLOT_LIMIT;
  const canRemove = configs.length > 1;

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        일봉 이동평균선 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        일봉 종가 기준 이평선을 분봉 차트에 투영 · 분봉 차트에서만 표시됩니다
      </p>
      <div>
        {configs.map((cfg, i) => (
          <MovingAverageRow
            key={cfg.id}
            index={i}
            config={cfg}
            canRemove={canRemove}
            onChange={(patch) => setMA(cfg.id, patch)}
            onRemove={() => removeMA(cfg.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addMA}
        disabled={atLimit}
        className="mt-3 px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        ⊕ 기간 추가
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/indicators/DailyMovingAverageConfig.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/DailyMovingAverageConfig.tsx frontend/src/live/indicators/DailyMovingAverageConfig.test.tsx
git commit -m "feat(live): DailyMovingAverageConfig 설정 페이지 (MovingAverageRow 재사용)"
```

---

## Task 5: `DailyMovingAverageOverlay` 투영 오버레이

**Files:**
- Create: `frontend/src/live/indicators/DailyMovingAverageOverlay.tsx`
- Test: `frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx`

- [ ] **Step 1: Write the failing test** — `DailyMovingAverageOverlay.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useLivePageStore } from '../../state/livePage';
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';

vi.mock('../../api/livePastDailyCandles', () => ({ useLivePastDailyCandles: vi.fn() }));
const mockUseDaily = vi.mocked(useLivePastDailyCandles);

function makeChartMock() {
  const seriesById = new Map<string, ReturnType<typeof makeSeriesMock>>();
  let seriesCounter = 0;
  function makeSeriesMock() {
    return { applyOptions: vi.fn(), setData: vi.fn(), _internalId: ++seriesCounter };
  }
  const addSeries = vi.fn(() => {
    const s = makeSeriesMock();
    seriesById.set(String(s._internalId), s);
    return s;
  });
  const removeSeries = vi.fn((s: ReturnType<typeof makeSeriesMock>) => { seriesById.delete(String(s._internalId)); });
  return { chart: { addSeries, removeSeries } as unknown, addSeries, removeSeries, seriesById };
}

const D_0612 = 1781222400000; // 2026-06-12 09:00 KST
const dailyCandles = [{ t_ms: D_0612, open: 100, high: 100, low: 100, close: 100, volume: 0 }];
const candles = [0, 1, 2].map((i) => ({
  ts_ms: D_0612 + i * 60_000, open: 1, close: 1, high: 1, low: 1, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
const axis = {
  contains: () => true,
  toVirtual: (m: number) => m,
  findByReal: () => 0,
  segments: [{ date: '20260612' }],
} as never;
const oneSlot = [{ id: 'dma-1', enabled: true, period: 1, color: '#EAB308', lineWidth: 2, source: 'close' }];

function renderOverlay(m: ReturnType<typeof makeChartMock>, over: Record<string, unknown> = {}) {
  return render(
    <DailyMovingAverageOverlay
      chart={m.chart as never}
      bundle={bundle}
      axis={axis}
      code="005930"
      timeframe="1m"
      todayKst="20260613"
      {...over}
    />,
  );
}

describe('DailyMovingAverageOverlay', () => {
  beforeEach(() => {
    cleanup();
    mockUseDaily.mockReturnValue({ data: { candles: dailyCandles } } as never);
    useLivePageStore.setState({
      dailyMovingAverages: oneSlot.map((m) => ({ ...m })) as never,
      dailyMovingAverageEnabled: true,
      dailyMovingAverageHidden: false,
    });
  });

  it('projects the daily MA value onto every in-session candle (day-anchored step)', () => {
    const m = makeChartMock();
    renderOverlay(m);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    expect(data).toHaveLength(3);
    expect(data.every((d) => d.value === 100)).toBe(true); // period 1, close 100
  });

  it('reconciles add by id without churning existing slots', () => {
    const m = makeChartMock();
    const { rerender } = renderOverlay(m);
    expect(m.addSeries).toHaveBeenCalledTimes(1);
    useLivePageStore.getState().addDailyMovingAverage();
    rerender(
      <DailyMovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} code="005930" timeframe="1m" todayKst="20260613" />,
    );
    expect(m.addSeries).toHaveBeenCalledTimes(2);
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('master off → setData([])', () => {
    useLivePageStore.setState({ dailyMovingAverageEnabled: false });
    const m = makeChartMock();
    renderOverlay(m);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    expect(first.setData.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('non-minute timeframe (D) → setData([]) (not drawn)', () => {
    const m = makeChartMock();
    renderOverlay(m, { timeframe: 'D' });
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    expect(first.setData.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('today live close overrides today value when last candle is on todayKst', () => {
    const liveCandles = [0, 1].map((i) => ({
      ts_ms: D_0612 + i * 60_000, open: 1, close: i === 1 ? 200 : 1, high: 1, low: 1, vol_a: 0, vol_b: 0,
    }));
    const m = makeChartMock();
    render(
      <DailyMovingAverageOverlay chart={m.chart as never} bundle={{ candles: liveCandles } as never} axis={axis} code="005930" timeframe="1m" todayKst="20260612" />,
    );
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number }>;
    expect(data.every((d) => d.value === 200)).toBe(true); // 100 overridden by live 200
  });

  it('empty daily response → no values, no throw', () => {
    mockUseDaily.mockReturnValue({ data: { candles: [] } } as never);
    const m = makeChartMock();
    expect(() => renderOverlay(m)).not.toThrow();
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number }>;
    expect(data.every((d) => d.value === undefined)).toBe(true);
  });

  it('unmount removes all series', () => {
    const m = makeChartMock();
    const { unmount } = renderOverlay(m);
    const added = m.addSeries.mock.calls.length;
    unmount();
    expect(m.removeSeries).toHaveBeenCalledTimes(added);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/indicators/DailyMovingAverageOverlay.test.tsx`
Expected: FAIL — `Cannot find module './DailyMovingAverageOverlay'`.

- [ ] **Step 3: Create the overlay** — `DailyMovingAverageOverlay.tsx`:

```tsx
import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useLivePageStore, isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import { computeDailyMaByDate } from '../../chart/projectors/dailyMovingAverage';
import { unixMsToKSTDate } from '../../util/time';
import { subtractDaysKst, PAST_CANDLES_MAX_DAYS } from '../liveDateTime';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  code: string | null;
  timeframe: LiveTimeframe;
  todayKst: string;
};

type LineApi = ISeriesApi<'Line'>;
const EMPTY_DAILY: never[] = [];

/** 일봉 이동평균선 오버레이 — 일봉 종가 SMA를 분봉 축에 거래일-계단으로 투영
 *  (ADR-0073). 현재봉 MovingAverageOverlay의 series-reconcile 패턴을 미러링하되,
 *  일봉 데이터를 useLiveBundle 밖 독립 훅으로 fetch한다(번들 split 비침투). 분봉
 *  전용: D/W/M에선 미렌더. 레전드 연동은 v1 비대상(maSeriesRegistry 미등록). */
function DailyMovingAverageOverlay({ chart, bundle, axis, code, timeframe, todayKst }: Props) {
  const configs = useLivePageStore((s) => s.dailyMovingAverages);
  const masterEnabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const hidden = useLivePageStore((s) => s.dailyMovingAverageHidden);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  const enabled = masterEnabled && isMinuteTimeframe(timeframe) && !!code && !!todayKst;

  // 일봉 fetch 창 — today 앵커 + PAST_CANDLES_MAX_DAYS(분봉 팬 클램프 하한) + period
  // headroom으로 분봉 가시 전 범위를 항상 덮는 superset. from/to가 좌측 팬에 불변이라
  // 재fetch 없이 lockstep(ADR-0073).
  const maxPeriod = useMemo(
    () => configs.reduce((mx, c) => (c.enabled ? Math.max(mx, c.period) : mx), 20),
    [configs],
  );
  // period 거래일 → 캘린더일 (KRX ≈ 5 거래일 / 7 캘린더일) + 휴장 슬랙.
  const lookbackDays = PAST_CANDLES_MAX_DAYS + Math.ceil((maxPeriod * 7) / 5) + 15;
  const from = enabled ? subtractDaysKst(todayKst, lookbackDays) : null;
  const to = enabled ? todayKst : null;
  const dailyQuery = useLivePastDailyCandles(enabled ? code : null, from, to);
  const daily = dailyQuery.data?.candles ?? EMPTY_DAILY;

  // Reconcile series ↔ configs by id (MovingAverageOverlay와 동일).
  useEffect(() => {
    const map = seriesByIdRef.current;
    const currentIds = new Set(configs.map((c) => c.id));
    for (const [id, s] of Array.from(map.entries())) {
      if (!currentIds.has(id)) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
        map.delete(id);
      }
    }
    for (const cfg of configs) {
      const existing = map.get(cfg.id);
      if (!existing) {
        try {
          const s = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: cfg.lineWidth,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0); // paneIndex 0 — candle pane overlay
          map.set(cfg.id, s);
        } catch { /* torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth });
      }
    }
  }, [chart, configs]);

  // Unmount cleanup — remove all series.
  useEffect(() => {
    return () => {
      const map = seriesByIdRef.current;
      for (const [, s] of map) {
        try { chart.removeSeries(s); } catch { /* torn down */ }
      }
      map.clear();
    };
  }, [chart]);

  // 오늘 현재가 프록시 — 마지막 in-session 캔들이 오늘 거래일일 때만.
  const todayLiveClose = useMemo(() => {
    if (!enabled) return null;
    const cs = bundle.candles;
    const last = cs.length ? cs[cs.length - 1] : null;
    return last && unixMsToKSTDate(last.ts_ms) === todayKst ? last.close : null;
  }, [enabled, bundle, todayKst]);

  // Project daily MA onto each in-session candle (day-anchored step).
  useEffect(() => {
    const map = seriesByIdRef.current;
    const inSession = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    for (const cfg of configs) {
      const s = map.get(cfg.id);
      if (!s) continue;
      const drawn = enabled && cfg.enabled;
      s.applyOptions({ visible: drawn && !hidden });
      if (!drawn) {
        s.setData([]);
        continue;
      }
      const maByDate = computeDailyMaByDate(daily, cfg.period, cfg.source, todayKst, todayLiveClose);
      const data = inSession.map((c) => {
        const segIdx = axis.findByReal(c.ts_ms);
        const date = axis.segments[segIdx]?.date;
        const v = date != null ? maByDate.get(date) : undefined;
        const time = (axis.toVirtual(c.ts_ms) / 1000) as Time;
        return v == null ? { time } : { time, value: v };
      });
      s.setData(data as never);
    }
    // `chart` dep: /live remounts the chart per (code, timeframe); fresh series
    // start empty and must be re-pushed in the same commit (MovingAverageOverlay 동일).
  }, [chart, bundle, axis, configs, enabled, hidden, daily, todayKst, todayLiveClose]);

  return null;
}

export default memo(DailyMovingAverageOverlay);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/indicators/DailyMovingAverageOverlay.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/DailyMovingAverageOverlay.tsx frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx
git commit -m "feat(live): DailyMovingAverageOverlay — 일봉 MA 거래일-계단 투영 (ADR-0073)"
```

---

## Task 6: `IndicatorPanel`에 「일봉 이동평균선」 카테고리 추가

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

- [ ] **Step 1: Update + add failing tests**

(1a) `IndicatorPanel.test.tsx:7-18`의 카테고리 개수 8→9 갱신:

```tsx
  it('활성 9개 체크박스(비활성 0), 호가 3종 포함', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true });
    render(<IndicatorPanel onClose={() => {}} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(9); // 상단 5(이동평균선·일봉 이동평균선·거래량·외국인·기관) + 호가 4
    expect(checkboxes.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(0);
    for (const name of ['총잔량', '호가비', '체결강도']) {
      const cb = screen.getByRole('checkbox', { name }) as HTMLButtonElement;
      expect(cb.disabled).toBe(false);
      expect(cb.getAttribute('aria-checked')).toBe('true');
    }
  });
```

(1b) 같은 파일 끝(라인 173 `});` 직전, describe 닫기 전)에 daily 카테고리 테스트 추가:

```tsx
  it('일봉 이동평균선 체크박스 토글 → dailyMovingAverageEnabled 반전', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ dailyMovingAverageEnabled: false });
    render(<IndicatorPanel onClose={() => {}} />);
    const cb = screen.getByRole('checkbox', { name: '일봉 이동평균선' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
  });

  it('일봉 이동평균선 라벨 클릭 → DailyMovingAverageConfig 노출', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '일봉 이동평균선' }));
    expect(screen.getByText(/일봉 종가 기준 이평선을 분봉 차트에 투영/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx`
Expected: FAIL — 체크박스 8개(9 기대), `일봉 이동평균선` 체크박스 없음.

- [ ] **Step 3: Wire the category** — `IndicatorPanel.tsx` 5곳 수정:

(i) import(라인 3 `import MovingAverageConfig ...` 뒤):

```tsx
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
```

(ii) `CategoryId` union(라인 13-21)에 추가:

```tsx
type CategoryId =
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'ask-peak'
  | 'quote-totals'
  | 'ratio'
  | 'fill-strength';
```

(iii) `CATEGORIES`(라인 26-35)의 `moving-average` 다음에 삽입:

```tsx
  { id: 'moving-average',       label: '이동평균선',       group: 'top'  },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top'  },
  { id: 'volume',               label: '거래량',           group: 'top'  },
```

(iv) 셀렉터(라인 42-43 `maEnabled`/`setMaEnabled` 뒤)에 추가:

```tsx
  const dailyMaEnabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const setDailyMaEnabled = useLivePageStore((s) => s.setDailyMovingAverageEnabled);
```

(v) `checkedFor`(라인 67) + `toggleFor`(라인 81)에 case 추가:

```tsx
// checkedFor switch:
      case 'moving-average': return maEnabled;
      case 'daily-moving-average': return dailyMaEnabled;
// toggleFor switch:
      case 'moving-average': return () => setMaEnabled(!maEnabled);
      case 'daily-moving-average': return () => setDailyMaEnabled(!dailyMaEnabled);
```

(vi) detail 분기(라인 139 `{selected === 'moving-average' && <MovingAverageConfig />}` 뒤):

```tsx
          {selected === 'moving-average' && <MovingAverageConfig />}
          {selected === 'daily-moving-average' && <DailyMovingAverageConfig />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx`
Expected: PASS (전체 IndicatorPanel 테스트 + 신규 2건).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat(live): 「지표」 모달에 일봉 이동평균선 카테고리 추가 (상단 지표)"
```

---

## Task 7: `LiveChartRoot`에 오버레이 마운트

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx:41` (import), `:759` (mount)

마운트 동작은 Task 5 오버레이 테스트가 커버하므로, 검증은 타입체크 + 빌드.

- [ ] **Step 1: Add the import** — `LiveChartRoot.tsx:41` `import MovingAverageOverlay ...` 바로 뒤:

```tsx
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import DailyMovingAverageOverlay from './indicators/DailyMovingAverageOverlay';
```

- [ ] **Step 2: Mount the overlay** — `:759` `<MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />` 바로 뒤:

```tsx
          <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
          <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} todayKst={todayKst} />
```

- [ ] **Step 3: Typecheck + build**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 타입 0 에러, 빌드 성공.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "feat(live): LiveChartRoot에 DailyMovingAverageOverlay 마운트 (분봉 일봉 MA)"
```

---

## Task 8: 전체 검증 + 수동 확인

**Files:** (없음 — 검증만)

- [ ] **Step 1: 전체 테스트 스위트**

Run: `cd frontend && npx vitest run`
Expected: 전체 PASS (기존 + 신규). 회귀 0.

- [ ] **Step 2: 타입체크 + 빌드 + 린트**

Run: `cd frontend && npx tsc -b && npm run build && npm run lint`
Expected: 0 에러.

- [ ] **Step 3: 수동 확인 (사용자, dev 서버)** — `/live`에서:

1. 「지표」 모달 → "일봉 이동평균선" 체크 → 분봉 차트에 노란 계단식 일봉20 라인.
2. 분봉 1→3→5→10분 전환 → 동일 일봉20 라인 유지(값 불변, x정렬만 변화).
3. 좌측 팬으로 과거 거래일 진입 → 라인 끊김/깜빡임 없이 연장(첫 enable만 1-fetch 지연 등장).
4. 장중(평일) 오늘 구간이 현재가 따라 갱신, 과거 거래일은 평평.
5. D/W/M 전환 → 일봉 라인 숨김(현재봉 이동평균선 페이지는 정상).
6. 슬롯 기간 20→60 변경, 색/두께 변경, 추가/삭제 동작.

- [ ] **Step 4: 최종 커밋(있으면)** — 검증 중 수정이 생기면 커밋. 없으면 skip.

---

## Self-Review (작성자 체크리스트 — 실행 시 이미 반영됨)

- **Spec coverage**: projector(§Design 1)=T2, overlay(2)=T5, Config(3)=T4, persistence(4)=T3, store(5)=T3, IndicatorPanel(6)=T6, LiveChartRoot(7)=T7, selectSource(8)=T1. lookback 클램프 고정=T5 코드. 분봉 게이트=T5. ✓ 전 항목 태스크 존재.
- **Type consistency**: `computeDailyMaByDate(daily, period, source, todayDate, todayLiveClose)` 시그니처가 T2 정의 = T5 호출 일치. `dailyMovingAverages`/`setDailyMovingAverage`/`addDailyMovingAverage`/`removeDailyMovingAverage`/`setDailyMovingAverageEnabled`/`setDailyMovingAverageHidden` 명칭이 T3 정의 = T4/T5/T6 사용 일치. `DEFAULT_DAILY_MAS` T3 export = T3/T4 test 사용. ✓
- **Placeholder scan**: 모든 스텝에 실제 코드·명령·기대출력. ✗ 없음.
- **커밋 green**: T3가 타입 깨짐 회피 위해 persistence+store 묶음. ✓
