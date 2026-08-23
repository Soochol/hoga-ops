/**
 * ChartWindow — 워크스페이스 차트 창의 실 콘텐츠 (ADR-0119 PR-C2b·C2c-2c).
 *
 * 창의 (group→종목, timeframe)로 창별 독립 데이터 파이프라인(`useLiveChartData`)을
 * 돌리고 실제 `LiveChartRoot` 를 렌더한다. 여기서 멀티창 시맨틱이 처음 활성화된다.
 * 지표는 창이 싣지 않는다 — 전역 1세트를 창의 봉으로 편 값을 `useWindowIndicators`
 * 가 컨텍스트 안에서 읽는다.
 *
 * **Provider 경계**: 컴포넌트는 자신이 렌더하는 Provider 의 *바깥*이므로, 훅 호출을
 * Provider 안으로 넣으려면 바깥(`ChartWindow`, Provider 설정)과 안쪽(`ChartWindowInner`,
 * Provider 자식에서 훅 호출)으로 쪼갠다. 안쪽에서 `useWindowView`/`useWindowIndicators`
 * 가 창의 값을 보고, `useLiveChartData` 내부의 `useLiveBundle` 도 같은 컨텍스트라 창의
 * 지표/historicalFromDate 로 페치한다.
 *
 * C2c-2c: 지수 심볼(GroupSymbol.kind='index') 1급 지원 — livePage 시맨틱 미러
 * (view.code=null·instrument=index, 파이프라인의 activeIndexId 분기 재사용).
 * 창 내 봉 컨트롤(TimeframeControl→setChartTimeframe) + 포커스 창의 상태바 발행.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveChartRoot } from '../LiveChartRoot';
import { ChartDrawingShell } from '../ChartDrawingShell';
import ChartErrorBoundary from '../../chart/ChartErrorBoundary';
import { useLiveChartData } from '../useLiveChartData';
import {
  useSeedWindowIndicatorScope,
  WindowViewContext,
  useWindowView,
  useWindowIndicators,
  type WindowViewValue,
} from './windowView';
import { indexInstrument, isLiveIndexId, stockInstrument } from '../liveInstrument';
import { focusLiveSearch } from '../liveSearchFocus';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useEffectiveVenue } from '../useEffectiveVenue';
import {
  groupTargetChartWindow,
  useWorkspaceStore,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';
import {
  publishGroupChartLink,
  clearGroupChartLink,
  type GroupChartLink,
} from './groupChartLinkSource';
import { TimeframeControl } from '../TimeframeControl';
import { DrawingMenu } from '../DrawingMenu';
import { IndicatorsButton } from '../LiveToolbar';
import { requestIndicatorDrawer } from './indicatorDrawerControls';
import { useChartHeaderFold } from './useChartHeaderCompact';
import {
  publishWindowWarnings,
  clearWindowWarnings,
  type WindowWarnings,
} from './windowWarningsSource';
import type { LiveStudySaveSource } from '../../studyViews/studySaveCommand';
import { LiveStudyViewSaveButton } from '../../studyViews/LiveStudyViewSaveButton';
import {
  useLivePageStore,
  isMinuteTimeframe,
  type CalendarTimeframe,
} from '../../state/livePage';
import { SAVED_RANGE_VENUE } from '../../studyViews/savedRangeFocus';
import { studyDailyViewport, studySavedRangeMarks } from '../../studyViews/studyDailyContext';
import { savedRangeNotice } from '../savedRangeNotice';
import { countBarsInRange } from '../savedRangeAnchor';
import type { Candle } from '../../api/types';
import { SavedRangeChip } from './SavedRangeChip';
import { CollectButton } from './CollectButton';
import { WatchlistHeartActionButton } from './WatchlistHeartActionButton';
import {
  HogaplaySourceButton,
  type HogaplaySourceDisabledReason,
} from './HogaplaySourceButton';
import { HogaplaySourceChip, type HogaplayChipGapFill } from './HogaplaySourceChip';
import {
  showsHeaderStateIcons,
  showsWatchlistHeart,
  LIVE_CALENDAR_HEADER_FOLD,
  LIVE_HEADER_FOLD,
} from './chartHeaderCompact';
import { JumpToMinuteButton } from './JumpToMinuteButton';
import type { JumpRange } from '../minuteJumpDestination';
import { MinuteJumpChip } from './MinuteJumpChip';
import { canPublishTimeframeJump } from '../../chart/timeframeJump';
import { jumpReceiverIds, registerJumpRunner } from './jumpControls';
import { useLiveCursorStore } from '../useLiveCursorStore';
import type { MinuteJumpState } from '../useTimeframeJump';
import { useWatchlistMembership } from '../../watchlist/useWatchlistMembership';
import type { CollectVisibleRange } from './collectDialogControls';
import { unixMsToKSTDate } from '../../util/time';
import { clearWindowFlagLegendValues } from '../indicators/flagLegendValueRegistry';
import { useMaSeriesRegistry } from '../indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from '../indicators/dailyMaSeriesRegistry';
import { usePaneLegendRegistry } from '../indicators/paneLegendRegistry';
import type { TabViewport } from '../viewportAnchor';

/** 빈 캔들 폴백 — **모듈 상수여야 한다.** 인라인 `[]` 는 매 렌더 새 배열이라
 *  아래 저장뷰 `useMemo` 들이 캔들이 안 왔을 때 매번 재계산된다. */
const EMPTY_CANDLES: readonly Candle[] = [];

export function ChartWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  const timeframe = win.chart?.timeframe ?? '1m';
  // 창별 팬 백필 from-date — 비영속 런타임(#713 뷰포트 비저장, 세션 한정).
  // 좌측 팬이 useHistoricalRangeActions 로 확장하면 이 값이 창의 페치를 re-key 한다.
  const historicalFromDate = useWorkspaceStore(
    (s) => s.chartRuntime[win.id]?.historicalFromDate ?? null,
  );
  const isIndex = symbol?.kind === 'index';
  // 이 창에 자기 지표 세트가 있는지 보장한다(ADR-0152) — `addWindow` 가 안 거친
  // 경로(업그레이드 직후의 기존 창·프리셋 적용·딥링크 탭)의 안전망. 멱등이다.
  useSeedWindowIndicatorScope(win.id);

  const view: WindowViewValue = useMemo(
    () => ({
      windowId: win.id,
      group: win.group,
      // 지수는 activeCode=null 시맨틱 미러(전역 instrumentToActiveCode 와 동일) —
      // 수집·WS·드로잉 등 code 게이트가 그대로 동작한다.
      code: isIndex ? null : symbol?.code ?? null,
      timeframe,
      historicalFromDate,
    }),
    [win.id, win.group, isIndex, symbol?.code, timeframe, historicalFromDate],
  );

  // 창 닫힘 시 이 창의 flag 레전드 provider 정리(비반응형 모듈 Map — 누수 방지).
  // 오버레이 4종은 자기 effect cleanup 으로도 해제하지만, ratio 의 broker late-entry
  // 는 projector 경로라 언마운트 훅이 없다. 언마운트 cleanup 은 자식 → 부모 순이라
  // 이 정리는 항상 자식들의 해제 뒤에 돌고, 재마운트 시엔 자식 등록이 먼저다.
  useEffect(() => () => {
    clearWindowFlagLegendValues(win.id);
    // 창 스코프 레지스트리 3종도 같은 지점에서 턴다. 자식 오버레이가 자기 cleanup
    // 으로 대부분 해제하지만, 해제가 throw 하거나(차트 파괴 레이스) 건너뛴 잔여가
    // 있으면 닫힌 창의 series 핸들이 남는다 — 창 수명에 묶인 단일 정리 지점.
    useMaSeriesRegistry.getState().clearScope(win.id);
    useDailyMaSeriesRegistry.getState().clearScope(win.id);
    usePaneLegendRegistry.getState().clearScope(win.id);
  }, [win.id]);

  return (
    <WindowViewContext.Provider value={view}>
      <ChartWindowInner win={win} symbol={symbol} />
    </WindowViewContext.Provider>
  );
}

function ChartWindowInner({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  const view = useWindowView(); // 창의 값(Provider 안)
  const ind = useWindowIndicators();
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  // 차트 계통의 venue 해석은 **여기 한 곳**이다. 아래 `useLiveChartData` 와
  // `<LiveChartRoot venue=…>` 가 이 값을 그대로 물려받아, 캔들 오버레이 게이트
  // (`overlayLiveTrades*`)·현재가 라인(`freshLiveTradePrice`)·분봉 세션창·동시호가
  // 오버레이가 전부 같은 값을 본다. 내려보내지 않고 각자 스토어를 읽게 두면
  // `useLiveSeries` 가 KRX 로 통과시킨 프레임을 캔들 오버레이가 UN 기준으로 다시
  // 걸러 **이중 필터로 전멸**한다.
  //
  // 지수 창(`view.code` 가 KOSPI 등)은 심볼 마스터에 없어 해석이 항등이다.
  const resolvedVenue = useEffectiveVenue(view.code, selectedVenue);
  // ── 저장뷰 기간 (2026-08-21) ──────────────────────────────────────────
  //
  // **표시는 전 창, venue 고정은 저장뷰 종목 창만** — 두 개념을 가른다.
  //
  // 표시(밴드·착석·칩)가 종목을 안 보는 이유: 저장 구간은 **달력 위의 구간**이고
  // `studySavedRangeMarks` 는 그 창의 캔들에서 해당 기간 봉을 찾을 뿐이라 종목에
  // 의존하지 않는다. 그래서 여러 종목을 나란히 놓고 **같은 기간을 비교**하는 화면이
  // 된다(2026-08-21 사용자 결정 — 종전에는 저장뷰 종목 창에만 떴다).
  //
  // ⚠ **venue 고정은 같이 넓히면 안 된다.** KRX 고정의 근거는 "저장뷰가 가리키는
  // **그 종목**의 복기 데이터가 hogaplay(KRX 전용)" 인데, 다른 종목 창은 그 데이터를
  // 보는 게 아니라 같은 기간을 볼 뿐이다. 함께 풀면 저장뷰와 무관한 창까지 거래소가
  // 조용히 바뀐다.
  const savedRangeFocus = useLivePageStore((s) => s.savedRangeFocus);
  const savedRange = savedRangeFocus;
  /** 이 창이 저장뷰 **그 종목**을 그리는가 — venue 고정과 칩의 「KRX」 표기의 축. */
  const isSavedRangeSubject = savedRangeFocus !== null && view.code === savedRangeFocus.code;
  // 근거는 `SAVED_RANGE_VENUE` 도크스트링(ADR-0144 와 동일).
  // 훅은 항상 부르고 결과만 덮는다(조건부 호출 금지).
  const venue = isSavedRangeSubject ? SAVED_RANGE_VENUE : resolvedVenue;
  /**
   * 저장뷰 **얼림**(2026-08-21 사용자 결정: "멈춰 있다 — 저장한 그 날만 보인다").
   *
   * venue 고정과 **같은 축**이다 — `isSavedRangeSubject`, 즉 저장뷰가 가리키는 그 종목을
   * 그리는 창만. 다른 종목 창은 같은 기간을 볼 뿐이라 그 종목의 복기 데이터를 보는 게
   * 아니고, 함께 얼리면 저장뷰와 무관한 창까지 실시간이 멎는다.
   *
   * ⚠ **기간이 250일 벽 안인지 밖인지 묻지 않는다.** 규칙이 하나여야 "어떤 저장뷰는
   * 멈추고 어떤 건 안 멈춘다" 를 사용자가 예측할 필요가 없다. 벽 판정을 여기 넣으면
   * 그 경계일에 같은 저장뷰의 동작이 조용히 바뀐다(벽이 매일 하루씩 밀리므로).
   *
   * ⚠ **봉 게이트는 여기 있어야 한다** — 소비자가 둘이기 때문이다(`useLiveChartData` 와
   * `<LiveChartRoot savedRangeFrozen>`). 한쪽에서만 거르면 일봉 저장뷰 창이 "얼지는
   * 않는데 백필은 꺼진" 잡종이 된다(좌측 팬이 조용히 죽는다). 훅 안쪽에도 같은 게이트가
   * 있지만 그건 다른 호출자(`LivePage`)를 위한 방어이지 이 축의 소유자가 아니다.
   */
  const savedRangeFreeze = useMemo(
    () => (isSavedRangeSubject && savedRangeFocus && isMinuteTimeframe(view.timeframe)
      ? { fromDate: savedRangeFocus.fromDate, toDate: savedRangeFocus.toDate }
      : null),
    [isSavedRangeSubject, savedRangeFocus, view.timeframe],
  );
  /**
   * 창별 **hogaplay 저장 데이터 소스**(헤더 버튼, `ChartWindowRuntime.hogaplaySource`).
   *
   * 저장뷰 얼림과 **축이 다르다** — 저쪽은 "어느 구간", 이쪽은 "어느 소스". 그래서
   * 여기서는 `today` 도 라이브 SSE 도 페치 시작일도 건드리지 않는다(상세는
   * `useLiveBundle` 의 `hogaplaySourceEnabled` 3열 표).
   *
   * 얼린 창에서는 값을 내린다. 얼림이 이미 디스크라 데이터는 같지만, 켜 둔 채로
   * 두면 칩이 두 개 뜨면서 서로 다른 것을 말한다(하나는 고정 구간, 하나는 따라가는
   * 구간). 플래그 자체는 스토어에 남아 얼림이 풀리면 되살아난다.
   *
   * 분봉 게이트는 훅도 자기 몫으로 갖고 있지만(`useLiveBundle`), 여기 있는 것은
   * **버튼·칩의 표시 축**이라 별개다 — 훅 쪽만 있으면 캘린더 봉에서 칩이 남는다.
   */
  const hogaplaySourceFlag = useWorkspaceStore(
    (s) => s.chartRuntime[win.id]?.hogaplaySource ?? false,
  );
  const hogaplaySourceEnabled =
    hogaplaySourceFlag && savedRangeFreeze === null && isMinuteTimeframe(view.timeframe);

  // 그룹 차트 링크 발행자 게이트(ADR-0119 PR-D) — 그룹당 하나(z-최상위 차트 창).
  const isGroupLink = useWorkspaceStore(
    (s) => groupTargetChartWindow(s.windows, s.zOrder, win.group)?.id === win.id,
  );
  // 같은 그룹 데이터 창의 sidecar 수요 — 발행 창만 fetch 를 확장한다(중복 fetch 방지).
  const groupNeedsVdist = useWorkspaceStore(
    (s) => s.windows.some((w) => w.group === win.group && w.kind === 'vdist'),
  );
  const groupNeedsProgram = useWorkspaceStore(
    (s) => s.windows.some((w) => w.group === win.group && w.kind === 'program'),
  );
  const sidecarDemands = useMemo(
    () =>
      isGroupLink && (groupNeedsVdist || groupNeedsProgram)
        ? { programTrade: groupNeedsProgram, volumeDistribution: groupNeedsVdist }
        : undefined,
    [isGroupLink, groupNeedsVdist, groupNeedsProgram],
  );
  const setChartTimeframe = useWorkspaceStore((s) => s.setChartTimeframe);
  const rememberedMinute = useWorkspaceStore(
    (s) => s.windows.find((w) => w.id === win.id)?.chart?.lastMinuteTimeframe ?? '1m',
  );
  const investorNetEnabled = ind.foreignNetEnabled || ind.institutionNetEnabled;
  const instrument = useMemo(() => {
    if (!symbol) return null;
    if (symbol.kind === 'index') {
      return isLiveIndexId(symbol.code) ? indexInstrument(symbol.code, symbol.name) : null;
    }
    return stockInstrument(symbol.code, symbol.name);
  }, [symbol]);
  const d = useLiveChartData({
    activeCode: view.code,
    activeInstrument: instrument,
    timeframe: view.timeframe,
    historicalFromDate: view.historicalFromDate,
    venue,
    investorNetEnabled,
    sidecarDemands,
    savedRangeFreeze,
    hogaplaySource: hogaplaySourceEnabled,
  });

  // ── 저장뷰 기간: 밴드 · 착석 (백필은 useViewportBackfill 3d 소유) ─────────
  const savedRangeCandles = d.workareaChartBundle?.candles ?? EMPTY_CANDLES;

  /**
   * 저장 구간 백필은 **`useViewportBackfill` 3d 가 소유한다**(`savedRangeFromDate` prop).
   *
   * 여기서 `historicalRange.extend` 를 한 번 부르던 시절엔 3개월 전 저장뷰가 **영영
   * 착석하지 않았다**(2026-08-21 실측, 3분 20초 무변화). 단발 extend 는 백엔드에서
   * 한 청크만 받고 끝나고, `fillKind` 를 세우지 않으므로 진행 루프(3a)가 이어받지
   * 못한다 — 나머지 스텝은 좌측 팬(3b)이 있어야 발화하는데 저장뷰 적용에는 팬이 없다.
   */

  /** 일봉 기간 밴드의 마크. 분봉에서는 `LiveChartRoot` 가 스스로 게이트한다. */
  const savedRangeBand = useMemo(
    () => (savedRange
      ? studySavedRangeMarks({ from_ms: savedRange.fromMs, to_ms: savedRange.toMs }, savedRangeCandles)
      : null),
    [savedRange, savedRangeCandles],
  );

  /**
   * 저장 구간을 화면에 앉히는 1회 뷰포트. 없으면 클릭해도 아무 일이 없다 — 라이브
   * 엣지에 있는 차트에서 몇 달 전 구간은 화면 밖이다.
   *
   * `atLiveEdge: false` 가 핵심 — true 면 `computeRestoreRange` 가 최신 봉을 따라가
   * 저장 구간이 도로 밀려난다.
   *
   * 봉에 따라 **다른 규칙**을 쓴다:
   * - 캘린더 봉: `studyDailyViewport` — 구간이 우측 45% 를 차지하고 이후 맥락이 보인다.
   * - 분봉: **B 를 오른쪽 끝**에 두고 줌은 저장 당시 그대로(2026-08-21 사용자 결정).
   *   저장 시점 화면을 가장 가깝게 재현한다.
   *
   * ⚠ 착석은 **이동만 한다.** 한때 여기 딸린 우측 벽이 있었으나 제거됐고(#1457),
   * 착석만 되돌아왔다(#1461) — B 오른쪽으로 나가는 것을 막지 않는다.
   */
  const savedRangeViewport = useMemo((): TabViewport | null => {
    if (!savedRange) return null;
    if (!isMinuteTimeframe(view.timeframe)) {
      return studyDailyViewport(savedRangeCandles, savedRange.fromMs, savedRange.toMs);
    }
    // 저장 `bar_span` 은 **봉이 일치할 때만** 유효하다(그 함수 주석). 아니면 구간의
    // 실제 봉 수에서 유도한다. 그릴 수 없는 크기는 `minuteRestoreGeometry` 가 접는다
    // (LiveChartRoot 착석부).
    const barSpan = view.timeframe === savedRange.savedTimeframe && savedRange.savedBarSpan > 0
      ? savedRange.savedBarSpan
      : Math.max(1, countBarsInRange(savedRangeCandles, savedRange.fromMs, savedRange.toMs));
    return { rightEdgeMs: savedRange.toMs, barSpan, atLiveEdge: false };
  }, [savedRange, savedRangeCandles, view.timeframe]);

  /**
   * 차트 정체성에 저장뷰를 섞는다 — viewKey 가 바뀌면 `lastAppliedCountRef` 가 리셋돼
   * `restoreViewport` 의 **1회 적용이 다시 살아난다**(LiveChartRoot 의 그 effect).
   * 섞지 않으면 이미 마운트된 차트에서는 그 1회가 이미 소진돼 착석이 조용히 무시된다.
   *
   * 부수효과 둘 다 의도된 것이다: ① 봉을 바꾸면 viewKey 에 timeframe 이 이미 있어
   * 그 봉에 맞는 착석이 자동으로 다시 일어난다. ② 칩 × 로 슬롯을 지우면 `sv=` 가
   * 빠져 차트가 재생성되고, `restoreViewport` 가 없으니 분봉 기본 초기 뷰
   * (=라이브 엣지)로 돌아간다 — **× 가 라이브 복귀를 겸하는 것이 여기서 나온다.**
   */
  /** 「되는 데까지 + 안내」의 안내 쪽(2026-08-21 결정). 없으면 null. */
  const savedRangeChipNotice = useMemo(
    () => (savedRange
      ? savedRangeNotice({
          timeframe: view.timeframe,
          fromDate: savedRange.fromDate,
          toDate: savedRange.toDate,
          hasBand: savedRangeBand !== null,
          candleCount: savedRangeCandles.length,
          // 얼린 창의 캔들 = 저장 구간 그 자체이므로 첫 봉의 거래일이 곧 커버리지
          // 시작이다. `ts_ms` → KST 거래일 변환은 `unixMsToKSTDate` 단일 소유자를 탄다.
          earliestCandleDate: savedRangeCandles.length > 0
            ? unixMsToKSTDate(savedRangeCandles[0].ts_ms)
            : null,
          // 보충 요약 — 개수만 넘긴다(순수 판정 함수라 봉 배열을 들이지 않는다).
          // `pending` 은 "지금 요청 중" 과 "아직 남은 run 이 있다" 의 합집합이다:
          // run 사이 커서가 넘어가는 프레임에서는 `isFetching` 이 잠깐 false 라,
          // 그것만 보면 안내가 '보충 중' → '없음' → '보충 중' 으로 깜빡인다.
          gapFill: {
            filledCount: d.gapFill.filledDates.size,
            rescaledCount: d.gapFill.rescaledDates.length,
            unfillableCount: d.gapFill.unfillableCount,
            pending: d.gapFill.isFetching || d.gapFill.remainingRuns > 0,
          },
        })
      : null),
    [savedRange, view.timeframe, savedRangeBand, savedRangeCandles, d.gapFill],
  );
  const clearSavedRange = useLivePageStore((s) => s.clearSavedRange);

  const baseIdentity = d.workareaCode ? `${d.workareaCode}:${venue}` : venue;
  const viewIdentity = savedRange ? `${baseIdentity}:sv=${savedRange.viewId}` : baseIdentity;

  // 헤더가 좁아지면 액션 라벨을 접는다(#762) — 관측 대상은 컨테이너 폭이라
  // 접힘이 관측값을 되바꾸지 않는다(피드백 루프 없음).
  // 훅이 **callback ref** 를 준다: 아래 `if (!instrument)` 빈 상태를 지나 종목이
  // 붙는 순간 헤더가 처음 마운트되는데, ref 객체로는 그 등장을 관측자에게 알릴 수
  // 없었다(그 훅의 주석 참조 — 리사이즈가 통째로 죽던 원인).
  // ── 「분봉으로」 기간 점프 ────────────────────────────────────────────────
  // 발행(캘린더 창)과 소비(분봉 창)가 한 창에 동시에 있을 수 없다 — 봉이 하나라
  // 헤더에도 둘 중 하나만 뜬다.
  const canJump = canPublishTimeframeJump(view.timeframe);
  // 접힘 임계는 **창의 봉**이 정한다 — 「분봉으로」가 캘린더 창에만 떠서 요구폭이
  // 갈린다(실측 Δ full +70 / actionsFolded +22). 하나로 합치면 분봉 헤더가 70px
  // 일찍 접힌다. 모듈 상수 둘 중 하나를 고르므로 참조가 안정적이다(관측자 재구독 없음).
  const [headerFold, headerRef] = useChartHeaderFold(
    canJump ? LIVE_CALENDAR_HEADER_FOLD : LIVE_HEADER_FOLD,
  );
  // 보낼 곳이 있는가. **자기 자신은 세지 않는다**(캘린더 창이라 어차피 대상이 아니지만,
  // 조건을 창 종류에 기대면 봉이 바뀔 때 조용히 어긋난다).
  const hasMinuteWindow = useWorkspaceStore((s) => s.windows.some(
    (w) => w.id !== win.id && w.kind === 'chart' && w.group === win.group
      && w.chart !== undefined && isMinuteTimeframe(w.chart.timeframe),
  ));
  // 차트 좌표와 캔들 배열은 `LiveChartRoot` 안에만 있다 — 헤더가 직접 계산할 수
  // 없어 등록으로 받는다(`captureViewport` 와 같은 패턴).
  const jumpSourceRef = useRef<() => JumpRange | null>(() => null);
  /** 목적지 날짜(YYYYMMDD) — 차트가 밀어 준다. 버튼이 호버 전에도 라벨에 쓴다(#1506 조사 A1). */
  const [jumpDestination, setJumpDestination] = useState<string | null>(null);
  const [minuteJump, setMinuteJump] = useState<{
    state: MinuteJumpState | null;
    clear: () => void;
    retry: () => void;
  }>({ state: null, clear: () => {}, retry: () => {} });
  // 발행 판정은 **여기 하나**다. 버튼과 `g` 가 각자 판정하면 "버튼은 막았는데
  // 단축키는 보내는" 상태가 생기고, 그 어긋남은 눌러 보기 전엔 안 보인다.
  const runJump = useCallback(() => {
    if (!hasMinuteWindow) return;
    const range = jumpSourceRef.current();
    // 「그 날짜는 데이터가 없다」는 여기서 막지 않는다 — 하한을 아는 것은 소비하는
    // 분봉 창뿐이고(모드에 따라 갈린다, #1497) 이 창은 항상 `null` 을 본다. 보내고,
    // 갈 수 없으면 그 창의 칩이 사유를 말한다.
    if (range === null
      || !Number.isFinite(range.fromMs) || !Number.isFinite(range.toMs)) return;
    useLiveCursorStore.getState().requestTimeframeJump(range.fromMs, range.toMs, {
      windowId: win.id, group: win.group, code: view.code, timeframe: view.timeframe,
    });
    // 결과는 **다른 창**에서 일어난다. 그 창이 가려져 있으면 누른 쪽에서는 아무 일도
    // 안 일어난 것처럼 보인다 — 실측(2026-08-23): 「창 추가」 기본 배치가 기존 분봉 창
    // 위에 겹쳐(일봉 404×261 @97,186 vs 분봉 711×596 @13,99) 칩도 뷰포트 이동도
    // 눈에 안 들어왔다. 그래서 수신 창을 앞으로 올린다.
    //
    // ⚠ 이 모델에서 **올리기 = 포커스**다(`focusedId = zOrder 끝`). 즉 이 조작 뒤
    // `g`·Shift+1~4 의 대상이 분봉 창으로 넘어간다 — 결과를 보고 있는 창이 포커스인
    // 것이 자연스러우므로 수용한다. 여럿이면 zOrder 순으로 올려 **상대 순서를 보존**한다.
    const ws = useWorkspaceStore.getState();
    jumpReceiverIds(ws.windows, ws.zOrder, win.id, win.group)
      .forEach((id) => ws.focusWindow(id));
  }, [hasMinuteWindow, win.id, win.group, view.code, view.timeframe]);
  // `g` 는 셸이 포커스 창을 정하고 실행은 그 창이 한다 — 목적지가 차트 좌표라
  // 스토어를 통해서는 도달할 수 없다(`jumpControls` 헤더).
  useEffect(() => {
    if (!canJump) return;
    return registerJumpRunner(win.id, runJump);
  }, [canJump, win.id, runJump]);

  // 관심 하트의 채움 상태. `useWatchlistMembership` 의 계약대로 **창에서 한 번만**
  // 부르고 버튼에 내린다(버튼이 직접 부르면 창 수만큼 옵저버가 는다). 타이틀바도
  // 자기 몫으로 한 번 부르므로 창당 2개인데, 창 단위라 행 단위였던 그 훅의 원래
  // 문제와는 규모가 다르다 — 의도된 비용이다.
  const { isMember } = useWatchlistMembership();
  const heartCode = symbol?.kind === 'index' ? null : symbol?.code ?? null;

  // 저장뷰 캡처용 뷰포트 ref — LiveChartRoot 가 마운트 시 캡처 함수를 공급한다.
  const viewportCaptureRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    viewportCaptureRef.current = capture;
  }, []);

  // 수집 버튼용 '보이는 구간' 스냅샷 — 이 창의 뷰포트에서 양 끝 캔들의 KST 거래일을
  // 읽는다. 저장뷰 캡처와 같은 소스(viewportCaptureRef)라 창별로 정확하다. leftEdgeMs 는
  // 라이브 캡처엔 항상 채워지지만(콜드/빈 차트면 캡처 자체가 null) 없으면 null 로 폴백해
  // 다이얼로그가 칩을 숨긴다. 우측 여백(rightOffset)이 미래로 넘칠 수 있어 end 는 오늘로
  // 클램프한다 — YYYYMMDD 는 사전식 비교가 곧 날짜 순서라 문자열 min 으로 충분.
  const todayKst = d.today;
  const getCollectVisibleRange = useCallback((): CollectVisibleRange | null => {
    const vp = viewportCaptureRef.current();
    if (!vp || vp.leftEdgeMs == null || !Number.isFinite(vp.rightEdgeMs)) return null;
    const startYmd = unixMsToKSTDate(vp.leftEdgeMs);
    const rawEndYmd = unixMsToKSTDate(vp.rightEdgeMs);
    const endYmd = todayKst && rawEndYmd > todayKst ? todayKst : rawEndYmd;
    if (startYmd > endYmd) return null;
    return { startYmd, endYmd };
  }, [todayKst]);

  // ── hogaplay 저장 데이터 소스: 토글 · 칩 ──────────────────────────────────
  const setChartHogaplaySource = useWorkspaceStore((s) => s.setChartHogaplaySource);
  const extendChartHistoricalRange = useWorkspaceStore((s) => s.extendChartHistoricalRange);
  /**
   * 켤 때 **보이는 구간을 페치 창에 못 박는다.**
   *
   * 이 모드는 시작일을 얼리지 않고 종전 시드를 그대로 탄다 —
   * `historicalFromDate ?? 봉별 기본 창`. 대개는 그 시드가 화면을 덮지만 한 조합이
   * 새어 나간다: 좌측 팬으로 넓힌 뒤 봉을 바꾸면 `setChartTimeframe` 이
   * `historicalFromDate` 를 null 로 되돌리므로(창별 백필 리셋), 화면에는 아직 과거
   * 봉이 남아 있는데 시드는 기본 창으로 돌아가 있다. 그 상태에서 켜면 디스크 요청이
   * 보이는 구간보다 짧아 왼쪽이 빈다 — "보이는 구간을 불러온다" 는 이 버튼의 계약이
   * 바로 그 자리에서 깨진다.
   *
   * `extendChartHistoricalRange` 는 단조 감소 가드라 이미 더 과거면 no-op 이고,
   * 뷰포트를 못 읽으면(콜드·빈 차트) 그냥 시드에 맡긴다.
   */
  const toggleHogaplaySource = useCallback((next: boolean) => {
    if (next) {
      const visible = getCollectVisibleRange();
      if (visible) extendChartHistoricalRange(win.id, visible.startYmd);
    }
    setChartHogaplaySource(win.id, next);
  }, [getCollectVisibleRange, extendChartHistoricalRange, setChartHogaplaySource, win.id]);

  /**
   * 칩에 찍을 기간 = **실제로 그려진 캔들의 양 끝**.
   *
   * 켤 때의 구간을 박아 두지 않는 이유는 이 모드의 정의다 — 좌측 팬을 따라 넓어지는
   * 창이라 고정 표기는 곧 거짓말이 된다. 아직 안 왔으면 `null` → 칩이 「불러오는 중」.
   */
  const hogaplayLoadedRange = useMemo(() => {
    if (!hogaplaySourceEnabled || savedRangeCandles.length === 0) return null;
    return {
      fromDate: unixMsToKSTDate(savedRangeCandles[0].ts_ms),
      toDate: unixMsToKSTDate(savedRangeCandles[savedRangeCandles.length - 1].ts_ms),
    };
  }, [hogaplaySourceEnabled, savedRangeCandles]);

  /**
   * 칩 툴팁에 실을 **키움 보충 요약** — 개수만. 봉 자체는 이미 번들을 통해 차트에 있다.
   *
   * `hogaplaySourceEnabled` 일 때만 만든다. 얼린 저장뷰도 같은 보충을 돌리지만 그쪽
   * 안내는 `savedRangeNotice` 가 소유하므로(같은 사실을 두 곳에서 다르게 말하지 않는다),
   * 이 값이 그 창으로 새면 칩 두 개가 같은 것을 두 번 말한다.
   */
  const hogaplayGapFill = useMemo<HogaplayChipGapFill | undefined>(
    () => (hogaplaySourceEnabled
      ? {
          filledCount: d.gapFill.filledDates.size,
          unfillableCount: d.gapFill.unfillableCount,
          rescaledCount: d.gapFill.rescaledDates.length,
          deferredCount: d.gapFill.deferredCount,
          // "지금 요청 중" 과 "아직 남은 run 이 있다" 의 합집합 — run 사이 커서가 넘어가는
          // 프레임에서 `isFetching` 만 보면 문구가 완료로 한 번 깜빡인다.
          pending: d.gapFill.isFetching || d.gapFill.remainingRuns > 0,
        }
      : undefined),
    [hogaplaySourceEnabled, d.gapFill],
  );

  /** 비활성 사유 — 없으면 `null`. 세 사유의 근거는 `HogaplaySourceButton` 도크스트링. */
  const hogaplayDisabledReason: HogaplaySourceDisabledReason | null =
    heartCode == null
      ? 'no-code'
      : !isMinuteTimeframe(view.timeframe)
        ? 'calendar-timeframe'
        : savedRangeFreeze !== null
          ? 'saved-range'
          : null;

  // 그룹 차트 링크 발행(ADR-0119 PR-D) — 같은 그룹 데이터 창(매물대·프로그램 실
  // 콘텐츠, 10호가·거래원 스팟 모드)이 소비한다. 상태바 발행과 같은 규율: deps 없는
  // effect + 값 동등성 가드(bundle 은 참조 동등성)로 변경시에만 발행 — 발행 구독은
  // 데이터 창 리프에 격리돼 있어 재렌더 루프가 없다(#706 함정).
  const lastLinkRef = useRef<GroupChartLink | null>(null);
  useEffect(() => {
    if (!isGroupLink) return;
    const next: GroupChartLink = {
      windowId: win.id,
      group: win.group,
      code: view.code,
      timeframe: view.timeframe,
      bundle: d.workareaChartBundle ?? d.workareaBundle,
      adjustFactors: d.adjustFactors,
      todayKst: d.today,
      vdist: {
        rangeCount: ind.volumeDistributionRangeCount,
        color: ind.volumeDistributionColor,
        maxColor: ind.volumeDistributionMaxColor,
        hoverCutoffEnabled: ind.volumeDistributionHoverCutoffEnabled,
      },
    };
    const prev = lastLinkRef.current;
    const same = prev !== null
      && prev.windowId === next.windowId
      && prev.group === next.group
      && prev.code === next.code
      && prev.timeframe === next.timeframe
      && prev.bundle === next.bundle
      // 계수는 번들과 lockstep 이라 대개 같이 바뀌지만, 계수만 늦게 도착하는
      // 순간(봉 응답이 번들보다 늦음)이 있어 별도 축으로 센다 — 빠뜨리면 그 창의
      // 데이터 창이 계수 없는 링크를 계속 본다.
      && prev.adjustFactors === next.adjustFactors
      && prev.todayKst === next.todayKst
      && prev.vdist.rangeCount === next.vdist.rangeCount
      && prev.vdist.color === next.vdist.color
      && prev.vdist.maxColor === next.vdist.maxColor
      && prev.vdist.hoverCutoffEnabled === next.vdist.hoverCutoffEnabled;
    if (!same) {
      lastLinkRef.current = next;
      publishGroupChartLink(next);
    }
  });
  // 링크 철회 — 게이트 이탈·그룹 이동·언마운트 시 자기 발행만 걷는다.
  useEffect(() => {
    if (!isGroupLink) return undefined;
    return () => {
      lastLinkRef.current = null;
      clearGroupChartLink(win.group, win.id);
    };
  }, [isGroupLink, win.group, win.id]);

  // 저장뷰 소스 — 이 창의 것. 헤더 버튼에 직접 넘긴다(전역 1슬롯 발행 폐지).
  // 슬롯 시절엔 z-최상위 창만 발행해서 "어느 창을 저장하나" 를 추론해야 했는데,
  // 버튼이 창 안으로 들어오며 그 추론이 통째로 사라졌다(#759 와 같은 단순화).
  const { liveSaveBundle, activeLabel, capabilities } = d;
  const studySaveSource: LiveStudySaveSource | null = useMemo(() => {
    if (!view.code || !liveSaveBundle || !capabilities.studySave) return null;
    return {
      origin: 'live',
      code: view.code,
      label: activeLabel || view.code,
      timeframe: view.timeframe,
      bundle: liveSaveBundle,
      captureViewport: () => viewportCaptureRef.current(),
    };
  }, [view.code, view.timeframe, liveSaveBundle, activeLabel, capabilities.studySave]);

  // 캔들 레전드 최상단 종목 식별 행 입력(#865 후속). 지수(view.code=null)는 종목
  // 행 없음. 타이틀바 종목 행 경고칩(과거 로딩) 발행 — 번들 파생값은 타이틀바
  // (WindowFrame, 이 창의 부모) 스코프 밖이라 windowWarnings 채널로 올린다. 현재가·
  // 등락률·히트맵은 타이틀바가 code 로 self-fetch 하므로 여기 싣지 않는다. 백필 진행
  // 게이트(extending·historicalFromDate·segments)는 여기서 판정해 결과 날짜만 넘긴다.
  // deps 없는 effect + 동등성 가드로 변경시에만 발행(발행→구독은 타이틀바 리프에
  // 격리돼 재렌더 루프 없음 — #865 liveWindowStatusSource 규율과 동일).
  const extending = d.activeIndexId ? d.indexExtending : d.isExtending;
  const lastWarningsRef = useRef<WindowWarnings | null>(null);
  useEffect(() => {
    const segs = d.workareaBundle?.segments;
    const next: WindowWarnings = {
      backfillEarliestDate:
        extending && view.historicalFromDate != null && segs && segs.length > 0
          ? segs[0].date
          : null,
    };
    const prev = lastWarningsRef.current;
    const same = prev !== null && prev.backfillEarliestDate === next.backfillEarliestDate;
    if (!same) {
      lastWarningsRef.current = next;
      publishWindowWarnings(win.id, next);
    }
  });
  useEffect(() => () => {
    lastWarningsRef.current = null;
    clearWindowWarnings(win.id);
  }, [win.id]);

  if (!instrument) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-md bg-bg-subtle/40 text-xs text-fg-dim">
        <span className="font-data">종목 없음 · 그룹 {view.group}</span>
        {/* 빈 상태 = "한 줄 설명 + 행동 1개" — 다음 행동(헤더 검색)이 있는데 빈 창은
            그 존재를 알려주지 않았다. focusLiveSearch 는 헤더 검색의 기존 채널(＋ 버튼·
            키보드 / 와 동일)이라 새 배선 없이 팝오버를 연다. */}
        <button
          type="button"
          onClick={focusLiveSearch}
          className="rounded-lg border border-border-strong px-3 py-[7px] text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          종목 검색 <kbd className="font-data text-fg-dim">/</kbd>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* 창 헤더 — 이 창의 차트 조작 진입로를 모두 소유한다(#758).
          봉은 창 소유(#708)였고, 여기에 그리기(레일 폐기분)와 보조지표가
          합류했다. 설정(⚙)은 편집 값이 앱 전역이라 전역 툴바에 남는다(#759). */}
      <div
        ref={headerRef}
        data-testid="chart-window-header"
        data-compact={headerFold.compactActions ? '' : undefined}
        data-compact-timeframe={headerFold.compactTimeframe ? '' : undefined}
        className="flex shrink-0 items-center gap-1 overflow-hidden bg-bg-card px-1 py-0.5"
      >
        {/* 종목 식별·현재가·경고는 창 타이틀바(TitleBarSymbolRow)로 이관됐다.
            이 헤더는 봉·그리기·보조지표·저장·수집만 소유한다. */}
        {/* 2단계 접힘(#762) — 기능 손실 없이 폭만 줄인다.
            ① 좁아지면 액션 라벨을 접고 아이콘만(요구폭 ~213px)
            ② 더 좁아지면 일·주·월을 분봉 드롭다운에 합친다(~110px)
            창은 MIN_W=160px 까지 좁아지므로 ②가 없으면 다시 잘린다. */}
        <TimeframeControl
          timeframe={view.timeframe}
          rememberedMinute={rememberedMinute}
          onChange={(tf) => setChartTimeframe(win.id, tf)}
          compact={headerFold.compactTimeframe}
        />
        {/* 저장뷰 기간 칩은 **헤더에 있다.** 차트 위 오버레이로 두면 `PaneLegendOverlay`
            와 겹치는데, legend 는 켜진 지표 수만큼 줄이 늘어나므로 좌표를 피해 가는
            방식으로는 구조적으로 못 막는다(2026-08-21 실측 — 좌상단·우상단 둘 다 겹쳤다).
            여기 두면 겹침이 원천 소멸한다. 대가는 좁은 창에서 액션이 한 단계 일찍
            접히는 것뿐이고, 그것도 저장뷰를 연 동안만이다(평소엔 폭을 0 먹는다).

            `ml-auto` 를 **달지 않는다** — 액션 그룹이 이미 갖고 있어서 두 번째를 달면
            여유를 반씩 나눠 칩이 끝이 아니라 중간에 뜬다. */}
        {savedRange && (
          <div className="ml-1 flex min-w-0 items-center">
            <SavedRangeChip
              label={savedRange.label}
              fromDate={savedRange.fromDate}
              toDate={savedRange.toDate}
              krxPinned={isSavedRangeSubject}
              notice={savedRangeChipNotice}
              onClear={clearSavedRange}
            />
          </div>
        )}
        {/* 점프 칩·hogaplay 칩은 저장뷰 칩과 **같은 자리**다 — 「차트가 특별한
            상태에 잡혀 있다 + × 로 푼다」는 이미 학습된 패턴이라 새 자리를 만들지
            않는다. 셋이 동시에 뜨는 조합도 서로 모순되지 않는다(각각 기간·소스·점프). */}
        {minuteJump.state && (
          <div className="ml-1 flex min-w-0 items-center">
            <MinuteJumpChip
              state={minuteJump.state}
              onClear={minuteJump.clear}
              onRetry={minuteJump.retry}
            />
          </div>
        )}
        {/* hogaplay 소스 칩 — 저장뷰 칩과 **같은 자리·다른 의미**다. 둘이 동시에 뜰 수
            있는 조합은 하나뿐이다: 저장뷰가 **다른 종목**을 가리켜 이 창이 얼지 않은
            경우(그때 저장뷰 칩은 "이 창에도 함께 표시 중" 이라는 기간 안내이고, 이
            칩은 이 창의 소스 안내다 — 서로 모순되지 않는다). 이 창이 얼면 위
            `hogaplaySourceEnabled` 가 내려가 이 칩은 사라진다. */}
        {hogaplaySourceEnabled && (
          <div className="ml-1 flex min-w-0 items-center">
            <HogaplaySourceChip
              range={hogaplayLoadedRange}
              gapFill={hogaplayGapFill}
              onClear={() => toggleHogaplaySource(false)}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {/* 「분봉으로」는 캘린더 봉 창에만 뜬다. 액션 그룹 맨 앞에 두는 이유:
              이것만 **다른 창을 움직이는** 동사라, 이 창을 대상으로 하는 나머지와
              섞이지 않게 앞에 세운다.
              **2단계 접힘에서는 내린다** — 상태 아이콘들과 같은 폭 예산 사유이고,
              도달 경로가 `g` 단축키로 남는다(#762 의 "기능 손실 없이" 를 지키는 조건).
              게이트를 `showsHeaderStateIcons` 와 공유하는 것은 이름이 아니라 **판정
              축이 같아서**다(둘 다 "2단계에서 렌더하지 않는다") — 따로 두면 한쪽만
              고쳤을 때 예산이 조용히 깨진다. */}
          {canJump && showsHeaderStateIcons(headerFold) && (
            <JumpToMinuteButton
              timeframe={view.timeframe as CalendarTimeframe}
              destinationDate={jumpDestination}
              hasMinuteWindow={hasMinuteWindow}
              onRun={runJump}
              showLabel={!headerFold.compactActions}
            />
          )}
          {/* hogaplay 소스는 액션 행 **맨 왼쪽**(하트보다 앞) — 2026-08-22 사용자
              지정. 의미로도 맞는다: 오른쪽 넷은 차트 조작이고 하트는 종목 속성인데,
              이것은 그 둘보다 앞선 **차트가 무엇을 그리는가**(소스)라 동사 묶음에서
              가장 멀다.
              **2단계 접힘에서는 하트와 함께 내린다** — 근거·실패 모드는 아래 하트
              주석과 `showsHeaderStateIcons` 참조(둘이 같은 폭 예산을 나눈다). */}
          {showsHeaderStateIcons(headerFold) && (
            <HogaplaySourceButton
              enabled={hogaplaySourceEnabled}
              disabledReason={hogaplayDisabledReason}
              onToggle={toggleHogaplaySource}
              compact={headerFold.compactActions}
            />
          )}
          {/* 관심 하트는 액션 행 맨 왼쪽 — 나머지 넷은 차트 조작이고 이것만
              종목 속성이라, 그리기 왼쪽에 두어 동사 묶음 앞에 세운다.
              **2단계 접힘에서는 내린다.** 그 단계의 요구폭이 하트 포함 170px 인데
              창은 MIN_W=160px(컨테이너 158px)까지 좁아져 12px 넘치고, 넘친 만큼
              오른쪽 끝 「수집」이 overflow-hidden 에 무성 잘린다(2026-08-14 실측으로
              확인 — #767 과 같은 실패 모드). #762 의 "기능 손실 없이 폭만 줄인다" 를
              여기서만 밟는 대가로 잘림을 0 으로 되돌린다 — 하트는 우측 레일·종목
              검색에도 있어 도달 경로가 남는다.
              발진하지 않는다: 접힘 판정은 **컨테이너 폭**을 보므로(useChartHeaderFold)
              내용물이 줄어드는 이 변화가 판정을 되돌리지 못한다. */}
          {showsWatchlistHeart(headerFold) && (
            <WatchlistHeartActionButton
              code={heartCode}
              name={symbol?.name ?? null}
              isMember={heartCode != null && isMember(heartCode)}
              compact={headerFold.compactActions}
            />
          )}
          <DrawingMenu
            code={d.workareaCode}
            timeframe={view.timeframe}
            showLabel={!headerFold.compactActions}
          />
          <IndicatorsButton
            onClick={() => requestIndicatorDrawer(win.id)}
            showLabel={!headerFold.compactActions}
          />
          <LiveStudyViewSaveButton
            source={studySaveSource}
            showLabel={!headerFold.compactActions}
          />
          {/* 수집 대상은 이 창의 종목 — 지수 창은 코드가 없어 비활성. */}
          <CollectButton
            code={symbol?.kind === 'index' ? null : symbol?.code ?? null}
            name={symbol?.name ?? null}
            showLabel={!headerFold.compactActions}
            getVisibleRange={getCollectVisibleRange}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChartErrorBoundary>
          <ChartDrawingShell>
            <LiveChartRoot
              code={d.workareaCode}
              timeframe={view.timeframe}
              venue={venue}
              viewIdentity={viewIdentity}
              savedRangeBand={savedRangeBand}
              restoreViewport={savedRangeViewport}
              savedRangeFromDate={savedRange?.fromDate ?? null}
              onJumpSourceReady={(read) => { jumpSourceRef.current = read; }}
              onJumpDestinationChange={setJumpDestination}
              onMinuteJumpChange={setMinuteJump}
              savedRangeFrozen={savedRangeFreeze !== null}
              savedRangeAnchorMs={savedRange && isMinuteTimeframe(view.timeframe) ? savedRange.toMs : null}
              /* 미캡처 안내는 **저장 구간이 걸린 창에서만** 켠다(2026-08-23).
                 원래 `/study` 가 켜던 것이고, 그 근거는 페이지가 아니라 **구간의
                 성격**이었다(`hogaMissingNotice` 의 `IGNORED_REASONS` 주석): 사용자가
                 구간을 명시적으로 정했으면 "그 안에 아직 안 받은 날이 있다" 가 행동으로
                 이어진다. 임의 종목을 훑는 평소 `/live` 에서는 미캡처가 정상이라 켜면
                 배너가 상시 들어와 진짜 결손이 묻힌다(실측 90일 창에서 22일 미캡처).
                 그래서 페이지가 사라져도 조건은 그대로 살아 창으로 옮겨온다. */
              showNotCapturedNotice={savedRange !== null}
              bundle={d.workareaBundle}
              chartBundle={d.workareaChartBundle}
              hogaPaneBundle={d.workareaHogaBundle}
              hogaMissingDates={d.workareaHogaMissingDates}
              candleEmpty={d.workareaCandleEmpty}
              onRetryCandles={d.refetchCandles}
              clampEngaged={d.clampEngaged}
              minuteScrollbackFloorDate={d.minuteScrollbackFloorDate}
              isPastCandlesLoading={d.workareaLoading}
              isHogaLoading={d.activeIndexId ? false : d.isHogaLoading}
              isSidecarLoading={d.activeIndexId ? false : (d.isSidecarLoading || d.isDailyMaLoading)}
              isExtending={d.activeIndexId ? d.indexExtending : d.isExtending}
              indicatorCoverageFromDate={d.activeIndexId ? null : d.indicatorCoverageFromDate}
              rangeWindowFromDate={d.activeIndexId ? null : d.rangeWindowFromDate}
              settledFromDate={d.activeIndexId ? d.indexSettledFromDate : d.pastSettledFromDate}
              pastDataWarnings={[...d.workareaDataWarnings]}
              dayAskPeaks={d.dayAskPeaks}
              todayAskPeakInput={d.liveInitial?.ask_peak_today ?? null}
              dayBidPeaks={d.dayBidPeaks}
              todayBidPeakInput={d.liveInitial?.bid_peak_today ?? null}
              liveObSnapshots={d.live.ob}
              liveTradeSnapshots={d.live.trade}
              todayKst={d.today}
              tradeVolumePocs={d.tradeVolumePocs}
              depthHeatmap={d.workareaDepthHeatmap}
              depthDeltaToday={d.depthDeltaToday}
              onViewportCaptureReady={handleViewportCaptureReady}
              // 창 간 동기화(크로스헤어 · 기간 · 줌)를 켠다. **범위는 창 헤더의 번호
              // (링크 그룹)** 다 — 번호가 다르면 아무것도 공유하지 않는다(사용자 결정
              // 2026-08-21, ADR-0119 §크로스헤어의 재번복). 그 안에서 종목 축은
              // ⚙️ 설정 → 차트의 「다른 종목까지」가 정한다(핀 때문에 같은 번호여도
              // 종목이 갈릴 수 있다).
              cursorSyncCrosshair
              paneTogglesOverride={{ hogaPanes: d.capabilities.hogaPanes }}
            />
          </ChartDrawingShell>
        </ChartErrorBoundary>
      </div>
    </div>
  );
}
