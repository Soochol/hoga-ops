# 호가 3종 지표 「지표」 모달 편입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live의 호가 3종(총잔량·호가비·체결강도)을 「지표」 모달(`IndicatorPanel`)의 사이드 메뉴 항목으로 편입하고(항목별 on/off 토글 + Config 디테일), 동작설정(급증 마커·문턱, 호가비 극단값 필터, 체결강도 누적선)을 ⚙️ 설정 모달에서 지표 모달로 이동한다.

**Architecture:** 마스터 on/off 토글 3개는 `volumeEnabled` 선례 그대로 `livePage` store에 추가하고 `paneSpecsForTimeframe`에서 pane을 게이트한다(분봉/일봉 calendar gate와 AND 합성, 기본 ON). 동작설정의 **상태는 `chartPrefs`에 그대로 두고 렌더 위치만** ⚙️ 설정 모달→지표 모달의 새 Config 컴포넌트로 옮긴다(`ToggleRow`/`NumericPrefRow` 재사용 → projector 무변경). ⚙️ 설정 모달에서의 제거는 `chartPrefs`의 `category`를 `'indicator-modal'`로 재분류하면 기존 navIds 필터가 자동으로 빈 카테고리를 숨겨 달성된다.

**Tech Stack:** React + TypeScript, Zustand(store), lightweight-charts v5(pane), vitest + @testing-library/react(test), Tailwind 토큰 클래스.

**Spec:** `docs/superpowers/specs/2026-06-13-hoga-indicators-in-indicator-panel-design.md`

---

## 사전 준비 (한 번)

- [ ] **fresh 워크트리 의존성 설치**

이 워크트리는 `node_modules`가 비어 있다(CLAUDE.md). 테스트/빌드 전에 한 번:

```bash
cd frontend && npm install
```

테스트 실행 명령은 본 플랜 전반에서: `npx vitest run <path>` (워킹디렉터리 `frontend`). vitest 설정은 `vite.config.ts`에 인라인.

---

## File Structure

**수정:**
- `frontend/src/state/liveIndicatorsPersistence.ts` — `PersistedIndicators`에 3 토글 필드 + `mergeLiveIndicatorPrefs` 기본값(ON) + `build()` 시그니처.
- `frontend/src/state/livePage.ts` — `PersistedIndicators` 타입(로컬 미러)·`Store` setter 시그니처·`snapshotIndicators`·setter 구현 3개.
- `frontend/src/live/paneSpecsForTimeframe.ts` — `PaneToggles`에 3 필드 + 분봉 분기 filter + 참조 안정화 memo 캐시.
- `frontend/src/live/LiveChartRoot.tsx` — 3 토글 구독 + `paneSpecsForTimeframe` 호출 2곳에 전달 + stretch effect deps.
- `frontend/src/state/chartPrefs.ts` — `ChartToggleCategory`에 `'indicator-modal'` 추가/`'indicators'`·`'surge'` 제거, 3 토글 `category` 재분류.
- `frontend/src/live/LiveSettingsSections.tsx` — `CategoryDetail`을 공유 `IndicatorPrefRows`로 치환, `CATEGORY_ORDER`/`LABEL` 정리.
- `frontend/src/live/indicators/IndicatorPanel.tsx` — `CategoryId`·`CATEGORIES`(group 필드)·"호가 지표" 서브헤더·`checkedFor`/`toggleFor`·디테일 분기.

**신규:**
- `frontend/src/live/settings/IndicatorPrefRows.tsx` — 토글 키 배열 → `ToggleRow` + gated `NumericPrefRow` 렌더(공유).
- `frontend/src/live/indicators/QuoteTotalsConfig.tsx` — 총잔량 Config(범례 + 급증 설정).
- `frontend/src/live/indicators/RatioConfig.tsx` — 호가비 Config(범례 + 극단값 필터 설정).
- `frontend/src/live/indicators/FillStrengthConfig.tsx` — 체결강도 Config(범례 + 누적선 설정).

**테스트:**
- `frontend/src/state/liveIndicatorsPersistence.test.ts` — merge 기본/보존(수정).
- `frontend/src/live/paneSpecsForTimeframe.test.ts` — 게이트/calendar/참조(수정).
- `frontend/src/live/settings/IndicatorPrefRows.test.tsx` — 신규.
- `frontend/src/live/indicators/QuoteTotalsConfig.test.tsx`·`RatioConfig.test.tsx`·`FillStrengthConfig.test.tsx` — 신규.
- `frontend/src/live/indicators/IndicatorPanel.test.tsx` — 새 항목·토글·서브헤더(수정).
- `frontend/src/live/LiveSettingsSections.test.tsx` — 이동 항목 부재(수정).

---

## Task 1: livePage 마스터 토글 3개 (persistence + store)

새 호가 토글의 영속/머지/store 배선. `volumeEnabled` 선례를 그대로 복제 — 기본값 **ON**(누락 시 ON → 구버전 사용자 자동표시 보존).

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`

- [ ] **Step 1: merge 실패 테스트 작성**

`frontend/src/state/liveIndicatorsPersistence.test.ts`에 추가(기존 describe 내부 또는 신규 describe). 파일 상단 import에 `mergeLiveIndicatorPrefs`가 이미 있으면 재사용.

```ts
import { describe, it, expect } from 'vitest';
import { mergeLiveIndicatorPrefs } from './liveIndicatorsPersistence';

describe('mergeLiveIndicatorPrefs — 호가 토글', () => {
  it('빈 입력 → 호가 3토글 기본 ON', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.quoteTotalsEnabled).toBe(true);
    expect(m.ratioEnabled).toBe(true);
    expect(m.fillStrengthEnabled).toBe(true);
  });
  it('구버전 store(키 없음) → ON으로 머지', () => {
    const m = mergeLiveIndicatorPrefs({ movingAverages: [], movingAverageEnabled: true });
    expect(m.quoteTotalsEnabled).toBe(true);
    expect(m.ratioEnabled).toBe(true);
    expect(m.fillStrengthEnabled).toBe(true);
  });
  it('명시적 false 보존', () => {
    const m = mergeLiveIndicatorPrefs({ ratioEnabled: false, fillStrengthEnabled: false });
    expect(m.ratioEnabled).toBe(false);
    expect(m.fillStrengthEnabled).toBe(false);
    expect(m.quoteTotalsEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: FAIL — `quoteTotalsEnabled` 등이 `undefined`(타입/런타임 미존재).

- [ ] **Step 3: `PersistedIndicators` 타입 + merge 구현 (liveIndicatorsPersistence.ts)**

`PersistedIndicators` 타입에 3필드 추가(`askPeakLineWidth` 뒤):

```ts
  /** 매도 최대벽 선 두께. 기본 2. */
  askPeakLineWidth: 1 | 2 | 3 | 4;
  /** 총잔량 pane on/off. Default TRUE(기존 자동표시 보존). */
  quoteTotalsEnabled: boolean;
  /** 호가비 pane on/off. Default TRUE. */
  ratioEnabled: boolean;
  /** 체결강도 pane on/off. Default TRUE. */
  fillStrengthEnabled: boolean;
```

`build()` 시그니처·본문에 3필드 추가. 현재:

```ts
  const build = (
    mas: LiveMAConfig[], enabled: boolean, fNet: boolean, iNet: boolean,
    vol: boolean, hidden: boolean,
  ): PersistedIndicators => ({
```

를 다음으로 교체:

```ts
  const build = (
    mas: LiveMAConfig[], enabled: boolean, fNet: boolean, iNet: boolean,
    vol: boolean, hidden: boolean,
    qt: boolean, ratio: boolean, fill: boolean,
  ): PersistedIndicators => ({
    movingAverages: mas,
    movingAverageEnabled: enabled,
    foreignNetEnabled: fNet,
    institutionNetEnabled: iNet,
    volumeEnabled: vol,
    movingAverageHidden: hidden,
    askPeakEnabled: apEnabled,
    askPeakColor: apColor,
    askPeakLineWidth: apWidth,
    quoteTotalsEnabled: qt,
    ratioEnabled: ratio,
    fillStrengthEnabled: fill,
  });
```

기본값(`raw` 없음) 분기 — 현재 `return build(defaults, true, false, false, true, false);` 를:

```ts
  if (!raw || typeof raw !== 'object') return build(defaults, true, false, false, true, false, true, true, true);
```

`obj` 존재 분기 — `vol`/`hidden` 계산 뒤에 3토글 계산 추가:

```ts
  const vol = o.volumeEnabled === false ? false : true;
  const hidden = o.movingAverageHidden === true;
  // 호가 pane 토글: volumeEnabled와 동일 규약 — false 리터럴만 OFF, 나머지(누락 포함) ON.
  const qt = o.quoteTotalsEnabled === false ? false : true;
  const ratio = o.ratioEnabled === false ? false : true;
  const fill = o.fillStrengthEnabled === false ? false : true;
```

그리고 이 분기의 두 `return build(...)` 호출(arr 비배열 / kept 비어있음 / 정상)에 `, qt, ratio, fill`을 append:

```ts
  const arr = o.movingAverages;
  if (!Array.isArray(arr)) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill);
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill);
  return build(kept, enabled, fNet, iNet, vol, hidden, qt, ratio, fill);
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: PASS.

- [ ] **Step 5: livePage.ts store 배선**

(a) 로컬 `PersistedIndicators` 타입(livePage.ts 88–109행)에 3필드 추가(`askPeakLineWidth` 뒤):

```ts
  askPeakLineWidth: 1 | 2 | 3 | 4;
  /** 총잔량 pane on/off. 기본 true. */
  quoteTotalsEnabled: boolean;
  /** 호가비 pane on/off. 기본 true. */
  ratioEnabled: boolean;
  /** 체결강도 pane on/off. 기본 true. */
  fillStrengthEnabled: boolean;
```

(b) `Store` 타입(setter 그룹, `setAskPeakStyle` 뒤)에 3 setter:

```ts
  setAskPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setQuoteTotalsEnabled: (enabled: boolean) => void;
  setRatioEnabled: (enabled: boolean) => void;
  setFillStrengthEnabled: (enabled: boolean) => void;
```

(c) `snapshotIndicators` 반환 객체에 3필드 추가(`askPeakLineWidth` 뒤):

```ts
    askPeakLineWidth: s.askPeakLineWidth,
    quoteTotalsEnabled: s.quoteTotalsEnabled,
    ratioEnabled: s.ratioEnabled,
    fillStrengthEnabled: s.fillStrengthEnabled,
```

(d) setter 구현 3개(`setAskPeakStyle` 구현 뒤, `projectActiveView` 앞):

```ts
  setQuoteTotalsEnabled: (enabled) => {
    set({ quoteTotalsEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setRatioEnabled: (enabled) => {
    set({ ratioEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setFillStrengthEnabled: (enabled) => {
    set({ fillStrengthEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },
```

(store 초기값은 `...readIndicatorsStorage()`가 merge 결과로 채우므로 별도 기본값 불필요.)

- [ ] **Step 6: 타입체크 + 전체 store 테스트**

Run: `npx vitest run src/state/liveIndicatorsPersistence.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS, 타입 에러 없음.
(권위 타입체크는 `tsconfig.app.json` — 메모리 `hoga-ops-frontend-tscb-phantom-errors` 참조. 루트 tsconfig는 인자 없이 아무것도 안 봄.)

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.ts
git commit -F <message-file>
```
메시지: `feat(live): 호가 3종 pane 마스터 토글 store 배선 (기본 ON)`
(커밋 훅 오탐 회피: `&&`-체이닝/heredoc 금지 — 메시지 파일 + 단독 `git commit -F`. 메모리 `hoga-ops-block-no-verify-commit-hook`.)

---

## Task 2: paneSpecsForTimeframe — 호가 pane 게이팅

분봉에서 off인 호가 pane을 제거. calendar(D/W/M) 분기는 무변경(거기엔 애초에 호가 pane 없음 → gate 합성 자동). 참조 안정화는 memo 캐시.

**Files:**
- Modify: `frontend/src/live/paneSpecsForTimeframe.ts`
- Test: `frontend/src/live/paneSpecsForTimeframe.test.ts`

- [ ] **Step 1: 게이팅 테스트 작성**

`frontend/src/live/paneSpecsForTimeframe.test.ts`에 추가:

```ts
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';

describe('paneSpecsForTimeframe — 호가 토글', () => {
  const names = (tf: any, t: any) => paneSpecsForTimeframe(tf, t).map((s) => s.name);

  it('기본(토글 ON) 분봉 → 5 pane 유지', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false });
    expect(n).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength']);
  });
  it('quoteTotalsEnabled=false → 총잔량 pane 제거', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, quoteTotalsEnabled: false });
    expect(n).not.toContain('quote-totals');
    expect(n).toContain('ratio');
    expect(n).toContain('fill-strength');
  });
  it('ratio·fill 동시 off → 둘 다 제거', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, ratioEnabled: false, fillStrengthEnabled: false });
    expect(n).toEqual(['candle', 'volume', 'quote-totals']);
  });
  it('calendar(D) → 호가 토글 무관(애초에 없음)', () => {
    const n = names('D', { foreignNet: false, institutionNet: false, quoteTotalsEnabled: true });
    expect(n).toEqual(['candle', 'volume']);
  });
  it('동일 토글 2회 호출 → 동일 배열 참조(참조 안정)', () => {
    const t = { foreignNet: false, institutionNet: false, ratioEnabled: false };
    expect(paneSpecsForTimeframe('1m', t)).toBe(paneSpecsForTimeframe('1m', t));
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/live/paneSpecsForTimeframe.test.ts`
Expected: FAIL — off 토글이 무시되어 pane이 그대로 5개(그리고 참조 안정 테스트 실패).

- [ ] **Step 3: PaneToggles 확장 + filter + memo 캐시 구현**

`PaneToggles` 타입에 3필드 추가:

```ts
export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  volumeEnabled?: boolean;
  /** 총잔량 pane mount. 누락/true → mount; false → 제거. */
  quoteTotalsEnabled?: boolean;
  /** 호가비 pane mount. 누락/true → mount; false → 제거. */
  ratioEnabled?: boolean;
  /** 체결강도 pane mount. 누락/true → mount; false → 제거. */
  fillStrengthEnabled?: boolean;
};
```

분봉 분기를 memo 캐시 기반으로 교체. 현재:

```ts
  const volumeOn = toggles.volumeEnabled !== false; // default true
  if (!isCalendarTimeframe(tf)) {
    return volumeOn ? PANE_SPECS : PANE_SPECS_NO_VOLUME;
  }
```

를 다음으로 교체(파일 하단 또는 함수 위에 캐시 + 헬퍼 추가):

```ts
// 분봉 pane 조합 캐시 — 동일 토글 조합은 동일(frozen) 배열을 반환해
// RangeSeriesPane의 spec-keyed reconciliation이 churn하지 않게 한다.
// (반환 배열은 어떤 dep 배열에도 안 들어가 load-bearing은 아니나, 기존
//  frozen 관행과 일관성·미래 방어 목적. 설계 §2.)
const HOGA_PANE_NAMES = new Set(['quote-totals', 'ratio', 'fill-strength']);
const minutePaneCache = new Map<string, readonly BoundPaneSpec[]>();

function minutePanes(
  volumeOn: boolean, qtOn: boolean, ratioOn: boolean, fillOn: boolean,
): readonly BoundPaneSpec[] {
  const key = `${volumeOn ? 1 : 0}${qtOn ? 1 : 0}${ratioOn ? 1 : 0}${fillOn ? 1 : 0}`;
  const cached = minutePaneCache.get(key);
  if (cached) return cached;
  const drop = new Set<string>();
  if (!volumeOn) drop.add('volume');
  if (!qtOn) drop.add('quote-totals');
  if (!ratioOn) drop.add('ratio');
  if (!fillOn) drop.add('fill-strength');
  const built = Object.freeze(
    PANE_SPECS.filter((s) => !drop.has(s.name)),
  ) as readonly BoundPaneSpec[];
  minutePaneCache.set(key, built);
  return built;
}
```

그리고 분봉 분기:

```ts
  const volumeOn = toggles.volumeEnabled !== false; // default true
  if (!isCalendarTimeframe(tf)) {
    return minutePanes(
      volumeOn,
      toggles.quoteTotalsEnabled !== false,
      toggles.ratioEnabled !== false,
      toggles.fillStrengthEnabled !== false,
    );
  }
```

(calendar 분기는 그대로 — 호가 pane은 `CALENDAR_PANE_SPECS`에 애초에 없음. `HOGA_PANE_NAMES` 상수는 가독성 보조이며 미사용 시 제거 가능하나, 향후 calendar gate 검증 테스트에서 재사용하므로 유지.)

> 참고: 기존 `PANE_SPECS_NO_VOLUME` frozen 상수는 더 이상 분봉 분기에서 직접 쓰이지 않지만 `CALENDAR_PANE_SPECS_NO_VOLUME`와 대칭이고 다른 import가 있을 수 있으니 **삭제하지 말 것**. (grep으로 잔여 참조 확인: `grep -rn "PANE_SPECS_NO_VOLUME" src/`)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/live/paneSpecsForTimeframe.test.ts`
Expected: PASS(참조 안정 포함).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/paneSpecsForTimeframe.ts frontend/src/live/paneSpecsForTimeframe.test.ts
git commit -F <message-file>
```
메시지: `feat(live): paneSpecsForTimeframe 호가 pane 토글 게이팅 (calendar gate와 합성)`

---

## Task 3: LiveChartRoot — 토글 배선

store의 3 토글을 구독해 `paneSpecsForTimeframe` 호출 2곳(stretch effect + render)에 전달하고 effect deps에 추가.

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: 토글 구독 추가**

`const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);`(615행 부근) 바로 아래에:

```ts
  const quoteTotalsEnabled = useLivePageStore((s) => s.quoteTotalsEnabled);
  const ratioEnabled = useLivePageStore((s) => s.ratioEnabled);
  const fillStrengthEnabled = useLivePageStore((s) => s.fillStrengthEnabled);
```

- [ ] **Step 2: stretch effect 호출부 + deps**

stretch effect(619행 부근)의 `paneSpecsForTimeframe(timeframe, { ... volumeEnabled, })`에 3필드 추가:

```ts
    const specs = paneSpecsForTimeframe(timeframe, {
      foreignNet: foreignNetEnabled,
      institutionNet: institutionNetEnabled,
      volumeEnabled,
      quoteTotalsEnabled,
      ratioEnabled,
      fillStrengthEnabled,
    });
```

그리고 같은 effect의 deps 배열(648행 부근)에 3토글 추가:

```ts
  }, [chart, cb, timeframe, foreignNetEnabled, institutionNetEnabled, volumeEnabled, quoteTotalsEnabled, ratioEnabled, fillStrengthEnabled]);
```

- [ ] **Step 3: render 호출부**

render의 `paneSpecsForTimeframe(timeframe, { ... volumeEnabled, }).map(...)`(720행 부근)에도 동일 3필드 추가:

```ts
          {paneSpecsForTimeframe(timeframe, {
            foreignNet: foreignNetEnabled,
            institutionNet: institutionNetEnabled,
            volumeEnabled,
            quoteTotalsEnabled,
            ratioEnabled,
            fillStrengthEnabled,
          }).map((spec, i) => (
```

- [ ] **Step 4: 타입체크 + 기존 LiveChartRoot 테스트**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS(기존 테스트 그린 — 기본 ON이라 동작 불변).

- [ ] **Step 5: 토글→pane 통합 테스트(가능 시)**

`LiveChartRoot.test.tsx`에 store 토글로 pane 마운트 변화를 검증하는 테스트가 가능한지 확인. lightweight-charts mock 구조상 pane 수 단언이 어려우면 **건너뛰고** Task 2의 단위 테스트 + Task 9 수동검증으로 커버(이 경우 본 step 체크만 하고 코드 추가 없음). 가능하면:

```ts
it('quoteTotalsEnabled=false → quote-totals RangeSeriesPane 미마운트', () => {
  useLivePageStore.setState({ quoteTotalsEnabled: false });
  // ... 기존 LiveChartRoot 렌더 헬퍼 사용, data-pane-name='quote-totals' 부재 단언
});
```
(RangeSeriesPane이 식별 가능한 testid/data-attr를 노출하지 않으면 생략.)

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -F <message-file>
```
메시지: `feat(live): LiveChartRoot에 호가 pane 토글 배선`

---

## Task 4: IndicatorPrefRows 공유 컴포넌트

「설정」 모달과 「지표」 모달 Config가 **동일한** 토글+숫자 행을 렌더하도록 `LiveSettingsSections.CategoryDetail`의 렌더 로직을 키-배열 입력 컴포넌트로 추출.

**Files:**
- Create: `frontend/src/live/settings/IndicatorPrefRows.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/live/settings/IndicatorPrefRows.test.tsx`

- [ ] **Step 1: 컴포넌트 테스트 작성**

`frontend/src/live/settings/IndicatorPrefRows.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import IndicatorPrefRows from './IndicatorPrefRows';
import { useChartPrefsStore } from '../../state/chartPrefs';

describe('IndicatorPrefRows', () => {
  afterEach(cleanup);

  it('주어진 토글 키의 ToggleRow를 렌더', () => {
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });

  it('enabledBy로 묶인 numeric을 함께 렌더', () => {
    useChartPrefsStore.setState({ surgeMarkerEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    // 급증 문턱 numeric 3개 중 하나(근접 문턱)의 라벨 일부 확인
    expect(screen.getByText(/급증 근접 문턱/)).toBeTruthy();
  });

  it('토글 클릭 → chartPrefs 갱신', () => {
    useChartPrefsStore.setState({ ratioOutlierFilterEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled']} />);
    fireEvent.click(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled'));
    expect(useChartPrefsStore.getState().ratioOutlierFilterEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/live/settings/IndicatorPrefRows.test.tsx`
Expected: FAIL — 모듈 부재.

- [ ] **Step 3: IndicatorPrefRows 구현**

`frontend/src/live/settings/IndicatorPrefRows.tsx`:

```tsx
import { Fragment } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  type ChartToggleKey,
} from '../../state/chartPrefs';
import ToggleRow from './ToggleRow';
import NumericPrefRow from './NumericPrefRow';

/**
 * 주어진 토글 키 목록을 `ToggleRow` + (enabledBy로 묶인) `NumericPrefRow`로
 * 렌더한다. 「설정」 모달(CategoryDetail)과 「지표」 모달의 호가 Config가 동일한
 * 행 디자인을 공유하도록 추출한 단일 소스. 키 순서가 아니라 CHART_TOGGLES
 * 등록 순서를 따른다(기존 CategoryDetail 동작 유지).
 */
export default function IndicatorPrefRows({
  toggleKeys,
}: {
  toggleKeys: readonly ChartToggleKey[];
}) {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);
  const keySet = new Set<string>(toggleKeys);
  const toggles = CHART_TOGGLES.filter((t) => keySet.has(t.key));
  return (
    <>
      {toggles.map((toggle, idx) => {
        const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === toggle.key);
        return (
          <Fragment key={toggle.key}>
            {idx > 0 && <div className="border-b border-border my-2" />}
            <ToggleRow
              label={toggle.label}
              description={toggle.description}
              checked={prefs[toggle.key]}
              onToggle={() => setToggle(toggle.key, !prefs[toggle.key])}
              testId={`settings-toggle-${toggle.key}`}
            />
            {gatedNumerics.length > 0 && (
              <div className="ml-4">
                {gatedNumerics.map((def) => (
                  <NumericPrefRow key={def.key} def={def} />
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/live/settings/IndicatorPrefRows.test.tsx`
Expected: PASS.

- [ ] **Step 5: LiveSettingsSections.CategoryDetail 치환**

`LiveSettingsSections.tsx`에서 `CategoryDetail` 함수를 다음으로 교체(import에 `IndicatorPrefRows` 추가, 더 이상 안 쓰는 `Fragment`/`CHART_NUMERIC_PREFS`/`ToggleRow`/`NumericPrefRow` import는 `DataSourceDetail`·다른 사용처 확인 후 정리):

```tsx
function CategoryDetail({ category }: { category: ChartToggleCategory }) {
  const keys = CHART_TOGGLES
    .filter((t) => categoryOf(t) === category)
    .map((t) => t.key);
  return <IndicatorPrefRows toggleKeys={keys} />;
}
```

import 블록 상단 정리(예시 — 실제 잔여 사용 확인 후):

```tsx
import { useState } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  categoryOf,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';
```

(`useChartPrefsStore`는 `DataSourceDetail`/다른 곳에서 안 쓰면 제거 가능 — `npx eslint` no-unused-vars로 확인.)

- [ ] **Step 6: 기존 설정 모달 테스트(현 상태) 통과 확인**

Run: `npx vitest run src/live/LiveSettingsSections.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS — 아직 카테고리 재분류 전이므로 보조지표·총잔량 급증·차트 nav가 그대로 보이고, IndicatorPrefRows가 동일 testId를 렌더하므로 기존 단언 유지.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/live/settings/IndicatorPrefRows.tsx frontend/src/live/settings/IndicatorPrefRows.test.tsx frontend/src/live/LiveSettingsSections.tsx
git commit -F <message-file>
```
메시지: `refactor(live): 토글+숫자 행 렌더를 IndicatorPrefRows로 추출(설정·지표 모달 공유)`

---

## Task 5: 호가 Config 컴포넌트 3개

각 Config = 제목 + 설명 + `SignColorLegend`(색→의미) + `IndicatorPrefRows`(해당 동작설정). 색 규약: 매수=빨강(`--price-up`), 매도=파랑(`--price-down`) — projector와 일치(quoteTotals: bid=red/ask=blue; ratio: bid>ask=매수우위=red/ask>bid=매도우위=blue; fillStrength: buy=red/sell=blue).

**Files:**
- Create: `frontend/src/live/indicators/QuoteTotalsConfig.tsx`
- Create: `frontend/src/live/indicators/RatioConfig.tsx`
- Create: `frontend/src/live/indicators/FillStrengthConfig.tsx`
- Test: 동명 `.test.tsx` 3개

- [ ] **Step 1: QuoteTotalsConfig 테스트 작성**

`frontend/src/live/indicators/QuoteTotalsConfig.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';

describe('QuoteTotalsConfig', () => {
  afterEach(cleanup);
  it('제목·범례·급증 마커 토글을 렌더', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByText('총잔량')).toBeTruthy();
    expect(screen.getByText(/매수 총잔량 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 총잔량 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/live/indicators/QuoteTotalsConfig.test.tsx`
Expected: FAIL — 모듈 부재.

- [ ] **Step 3: QuoteTotalsConfig 구현**

`frontend/src/live/indicators/QuoteTotalsConfig.tsx`:

```tsx
import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 총잔량 상세 — 매수/매도 호가 총잔량 라인 범례 + 급증 마커 설정.
 *  동작설정(급증 마커·문턱)은 chartPrefs에 저장(렌더 위치만 ⚙️→지표 모달 이동). */
export default function QuoteTotalsConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        총잔량 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        해당 분봉 시점의 매수·매도 호가 총잔량을 라인으로 표시합니다.
      </p>
      <SignColorLegend up="매수 총잔량" down="매도 총잔량" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/live/indicators/QuoteTotalsConfig.test.tsx`
Expected: PASS.

- [ ] **Step 5: RatioConfig 테스트 + 구현**

테스트 `frontend/src/live/indicators/RatioConfig.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RatioConfig from './RatioConfig';

describe('RatioConfig', () => {
  afterEach(cleanup);
  it('제목·범례·극단값 필터 토글을 렌더', () => {
    render(<RatioConfig />);
    expect(screen.getByText('호가비')).toBeTruthy();
    expect(screen.getByText(/매수 우위 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 우위 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });
});
```

구현 `frontend/src/live/indicators/RatioConfig.tsx`:

```tsx
import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 호가비 상세 — 매수/매도 우위 범례 + 극단값 필터 설정.
 *  값이 양수면 매도 우위(파랑), 음수면 매수 우위(빨강)이나 범례는 색→의미로 표기. */
export default function RatioConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        호가비 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        매수·매도 호가 총잔량의 불균형(우위)을 0 기준선 위아래로 표시합니다.
      </p>
      <SignColorLegend up="매수 우위" down="매도 우위" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled']} />
    </div>
  );
}
```

Run: `npx vitest run src/live/indicators/RatioConfig.test.tsx`
Expected: PASS.

- [ ] **Step 6: FillStrengthConfig 테스트 + 구현**

테스트 `frontend/src/live/indicators/FillStrengthConfig.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import FillStrengthConfig from './FillStrengthConfig';

describe('FillStrengthConfig', () => {
  afterEach(cleanup);
  it('제목·범례·누적선 토글을 렌더', () => {
    render(<FillStrengthConfig />);
    expect(screen.getByText('체결강도')).toBeTruthy();
    expect(screen.getByText(/매수 체결 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 체결 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-fillStrengthCumulative')).toBeTruthy();
  });
});
```

구현 `frontend/src/live/indicators/FillStrengthConfig.tsx`:

```tsx
import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 체결강도 상세 — 매수/매도 체결량 범례 + 당일 누적선 설정. */
export default function FillStrengthConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        체결강도 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        해당 분봉 동안 체결된 매수·매도 물량을 막대로 표시합니다.
      </p>
      <SignColorLegend up="매수 체결" down="매도 체결" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['fillStrengthCumulative']} />
    </div>
  );
}
```

Run: `npx vitest run src/live/indicators/FillStrengthConfig.test.tsx`
Expected: PASS.

> 색 검증 메모: `fillStrength` projector의 buy/sell 색 토큰이 `--price-up`/`--price-down`이 맞는지 구현 중 한 번 확인(`grep -n "buy\|sell" src/chart/projectors/fillStrength.ts` 상단의 `resolveTokens` 스펙). KRX 컨벤션상 buy=red가 표준이며 quoteTotals/ratio와 일관. 다르면 라벨만 조정.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/live/indicators/QuoteTotalsConfig.tsx frontend/src/live/indicators/QuoteTotalsConfig.test.tsx frontend/src/live/indicators/RatioConfig.tsx frontend/src/live/indicators/RatioConfig.test.tsx frontend/src/live/indicators/FillStrengthConfig.tsx frontend/src/live/indicators/FillStrengthConfig.test.tsx
git commit -F <message-file>
```
메시지: `feat(live): 총잔량·호가비·체결강도 Config 컴포넌트(범례+동작설정)`

---

## Task 6: IndicatorPanel — 사이드 항목 3개 + "호가 지표" 서브헤더

「지표」 모달 네비에 활성 항목 3개 추가, group 기반 서브헤더, 토글/디테일 배선. 이 시점에 호가 동작설정이 지표 모달에서 노출(설정 모달에도 아직 남아 있어 일시 중복 — Task 7에서 제거).

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

- [ ] **Step 1: 테스트 작성/수정**

`IndicatorPanel.test.tsx`의 첫 테스트(`lists ... category checkboxes`)를 갱신하고 신규 테스트 추가:

```tsx
it('활성 8 + 비활성 6 = 14 체크박스, 호가 3종 활성', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes).toHaveLength(14);
  expect(checkboxes.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(6);
  for (const name of ['총잔량', '호가비', '체결강도']) {
    const cb = screen.getByRole('checkbox', { name }) as HTMLButtonElement;
    expect(cb.disabled).toBe(false);
    expect(cb.getAttribute('aria-checked')).toBe('true'); // 기본 ON
  }
});

it('"호가 지표" 서브헤더를 렌더', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  expect(screen.getByText('호가 지표')).toBeTruthy();
  expect(screen.getByText('상단 지표')).toBeTruthy();
});

it('총잔량 토글 클릭 → quoteTotalsEnabled 반전', () => {
  useLivePageStore.setState({ quoteTotalsEnabled: true });
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '총잔량' }));
  expect(useLivePageStore.getState().quoteTotalsEnabled).toBe(false);
});

it('호가비 라벨 클릭 → 우측에 RatioConfig(극단값 필터 토글) 노출', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '호가비' }));
  expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
});
```

(기존 `lists 10 category checkboxes ...` 테스트는 위 첫 테스트로 대체 — 삭제.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/live/indicators/IndicatorPanel.test.tsx`
Expected: FAIL — 호가 항목/서브헤더/토글 미존재.

- [ ] **Step 3: IndicatorPanel 구현**

(a) `CategoryId` 유니온에 3개 추가:

```ts
type CategoryId =
  | 'moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'ask-peak'
  | 'quote-totals'
  | 'ratio'
  | 'fill-strength'
  | 'ichimoku'
  | 'bollinger'
  | 'supertrend'
  | 'volume-profile'
  | 'envelope'
  | 'williams';

type GroupId = 'top' | 'hoga';
const GROUP_LABEL: Record<GroupId, string> = { top: '상단 지표', hoga: '호가 지표' };
```

(b) `CATEGORIES`에 `group` 필드 추가 + 호가 3항목(비활성군 뒤). 기존 항목에 `group: 'top'`:

```ts
const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; active: boolean; group: GroupId }> = [
  { id: 'moving-average',  label: '이동평균선',       active: true,  group: 'top'  },
  { id: 'volume',          label: '거래량',           active: true,  group: 'top'  },
  { id: 'foreign-net',     label: '외국인 순매수량',  active: true,  group: 'top'  },
  { id: 'institution-net', label: '기관 순매수량',    active: true,  group: 'top'  },
  { id: 'ask-peak',        label: '당일 매도 최대벽', active: true,  group: 'top'  },
  { id: 'ichimoku',       label: '일목균형표',  active: false, group: 'top' },
  { id: 'bollinger',      label: '볼린저밴드',  active: false, group: 'top' },
  { id: 'supertrend',     label: '슈퍼트렌드',  active: false, group: 'top' },
  { id: 'volume-profile', label: '매물대분석',  active: false, group: 'top' },
  { id: 'envelope',       label: '엔벨로프',    active: false, group: 'top' },
  { id: 'williams',       label: '윌리엄스 프랙탈', active: false, group: 'top' },
  { id: 'quote-totals',  label: '총잔량',   active: true, group: 'hoga' },
  { id: 'ratio',         label: '호가비',   active: true, group: 'hoga' },
  { id: 'fill-strength', label: '체결강도', active: true, group: 'hoga' },
];
```

(c) store 구독 추가(컴포넌트 본문, `askPeakEnabled` 구독 뒤):

```ts
  const quoteTotals = useLivePageStore((s) => s.quoteTotalsEnabled);
  const setQuoteTotals = useLivePageStore((s) => s.setQuoteTotalsEnabled);
  const ratio = useLivePageStore((s) => s.ratioEnabled);
  const setRatio = useLivePageStore((s) => s.setRatioEnabled);
  const fillStrength = useLivePageStore((s) => s.fillStrengthEnabled);
  const setFillStrength = useLivePageStore((s) => s.setFillStrengthEnabled);
```

(d) `checkedFor`/`toggleFor` switch에 3 case:

```ts
      case 'ask-peak': return askPeakEnabled;
      case 'quote-totals': return quoteTotals;
      case 'ratio': return ratio;
      case 'fill-strength': return fillStrength;
```
```ts
      case 'ask-peak': return () => setAskPeakEnabled(!askPeakEnabled);
      case 'quote-totals': return () => setQuoteTotals(!quoteTotals);
      case 'ratio': return () => setRatio(!ratio);
      case 'fill-strength': return () => setFillStrength(!fillStrength);
```

(e) import 추가(상단):

```ts
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import FillStrengthConfig from './FillStrengthConfig';
import { Fragment } from 'react';
```
(`useState`는 이미 `react`에서 import 중 — `Fragment`를 같은 줄에 합쳐도 됨: `import { useState, Fragment } from 'react';`)

(f) 네비 렌더 — 하드코딩 "상단 지표" 헤더 제거하고 group 경계마다 서브헤더 렌더. 현재:

```tsx
        <nav className="w-[200px] py-2 border-r border-border" aria-label="지표 카테고리">
          <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">상단 지표</div>
          {CATEGORIES.map((c) => {
```

를:

```tsx
        <nav className="w-[200px] py-2 border-r border-border" aria-label="지표 카테고리">
          {CATEGORIES.map((c, i) => {
            const showHeader = i === 0 || CATEGORIES[i - 1].group !== c.group;
```

그리고 각 row의 최상위 `<div key={c.id} ...>`를 `<Fragment key={c.id}>`로 감싸 서브헤더를 앞에 렌더. 즉 map 콜백 return을:

```tsx
            return (
              <Fragment key={c.id}>
                {showHeader && (
                  <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2 pt-2">
                    {GROUP_LABEL[c.group]}
                  </div>
                )}
                <div
                  className={
                    c.active
                      ? `${rowBase} ${isSelected ? 'bg-bg-input' : 'hover:bg-bg-input'}`
                      : `${rowBase} opacity-50`
                  }
                >
                  {/* ...기존 라벨 버튼 + 체크박스 버튼 그대로... */}
                </div>
              </Fragment>
            );
```

(기존 `<div key={c.id} ...>`의 `key`는 `Fragment`로 이동했으므로 내부 `<div>`에서는 제거.)

(g) 우측 디테일 분기에 3줄 추가(`ask-peak` 뒤):

```tsx
          {selected === 'ask-peak' && <AskPeakConfig />}
          {selected === 'quote-totals' && <QuoteTotalsConfig />}
          {selected === 'ratio' && <RatioConfig />}
          {selected === 'fill-strength' && <FillStrengthConfig />}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/live/indicators/IndicatorPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -F <message-file>
```
메시지: `feat(live): 「지표」 모달에 호가 3종 항목 + "호가 지표" 서브헤더`

---

## Task 7: chartPrefs 재분류 — ⚙️ 설정 모달에서 제거

이동 대상 3토글의 `category`를 `'indicator-modal'`로 옮겨 설정 모달 navIds 필터가 자동으로 보조지표·총잔량 급증 카테고리를 숨기게 한다(이미 Config가 지표 모달에서 제공 → 중복 해소·고아 없음).

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

- [ ] **Step 1: 설정 모달 부재 테스트 작성/수정**

`LiveSettingsSections.test.tsx`를 갱신 — 기존 4개 테스트를 다음으로 교체:

```tsx
it('카테고리 nav를 렌더 (차트·데이터소스만 — 보조지표·총잔량 급증은 지표 모달로 이동)', () => {
  render(<LiveSettingsSections />);
  expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
  expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
  expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
  expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
});

it('기본 선택은 차트 — 동시호가 마스킹 토글이 상세에 보인다', () => {
  render(<LiveSettingsSections />);
  expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
});

it('이동된 토글은 설정 모달에 없다 (급증·누적·극단값필터)', () => {
  render(<LiveSettingsSections />);
  expect(screen.queryByTestId('settings-toggle-surgeMarkerEnabled')).toBeNull();
  expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
  expect(screen.queryByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeNull();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/live/LiveSettingsSections.test.tsx`
Expected: FAIL — 아직 surge/indicators nav와 토글이 보임.

- [ ] **Step 3: chartPrefs 카테고리 재분류**

`ChartToggleCategory` 유니온 교체:

```ts
/** UI surface a toggle belongs to. 'indicator-modal'은 「지표」 모달의
 *  호가 Config로 이동했음을 뜻하며 ⚙️ 설정 모달에는 렌더되지 않는다
 *  (LiveSettingsSections의 CATEGORY_ORDER가 포함하지 않음). Unset → 'chart'. */
export type ChartToggleCategory = 'chart' | 'indicator-modal';
```

3토글 `category` 설정:
- `fillStrengthCumulative` 항목: `category: 'indicators'` → `category: 'indicator-modal'`
- `surgeMarkerEnabled` 항목: `category: 'surge'` → `category: 'indicator-modal'`
- `ratioOutlierFilterEnabled` 항목: `category` 필드 신규 추가 → `category: 'indicator-modal'`. 예:

```ts
  {
    key: 'ratioOutlierFilterEnabled',
    label: '호가비 극단값 필터',
    description:
      '한쪽 호가가 임계 배수를 넘으면 그 시점의 호가비를 0 으로 마스킹합니다. (오토스케일을 잡아먹는 스파이크 제거)',
    default: true,
    category: 'indicator-modal',
  },
```

`categoryOf`의 주석에서 'indicators'/'surge' 언급을 'indicator-modal'로 갱신(동작 불변, 문서성).

- [ ] **Step 4: LiveSettingsSections CATEGORY_ORDER/LABEL 정리**

`CATEGORY_ORDER`를 `['chart']`로, `LABEL`에서 indicators/surge 제거 + indicator-modal 추가(NavId 타입상 필요):

```ts
const CATEGORY_ORDER: ChartToggleCategory[] = ['chart'];
const LABEL: Record<NavId, string> = {
  chart: '차트',
  'indicator-modal': '지표',
  'data-source': '데이터소스',
};
```

(`'indicator-modal'`은 `CATEGORY_ORDER`에 없어 nav에 절대 안 뜨지만 `Record<NavId>` 완전성 때문에 LABEL 엔트리 필요. navIds = `CATEGORY_ORDER.filter(...) + 'data-source'` = `['chart','data-source']`.)

- [ ] **Step 5: 통과 확인 + 지표 모달 회귀**

Run: `npx vitest run src/live/LiveSettingsSections.test.tsx src/live/indicators/IndicatorPanel.test.tsx src/live/settings/IndicatorPrefRows.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS — 설정 모달은 차트·데이터소스만; 지표 모달 Config는 여전히 동작설정 렌더(IndicatorPrefRows는 chartPrefs 키로 직접 렌더, 카테고리 무관).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/live/LiveSettingsSections.tsx frontend/src/live/LiveSettingsSections.test.tsx
git commit -F <message-file>
```
메시지: `feat(live): 급증·누적·극단값필터 설정을 ⚙️→「지표」 모달로 이동(설정 모달서 제거)`

---

## Task 8: 통합 검증 — 빌드·전체 테스트·수동 확인

**Files:** (없음 — 검증/문서)

- [ ] **Step 1: 전체 프론트엔드 테스트**

Run: `npx vitest run`
Expected: 전부 PASS(기존 + 신규). 실패 시 해당 Task로 복귀.

- [ ] **Step 2: 빌드(권위 타입체크 포함)**

Run: `npm run build`
Expected: `tsc -b && vite build` 그린. (메모리: 권위 타입체크는 `tsconfig.app.json`.)

- [ ] **Step 3: lint**

Run: `npx eslint src/live/indicators src/live/settings src/live/LiveSettingsSections.tsx src/state/livePage.ts src/state/liveIndicatorsPersistence.ts src/state/chartPrefs.ts src/live/paneSpecsForTimeframe.ts src/live/LiveChartRoot.tsx`
Expected: no-unused-vars 등 0(특히 Task 4에서 정리한 import).

- [ ] **Step 4: 수동 검증(dev 서버, /live 분봉)**

CLAUDE.md의 dev 서버 2개 기동(backend uvicorn + frontend vite) 또는 사용자에게 `! npm run dev` 안내. `/browse`로 헤드리스 확인 가능 항목:
1. 「지표」 모달 → "호가 지표" 서브헤더 + 총잔량/호가비/체결강도 3항목, 각 토글 on/off.
2. 토글 OFF → 해당 pane mount 해제(빈 띠 아님), 새로고침 후 상태 유지(localStorage).
3. 각 Config 디테일에 급증 마커/극단값 필터/누적선 설정 노출 + 변경이 차트 반영.
4. ⚙️ 설정 모달 → 차트·데이터소스만(보조지표·총잔량 급증 나브 부재).
5. D/W/M 전환 → 호가 pane·토글 영향 없음.

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors
$B snapshot -i
```

⚠️ 차트 시각 반영(pane 렌더·마커)은 헤드리스로 단정 어려움 → **사용자 /live 육안 검증 권장**(호가지표 검증 관행).

- [ ] **Step 5: 최종 커밋(필요 시 문서/스펙 status 갱신)**

스펙 status를 `Approved`→`Implemented`로 갱신하거나 변경 없으면 생략. 빌드/테스트 산출물만이라면 커밋 불필요.

---

## Self-Review (작성자 체크리스트)

**1. Spec coverage:**
- 사이드 항목 3개 + 토글 → Task 1(store)·6(UI). ✅
- pane mount/unmount → Task 2·3. ✅
- Config 디테일 동작설정(렌더 위치 이동) → Task 4(공유)·5(Config). ✅
- ⚙️ 설정서 제거(보조지표·총잔량 급증 카테고리 소멸) → Task 7. ✅
- 디자인 일치(IndicatorPrefRows 공유, SignColorLegend, 기존 row 마크업) → Task 4·5·6. ✅
- calendar gate 보존·기본 ON 자동표시 보존 → Task 1(merge ON)·2(calendar 무변경) + 회귀 테스트. ✅
- auctionWindowMask 차트 유지(Non-Goal) → Task 7에서 미이동(category 'chart' 유지). ✅

**2. Placeholder scan:** 모든 코드 스텝에 실제 코드/명령/기대출력 명시. Task 3 Step 5만 조건부(테스트 인프라 한계 시 생략 명시) — 플레이스홀더 아님(대안 경로 명시).

**3. Type consistency:** setter 명명 `setQuoteTotalsEnabled`/`setRatioEnabled`/`setFillStrengthEnabled`, 필드 `quoteTotalsEnabled`/`ratioEnabled`/`fillStrengthEnabled`, `PaneToggles` 동명, spec name `'quote-totals'`/`'ratio'`/`'fill-strength'`, chartPrefs 키 `surgeMarkerEnabled`/`ratioOutlierFilterEnabled`/`fillStrengthCumulative` — 전 Task 일관. `ChartToggleCategory='chart'|'indicator-modal'` 일관.
