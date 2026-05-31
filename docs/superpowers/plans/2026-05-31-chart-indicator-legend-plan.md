# Pane Legend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 차트의 각 pane 좌상단에 라벨+색상+커서 시점 값 레전드(Pane Legend)를 추가하고, ✕(지표 끄기)·눈(MA 선 숨김) 아이콘으로 제어한다.

**Architecture:** 단일 `PaneLegendOverlay`(LiveChartRoot 마운트)가 pane별 Y-오프셋(런타임 `paneSpecsForTimeframe` 순서로 `chart.panes()[i].getHeight()` 누적)에 절대배치된 HTML 레전드를 렌더한다. 값은 **crosshair `param.seriesData`에서 registry된 series로 읽는다**(차트와 동일, recompute 없음). MA series는 `maSeriesRegistry`로 노출, 거래량은 `VOLUME_SPEC.useContext(volumeEnabled)`로 조건부, MA 숨김은 `movingAverageHidden`.

**Tech Stack:** React 18, zustand, lightweight-charts v5, vitest + RTL.

```yaml
scope: frontend
```

---

### Task 1: 공유 한국어 정수 포맷터 (DRY)

**Files:** Create `frontend/src/util/koreanNumber.ts` (+`.test.ts`); Modify `frontend/src/chart/projectors/volume.ts`, `investorNet.ts`

- [ ] **Step 1: 실패 테스트** — `formatKoreanInt(311400)==='311,400'`, `(-1061741)==='-1,061,741'`, `(1234.7)==='1,235'`.
- [ ] **Step 2: 실패 확인** — `cd frontend && npx vitest run src/util/koreanNumber.test.ts` → FAIL.
- [ ] **Step 3: 구현** — `export const formatKoreanInt = (v: number): string => Math.round(v).toLocaleString('ko-KR');`
- [ ] **Step 4: volume.ts / investorNet.ts 재사용** — 두 `priceFormat.formatter`를 `(v) => formatKoreanInt(v)`로, import 추가.
- [ ] **Step 5: 통과** — `npx vitest run src/util src/chart/projectors` → PASS.
- [ ] **Step 6: 커밋** — `git add frontend/src/util/koreanNumber.ts frontend/src/util/koreanNumber.test.ts frontend/src/chart/projectors/volume.ts frontend/src/chart/projectors/investorNet.ts && git commit -m "refactor(chart): extract shared formatKoreanInt"`

---

### Task 2: store 상태 — volumeEnabled(기본 true) + movingAverageHidden(기본 false)

**merge idiom 방향 반대** (volume default-true, hidden default-false).

**Files:** Modify `frontend/src/state/liveIndicatorsPersistence.ts`, `livePage.ts`; Test `liveIndicatorsPersistence.test.ts`

- [ ] **Step 1: 실패 테스트** (persistence merge)
```ts
it('volumeEnabled defaults true', () => {
  const m = mergeLiveIndicatorPrefs({ movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })) } as any);
  expect(m.volumeEnabled).toBe(true);
});
it('persisted volumeEnabled=false survives', () => {
  const m = mergeLiveIndicatorPrefs({ movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })), volumeEnabled: false } as any);
  expect(m.volumeEnabled).toBe(false);
});
it('movingAverageHidden defaults false', () => {
  const m = mergeLiveIndicatorPrefs({ movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })) } as any);
  expect(m.movingAverageHidden).toBe(false);
});
```
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: persistence** — `liveIndicatorsPersistence.ts` `PersistedIndicators`에 `volumeEnabled`/`movingAverageHidden` 추가; `mergeLiveIndicatorPrefs` `build(...)` 시그니처/호출에 `volumeEnabled: obj.volumeEnabled === false ? false : true`(default-true), `movingAverageHidden: obj.movingAverageHidden === true`(default-false) 추가(모든 build 호출 갱신).
- [ ] **Step 4: 통과** → PASS.
- [ ] **Step 5: livePage store** — 로컬 `PersistedIndicators`에 두 필드; `Store`에 `setVolumeEnabled`/`setMovingAverageHidden`; `snapshotIndicators`에 두 필드; setter 2개(setForeignNetEnabled 패턴: `set({...}); persistIndicators(snapshotIndicators(get));`).
- [ ] **Step 6: build** — `npm run build` → tsc OK.
- [ ] **Step 7: 커밋** — `git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.ts && git commit -m "feat(live): add volumeEnabled + movingAverageHidden state"`

---

### Task 3: 거래량 조건부 데이터 (VOLUME_SPEC.useContext) + stretch 결정

거래량 pane 항상 마운트, `volumeEnabled=false`면 빈 데이터(FillStrength useContext 패턴) → drawing index 안전.

**Files:** Modify `frontend/src/chart/projectors/volume.ts`; Test `volume.test.ts`

- [ ] **Step 1: 실패 테스트**
```ts
import { VOLUME_SPEC } from './volume';
it('VOLUME_SPEC hides data when volumeEnabled is false', () => {
  const bundle = { candles: [{ ts_ms: 0, open: 1, close: 2, high: 2, low: 1, vol_a: 5, vol_b: 5 }] } as any;
  const axis = { contains: () => true, toVirtual: (t: number) => t } as any;
  const dataFn = VOLUME_SPEC.series[0].data;
  expect(dataFn(bundle, axis, { volumeEnabled: false }).length).toBe(0);
  expect(dataFn(bundle, axis, { volumeEnabled: true }).length).toBe(1);
});
```
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현**
```ts
import { useShallow } from 'zustand/react/shallow';
import { useLivePageStore } from '../../state/livePage';
export type VolumePaneContext = { volumeEnabled: boolean };
const useVolumeContext = (): VolumePaneContext =>
  useLivePageStore(useShallow((s) => ({ volumeEnabled: s.volumeEnabled })));
export const VOLUME_SPEC = {
  name: 'volume' as const,
  stretch: 0.3,
  useContext: useVolumeContext,
  series: [{
    type: HistogramSeries,
    options: { priceFormat, priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false },
    data: (bundle: RangeBundle, axis: VirtualAxis, ctx: VolumePaneContext) =>
      ctx.volumeEnabled ? projectVolume(bundle, axis) : [],
  }],
} satisfies PaneSpec<VolumePaneContext>;
```
- [ ] **Step 4: stretch 결정 (review nit)** — `volumeEnabled=false`여도 `stretch:0.3` 유지(빈 pane 수용 — pane stretch 동적 조정은 `LiveChartRoot`의 stretch effect를 거래량 토글에 묶어야 해 범위 확대; 본 plan은 0.3 고정 수용). 이 결정을 Self-Review에 기록.
- [ ] **Step 5: 통과** → PASS.
- [ ] **Step 6: 커밋** — `git add frontend/src/chart/projectors/volume.ts frontend/src/chart/projectors/volume.test.ts && git commit -m "feat(chart): gate volume bars on volumeEnabled via useContext"`

---

### Task 4: maSeriesRegistry + MA hide (visible) — **T7이 실제 소비**

(a) MA 슬롯 series를 공유 registry에 등록(레전드가 `param.seriesData`에서 식별하도록), (b) hide는 `applyOptions({visible})`(데이터 유지 → 레전드 값 쿼리 가능).

**Files:** Create `frontend/src/live/indicators/maSeriesRegistry.ts`; Modify `MovingAverageOverlay.tsx`; Test `MovingAverageOverlay.test.tsx`

- [ ] **Step 1: registry 생성**
```ts
import { create } from 'zustand';
import type { ISeriesApi } from 'lightweight-charts';
type MaSeries = ISeriesApi<'Line'>;
interface MaRegistry {
  series: ReadonlyMap<string, MaSeries>;       // slot id -> line series (param.seriesData 키 매칭용)
  register: (id: string, s: MaSeries) => void;
  unregister: (id: string) => void;
}
export const useMaSeriesRegistry = create<MaRegistry>((set, get) => ({
  series: new Map(),
  register: (id, s) => { const m = new Map(get().series); m.set(id, s); set({ series: m }); },
  unregister: (id) => { const m = new Map(get().series); m.delete(id); set({ series: m }); },
}));
```
- [ ] **Step 2: 실패 테스트** — hidden=true면 `applyOptions({visible:false})` 호출 + `setData`는 `[]`가 **아님**(데이터 유지); add 시 `register(cfg.id, series)` 호출. (가짜 chart 스텁은 기존 `MovingAverageOverlay.test.tsx` 패턴.)
- [ ] **Step 3: 실패 확인** → FAIL.
- [ ] **Step 4: 구현** — `MovingAverageOverlay.tsx`:
  - `const hidden = useLivePageStore((s) => s.movingAverageHidden);`
  - add 분기 `chart.addSeries(...)` 직후 `useMaSeriesRegistry.getState().register(cfg.id, s)`; remove/unmount cleanup에서 `unregister(cfg.id)`.
  - 데이터 effect: `masterEnabled && cfg.enabled`이면 항상 SMA `setData`(hidden이어도 데이터 유지), `s.applyOptions({ visible: masterEnabled && cfg.enabled && !hidden })`; `!masterEnabled || !cfg.enabled`이면 `setData([])` + `visible:false`. deps에 `hidden` 추가.
- [ ] **Step 5: 통과** → PASS.
- [ ] **Step 6: 커밋** — `git add frontend/src/live/indicators/maSeriesRegistry.ts frontend/src/live/indicators/MovingAverageOverlay.tsx frontend/src/live/indicators/MovingAverageOverlay.test.tsx && git commit -m "feat(live): MA hide via visible + slot series registry"`

---

### Task 5: cursor 발행 분리 — **LiveSidebar spot 회귀 방지 (red 테스트 필수)**

레전드는 D에서도 커서 값 필요. cursor를 모든 timeframe에서 발행하되, **소비측 spot 진입은 분봉만**(LiveSidebar isSpot / brokerCursorMs / SidebarHeader isSpot에 `isMinuteTimeframe` 가드).

**Files:** Modify `frontend/src/live/LiveChartRoot.tsx`(crosshair effect ~504-535), `frontend/src/live/LiveSidebar.tsx`, `frontend/src/live/SidebarHeader.tsx`; Test `LiveSidebar.test.tsx`

- [ ] **Step 1: red 회귀 테스트** — `LiveSidebar.test.tsx`: timeframe='D' + `useLiveCursorStore.setState({ cursorMs: <past> })`일 때 호가 카드가 `latestOrderbook`를 유지하고 SidebarHeader가 "과거 시점" 라벨을 띄우지 **않음**을 단언.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/live/LiveSidebar.test.tsx` → FAIL (현재 isSpot=cursorMs!==null이라 D에서도 spot).
- [ ] **Step 3: 소비측 가드** — `LiveSidebar.tsx`: `isSpot = cursorMs !== null && isMinuteTimeframe(timeframe)` (timeframe prop은 이미 전달됨); `brokerCursorMs`도 `isMinuteTimeframe(timeframe) ? (cursorMs ?? latestBrokerTs) : latestBrokerTs`. `SidebarHeader.tsx`: 자체 isSpot 파생을 동일하게 `cursorMs!==null && isMinuteTimeframe(timeframe)`로(timeframe prop 추가 필요 시 전달).
- [ ] **Step 4: red 통과** — `npx vitest run src/live/LiveSidebar.test.tsx` → PASS.
- [ ] **Step 5: cursor 발행 확대** — `LiveChartRoot.tsx` crosshair effect의 `if (!chart || !isMinuteTimeframe(timeframe)) { clearCursor(); return; }`에서 `!isMinuteTimeframe(timeframe)` 조건 제거(모든 tf 구독). handler: `param.time`(virtual sec) → `axis.toReal(virtualMs)` → `setCursor(realMs)`; `param.point==null`이면 `clearCursor`. axis.segments 비면 skip. deps 유지.
- [ ] **Step 6: 통과 + 회귀** — `npx vitest run src/live/LiveSidebar.test.tsx src/live/LiveChartRoot.test.tsx` → PASS.
- [ ] **Step 7: 커밋** — `git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveSidebar.tsx frontend/src/live/SidebarHeader.tsx frontend/src/live/LiveSidebar.test.tsx && git commit -m "feat(live): publish cursor on all timeframes; gate sidebar spot to minute (legend)"`

---

### Task 6: IndicatorPanel — 거래량 카테고리 + 투자자 라벨 통일

**Files:** Modify `IndicatorPanel.tsx`; Test `IndicatorPanel.test.tsx`

- [ ] **Step 1: 실패 테스트** — '거래량' active checkbox가 `volumeEnabled` 토글; 클릭 → false.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현** — `CategoryId`에 `'volume'`; `CATEGORIES`에 `{ id:'volume', label:'거래량', active:true }`(이동평균선 다음); 투자자 라벨 `'외국인 순매수량'`/`'기관 순매수량'`; `checkedFor`/`toggleFor`에 `'volume'` case(`volumeEnabled`/`setVolumeEnabled`).
- [ ] **Step 4: 기존 테스트 갱신** — 카테고리 9→10, active 3→4, **disabled는 6 유지**(volume은 active이므로 placeholder 개수 불변); 투자자 라벨 단언이 있으면 새 라벨로.
- [ ] **Step 5: 통과** → PASS.
- [ ] **Step 6: 커밋** — `git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx && git commit -m "feat(live): popover 거래량 toggle + unified investor labels"`

---

### Task 7: PaneLegendOverlay (핵심) — registry 읽기 + 런타임 pane index + 디자인 스펙

각 pane 좌상단 절대배치 HTML 레전드. **값은 crosshair `param.seriesData`에서 registry된 series로 읽는다**(recompute 없음). pane Y는 **런타임 `paneSpecsForTimeframe` 순서**로 누적.

**Files:** Create `frontend/src/live/PaneLegendOverlay.tsx`(+`.test.tsx`), `frontend/src/live/legendRows.ts`(+`.test.ts`)

- [ ] **Step 1: 타입 + 순수 빌더 실패 테스트** — `legendRows.ts`에 spec §타입의 `LegendRow`/`LegendMAValue` export + 순수 빌더. 빌더는 **series 값 Map을 입력**으로 받는다(impure 분리 — 컴포넌트가 param.seriesData에서 추출):
```ts
// legendRows.test.ts
import { buildLegendRows } from './legendRows';
it('builds candle MA rows from variable slots; value=null when missing', () => {
  const rows = buildLegendRows({
    timeframe: 'D',
    movingAverages: [{ id: 'ma-1', enabled: true, period: 5, color: '#EC4899', lineWidth: 1, source: 'close' }],
    movingAverageHidden: false,
    maValues: new Map([['ma-1', 311400]]),       // slot id -> value (from param.seriesData)
    volumeValue: 12345, foreignValue: 100, institutionValue: -50,
    foreignNetEnabled: true, institutionNetEnabled: true, volumeEnabled: true,
  });
  const candle = rows.find((r) => r.paneId === 'candle');
  expect(candle && candle.paneId === 'candle' && candle.mas[0].value).toBe(311400);
});
```
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: legendRows 구현** — `buildLegendRows(input): LegendRow[]`:
  - candle: `movingAverages.map(cfg => ({ id, color, period, value: input.maValues.get(cfg.id) ?? null }))`, `hidden: movingAverageHidden`.
  - volume: `{ paneId:'volume', label:'거래량', value: input.volumeValue }` (volumeEnabled일 때만 push).
  - investor(D + 토글 on): `{ paneId:'investor-foreign', label:'외국인 순매수량', value: input.foreignValue }` 및 institution.
  - 값 추출은 컴포넌트가 담당(아래) — 빌더는 값 Map만 받는 순수 함수.
- [ ] **Step 4: 통과** → PASS.
- [ ] **Step 5: PaneLegendOverlay 컴포넌트** — `PaneLegendOverlay.tsx` props `{ chart, axis, timeframe }`:
  - **값 소스 (registry 읽기, recompute 없음)**: `chart.subscribeCrosshairMove(param => ...)`. MA 값 = `useMaSeriesRegistry.getState().series` 각 series에 `param.seriesData.get(series)` → `d && 'value' in d ? d.value : null` (slot id→value Map). 거래량/투자자 값 = 그 pane primary series(`paneSeries`/`registerPaneSeries`)에 동일하게 `param.seriesData.get`. 커서 없으면(`param.point==null`) 각 series의 **마지막 데이터 점**(`series.dataByIndex(last, -1)` 또는 보관한 latest) 사용. 값 추출 후 `buildLegendRows`에 Map으로 전달.
  - **pane index (런타임)**: `const specs = paneSpecsForTimeframe(timeframe, { foreignNet, institutionNet });` 로 paneId→index를 구한다(conditional: foreign off면 institution=index 2). `chart.panes()` 각 `getHeight()` 누적으로 pane top Y. **`chartCoordinates.paneTopY`는 static PANE_ID_TO_INDEX가 런타임 append되는 투자자 pane을 몰라(return 0 fallback) 재사용 불가** — spec line 50-52 paneTopY 재사용 결정을 override(Self-Review/spec 동기화).
  - **렌더**: 차트 위 단일 절대배치 div. 각 row를 `top: paneTopY[paneId]`에. candle row = MA별 [색상 스와치 + period + value] + 눈 + ✕; volume/investor = 라벨 + value + ✕.
  - **디자인 스펙 (DESIGN.md 준수)**:
    - **값 셀**: `fontFamily: var(--font-mono)`(Geist Mono), `fontVariantNumeric: 'tabular-nums'`, `textAlign: right`, **고정 `min-width` (ch 기반, 최악값 `-9,999,999`≈12ch)** — 커서 이동 시 가로 흔들림 방지. 값 색 `--fg`, 라벨/period `--fg-dim`.
    - **컨테이너**: opaque `bg-bg-card border border-border rounded-[var(--radius-md)] px-[var(--space-sm)] py-[var(--space-2xs)]`(SourceChip/IndicatorPanel 선례 — 반투명 토큰 없음). saturated 캔들 위 가독성 보장.
    - **아이콘**: hit-area ~18px square, 기본 `--fg-dimmer` → hover `--fg-dim`, `transition 80ms ease-in-out`(Tabs/Motion 선례). 눈은 `movingAverageHidden`일 때 filled/struck-through 상태로 ✕(끄기)와 구분. 색 스와치는 `MAStylePicker` 치수 + `rounded-[var(--radius-sm)]`.
    - **모션**: 값은 커서 이동 시 **즉시 snap**(fade/count-up/tween 금지, DESIGN.md Motion). 유일한 애니메이션은 rAF pane-position 추종.
  - rAF로 pane 높이/위치 추종(`MovingAverageOverlay`/`DrawingOverlay` 패턴).
  - 눈 클릭 → `setMovingAverageHidden(!hidden)`; ✕ → 해당 토글 off(`setMovingAverageEnabled(false)`/`setVolumeEnabled(false)`/`setForeignNetEnabled(false)`/`setInstitutionNetEnabled(false)`).
- [ ] **Step 6: 컴포넌트 렌더 테스트** — RTL로 candle 레전드 MA 라벨/값, ✕/눈 클릭 → store setter 호출.
- [ ] **Step 7: 통과** → PASS.
- [ ] **Step 8: 커밋** — `git add frontend/src/live/PaneLegendOverlay.tsx frontend/src/live/PaneLegendOverlay.test.tsx frontend/src/live/legendRows.ts frontend/src/live/legendRows.test.ts && git commit -m "feat(live): PaneLegendOverlay with registry-read cursor values"`

---

### Task 8: LiveChartRoot 마운트 + 브라우저 dogfooding

**Files:** Modify `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: 마운트** — `MovingAverageOverlay` 옆에 `<PaneLegendOverlay chart={chart} axis={axis} timeframe={timeframe} />`.
- [ ] **Step 2: build + 전체 vitest** — `npm run build && npx vitest run` → 전부 PASS.
- [ ] **Step 3: 백엔드 회귀** — `cd .. && uv run --extra dev pytest -q` → PASS.
- [ ] **Step 4: 브라우저 dogfooding** (`/browse`, 8000/5173):
  - `/live` → 005930 → D. 각 pane 좌상단 레전드(이동평균선 색상별 값, 거래량, 외국인/기관).
  - 커서 이동 → 모든 레전드 값이 그 시점으로 snap(D 포함), 행 너비 안 흔들림. 커서 떼면 최신값.
  - **호가 카드 회귀 확인**: D에서 커서 올려도 호가 카드가 latestOrderbook 유지, "과거 시점" 라벨 안 뜸(Task 5 회귀).
  - 눈(👁) → MA 선 숨김 + 레전드 값 유지. ✕ → MA 끄기(popover off).
  - 거래량 ✕ → 막대 사라짐(pane 유지), popover 거래량 off. 재활성 복원.
  - W/M → 투자자 레전드 없음, MA/거래량 레전드 있음. (foreign만/institution만 토글 시 레전드 위치 정확.)
  - `console --errors` clean.
- [ ] **Step 5: 커밋** — `git add frontend/src/live/LiveChartRoot.tsx && git commit -m "feat(live): mount PaneLegendOverlay"`

---

## Self-Review

**Spec coverage:** 값 커서추적(T5 발행 + T7 registry 읽기) · ✕/눈(T7) · 거래량 토글(T2/T3/T6) · MA 가변슬롯+registry(T4 등록→T7 소비) · 용어(spec/CONTEXT) · 타입 LegendRow(T7) · persistence idiom(T2) · 포맷터 DRY(T1) — 전부 태스크 존재.

**Type consistency:** `LegendRow`/`LegendMAValue`(legendRows.ts) · `useMaSeriesRegistry`(T4, T7이 `.getState().series` 읽음) · `VolumePaneContext`(T3) · `formatKoreanInt`(T1) 일관.

**Plan review 반영:** T4 registry는 T7이 `param.seriesData`로 실제 소비(dead code 해소, recompute 없음 — spec 결정 준수). T5는 LiveSidebar/SidebarHeader Files 포함 + spot 가드 + red 회귀 테스트(dogfooding 의존 제거). T7은 런타임 paneSpecsForTimeframe index(투자자 위치 정확, paneTopY override 문서화) + tabular-nums/reserved-width(흔들림 방지) + opaque --bg-card(반투명 토큰 부재) + 아이콘/snap 스펙.

**의도적 수용:** 거래량 off 시 빈 pane stretch 0.3 유지(동적 stretch 조정은 범위 확대 — 빈 pane 수용). spec line 50-52 paneTopY 재사용 mandate는 투자자 런타임 pane에 부적용 → T7이 런타임 index로 override(spec 동기화 필요).
