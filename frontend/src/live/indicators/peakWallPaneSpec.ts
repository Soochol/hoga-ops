// 최대벽 강도 pane 의 PaneSpec — 기존 「당일 최대벽」의 시간축 표현.
//
// ## 이 파일이 chart/projectors 가 아니라 live/ 에 있는 이유
//
// `useContext` 가 창 스코프(`useWindowScopeId`)와 계단 레지스트리를 구독하는데 둘 다
// live/ 계층이다. chart/ 는 live/ 에 런타임 의존하지 않는다는 규칙이 있으므로
// (`RangeSeriesPane` 의 onLegendReady 가 콜백인 이유와 동일), spec 이 live/ 로 온다.
// 마운트 경로도 `chart/paneSpecs.PANE_SPECS` 가 아니라 `paneSpecsForTimeframe` 의
// `GATED` append 다 — 투자자 pane 과 같은 방식. `PANE_SPECS` 에 넣으면 all-base
// 캐시 시드(`ALL_BASE_KEY`)가 어긋나 `=== PANE_SPECS` identity 계약이 깨진다
// (프로토타입에서 실측: 관련 테스트 16건 실패).
//
// ## 데이터는 번들이 아니라 레지스트리에서 온다
//
// 값은 `LiveChartRoot` 가 `usePeakWallRender` 세그먼트로 만든 계단이다
// (`peakWallStepsRegistry` 주석 참조). 그래서 `data` 는 ctx pass-through 이고
// 번들·축 인자를 쓰지 않는다 — 오버레이의 모든 필터(체결된 벽 판정·표시 개수·
// MA 필터·시간 컷오프·intraMax)가 상류에서 이미 적용된 결과를 받는다.

import { LineSeries, LineType, type LineData, type Time } from 'lightweight-charts';
import { useMemo } from 'react';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneSpec } from '../../chart/RangeSeriesPane';
import type { PeakWallStepPoint } from '../../chart/peakWallSteps';
import { formatKoreanInt } from '../../util/koreanNumber';
import { formatQtyCompact } from '../../util/formatQtyCompact';
import { useWindowScopeId } from '../workspace/windowView';
import { scopeEntries } from './windowScopedRegistry';
import {
  PEAK_WALL_STEP_SLOTS,
  usePeakWallStepsRegistry,
  type PeakWallStepKey,
} from './peakWallStepsRegistry';

/** 슬롯 키 → 계단 점. 키 목록은 `PEAK_WALL_STEP_SLOTS` 하나에서만 온다. */
export type PeakWallPaneCtx = Readonly<Record<PeakWallStepKey, readonly PeakWallStepPoint[]>>;

/** 등록 전(첫 렌더)·스코프 미스에 돌려줄 **공유** 빈 배열 — 매번 새 `[]` 를 만들면
 *  ctx 참조가 흔들려 data effect 가 헛돈다. */
const EMPTY_POINTS: readonly PeakWallStepPoint[] = [];

const usePeakWallPaneContext = (): PeakWallPaneCtx => {
  const scope = useWindowScopeId();
  const slots = usePeakWallStepsRegistry((s) => scopeEntries(s.byScope, scope));
  // 슬롯 6개를 각각 꺼내 memo deps 로 편다 — Map 자체를 dep 으로 쓰면 참조가 매번
  // 달라져(스토어가 새 Map 을 낸다) ctx 가 흔들리고 data effect 가 헛돈다.
  const points = PEAK_WALL_STEP_SLOTS.map((s) => slots.get(s.key)?.points ?? EMPTY_POINTS);
  return useMemo(
    () => Object.fromEntries(
      PEAK_WALL_STEP_SLOTS.map((slot, i) => [slot.key, points[i]]),
    ) as PeakWallPaneCtx,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 위 주석: 슬롯별 참조로 편다.
    points,
  );
};

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => formatKoreanInt(v),
  minMove: 1,
};

// 색은 점에 실려 온다(per-point color — LiveChartRoot 가 askPeakColor/bidPeakColor 를
// 계단 점에 박는다). 시리즈 기본색은 등록 전 빈 상태에서만 의미가 있어 아무거나 무방.
const lineOptions = {
  // 계단 렌더 — 점 사이를 대각선이 아니라 수직+수평으로 잇는다. 이 pane 의 값이
  // "당일 누적 최대" 라 상승이 사건(갱신)이지 추세가 아니기 때문.
  lineType: LineType.WithSteps,
  lineWidth: 2 as const,
  priceScaleId: 'right',
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
  priceFormat,
};

const dataFor = (key: PeakWallStepKey) => (
  _bundle: RangeBundle, _axis: VirtualAxis, ctx: PeakWallPaneCtx,
): LineData<Time>[] => ctx[key].slice();

export const PEAK_WALL_SPEC = {
  name: 'peak-wall' as const,
  // 셀 라벨(매도/매수)이 방향만 말하므로 pane 제목이 지표를 밝힌다 — 총잔량·체결강도와
  // 같은 근거(라벨이 pane 간 중복되는 다중 셀 pane).
  legendTitle: '최대벽',
  // 레전드 ✕ → setPanePrefForTimeframe(timeframe, key, false) — 이 키는
  // INDICATOR_PANE_PREF_KEYS 소속이라 per-timeframe 버킷에 기록된다.
  legendToggleKey: 'peakWallPaneEnabled' as const,
  // 계단은 대부분 평평해(하루 1~3회 갱신 — 프로토타입 실측) 총잔량 pane 의 0.3 은
  // 과하다. 0.2 로 시작한다(구현 계획 §5.3 — PR 3 에서 실화면으로 확정).
  stretch: 0.2,
  // bundleKind 없음(기본 candle 그릇): 이 pane 은 번들을 읽지 않지만, SSE 틱마다
  // 참조가 바뀌는 그릇을 받으면 data effect 가 틱마다 헛돈다 — 안정 참조 그릇이 맞다.
  useContext: usePeakWallPaneContext,
  // 계열별 series — 레전드 라벨과 데이터 키가 **같은 상수**에서 파생된다
    // (`PEAK_WALL_STEP_SLOTS`). 손으로 두 벌 적으면 한쪽이 조용히 빈 슬롯을 읽는다.
    //
    // 스와치 없음: 선 색은 창별 사용자 설정이 점에 실려 오는데, legend meta 의 color
    // thunk 는 모듈 레벨이라 자기 창을 모른다 — 전역 투영을 읽으면 다른 창에서 틀린
    // 색이 나온다. 라벨이 방향·계열을 이미 말하므로 생략한다.
    // 값 포맷은 도킹 라벨의 잔량부와 **같은 함수**(formatQtyCompact) — 두 표면이
    // 같은 벽을 다르게 읽으면 안 된다(#839 의 규율).
  series: PEAK_WALL_STEP_SLOTS.map((slot) => ({
    type: LineSeries,
    legend: { label: slot.label, format: formatQtyCompact },
    options: lineOptions,
    data: dataFor(slot.key),
  })),
} satisfies PaneSpec<PeakWallPaneCtx>;
