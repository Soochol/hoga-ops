/**
 * useLiveChartData — /live 차트 데이터 파이프라인 (ADR-0119 PR-C2a).
 *
 * `LivePage` 가 인라인으로 갖고 있던 ~130줄의 데이터 파이프라인(useLiveSeries +
 * useLiveBundle + 지수 번들 + ask/bid peaks + trade-volume POC + liveSaveBundle +
 * workarea 파생)을 **창별 재사용 가능한 훅**으로 추출한다. LivePage 는 활성 뷰의
 * (code, timeframe, historicalFromDate) 로 이 훅을 호출해 기능 무변경을 유지하고,
 * 멀티창의 `ChartWindow`(C2b) 는 창의 값으로 같은 훅을 호출해 창별 독립 파이프라인을
 * 얻는다 — 두 번째 소비자를 만들되 로직 중복이 없다.
 *
 * 순수 이동(behavior-preserving refactor): 기존 useLiveBundle/LiveWorkarea 테스트가
 * 이 출력을 고정한다. index/save-source/viewport 는 LivePage 에 남는 페이지 관심사와
 * 무관하게 여기서 파생되는 값만 반환한다.
 */
import { useMemo } from 'react';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { useLiveBundle, type SidecarDemands } from './useLiveBundle';
import { useLiveSeries } from '../api/liveSeries';
import { useDayAskPeaks } from './useDayAskPeaks';
import { useDayBidPeaks } from './useDayBidPeaks';
import { useTradeVolumePocs } from './useTradeVolumePoc';
import type {
  AskPeak,
  BidPeak,
  Candle,
  DepthHeatmapPointWire,
  RangeBundle,
  TradeVolumePocWire,
} from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import type { LiveVenueOption } from '../state/liveVenue';
import { liveVenueSessionBoundsMs } from './liveVenuePolicy';
import { freshLiveTradePrice } from './deriveCurrentPriceLine';
import { indexWorkareaCode, instrumentLabel, type LiveInstrument } from './liveInstrument';
import { useLiveIndexCandles, useLiveIndexInvestorNet } from '../api/liveIndices';
import { buildIndexBundle } from './buildIndexBundle';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';
import { useDailyMaRevealGate } from './indicators/useDailyMaRevealGate';
import { useWindowIndicators } from './workspace/windowView';

/** 안정 빈 배열 — 매 렌더 새 [] 가 peaks 훅의 메모 deps 를 churn 하지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_CANDLES: readonly Candle[] = [];
const EMPTY_OB_SNAPSHOTS: readonly ObSnapshot[] = [];
const EMPTY_TRADE_SNAPSHOTS: readonly TradeSnapshot[] = [];
const EMPTY_DEPTH_HEATMAP: readonly DepthHeatmapPointWire[] = [];

const INDEX_BUCKET_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
  '120m': 7_200_000,
  '240m': 14_400_000,
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 31 * 86_400_000,
} as const;

function tradeVolumePocsToWire(pocs: readonly {
  date: string;
  centerPrice: number;
  lowPrice: number;
  highPrice: number;
  qty: number;
  t_ms: number;
  bandPct: number;
}[]): TradeVolumePocWire[] {
  return pocs.map((poc) => ({
    date: poc.date,
    center_price: poc.centerPrice,
    low_price: poc.lowPrice,
    high_price: poc.highPrice,
    qty: poc.qty,
    t_ms: poc.t_ms,
    band_pct: poc.bandPct,
  }));
}

export interface UseLiveChartDataArgs {
  activeCode: string | null;
  activeInstrument: LiveInstrument | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  venue: LiveVenueOption;
  /** 활성 지표에서 파생한 투자자 순매수 게이트(호출측이 공급 — 전역/창별). */
  investorNetEnabled: boolean;
  /** 같은 그룹 데이터 창의 sidecar 강제 fetch 수요(ADR-0119 PR-D) — 그룹 링크
   *  발행 차트 창만 공급. useLiveBundle 로 그대로 전달된다. */
  sidecarDemands?: SidecarDemands;
  /**
   * 저장뷰 구간에 **얼린** 창(2026-08-21 사용자 결정). `null` = 평소의 라이브 창.
   *
   * `/study`(복기)와 같은 의미론이다 — 저장 구간만 디스크에서 읽고 그 구간에 멈춰 있다.
   * 칩 × 로 슬롯을 지우면 이 값이 `null` 이 되어 라이브로 돌아온다(`viewIdentity` 의
   * `sv=` 가 빠지며 차트가 재생성되는 기존 경로가 그대로 겸한다).
   *
   * **`toDate` 가 이 훅의 "오늘" 이 된다.** 그 한 줄이 얼림의 전부다 — `minutePastTo`·
   * 세션 경계·라이브 엣지 판정·피크 래칫의 당일 병합이 전부 `today` 를 기준으로 돌아서,
   * 별도의 freeze 플래그를 하류에 뿌릴 필요가 없다. (`/study` 도 같은 자리를 썼다 —
   * 저장 구간의 끝날을 `todayKst` 로 넘기는 방식. 그 페이지는 사라졌지만 얼림의
   * 메커니즘은 이것 하나로 남았다.)
   *
   * 라이브 SSE 는 여기서 **구독 자체를 끊는다**(`useLiveSeries('')`). 안 끊으면 오늘
   * 틱이 과거 축에 얹혀 실재하지 않는 봉이 생긴다.
   */
  savedRangeFreeze?: { fromDate: string; toDate: string } | null;
  /**
   * 창별 **hogaplay 저장 데이터 소스** 토글(차트 창 헤더 버튼).
   *
   * 위 `savedRangeFreeze` 와 **겹치지 않는 축**이다: 저쪽은 "어느 구간" 이고 이쪽은
   * "어느 소스" 다. 그래서 `today` 도 라이브 SSE 도 건드리지 않는다 — 이 모드의
   * 오늘은 여전히 오늘이고, 좌측 팬도 종전대로 산다. 바뀌는 것은 캔들이 벤더
   * (`ka10080`)에서 오느냐 디스크(`/api/range mode=candles`)에서 오느냐 하나뿐이다.
   *
   * 둘이 동시에 서면 **얼림이 이긴다**(호출부가 그때 버튼을 비활성으로 둔다) —
   * 어차피 얼림이 이미 디스크라 소스 축에서는 결과가 같고, 구간 축에서 더 구체적인
   * 요청이 저장뷰다.
   */
  hogaplaySource?: boolean;
}

export function useLiveChartData(args: UseLiveChartDataArgs) {
  const { activeCode, activeInstrument, timeframe, historicalFromDate, venue, investorNetEnabled, sidecarDemands } = args;

  // 얼림은 **분봉에서만** 건다. 캘린더 봉은 250일 벽이 애초에 없어 저장뷰가 지금도
  // 그려지고, 얼리면 `/study` 처럼 맥락 창을 따로 넓혀야 해서(`studyDailyContextWindow`)
  // 오히려 화면이 저장 구간만큼으로 좁아진다.
  const freeze = isMinuteTimeframe(timeframe) ? (args.savedRangeFreeze ?? null) : null;
  // **얼림의 전부가 이 한 줄이다** — 인자 도크스트링 참조.
  const today = freeze?.toDate ?? todayKstYyyymmdd();
  // 얼린 창은 라이브 스트림을 아예 구독하지 않는다. `useLiveSeries` 는 빈 코드에서
  // 초기 fetch(`enabled: !!code`)와 WS 구독(`if (!code) return`)을 둘 다 끊고 버퍼를
  // 안 보이게 하므로(`bufferVisible`), 하류 피크·매물대의 당일 병합이 전부 no-op 이 된다.
  const live = useLiveSeries(freeze ? '' : (activeCode ?? ''), venue);
  const {
    bundle,
    chartBundle,
    hogaBundle,
    hogaMissingDates,
    candleEmpty,
    refetchCandles,
    depthDeltaToday,
    clampEngaged,
    minuteScrollbackFloorDate,
    isPastCandlesLoading,
    isHogaLoading,
    isExtending,
    isSidecarLoading,
    pastDataWarnings,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
    pastSettledFromDate,
    adjustFactors,
    gapFill,
  } = useLiveBundle(activeCode, timeframe, today, live, {
    investorNetEnabled,
    venue,
    sidecarDemands,
    frozenRangeFrom: freeze?.fromDate ?? null,
    hogaplaySourceEnabled: args.hogaplaySource === true,
  });
  const liveInitial = live.initial?.code === activeCode ? live.initial : undefined;
  const stockBundle = activeCode && bundle?.code === activeCode ? bundle : null;
  const stockChartBundle = activeCode && chartBundle?.code === activeCode ? chartBundle : null;
  const stockHogaBundle = activeCode && hogaBundle?.code === activeCode ? hogaBundle : null;
  /** 캔들 경로 그릇 — 안정 참조인 `chartBundle` 우선, 없으면 병합 번들.
   *
   *  **여기서 읽어도 되는 것은 `todaySource` 가 `'bundle'` 이 아닌 슬라이스뿐이다**
   *  (`frontend/src/api/rangeSlices.ts`). 그 축이 `'bundle'` 인 넷(quote_ratio ·
   *  fill_strength · price_level_hits · depth_heatmap)을 이 값에서 뽑으면 에러 없이
   *  조용히 과거분만 얻는다(#719). 아래 소비처들이 뽑는 것은 씨앗·캔들·세그먼트라 안전하다.
   *
   *  `??` 는 새 객체를 만들지 않으므로 두 그릇 중 하나의 참조를 그대로 갖는다 — SSE 틱에
   *  이 값이 churn 하지 않는다는 뜻이고, 하류 today-merge 훅들의 memo deps 가 그걸 전제한다. */
  const candlePathBundle = stockChartBundle ?? stockBundle;
  const activeIndexId = activeInstrument?.kind === 'index' ? activeInstrument.id : null;
  const isDailyMaLoading = useDailyMaRevealGate({ code: activeCode, timeframe, venue, todayKst: today });
  const capabilities = useMemo(() => capabilitiesForInstrument(activeInstrument), [activeInstrument]);
  const indexFrom = historicalFromDate ?? subtractDaysKst(today, initialHistoricalDaysFor(timeframe));
  const indexCandles = useLiveIndexCandles(activeIndexId, timeframe, indexFrom, today);
  const indexInvestorFrom = indexCandles.data?.from ?? indexFrom;
  const indexInvestorTo = indexCandles.data?.to ?? today;
  const indexInvestorNet = useLiveIndexInvestorNet(
    activeIndexId && timeframe === 'D' && capabilities.investorNet === 'market' ? activeIndexId : null,
    indexInvestorFrom,
    indexInvestorTo,
    timeframe === 'D' && capabilities.investorNet === 'market' && investorNetEnabled,
  );
  const indexBundle = useMemo<RangeBundle | null>(() => {
    if (!activeIndexId || !indexCandles.data) return null;
    return buildIndexBundle({
      indexId: activeIndexId,
      from: indexCandles.data.from,
      to: indexCandles.data.to,
      bucketMs: INDEX_BUCKET_MS[timeframe],
      candles: indexCandles.data.candles,
      investorPoints: indexInvestorNet.data?.points ?? [],
    });
  }, [activeIndexId, timeframe, indexCandles.data, indexInvestorNet.data?.points]);
  const activeLabel = activeInstrument ? instrumentLabel(activeInstrument) : activeCode;
  // 상태바 현재가용 fresh 체결가 — 타임프레임 무관(live.trade 는 code 단위 구독).
  const liveTradePrice = freshLiveTradePrice(live.trade, venue, Date.now());
  // 최대벽 래칫의 유효-스냅샷 하한 — 캔들·호가 지표와 **같은 venue 세션**을 쓴다.
  // 종전엔 술어 안에 09:00 이 박혀 있어 NXT 프리마켓(08:00–08:50) 벽이 배제됐다.
  const peakSessionOpenMs = useMemo(
    () => liveVenueSessionBoundsMs(today, venue).open_ms,
    [today, venue],
  );
  /**
   * 라이브 스트림을 훑는 지표의 **계산 게이트**. fetch 게이트(`planLiveRangeRequest` 의
   * `askPeaksEnabled`/`bidPeaksEnabled`/`tradeVolumePocEnabled`)와 **같은 술어**여야 한다.
   *
   * 종전엔 `isMinuteTimeframe` 하나뿐이라 **비대칭**이었다: 토글을 끄면 백엔드는 seed 를
   * 안 보내는데 클라이언트는 없는 데이터를 위해 `live.ob`·`live.trade` 를 계속 훑었다.
   * 기본값이 OFF 이고(`liveIndicatorsPersistence` 의 `=== true`) 기본 봉이 분봉이라,
   * **최대벽·매물대를 한 번도 켠 적 없는 사용자가 매 flush(150ms)마다 이 비용을 전액**
   * 냈다 — 화면에는 아무것도 안 그려지므로 원인을 지목할 단서가 없다. #923 이 히트맵·증감에
   * 같은 처방을 넣으면서 이 세 지표를 빠뜨린 것이다(기각이 아니라 적용 누락).
   *
   * **끄는 것은 `ob`/`trade` 뿐이다.** `seeds`·`candles`·`segments` 는 그대로 흘린다 —
   * 그래야 꺼진 상태에서도 파생값이 백엔드 래칫(`liveInitial.ask_peak_today`)과 캔들 폴백
   * (`computeCandleVolumePocs`)으로 조립되고, `liveSaveBundle` 이 `/study` 저장 뷰로
   * 내보내는 `ask_peaks`/`bid_peaks`/`trade_volume_pocs` 가 통째로 비지 않는다. 그 둘은
   * 틱마다 churn 하지 않으므로 게이트의 목적(틱당 비용 제거)과 충돌하지 않는다.
   *
   * `hidden` 은 게이트에 넣지 않는다 — fetch 게이트가 `enabled` 만 보므로 같은 축을 유지한다
   * (넣으면 숨김 토글이 저장 뷰의 내용을 조용히 바꾼다).
   */
  const { askPeakEnabled, bidPeakEnabled, tradeVolumePocEnabled } = useWindowIndicators();
  const isMinute = isMinuteTimeframe(timeframe);
  const askPeaksOn = isMinute && askPeakEnabled;
  const bidPeaksOn = isMinute && bidPeakEnabled;
  const tradeVolumePocOn = isMinute && tradeVolumePocEnabled;
  const askPeakOb = askPeaksOn ? live.ob : EMPTY_OB_SNAPSHOTS;
  const askPeakTrade = askPeaksOn ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const askPeakSeeds = candlePathBundle?.ask_peaks ?? EMPTY_ASK_PEAKS;
  const askPeakCandles = isMinuteTimeframe(timeframe) ? (candlePathBundle?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayAskPeaks = useDayAskPeaks(
    askPeakOb,
    askPeakTrade,
    askPeakSeeds,
    today,
    peakSessionOpenMs,
    activeCode,
    liveInitial?.ask_peak_today ?? null,
    askPeakCandles,
  );
  const bidPeakOb = bidPeaksOn ? live.ob : EMPTY_OB_SNAPSHOTS;
  const bidPeakTrade = bidPeaksOn ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const bidPeakSeeds = candlePathBundle?.bid_peaks ?? EMPTY_BID_PEAKS;
  const bidPeakCandles = isMinuteTimeframe(timeframe) ? (candlePathBundle?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayBidPeaks = useDayBidPeaks(
    bidPeakOb,
    bidPeakTrade,
    bidPeakSeeds,
    today,
    peakSessionOpenMs,
    activeCode,
    liveInitial?.bid_peak_today ?? null,
    bidPeakCandles,
  );
  // 라이브 인자(trade·ob)만 토글로 끊는다 — candles·segments 는 봉 게이트만 따른다.
  // `orderbooks` 는 `firstTrailingSinglePriceBookMs` 로 들어가는데, 그 함수가 창을 조기
  // 종료 없이 두 번 완주하므로 이 훅에서 가장 비싼 항이다(위 게이트 주석 참조).
  const tradeVolumePocs = useTradeVolumePocs(
    tradeVolumePocOn ? live.trade : EMPTY_TRADE_SNAPSHOTS,
    candlePathBundle?.trade_volume_pocs ?? [],
    today,
    activeCode,
    isMinute ? (candlePathBundle?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES,
    isMinute ? (candlePathBundle?.segments ?? []) : [],
    tradeVolumePocOn ? live.ob : EMPTY_OB_SNAPSHOTS,
  );
  const liveSaveBundle = useMemo<RangeBundle | null>(() => {
    // `candlePathBundle` 은 `stockChartBundle ?? stockBundle` 이라 `stockBundle` 이 있으면
    // 반드시 있지만, 타입이 그걸 모른다. 가드를 함께 두어 아래를 non-null 로 좁힌다.
    if (!stockBundle || !candlePathBundle) return null;
    return {
      ...stockBundle,
      from_date: candlePathBundle.from_date,
      to_date: candlePathBundle.to_date,
      bucket_ms: candlePathBundle.bucket_ms,
      segments: candlePathBundle.segments,
      candles: candlePathBundle.candles,
      volume_profile_range: candlePathBundle.volume_profile_range,
      volume_profile_by_day: candlePathBundle.volume_profile_by_day,
      volume_distributions: candlePathBundle.volume_distributions ?? [],
      investorPoints: candlePathBundle.investorPoints,
      ask_peaks: dayAskPeaks,
      bid_peaks: dayBidPeaks,
      broker_late_entries: candlePathBundle.broker_late_entries ?? [],
      trade_volume_pocs: tradeVolumePocsToWire(tradeVolumePocs),
      // ⚠️ `candlePathBundle`(=캔들 경로 그릇) 가 아니라 병합 번들에서 가져온다 — 아래
      // workareaDepthHeatmap 과 같은 이유다. 저장 뷰는 "지금 화면"의 스냅샷이라
      // 오버레이가 그린 것과 같은 배열이어야 한다.
      depth_heatmap: stockBundle.depth_heatmap ?? [],
    };
  }, [stockBundle, stockChartBundle, dayAskPeaks, dayBidPeaks, tradeVolumePocs]);
  const workareaCode = activeCode ?? (activeIndexId ? indexWorkareaCode(activeIndexId) : null);
  const workareaBundle = activeIndexId ? indexBundle : stockBundle;
  const workareaChartBundle = activeIndexId ? indexBundle : stockChartBundle;
  const workareaHogaBundle = activeIndexId ? indexBundle : stockHogaBundle;
  /**
   * 호가 잔량 히트맵 오버레이의 소스. **반드시 병합 번들(`workareaBundle`)에서** 온다.
   *
   * 왜 훅이 배열째 내보내나: 소비처(ChartWindow)가 `chartBundle ?? bundle` 로 고르면
   * 종목 뷰에서는 `chartBundle` 이 항상 non-null 이라 **sidecar 전용 배열**이 잡히고,
   * `useLiveBundle` 의 `mergeDepthHeatmapToday`(오늘 SSE 버킷 overlay)가 통째로
   * 버려진다 — 2026-07-20 멀티창 플립(#719) 때 그렇게 배선돼 있었다. 그 상태에서
   * 히트맵은 디스크 승격 주기(5분)로만 갱신돼, 승격 직전에는 최신(형성 중) 캔들 포함
   * 4~5개 버킷이 항상 비어 보였다(2026-08-04 실측: 11:21~11:24 마지막 버킷 11:20 고정
   * → 11:25 에 5칸 동시 등장). 선택을 창 밖에서 없애 잘못 고를 여지 자체를 지운다.
   *
   * `chartBundle`/`bundle` 분리는 SSE 틱이 캔들·세그먼트 경로를 churn 하지 않게 하는
   * **성능** 분기지, 데이터 분기가 아니다. 라이브 성분이 필요한 필드를 `chartBundle`
   * 에서 뽑으면 조용히 과거분만 얻는다.
   */
  const workareaDepthHeatmap: readonly DepthHeatmapPointWire[] =
    (activeIndexId ? indexBundle : stockBundle)?.depth_heatmap ?? EMPTY_DEPTH_HEATMAP;
  const workareaLoading = activeIndexId ? indexCandles.isLoading : isPastCandlesLoading;
  const indexExtending = activeIndexId ? historicalFromDate !== null && indexCandles.isFetching : false;
  /** 지수 캔들 응답이 되싣는 from — 웜 캐시 스텝의 백필 진행 신호(#1328).
   *  지수는 캔들 쿼리 하나가 곧 스텝이라(동반 확장할 range 지표가 없다) 종목 D/W/M과
   *  달리 **전 봉**에서 안전하다. 지수 분봉도 병합 캐시가 없어 같은 잠금을 겪으므로
   *  봉으로 가르지 않는다. `indexExtending` 식 자체는 원자화 의미라 손대지 않는다. */
  const indexSettledFromDate = activeIndexId ? indexCandles.data?.from ?? null : null;
  const workareaDataWarnings = activeIndexId ? indexCandles.data?.data_warnings ?? [] : pastDataWarnings;

  return {
    today,
    live,
    liveInitial,
    liveTradePrice,
    activeIndexId,
    activeLabel,
    capabilities,
    clampEngaged,
    minuteScrollbackFloorDate,
    isHogaLoading,
    isSidecarLoading,
    isExtending,
    indexExtending,
    isDailyMaLoading,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
    pastSettledFromDate,
    indexSettledFromDate,
    dayAskPeaks,
    dayBidPeaks,
    tradeVolumePocs,
    liveSaveBundle,
    // 지수(index) 워크에어리어는 호가장이 없어 증감 소스도 없다 — 종목일 때만 흘린다.
    depthDeltaToday: activeIndexId ? [] : depthDeltaToday,
    /** 번들 지표에 적용된 날짜별 수정계수 — `/api/range` 를 따로 호출하는 데이터 창이
     *  같은 척도를 쓰게 하는 통로(`scaleRangeBundlePrices`). 지수는 호가 지표 자체가
     *  없으므로 `undefined`(`depthDeltaToday` 와 같은 규율). */
    adjustFactors: activeIndexId ? undefined : adjustFactors,
    /** 디스크 창(얼린 저장뷰 · 창별 hogaplay 소스)의 키움 보충 결과.
     *  **로딩 게이트에는 넣지 않는다** — 보충은 디스크
     *  캔들이 그려진 뒤 점진적으로 도착하는 것이 설계다. reveal 을 여기에 묶으면 있는
     *  데이터마저 가장 느린 벤더 walk 를 기다리게 되고, 그게 이 기능이 피하려던 비용이다.
     *  지수 워크에어리어는 분봉 캡처 파이프라인 자체가 없으므로 대상이 아니다. */
    gapFill,
    workareaCode,
    workareaBundle,
    workareaChartBundle,
    workareaHogaBundle,
    /** 호가 결손 사유 — 번들과 **따로** 흘린다(#1133). 지수 워크에어리어는 호가장이
     *  없어 결손이라는 개념 자체가 없으므로 빈 배열이다(`depthDeltaToday` 와 같은 규율). */
    workareaHogaMissingDates: activeIndexId ? [] : hogaMissingDates,
    /** 캔들 빈 상태 — 지수 워크에어리어는 캔들 파이프라인이 달라(indexBundle) 이
     *  판별의 대상이 아니다. `workareaHogaMissingDates` 와 같은 규율. */
    workareaCandleEmpty: activeIndexId ? null : candleEmpty,
    refetchCandles,
    workareaDepthHeatmap,
    workareaLoading,
    workareaDataWarnings,
  } as const;
}
