/**
 * 갱신 루프 덫의 **설치부** — 앱의 모든 zustand 스토어에 `subscribe` 로 붙어
 * `noteStoreWrite` 를 부른다. 판정·신고는 `updateLoopSignal.ts` 가 갖는다.
 *
 * ## 왜 `subscribe` 인가 — `setState` 를 감싸지 않고
 *
 * zustand 의 액션은 스토어를 만들 때 받은 **내부 `set` 클로저**로 쓴다. `api.setState`
 * 를 갈아끼워도 그 클로저는 그대로라 **액션의 쓰기가 전부 새어 나간다** — 정작 우리가
 * 잡아야 할 경로다. 반면 `subscribe` 리스너는 `setState` **안에서 동기적으로** 돌므로
 * ① 액션이든 직접 호출이든 빠짐없이 보이고 ② 그 안에서 뜬 스택에 **쓴 쪽의 프레임이
 * 그대로 들어 있다**. 구독은 동작을 바꾸지도 않는다(관측만 한다는 계약).
 *
 * ## DEV 전용, 그리고 test 제외
 *
 * vitest 는 `import.meta.env.DEV` 가 **참**이다. 테스트는 스토어를 한 틱에 수십 번
 * 두드리는 것이 정상이라 그대로 켜면 콘솔이 신고로 덮인다. 그래서 `MODE === 'test'`
 * 를 함께 본다. 프로덕션에서는 호출부(`main.tsx`)의 `import.meta.env.DEV` 분기가
 * 통째로 제거되므로 이 모듈은 번들에 들어가지도 않는다.
 *
 * ## 목록 관리
 *
 * 새 zustand 스토어를 만들면 여기 한 줄을 더한다. 빠뜨리면 **그 스토어가 범인일 때만**
 * 조용히 못 잡는다(덫이 틀린 답을 주지는 않는다 — 다른 스토어의 폭주는 그대로 잡힌다).
 * 손수 만든 발행 채널(`subscribe` 가 없는 것)은 자기 알림 함수에서 `noteStoreWrite` 를
 * 직접 부른다 — 지금은 `groupChartLinkSource` · `windowWarningsSource` 둘이다. 둘 다
 * `ChartWindow` 의 이펙트(와 그 cleanup)에서만 발행하므로 스택에 react-dom 이 있고,
 * `updateLoopSignal` 의 react-dom 게이트를 통과한다 — 새 채널을 만들 때는 **발행이
 * React 밖(WS 콜백·rAF)에서 나면 게이트가 자른다**는 것을 알고 붙일 것(그 경우엔
 * 애초에 「Maximum update depth exceeded」를 던지지도 않으므로 표적 밖이다).
 */
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useDailyMaSeriesRegistry } from '../live/indicators/dailyMaSeriesRegistry';
import { useMaSeriesRegistry } from '../live/indicators/maSeriesRegistry';
import { usePaneLegendRegistry } from '../live/indicators/paneLegendRegistry';
import { usePeakWallCountsRegistry } from '../live/indicators/peakWallCountsRegistry';
import { usePeakWallStepsRegistry } from '../live/indicators/peakWallStepsRegistry';
import { useChartPrefsStore } from './chartPrefs';
import { useDrawingsStore } from './drawings';
import { useEntryDragStore } from './entryDrag';
import { useHeatmapPrefsStore } from './heatmapPrefs';
import { useInvestorDailySpanStore } from './investorDailySpan';
import { useInvestorEstimateUnitStore } from './investorEstimateUnit';
import { useKiwoomFullHouseStore } from './kiwoomFullHouse';
import { useLiveLayoutStore } from './liveLayout';
import { useLivePageStore } from './livePage';
import { useLivePromotionStore } from './livePromotion';
import { useLiveVenueStore } from './liveVenue';
import { useRestBypassModeStore } from './restBypassMode';
import { useRightRailStore } from './rightRail';
import { useScreenerPanelStore } from './screenerPanel';
import { useSignalAlertInboxStore } from './signalAlertInbox';
import { useThemePrefsStore } from './themePrefs';
import { useViewportStore } from './viewport';
import { useWorkspaceStore } from './workspace';
import { armUpdateLoopSignal, noteStoreWrite } from './updateLoopSignal';

/** 구독만 필요한 최소 형태 — 스토어들의 상태 타입이 전부 달라 여기서 지운다. */
type Subscribable = { subscribe: (listener: () => void) => () => void };

const WATCHED: readonly (readonly [string, Subscribable])[] = [
  ['chartPrefs', useChartPrefsStore],
  ['drawings', useDrawingsStore],
  ['entryDrag', useEntryDragStore],
  ['heatmapPrefs', useHeatmapPrefsStore],
  ['investorDailySpan', useInvestorDailySpanStore],
  ['investorEstimateUnit', useInvestorEstimateUnitStore],
  ['kiwoomFullHouse', useKiwoomFullHouseStore],
  ['liveCursor', useLiveCursorStore],
  ['liveLayout', useLiveLayoutStore],
  ['livePage', useLivePageStore],
  ['livePromotion', useLivePromotionStore],
  ['liveVenue', useLiveVenueStore],
  ['restBypassMode', useRestBypassModeStore],
  ['rightRail', useRightRailStore],
  ['screenerPanel', useScreenerPanelStore],
  ['signalAlertInbox', useSignalAlertInboxStore],
  ['themePrefs', useThemePrefsStore],
  ['viewport', useViewportStore],
  ['workspace', useWorkspaceStore],
  ['registry:maSeries', useMaSeriesRegistry],
  ['registry:dailyMaSeries', useDailyMaSeriesRegistry],
  ['registry:paneLegend', usePaneLegendRegistry],
  ['registry:peakWallSteps', usePeakWallStepsRegistry],
  ['registry:peakWallCounts', usePeakWallCountsRegistry],
];

let unsubscribes: (() => void)[] = [];

/** 덫을 놓는다. 두 번 불러도 구독이 겹치지 않는다(HMR 안전). */
export function installUpdateLoopWatch(): () => void {
  uninstallUpdateLoopWatch();
  armUpdateLoopSignal();
  unsubscribes = WATCHED.map(([name, store]) => store.subscribe(() => noteStoreWrite(name)));
  return uninstallUpdateLoopWatch;
}

export function uninstallUpdateLoopWatch(): void {
  unsubscribes.forEach((off) => off());
  unsubscribes = [];
}

/** 감시 대상 이름 — 테스트가 목록 누락을 재는 데 쓴다. */
export function watchedStoreNames(): readonly string[] {
  return WATCHED.map(([name]) => name);
}
