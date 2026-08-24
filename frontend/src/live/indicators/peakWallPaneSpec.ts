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
import { usePeakWallStepsRegistry } from './peakWallStepsRegistry';

export type PeakWallPaneCtx = {
  ask: readonly PeakWallStepPoint[];
  bid: readonly PeakWallStepPoint[];
};

/** 등록 전(첫 렌더)·스코프 미스에 돌려줄 **공유** 빈 배열 — 매번 새 `[]` 를 만들면
 *  ctx 참조가 흔들려 data effect 가 헛돈다. */
const EMPTY_POINTS: readonly PeakWallStepPoint[] = [];

const usePeakWallPaneContext = (): PeakWallPaneCtx => {
  const scope = useWindowScopeId();
  const slots = usePeakWallStepsRegistry((s) => scopeEntries(s.byScope, scope));
  const ask = slots.get('ask')?.points ?? EMPTY_POINTS;
  const bid = slots.get('bid')?.points ?? EMPTY_POINTS;
  return useMemo(() => ({ ask, bid }), [ask, bid]);
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

const askData = (
  _bundle: RangeBundle, _axis: VirtualAxis, ctx: PeakWallPaneCtx,
): LineData<Time>[] => ctx.ask.slice();
const bidData = (
  _bundle: RangeBundle, _axis: VirtualAxis, ctx: PeakWallPaneCtx,
): LineData<Time>[] => ctx.bid.slice();

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
  series: [
    // 스와치 없음: 선 색은 창별 사용자 설정(askPeakColor/bidPeakColor)이 점에 실려
    // 오는데, legend meta 의 color thunk 는 모듈 레벨이라 자기 창을 모른다 — 전역
    // 투영을 읽으면 다른 창에서 틀린 색이 나온다. 라벨(매도/매수)이 방향을 이미
    // 말하므로 생략한다(거래량 pane 의 per-bar 색 생략과 같은 결).
    // 값 포맷은 도킹 라벨의 잔량부와 **같은 함수**(formatQtyCompact) — 두 표면이
    // 같은 벽을 다르게 읽으면 안 된다(#839 의 규율).
    {
      type: LineSeries,
      legend: { label: '매도', format: formatQtyCompact },
      options: lineOptions,
      data: askData,
    },
    {
      type: LineSeries,
      legend: { label: '매수', format: formatQtyCompact },
      options: lineOptions,
      data: bidData,
    },
  ],
} satisfies PaneSpec<PeakWallPaneCtx>;
