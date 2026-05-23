# Replay 차트 — 이동평균선(Moving Average) 보조지표

**Status:** approved (2026-05-23)

## 1. Context

`http://localhost:5173/replay`의 캔들 차트에 첫 번째 보조지표로 **단순이동평균(SMA) 5개 선**을 추가한다. 차트 로드 직후 5/10/20/60/120 캔들 SMA가 캔들 위에 overlay되어 HTS와 동일한 첫인상을 제공하며, 사용자는 Settings 모달의 새 사이드바 항목 "보조지표"에서 개별 toggle과 period 조정을 할 수 있다.

Settings 모달 셸·기어 버튼·`CHART_TOGGLES` declarative registry·`ChartPrefsContext`·`RangeSeriesPane` + `PaneSpec` 패턴은 이미 완성되어 있다. 이 spec은 그 위에 한 종류의 indicator를 더 얹는 deepening 작업이다.

## 2. 합의된 결정

| 항목 | 결정 |
|---|---|
| 진입 위치 | 기존 SettingsModal 사이드바에 "보조지표" 두 번째 항목 추가 |
| MA 종류 | SMA만 (EMA 미지원) |
| 선 개수 | 5개 고정 |
| 기본 period | 5 / 10 / 20 / 60 / 120 (캔들 개수) |
| period 편집 | number input, 범위 2..400 |
| 색상 | 인덱스 0..4가 분홍/파랑/주황/녹색/하양, `tokens.css`에 등록 |
| 초기 상태 | 5개 전부 ON |
| 범위 | 탭별 (`ChartViewPrefs` 확장), 새로고침 시 리셋 |
| 차트 위치 | `paneIndex=0` overlay (캔들과 동일 pane) |
| 컴포넌트 패턴 | `RangeSeriesPane` + `MOVING_AVERAGE_SPEC: PaneSpec` (CONTEXT.md "RangeSeriesPane") |

## 3. 아키텍처

```
Toolbar.tsx (기존)
  [종목] [날짜] [⚙ Settings] [Reload]
                 │
                 ▼
SettingsModal.tsx (기존, 확장)
  Category: 'chart' | 'indicators'   ← 'indicators' 추가
  ┌── Sidebar 180px ─────┬── Content flex-1 ──────────────┐
  │ ● 차트               │  ChartSettingsSection            │
  │ ○ 보조지표           │  ── 또는 ──                      │
  │                      │  IndicatorsSection (신규)        │
  └──────────────────────┴──────────────────────────────────┘
                                  │
                                  ▼
                  IndicatorsSection.tsx (신규)
                  "Moving Average" 헤더
                    MA  5  [✓]  [  5 ]  ● --ma-1 (분홍)
                    MA 10  [✓]  [ 10 ]  ● --ma-2 (파랑)
                    MA 20  [✓]  [ 20 ]  ● --ma-3 (주황)
                    MA 60  [✓]  [ 60 ]  ● --ma-4 (녹색)
                    MA120  [✓]  [120 ]  ● --ma-5 (하양)

ChartStage.tsx (기존, 확장)
  ├ RangeSeriesPane paneIndex=0 spec=CANDLE_SPEC          (기존)
  ├ RangeSeriesPane paneIndex=0 spec=MOVING_AVERAGE_SPEC  (신규 overlay)
  ├ RangeSeriesPane paneIndex=1 spec=VOLUME_SPEC          (기존)
  ├ RangeSeriesPane paneIndex=2 spec=RATIO_SPEC           (기존)
  ├ RangeSeriesPane paneIndex=3 spec=QUOTE_TOTALS_SPEC    (기존)
  ├ RangeSeriesPane paneIndex=4 spec=FILL_STRENGTH_SPEC   (기존)
  └ VolumeProfileOverlay / DayBoundaryOverlay             (기존)

Prefs 흐름
  IndicatorsSection ──setMovingAverage──▶ useTabsStore.prefs.movingAverages
                                                  │
                                                  ▼
                                          ChartPrefsProvider (기존)
                                                  │
                                                  ▼ useChartPrefs()
                                          MOVING_AVERAGE_SPEC.useContext
                                                  │
                                                  ▼ ctx → 각 series data()
                                          RangeSeriesPane → setData
```

## 4. 데이터 모델 (state/tabs.ts 확장)

```ts
export type MAConfig = {
  period: number;   // 정수, 2..400
  enabled: boolean;
};

export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  movingAverages: MAConfig[];          // 길이 5 고정, 인덱스 ↔ MA_COLORS 매핑
} & { [K in ChartToggleKey]: boolean };

export const DEFAULT_MOVING_AVERAGES: readonly MAConfig[] = Object.freeze([
  { period: 5,   enabled: true },
  { period: 10,  enabled: true },
  { period: 20,  enabled: true },
  { period: 60,  enabled: true },
  { period: 120, enabled: true },
]);
```

`DEFAULT_PREFS`에 `movingAverages: [...DEFAULT_MOVING_AVERAGES]`를 추가한다 (mutable copy로 — store 내부 갱신 대응).

새 액션:

```ts
setMovingAverage(tabId: string, index: 0|1|2|3|4, patch: Partial<MAConfig>): void
```

기존 `setToggle` / `setVolumeProfileMode`와 동일하게 `prefs` Map을 immutably 갱신, 길이 5 invariant를 액션 내부에서 보장.

## 5. 색상 토큰 (tokens.css)

`tokens.css`의 색상 섹션(hand-edited, ADR-0012는 size/spacing만 generator 관리)에 추가:

```css
/* ───── Color · Moving Average ─────
   Per spec 2026-05-23-replay-moving-average-design.md §5.
   HTS 관습을 따른 5색 팔레트. price-up/down 토큰과 색역이 다른 채도(분홍/파랑/주황/녹색/하양)
   를 골라 KRX 가격 방향 색(빨강/파랑)과 시각적으로 분리한다. */
--ma-1: #EC4899; /* period 5  */
--ma-2: #3B82F6; /* period 10 */
--ma-3: #F97316; /* period 20 */
--ma-4: #22C55E; /* period 60 */
--ma-5: #F8FAFC; /* period 120 */
```

`tailwind.config.ts` 색상 섹션에도 동일하게 `ma-1..ma-5` 등록 (IndicatorsSection의 색 dot에 사용).

`projectors/movingAverage.ts`는 `resolveTokens` 헬퍼로 fallback hex를 가지며, lightweight-charts canvas의 line color도 동일한 토큰을 통해 얻는다 — KRX `--price-up/down` 토큰 차용 패턴(`ratio.ts`)과 동일.

## 6. PaneSpec (projectors/movingAverage.ts, 신규)

```ts
import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useChartPrefs } from '../ChartPrefsContext';
import type { PaneSpec, SeriesSpec } from '../RangeSeriesPane';
import type { MAConfig } from '../../state/tabs';

const TOKEN_SPEC = {
  ma1: ['--ma-1', '#EC4899'],
  ma2: ['--ma-2', '#3B82F6'],
  ma3: ['--ma-3', '#F97316'],
  ma4: ['--ma-4', '#22C55E'],
  ma5: ['--ma-5', '#F8FAFC'],
} as const;

const colors = resolveTokens(TOKEN_SPEC);
export const MA_COLORS = [colors.ma1, colors.ma2, colors.ma3, colors.ma4, colors.ma5];

/** SMA over close prices. Returns array of length `closes.length`;
 *  values before period-1 are `null` (rendered as whitespace). */
export function computeSMA(closes: number[], period: number): (number | null)[];

type MAContext = { configs: readonly MAConfig[] };

const useMAContext = (): MAContext => ({
  configs: useChartPrefs().movingAverages,
});

function makeSeries(index: 0 | 1 | 2 | 3 | 4): SeriesSpec<MAContext> {
  return {
    type: LineSeries,
    options: {
      color: MA_COLORS[index],
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    },
    data: (bundle: RangeBundle, axis: VirtualAxis, ctx: MAContext) => {
      const cfg = ctx.configs[index];
      if (!cfg || !cfg.enabled) return [];                  // disabled → 빈 시리즈
      const closes = bundle.candles.map((c) => c.close);
      const sma = computeSMA(closes, cfg.period);
      const out: any[] = [];
      for (let i = 0; i < bundle.candles.length; i++) {
        const c = bundle.candles[i];
        if (!axis.contains(c.ts_ms)) continue;
        const v = sma[i];
        const time = (axis.toVirtual(c.ts_ms) / 1000) as any;
        // whitespaceData: { time } only (no value) — lightweight-charts에서
        // 선이 끊겨 보이지 않고 period 충족 시점부터 그려진다.
        out.push(v == null ? { time } : { time, value: v });
      }
      return out;
    },
  };
}

export const MOVING_AVERAGE_SPEC: PaneSpec<MAContext> = {
  name: 'moving-average',
  stretch: 0,                              // overlay — pane stretch 영향 없음
  useContext: useMAContext,
  series: [makeSeries(0), makeSeries(1), makeSeries(2), makeSeries(3), makeSeries(4)],
};
```

**왜 5개 series 정적 정의인가?** `RangeSeriesPane`은 `spec` identity가 바뀌면 전체 series를 unmount/remount한다. enabled toggle마다 spec을 다시 만들면 5개 모두가 매번 재마운트되어 깜빡거림이 발생한다. series 5개를 정적으로 유지하고 disabled는 빈 데이터로 처리하면, `ctx` 변경만으로 `setData(...)`가 다시 호출되어 깔끔하다 — `RangeSeriesPane`의 effect 의존성에 `ctx`가 포함되어 있어 이 동작이 보장된다.

**왜 `stretch: 0`인가?** ChartStage의 stretch 적용 로직은 `PANE_SPECS` 배열을 기준으로 한다. MA는 그 배열에 속하지 않고 paneIndex=0의 overlay이므로 자체 stretch 값이 의미 없다 — `0` 또는 어떤 값이든 무시된다. 명시적으로 `0`을 두어 "이 spec은 stretch에 참여하지 않는다"를 신호한다.

## 7. ChartStage.tsx 변경

`MOVING_AVERAGE_SPEC` 임포트, candle 다음 줄에 한 RangeSeriesPane 마운트:

```tsx
<div data-pane="candle" className="hidden">
  <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} spec={CANDLE_SPEC} />
</div>
<div data-pane="moving-average" className="hidden">
  <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} spec={MOVING_AVERAGE_SPEC} />
</div>
```

`PANE_SPECS` 배열은 건드리지 않는다 — stretch 분배는 5개 pane(0..4) 기준 그대로.

순서 주의: lightweight-charts는 paneIndex 클램프 규칙이 있다 (ChartStage 주석 참조). MA는 paneIndex=0이고 candle보다 뒤에 마운트되므로, candle이 먼저 pane 0을 차지한 뒤 MA의 5개 LineSeries가 같은 pane 0에 얹힌다.

## 8. SettingsModal.tsx 변경

`Category` 타입 확장:

```ts
type Category = 'chart' | 'indicators';
```

사이드바 nav에 두 번째 버튼 추가 (기존 "차트" 버튼과 동일한 스타일):

```tsx
<button
  type="button"
  onClick={() => setCategory('indicators')}
  aria-pressed={category === 'indicators'}
  className={category === 'indicators' ? ACTIVE : INACTIVE}
>
  보조지표
</button>
```

콘텐츠 영역에 IndicatorsSection 분기 추가:

```tsx
{category === 'indicators' && <IndicatorsSection />}
```

## 9. IndicatorsSection.tsx (신규)

```tsx
export default function IndicatorsSection() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  const setMA = useTabsStore((s) => s.setMovingAverage);
  return (
    <section>
      <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">보조지표</h3>
      <div className="mb-3 text-fg-dim text-xs uppercase tracking-[0.08em] font-semibold">
        Moving Average
      </div>
      <div className="flex flex-col gap-3">
        {prefs.movingAverages.map((cfg, i) => (
          <MovingAverageRow
            key={i}
            index={i}
            config={cfg}
            onChange={(patch) => setMA(activeTabId, i as 0|1|2|3|4, patch)}
          />
        ))}
      </div>
    </section>
  );
}
```

`MovingAverageRow`는 같은 파일 내 helper:

- grid `[24px_1fr_72px_16px]`, `items-center gap-3`
- 체크박스: 14×14px (커스텀 또는 native + 토큰 색)
- 라벨 `MA {cfg.period}` (`text-sm text-fg`, tabular-nums)
- period input: `<input type="number" min={2} max={400} step={1}>` (`w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums`)
- 색 dot: 12×12px `rounded-full`, `style={{ backgroundColor: \`var(--ma-\${index+1})\` }}`

**period input UX**
- 로컬 state로 입력 중 값 유지 (`useState<string>`).
- `onChange`: 로컬 state만 갱신.
- `onBlur` / `Enter`: parse → integer 2..400 범위면 `setMovingAverage(...)`, 아니면 직전 유효값(`config.period`)으로 복원.
- 부모 `config.period` 외부 변경(예: tab switch) 시 `useEffect`로 로컬 state 동기화.

## 10. SMA 알고리즘 (computeSMA)

`projectors/movingAverage.ts`에 export. 표준 sliding window:

```ts
export function computeSMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n);
  if (period < 1 || period > n) {
    for (let i = 0; i < n; i++) out[i] = period === 1 ? closes[i] : null;
    return out;
  }
  let sum = 0;
  for (let i = 0; i < period - 1; i++) {
    sum += closes[i];
    out[i] = null;
  }
  sum += closes[period - 1];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
}
```

엣지 케이스:
- `period < 2` 입력은 UI에서 차단되지만 헬퍼는 안전하게 처리: `period === 1` → close 그대로, `period === 0`/음수 → 전부 null.
- `period > closes.length`: 전부 null.
- 빈 배열: 빈 배열.

## 11. Timeframe 상호작용

ADR-0014에 따라 모든 시리즈가 단일 timeframe 공유. `bundle.candles`는 timeframe별로 새로 fetch되며, MA는 그 위에서 계산되므로 timeframe 변경 시 자동 재계산. period UI 단위는 "캔들 개수"로 의미가 timeframe에 의존 — HTS 관습이며 의도된 동작이다.

## 12. 테스트

**유닛**
- `frontend/src/chart/projectors/movingAverage.test.ts`
  - `computeSMA([1,2,3,4,5], 3) === [null, null, 2, 3, 4]`
  - `computeSMA([], 5) === []`
  - `computeSMA([1,2,3], 5) === [null, null, null]` (period > length)
  - `computeSMA([1,2,3], 1) === [1, 2, 3]`
  - `projectCandle`처럼 axis mock으로 series projector 통합 테스트:
    - enabled=true → period-1 이후부터 값 존재
    - enabled=false → 빈 배열
    - axis.contains=false인 캔들은 skip

- `frontend/src/replay/settings/IndicatorsSection.test.tsx`
  - 5행 렌더
  - 체크박스 클릭 → `setMovingAverage(tabId, idx, { enabled: !prev })` 호출
  - period input blur (정상 값) → `setMovingAverage(tabId, idx, { period: N })`
  - period input blur (1, 401, "abc") → 스토어 미호출, 로컬 값 복원
  - 색 dot의 `style.backgroundColor`가 `var(--ma-{i+1})`

**컴포넌트 통합 — 신규 안 함**: `RangeSeriesPane`은 이미 테스트 커버되어 있고 `MOVING_AVERAGE_SPEC`은 PaneSpec 데이터 구조뿐. projector 테스트로 행위 검증.

**E2E 시나리오 추가** — `frontend/tests/e2e/replay-smoke.spec.ts`
- 종목 로드 → 기어 클릭 → 모달 → "보조지표" → MA 20 체크 해제 → "닫기" → store snapshot으로 `movingAverages[2].enabled === false` 검증 (canvas pixel 검증은 flaky하므로 회피).

## 13. 검증 체크리스트

수동 (`cd frontend && npm run dev`):

- [ ] 종목 로드 후 캔들 위에 5색 선(분홍/파랑/주황/녹색/하양) 표시
- [ ] 각 선이 첫 `period-1` 캔들 이후부터 시작 (period=120 선은 처음 119캔들 동안 보이지 않음)
- [ ] 기어 → 모달 → "보조지표" 사이드바 클릭 시 IndicatorsSection 렌더
- [ ] MA 20 체크 해제 시 주황 선만 사라짐 (다른 선 영향 없음)
- [ ] period 20 → 30 변경 후 blur 시 즉시 재계산
- [ ] period에 1, 401, "abc" 입력 후 blur → 직전 값으로 복원, 차트 변화 없음
- [ ] 다른 탭으로 전환 후 돌아오면 그 탭의 prefs 그대로 (탭별 격리)
- [ ] 새 탭은 디폴트(5개 ON, 5/10/20/60/120)
- [ ] 페이지 새로고침 → 디폴트로 리셋 (의도된 동작)
- [ ] timeframe 1m → 5m 전환 시 선이 새 캔들 위에서 재계산되어 자연스럽게 그려짐
- [ ] Settings 모달 첫 진입 시 "차트" 카테고리, "보조지표" 클릭하면 전환

테스트:
- `cd frontend && npm test`
- `cd frontend && npm run build && npx playwright test`

디자인 일관성:
- [ ] `tokens.css` 외부에 hex 색상 hardcode 없음 (`grep -nE "#[0-9A-Fa-f]{6}" frontend/src/chart/projectors/movingAverage.ts` → fallback만)
- [ ] DESIGN.md 토큰만 사용 (off-token spacing/font-size 없음)

## 14. Out of scope

- EMA, WMA, VWMA 등 다른 평균 방식
- 사용자 정의 색상
- 선 굵기/스타일(dashed) 변경
- 보조지표 프리셋 저장
- localStorage persist (Settings 전체 정책상 새로고침 리셋)
- Bollinger Band, MACD 등 다른 보조지표 (이 spec은 MA 한 종에 집중하되 PaneSpec 추가만으로 확장 가능한 구조를 마련)
