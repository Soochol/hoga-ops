/**
 * /study 데이터 창 콘텐츠 (ADR-0123 PR-3).
 *
 * 구 StudyReferenceDetailPanel(우측 aside 4카드 스택)의 카드 resolver 들을 창 단위로
 * 이관한 것. 커서(`sidebarCursorMs`)는 전 창이 암묵 단일 그룹으로 소비한다 —
 * /live 의 `useGroupCursor`(origin.group 게이트)가 필요 없다(활성 저장뷰 하나뿐).
 * 각 kind 가 자기 데이터 훅만 부른다 — react-query 가 중복 조회를 dedupe 하므로
 * 동종 창 중복도 안전하다.
 */
import { useMemo } from 'react';
import {
  useLiveBrokersAtCursor,
  useLiveOrderbookAtCursor,
} from '../api/useLiveCursor';
import type { RangeBundle } from '../api/types';
import type { StudyViewReference } from '../api/studyViews';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { realMsToYyyymmdd, subtractDaysKst } from '../live/liveDateTime';
import { useScreenerDailyCandles, prevCloseBeforeDate } from '../api/screenerDailyCandles';
import {
  buildCandleDateIndex,
  selectVolumeDistributionProfile,
  volumeDistributionClosePointsFromCandles,
} from '../live/continuousTradeVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../live/useVolumeDistributionCutoffProfile';
import BookPanel from '../live/workspace/BookPanel';
import { EMPTY_TRADE_SUMMARY, type LiveTradeSummary } from '../live/liveSidebarAdapters';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import { isMinuteTimeframe, useLivePageStore, type MinuteTimeframe } from '../state/livePage';
import { STUDY_DATA_WINDOW_TEST_ID, type StudyDataWindowKind } from './studyWindowMeta';

type ContentProps = {
  save: StudyViewReference;
  bundle: RangeBundle;
};

/** 커서 스코프 공용 파생 — 구 패널 상단 로직 그대로(창별 호출·값 동일). */
function useStudyCursorScope(save: StudyViewReference) {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const cursorScope = resolveCursorDetailScope({ cursorMs, timeframe: save.timeframe });
  const detailCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;
  const minuteTimeframe: MinuteTimeframe | null = cursorScope.kind === 'minute-cursor'
    ? cursorScope.minuteTimeframe
    : isMinuteTimeframe(save.timeframe)
      ? save.timeframe
      : null;
  const volumeDistributionDate = detailCursorMs !== null
    ? realMsToYyyymmdd(detailCursorMs)
    : save.range.to_date;
  return { cursorScope, detailCursorMs, minuteTimeframe, volumeDistributionDate };
}

function BookContent({ save, bundle }: ContentProps) {
  const { cursorScope, detailCursorMs, minuteTimeframe, volumeDistributionDate } = useStudyCursorScope(save);
  const spotOrderbook = useLiveOrderbookAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const orderbookSnapshot = resolveOrderbookCardSnapshot({
    scope: cursorScope,
    spotSnapshot: spotOrderbook?.snapshot,
    inactiveSnapshot: null,
    bufferFallbackSnapshot: null,
  });
  // 10호가 가격색 기준 = 리플레이 날짜의 전일 종가(그 직전 거래일 일봉 close).
  // 커서 이동 시 날짜가 따라가므로 색 기준도 따라간다. 15일 창(주말·공휴일 커버).
  const baselineFrom = subtractDaysKst(volumeDistributionDate, 15);
  const prevCloseQuery = useScreenerDailyCandles(
    orderbookSnapshot ? save.code : null,
    baselineFrom,
    volumeDistributionDate,
  );
  const baselinePrice = useMemo(
    () => prevCloseBeforeDate(prevCloseQuery.data?.candles ?? [], volumeDistributionDate),
    [prevCloseQuery.data, volumeDistributionDate],
  );
  // 십자 배치 BookPanel(/live 와 동일 표면). 요약 지표는 라이브 WS(FID) 대신
  // 커서 시점까지의 번들에서 파생한다 — 시/고/저·누적량은 그날 캔들 누적,
  // 체결강도는 fill_strength 누적 비. 재료가 없는 값(거래대금·전일비·상하한·VI·
  // 체결 리스트·순간 증감)은 null/빈 값 → 패널이 대시/빈 열로 처리한다.
  const cursorLimitMs = detailCursorMs ?? Number.POSITIVE_INFINITY;
  const dayCandles = useMemo(
    () => buildCandleDateIndex(bundle.candles).get(volumeDistributionDate) ?? [],
    [bundle.candles, volumeDistributionDate],
  );
  const { summary, lastPrice } = useMemo((): { summary: LiveTradeSummary; lastPrice: number | null } => {
    const upTo = dayCandles.filter((c) => c.ts_ms <= cursorLimitMs);
    if (upTo.length === 0) return { summary: EMPTY_TRADE_SUMMARY, lastPrice: null };
    const segment = bundle.segments.find((s) => s.date === volumeDistributionDate) ?? null;
    const fills = segment
      ? (bundle.fill_strength?.points ?? []).filter(
          (p) => p.t >= segment.session_open_ms && p.t <= Math.min(cursorLimitMs, segment.session_close_ms),
        )
      : [];
    const buyQty = fills.reduce((acc, p) => acc + p.buy_qty, 0);
    const sellQty = fills.reduce((acc, p) => acc + p.sell_qty, 0);
    return {
      summary: {
        ...EMPTY_TRADE_SUMMARY,
        dayOpen: upTo[0].open,
        dayHigh: Math.max(...upTo.map((c) => c.high)),
        dayLow: Math.min(...upTo.map((c) => c.low)),
        cumVolume: upTo.reduce((acc, c) => acc + c.vol_a + c.vol_b, 0),
        fillStrengthPct: sellQty > 0 ? (buyQty / sellQty) * 100 : null,
        prevClose: baselinePrice,
      },
      lastPrice: upTo[upTo.length - 1].close,
    };
  }, [dayCandles, cursorLimitMs, bundle.segments, bundle.fill_strength, volumeDistributionDate, baselinePrice]);
  return (
    <BookPanel
      snapshot={orderbookSnapshot}
      baselinePrice={baselinePrice}
      summary={summary}
      trades={[]}
      maskRatio={false}
      lastPrice={lastPrice}
    />
  );
}

function BrokerContent({ save }: ContentProps) {
  const { cursorScope, minuteTimeframe } = useStudyCursorScope(save);
  const spotBrokers = useLiveBrokersAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const brokerCard = resolveBrokerCardProps({
    scope: cursorScope,
    spotSeries: spotBrokers,
    inactiveSeries: null,
    inactiveCursorMs: null,
  });
  return <BrokerTrajectoryTable series={brokerCard.series} cursorMs={brokerCard.cursorMs} />;
}

function VdistContent({ save, bundle }: ContentProps) {
  const { detailCursorMs, minuteTimeframe, volumeDistributionDate } = useStudyCursorScope(save);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const candleDateIndex = useMemo(
    () => buildCandleDateIndex(bundle.candles),
    [bundle.candles],
  );
  const volumeDistributionCandles = useMemo(
    () => candleDateIndex.get(volumeDistributionDate) ?? [],
    [candleDateIndex, volumeDistributionDate],
  );
  const volumeDistribution = useMemo(
    () => selectVolumeDistributionProfile({
      enabled: volumeDistributionEnabled,
      date: volumeDistributionDate,
      todayKst: null,
      rangeCount: volumeDistributionRangeCount,
      persistedProfiles: bundle.volume_distributions ?? [],
      recomputedToday: null,
      liveTrades: [],
    }),
    [
      bundle.volume_distributions,
      volumeDistributionDate,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    ],
  );
  const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
    enabled:
      volumeDistributionEnabled
      && volumeDistributionHoverCutoffEnabled
      && detailCursorMs !== null,
    code: save.code,
    timeframe: minuteTimeframe,
    date: volumeDistributionDate,
    cursorMs: detailCursorMs,
    todayKst: null,
    rangeCount: volumeDistributionRangeCount,
    finalProfile: volumeDistribution,
    priceRange: null,
    liveTrades: [],
    candles: volumeDistributionCandles,
    segment: bundle.segments.find((segment) => segment.date === volumeDistributionDate) ?? null,
  });
  const volumeClosePoints = useMemo(
    () => volumeDistributionClosePointsFromCandles(volumeDistributionCandles),
    [volumeDistributionCandles],
  );
  return (
    <VolumeDistributionCard
      profile={cutoffVolumeDistribution}
      cursorMs={detailCursorMs}
      closePoints={volumeClosePoints}
      color={volumeDistributionColor}
      maxColor={volumeDistributionMaxColor}
    />
  );
}

function ProgramContent({ save, bundle }: ContentProps) {
  const { detailCursorMs } = useStudyCursorScope(save);
  return <ProgramTradeSummaryCard series={bundle.program_trade} cursorMs={detailCursorMs} />;
}

function contentFor(kind: StudyDataWindowKind, props: ContentProps): React.ReactNode {
  switch (kind) {
    case 'book': return <BookContent {...props} />;
    case 'broker': return <BrokerContent {...props} />;
    case 'vdist': return <VdistContent {...props} />;
    case 'program': return <ProgramContent {...props} />;
  }
}

/**
 * 데이터 창 본문 — 활성 저장뷰 번들이 준비되기 전엔 로딩 카드.
 * testid 는 구 카드 계약(`study-detail-card-*`/`study-detail-content-*`)을 승계해
 * 커서 스팟 테스트가 창 전환을 넘어 그대로 통과한다.
 */
export function StudyDataWindowContent({
  kind,
  save,
  bundle,
}: {
  kind: StudyDataWindowKind;
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
}) {
  const testId = STUDY_DATA_WINDOW_TEST_ID[kind];
  if (!save || !bundle) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-[11px] text-fg-dimmer">
        <span className="font-data">학습뷰 불러오는 중…</span>
      </div>
    );
  }
  return (
    <div
      data-testid={`study-detail-card-${testId}`}
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg-card"
    >
      <div data-testid={`study-detail-content-${testId}`} className="flex-1">
        {contentFor(kind, { save, bundle })}
      </div>
    </div>
  );
}
