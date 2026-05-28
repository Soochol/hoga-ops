# /live Moving Average Indicator — Design

**Date**: 2026-05-28
**Status**: Draft
**Scope**: `frontend/src/state/livePage.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/LiveToolbar.tsx`, `frontend/src/live/indicators/*` (신규), `frontend/src/chart/projectors/movingAverage.ts` (재사용), `frontend/src/styles/tokens.css`

## Problem

`/live` 페이지에는 현재 어떤 보조지표도 없다. 사용자는 분봉 차트에서 추세를
즉각적으로 가늠하기 위한 이동평균선이 필요하다. 사용자 표현:

> "여기에 지표 추가 기능 만들어줘. 이동평균선 하나만 먼저 만들어줘."

`/replay`에는 이미 5슬롯 고정 SMA(`MOVING_AVERAGE_SPEC`, `IndicatorsSection`)가
구현되어 있지만, `/live`는 이를 mount하지 않는다. 또한 `/live`는 자체
`useLivePageStore`를 쓰고 `/replay`의 탭 컨텍스트(`useTabsStore`)와 분리되어
있어, prefs 소스가 재사용되지 않는다.

사용자가 첨부한 mockup은 기존 `IndicatorsSection`보다 풍부한 모델을 요구한다:

- 좌측: 7개 지표 카테고리 목록 (이동평균선 / 일목균형표 / 볼린저 / 슈퍼트렌드
  / 매물대 / 엔벨로프 / 윌리엄스 프랙탈) — 이번엔 이동평균선만 활성.
- 우측: 슬롯당 색상 swatch · 선 굵기 · 소스(종가/시가/고가/저가/HL2/HLC3/OHLC4)
  · 기간 입력 + 슬롯 추가/삭제 (가변 슬롯 카드).

## Invariants

이 변경이 건드리는 시스템이 **현재 보존하고 있는** 속성들:

- **/live ↔ /replay prefs 분리**: `/live`의 chart 상태(timeframe, watchlist 패널,
  historical 윈도우 등)는 `useLivePageStore`에 사는 별도 슬라이스이며,
  `useTabsStore`의 per-tab 상태와 어떤 키도 공유하지 않는다.
  근거: [livePage.ts](../../../frontend/src/state/livePage.ts), [tabs.ts](../../../frontend/src/state/tabs.ts).
- **SMA 사전 동시호가 제외**: 이동평균은 정규장(09:00–15:30) 캔들만으로 계산
  되며, 8:30–9:00 사전 단일가 캔들은 평균에 포함되지 않는다 — 그렇지 않으면
  첫 `period`개 정규장 봉의 평균이 사전 호가 가격으로 오염된다.
  근거: [movingAverage.ts:84-87](../../../frontend/src/chart/projectors/movingAverage.ts#L84-L87) (`axis.contains(c.ts_ms)` 필터).
- **PaneId 영속성**: `BoundPaneSpec.name`은 사용자 drawing이 anchor하는
  지속 키 (ADR-0028). `MOVING_AVERAGE_SPEC`은 candle pane(`paneIndex: 0`)
  위에 mount되는 *오버레이*라 자체 `PaneId`를 발급하지 않는다.
  근거: [paneSpecs.ts:14-19](../../../frontend/src/chart/paneSpecs.ts#L14-L19), `MOVING_AVERAGE_SPEC.name = 'moving-average'`(PaneId 아님).
- **RangeSeriesPane series identity**: `spec.series` 개수는 모듈 상수이며
  prefs가 변해도 series handle은 churn하지 않는다. period bump가
  setData만 트리거하고 LineSeries를 재생성하지 않는 것이 load-bearing.
  근거: [RangeSeriesPane.tsx:76-109](../../../frontend/src/chart/RangeSeriesPane.tsx#L76-L109).
- **chartScale 토큰 단일 소스**: `lineWidth`를 비롯한 시각 속성은
  설계 토큰 또는 `chartScale.ts` 상수에서 온다. 임의의 px 값을 인라인하지
  않는다. 근거: [ADR-0012](../../adr/0012-design-tokens-single-source.md).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| /live ↔ /replay prefs 분리 | **preserves** | `useLivePageStore`에 `movingAverages` 슬라이스를 추가. `useTabsStore`는 변경 없음. /replay의 `MOVING_AVERAGE_SPEC` 동작은 그대로. |
| SMA 사전 동시호가 제외 | **preserves** | 새 `MovingAverageOverlay`도 동일하게 `axis.contains(c.ts_ms)`로 in-session candle만 입력. `computeSMA`는 재사용. |
| PaneId 영속성 | **preserves** | `/live` MA도 candle pane(`paneIndex: 0`) 위 오버레이로 mount. 새 PaneId 발급 없음. |
| RangeSeriesPane series identity | **intentionally breaks** (제한적) | 가변 슬롯을 지원하므로 `MOVING_AVERAGE_SPEC`(고정 5슬롯 spec) 재사용 불가. `/live` 전용 `MovingAverageOverlay`가 series 라이프사이클을 직접 관리: 슬롯 *추가/삭제* 시에만 series 생성/제거, 슬롯 *patch* (period/color/lineWidth/source 변경) 시에는 기존 series에 setData/applyOptions만 호출 — identity 유지. /replay의 `MOVING_AVERAGE_SPEC`는 손대지 않는다. |
| chartScale 토큰 단일 소스 | **preserves** | lineWidth는 1/2/3/4 정수 enum, 색상은 `--ma-1..--ma-N` palette + 사용자 hex. 임의 인라인 px 없음. |

**Trade-off 정당화 (Invariant 4):** /replay의 5슬롯 고정 모델을 /live의 가변
모델과 같은 추상(`RangeSeriesPane`)으로 묶으려면 `spec.series`를 함수로
바꾸고 deps를 재설계해야 한다 — /replay 회귀 위험이 큰 큰 리팩터. 이번 spec은
범위를 /live에 한정하고, 두 모델을 일단 *나란히* 둔 뒤 두 번째 indicator가
추가되는 시점에 통합 ADR로 다룬다.

## Goals

- `/live`에 SMA 이동평균선 표시 — minute(1m–30m) 및 calendar(D/W/M) timeframe
  모두에서 동작.
- 사용자가 LiveToolbar의 "지표" 버튼으로 IndicatorPanel을 열어 이동평균선 슬롯
  추가/삭제, 기간(2–400) · 색상 · 선 굵기 · 소스 편집.
- 설정은 `localStorage('live.indicators.v1')`로 지속.
- /replay 이동평균선 동작에 회귀 없음 (`MOVING_AVERAGE_SPEC` 미변경).

## Non-Goals

- 다른 6개 지표(일목균형표, 볼린저, 슈퍼트렌드, 매물대, 엔벨로프, 윌리엄스):
  IndicatorPanel 좌측 목록에는 표시하되 **disabled + "추후 지원"**.
- /live MA prefs와 /replay tab MA prefs의 동기화/공유.
- EMA, WMA 등 다른 평균 알고리즘. SMA만.
- 새 backend API. 모든 데이터(OHLCV)는 이미 `RangeBundle`에 있음.
- /replay `MOVING_AVERAGE_SPEC`의 가변화. 별도 ADR에서 다룸.

## Design

### 1. 데이터 모델

새 타입은 `frontend/src/state/livePage.ts`에 둔다.

```ts
export type MASource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

/** /live의 이동평균선 한 슬롯. 가변 슬롯이므로 array index가 아니라
 * id로 식별한다 (mid-list 삭제가 다른 슬롯의 series identity를 churn하지
 * 않도록 안정 키 필요). */
export type LiveMAConfig = {
  id: string;            // 'ma-<랜덤>' (crypto.randomUUID 또는 ts+counter)
  enabled: boolean;
  period: number;        // [2..400] — UI에서 검증, store에서 clamp
  color: string;         // hex — palette pick 또는 사용자 custom
  lineWidth: 1 | 2 | 3 | 4;
  source: MASource;
};

const DEFAULT_LIVE_MAS: readonly LiveMAConfig[] = Object.freeze([
  // hex 값은 tokens.css의 --ma-N과 정확히 일치 (정적 deflate; lightweight-charts는
  // canvas에 색을 쓰므로 CSS var를 그대로 전달할 수 없어 hex로 변환).
  { id: 'ma-1', enabled: true,  period: 5,   color: '#EC4899' /* --ma-1 */, lineWidth: 1, source: 'close' },
  { id: 'ma-2', enabled: true,  period: 20,  color: '#F97316' /* --ma-3 */, lineWidth: 1, source: 'close' },
  { id: 'ma-3', enabled: true,  period: 60,  color: '#22C55E' /* --ma-4 */, lineWidth: 1, source: 'close' },
  { id: 'ma-4', enabled: true,  period: 120, color: '#F8FAFC' /* --ma-5 */, lineWidth: 1, source: 'close' },
]);
```

> **Defaults 근거**: mockup의 4슬롯(5/20/60/120)을 그대로 채용. /replay의
> 5슬롯 기본값(5/10/20/60/120)은 spec 의도가 다른 페이지(분석용 정밀)
> 라 별개로 둔다.

`MA_PERIOD_MIN = 2`, `MA_PERIOD_MAX = 400`, `MA_SLOT_LIMIT = 8` (가변이지만
무한 추가 방지).

### 2. Store 확장

`useLivePageStore` 슬라이스에 다음을 추가:

```ts
type Persisted = { /* 기존 ... */ } & {
  movingAverages: LiveMAConfig[];
};

type Store = Persisted & { /* 기존 ... */ } & {
  addMovingAverage: () => void;              // MA_SLOT_LIMIT 가드, 다음 default 기간/색 자동 선택
  removeMovingAverage: (id: string) => void;
  setMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
};
```

`setMovingAverage`는:
- 알 수 없는 `id` → no-op.
- `period`는 `[MA_PERIOD_MIN..MA_PERIOD_MAX]`로 clamp (정수 아닌 값은 reject).
- 부분 patch는 immutable 갱신 (배열의 해당 entry만 새 객체).

`addMovingAverage`:
- 현재 슬롯 수가 `MA_SLOT_LIMIT` 이상이면 no-op.
- 새 id = `'ma-' + crypto.randomUUID().slice(0, 8)` (또는 fallback `Date.now()`).
- period는 마지막 슬롯의 period × 2 (mockup의 5→20→60→120 비율과 호환,
  cap = MA_PERIOD_MAX).
- color는 `--ma-1..--ma-8` palette를 *처음 미사용 색* 순으로 선택. 모두
  사용 중이면 index `(slotCount % 8)`로 wrap around. — 두 슬롯이 같은 색을
  쓰는 게 일시적으로 허용되며, 사용자는 색상 swatch로 즉시 바꿀 수 있음.
- lineWidth=1, source='close', enabled=true.

`mergePrefs` validator는 `frontend/src/state/liveIndicatorsPersistence.ts`
(신규)에 둔다 — 기존 `tabsPersistence.ts`와 같은 패턴: schema mismatch면
DEFAULT_LIVE_MAS로 fallback, 부분 손상은 entry 단위로 default 대체.

`removeMovingAverage`:
- 마지막 1개 슬롯은 삭제 금지 (UI에서 disable; store는 silent no-op).

localStorage:
- 키 `live.indicators.v1` (기존 `live.page.v1`과 분리: 다른 라이프사이클).
- `mergePrefs`-스타일 validator로 손상된 entry는 default로 대체.

> **별도 키 근거**: `live.page.v1`은 timeframe/watchlist 같은 view state이고,
> indicators는 분석 도구 prefs로 라이프사이클이 다르다. 마이그레이션도 분리.

### 3. SMA 계산 — 재사용 + source helper

기존 `frontend/src/chart/projectors/movingAverage.ts`의 `computeSMA`를 그대로
재사용. 새 helper 하나만 추가:

```ts
// frontend/src/chart/projectors/movingAverage.ts에 추가 export
export function selectSource(c: Candle, source: MASource): number {
  switch (source) {
    case 'close': return c.close;
    case 'open':  return c.open;
    case 'high':  return c.high;
    case 'low':   return c.low;
    case 'hl2':   return (c.high + c.low) / 2;
    case 'hlc3':  return (c.high + c.low + c.close) / 3;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
  }
}
```

### 4. Chart overlay — `MovingAverageOverlay`

`frontend/src/live/indicators/MovingAverageOverlay.tsx` (신규):

```ts
type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
};

export default function MovingAverageOverlay({ chart, bundle, axis }: Props) {
  const configs = useLivePageStore(s => s.movingAverages);
  const seriesByIdRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  // ① Lifecycle effect: reconcile series map ↔ configs by id.
  //    Add new id → addSeries; missing id → removeSeries; existing id →
  //    applyOptions (color/lineWidth) on potential change.
  useEffect(() => { /* reconcile */ }, [chart, configs]);

  // ② Data effect: setData on every series with projected SMA values.
  useEffect(() => { /* project + setData */ }, [bundle, axis, configs]);

  return null;
}
```

라이프사이클 reconciliation 의사 코드:

```ts
const currentIds = new Set(configs.map(c => c.id));
// Remove
for (const [id, s] of seriesByIdRef.current) {
  if (!currentIds.has(id)) {
    try { chart.removeSeries(s); } catch {}
    seriesByIdRef.current.delete(id);
  }
}
// Add or update options
for (const cfg of configs) {
  let s = seriesByIdRef.current.get(cfg.id);
  if (!s) {
    s = chart.addSeries(LineSeries, {
      color: cfg.color,
      lineWidth: cfg.lineWidth,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 0); // paneIndex 0 = candle pane overlay
    seriesByIdRef.current.set(cfg.id, s);
  } else {
    s.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth });
  }
}
```

Data effect:

```ts
const inSession = bundle.candles.filter(c => axis.contains(c.ts_ms));
for (const cfg of configs) {
  const s = seriesByIdRef.current.get(cfg.id);
  if (!s) continue;
  if (!cfg.enabled) { s.setData([]); continue; }
  const values = inSession.map(c => selectSource(c, cfg.source));
  const sma = computeSMA(values, cfg.period);
  const data = inSession.map((c, j) => {
    const time = (axis.toVirtual(c.ts_ms) / 1000) as Time;
    const v = sma[j];
    return v === null ? { time } : { time, value: v };
  });
  s.setData(data);
}
```

Cleanup (unmount): map의 모든 series에 removeSeries try/catch.

Mount: `LiveChartRoot.tsx`의 chart-ready 분기에서 `<MovingAverageOverlay
chart={chart} bundle={bundle} axis={axis} />`를 `RangeSeriesPane` 옆에 렌더.
Day boundary overlay와 같은 자리.

### 5. UI 패널 — `IndicatorPanel`

`frontend/src/live/indicators/IndicatorPanel.tsx` (신규) — modal overlay.
`/replay`의 `SettingsModal`과 같은 시각 언어(중앙 정렬, backdrop click 닫기,
Escape, ✕ 버튼).

```
┌─────────────────────────────────────────────────────────────┐
│ 지표                                                     ✕  │
├────────────────┬────────────────────────────────────────────┤
│ 상단 지표      │ 이동평균선 ⓘ                              │
│ ─────────────  │ 지난 n일 동안 주가 평균값을 이은 선         │
│ ● 이동평균선   │                                            │
│ ○ 일목균형표   │ 기간1  [■]  1px ▾   종가 ▾   [   5]        │
│ ○ 볼린저밴드   │ 기간2  [■]  1px ▾   종가 ▾   [  20]   ✕   │
│ ○ 슈퍼트렌드   │ 기간3  [■]  1px ▾   종가 ▾   [  60]   ✕   │
│ ○ 매물대분석   │ 기간4  [■]  1px ▾   종가 ▾   [ 120]   ✕   │
│ ○ 엔벨로프     │                                            │
│ ○ 윌리엄스     │ ⊕ 기간 추가                                │
└────────────────┴────────────────────────────────────────────┘
```

좌측 카테고리 목록:
- `이동평균선`만 활성. 나머지는 `disabled` + tooltip "추후 지원 예정".
- 활성 카테고리는 `--accent` border-left, `--bg-input` 배경.

우측 panel — `MovingAverageConfig.tsx` (신규):
- 상단: 지표명 + `ⓘ` 툴팁 (정의 한 줄).
- 각 행은 `MovingAverageRow.tsx` (신규):
  - **색상 swatch** — 클릭 시 작은 popover로 `--ma-1..--ma-8` palette 8색
    그리드. 커스텀 hex 입력은 v1 미포함 (Out of Scope에 명시).
  - **선 굵기 select** — 1px/2px/3px/4px (native `<select>`).
  - **소스 select** — 종가/시가/고가/저가/HL2/HLC3/OHLC4.
  - **기간 input** — number, min=2 max=400. blur 또는 Enter에서 commit
    (기존 `MovingAverageRow` 패턴 재사용 — draft string).
  - **✕ 삭제 버튼** — 마지막 1개 슬롯은 hidden.
- 하단: `⊕ 기간 추가` 버튼 — `MA_SLOT_LIMIT` 도달 시 disabled.

새 palette 토큰 (`tokens.css`):
- 기존 `--ma-1..--ma-5` 유지.
- `--ma-6: #06B6D4` (cyan), `--ma-7: #EAB308` (yellow), `--ma-8: #94A3B8` (slate) 추가
  — 가변 슬롯 + 색상 swatch가 8색 grid를 보여줄 수 있도록.

### 6. 진입점 — LiveToolbar

`LiveToolbar.tsx`에 timeframe pill 그룹 우측으로 "지표" 버튼 추가:

```tsx
<button
  type="button"
  data-testid="live-indicators-button"
  onClick={() => setPanelOpen(true)}
  aria-pressed={panelOpen}
  className="..."
>
  📈 지표
</button>
```

modal 표시 상태는 `useLivePageStore.indicatorPanelOpen`(persist 안 함, 휘발성)
또는 `LivePage`의 로컬 `useState`로 — view-only 상태이므로 store에 둘 필요
없음. 후자 채택.

### 7. Calendar timeframe 처리

기존 `LiveChartRoot.tsx`는 `dwDisabled` 분기에서
*"라이브 지표는 분봉에서 표시됩니다"* 노트를 띄운다 — 이는 **hoga 지표**
(RatioPane/QuoteTotals/FillStrength)에 해당하는 메시지. MA는 candle 오버레이
이므로 D/W/M에서도 정상 동작.

행동: `MovingAverageOverlay`는 timeframe 분기 없이 항상 mount. mockup에
"기간 1 = 5"가 D timeframe에서 "5일 평균선"으로 자연 동작.

### 8. Auction mask 처리

기존 `MOVING_AVERAGE_SPEC`의 데이터 projector는 `axis.contains(c.ts_ms)`로
사전 동시호가만 거른다. 종가 동시호가(15:20–15:30)는 정규 종가 흐름의
일부로 보고 평균에 포함시킨다 — 이는 `axis.contains`의 의미와 일치
(CONTEXT.md `Auction Mask` 정의 참고: candle/volume은 mask에서 제외됨).
새 `MovingAverageOverlay`도 동일 정책.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| `selectSource('close')` returns `c.close` | Candle `{open:1, high:2, low:0, close:1.5}` | `1.5` |
| `selectSource('hl2')` returns mid | 위 동일 | `1` |
| `selectSource('ohlc4')` returns mean | 위 동일 | `1.125` |
| `addMovingAverage` 새 id 발급 | 기본 4슬롯 상태 | 슬롯 5개, 모든 id unique |
| `addMovingAverage` MA_SLOT_LIMIT 도달 시 no-op | 8슬롯 상태 | 여전히 8슬롯 |
| `removeMovingAverage` 알 수 없는 id | id='nope' | no-op, configs identity 유지 (===) |
| `removeMovingAverage` 마지막 슬롯 | 1슬롯 상태 | no-op |
| `setMovingAverage` period clamp | patch `{period: 1000}` | period=400 |
| `setMovingAverage` period < MIN | patch `{period: 1}` | period=2 |
| `setMovingAverage` non-integer | patch `{period: 3.7}` | reject (혹은 floor=3 — 결정 필요, 일단 floor) |
| `setMovingAverage` 모르는 id | id='nope', patch `{period:10}` | no-op |
| `setMovingAverage` 부분 patch immutability | patch `{enabled: false}` | 다른 슬롯 entry는 referentially equal |
| persistence — 손상된 LS 복원 | LS에 invalid color | mergePrefs가 default로 대체 |
| persistence — version mismatch | LS에 미래 schema | DEFAULT_LIVE_MAS로 fallback |
| `MovingAverageOverlay` 슬롯 추가 시 series 추가 | 3슬롯 mount, configs +1 | `chart.addSeries` 1회 호출 (총 4 series) |
| 슬롯 patch (period only) 시 series identity 유지 | 동일 id의 period 변경 | `addSeries`/`removeSeries` 호출 없음, `setData`만 |
| 슬롯 patch (color) 시 applyOptions | 동일 id의 color 변경 | `applyOptions({color})` 호출, addSeries 없음 |
| 슬롯 제거 시 removeSeries | 4슬롯 mount, 1슬롯 제거 | `removeSeries` 1회 호출 |
| enabled=false → setData([]) | 슬롯 비활성화 | 해당 series에 빈 array |
| 사전 동시호가 캔들 제외 | bundle에 08:30 캔들 포함 | `inSession.filter`로 제외, 평균 영향 없음 |

**Invariant 회귀 테스트**:
- /replay tab MA prefs 변경이 /live store에 영향을 주지 않음 (분리 invariant).
- `MOVING_AVERAGE_SPEC` projector test가 그대로 통과 (변경 없음 보장).
- /replay 페이지에서 MA 동작 그대로 (snapshot/integration test로 회귀 감지).

### Manual verification

`/browse` 스킬로:
1. `http://localhost:5173/live` 로딩, 종목 선택.
2. LiveToolbar의 "📈 지표" 버튼 → IndicatorPanel 모달 오픈.
3. 좌측에서 이동평균선 활성, 나머지 6개 disabled 확인.
4. 우측에서 기간 4개 보임 (5/20/60/120), 각각 차트에 다른 색 line 표시.
5. "⊕ 기간 추가" → 5번째 슬롯 등장, 차트에 새 line.
6. ✕ 삭제 → 차트에서 사라짐.
7. 기간을 5 → 10 변경, 차트 line이 부드럽게 갱신 (전체 redraw 없음 — 시각적 깜빡임 없음).
8. 색상 swatch 클릭 → palette popover → 새 색 선택, 즉시 반영.
9. 소스를 '종가' → '고가' 변경, line 위치 이동.
10. 페이지 새로고침 후 설정 유지 확인.
11. timeframe을 1m → D 변경, MA line이 D 단위로 재계산되어 표시.
12. /replay 페이지로 이동, 기존 MA가 그대로 동작하는지 확인 (회귀 없음).

## Risks / Open questions

- **색상 충돌 검출 없음**: 사용자가 두 슬롯에 같은 색을 고를 수 있다.
  실수 방지 안내(disabled)를 v1에 넣지 않음 — 자유롭게 두기로. 후속 spec에서
  팔레트 자동 회피를 고려.
- **`crypto.randomUUID` 가용성**: 일부 오래된 브라우저(특히 비-HTTPS localhost)
  에서 미지원. fallback으로 `Date.now() + Math.random()`을 사용.
- **`/replay`의 MA spec과의 통합**: 두 모델이 병행 존재함은 일시적이다.
  두 번째 indicator(예: 볼린저)를 추가할 때 가변 슬롯 모델을 /replay에도
  적용하는 별도 ADR을 작성한다.
- **non-integer period 정책**: 위 테스트 표에서 floor로 둠. UI는 `step=1` +
  blur commit이라 사실상 정수만 들어오지만 store는 방어적으로 floor.

## Out of Scope (Backlog)

- 색상 swatch에서 커스텀 hex 입력 — v1은 8색 palette만.
- EMA, WMA, VWMA — SMA만.
- 다른 6개 지표 (좌측 목록의 placeholder만).
- /replay MA의 가변 슬롯 통합 마이그레이션.
- MA prefs 페이지 간 동기화 (/live ↔ /replay).
- 슬롯 reorder (drag-and-drop).
- 슬롯 이름 라벨 변경 (`MA 5`가 아니라 사용자 정의 이름).
