import { useMemo, type ReactNode } from 'react';
import {
  useLiveBrokersAtCursor,
  useLiveOrderbookAtCursor,
} from '../api/useLiveCursor';
import type { RangeBundle } from '../api/types';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { realMsToYyyymmdd, subtractDaysKst } from '../live/liveDateTime';
import { useScreenerDailyCandles, prevCloseBeforeDate } from '../api/screenerDailyCandles';
import {
  buildCandleDateIndex,
  selectVolumeDistributionProfile,
  volumeDistributionClosePointsFromCandles,
} from '../live/continuousTradeVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../live/useVolumeDistributionCutoffProfile';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import { isMinuteTimeframe, type MinuteTimeframe } from '../state/livePage';
import { useLivePageStore } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';
import { DataSection } from '../ui/DataSurface';
import { PanelCard } from '../ui/PageShell';

type Props = {
  save: StudyViewReference;
  bundle: RangeBundle;
};

type SectionProps = {
  label: string;
  testId: string;
  children: ReactNode;
};

export function StudyReferenceDetailPanel({ save, bundle }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const cursorScope = resolveCursorDetailScope({
    cursorMs,
    timeframe: save.timeframe,
  });
  const detailCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;
  const minuteTimeframe: MinuteTimeframe | null = cursorScope.kind === 'minute-cursor'
    ? cursorScope.minuteTimeframe
    : isMinuteTimeframe(save.timeframe)
      ? save.timeframe
      : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const orderbookSnapshot = resolveOrderbookCardSnapshot({
    scope: cursorScope,
    spotSnapshot: spotOrderbook?.snapshot,
    inactiveSnapshot: null,
    bufferFallbackSnapshot: null,
  });
  const brokerCard = resolveBrokerCardProps({
    scope: cursorScope,
    spotSeries: spotBrokers,
    inactiveSeries: null,
    inactiveCursorMs: null,
  });
  const volumeDistributionDate = detailCursorMs !== null
    ? realMsToYyyymmdd(detailCursorMs)
    : save.range.to_date;
  // 10호가 가격색 기준 = 리플레이 날짜(volumeDistributionDate)의 전일 종가 = 그 직전 거래일의
  // 일봉 close(라이브의 quote.baseline_price 와 같은 의미, 과거일 판). 커서 이동 시
  // volumeDistributionDate 가 그 위치 날짜로 바뀌므로 색 기준도 따라간다. 호가가 실제로 있을
  // 때만(minute-cursor 스코프) 조회 — 15일 창(주말·공휴일 커버). screener-daily-candles 는
  // 이미 D/W/M study 가 쓰는 KRX 확정 일봉 소스라 신규 API 표면 없음.
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
    enabled: volumeDistributionEnabled && volumeDistributionHoverCutoffEnabled && detailCursorMs !== null,
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
    <div
      data-testid="study-reference-detail-cards"
      className="grid min-h-full content-start gap-2 bg-bg-subtle/40 p-2"
      style={{ gridTemplateRows: 'auto auto auto auto' }}
    >
      <StudyDetailSection label="10호가" testId="orderbook">
        <>
          <OrderbookTable snapshot={orderbookSnapshot} baselinePrice={baselinePrice} />
          <TotalQtyBar snapshot={orderbookSnapshot} maskRatio={false} />
        </>
      </StudyDetailSection>
      <StudyDetailSection label="거래원" testId="brokers">
        <BrokerTrajectoryTable
          series={brokerCard.series}
          cursorMs={brokerCard.cursorMs}
        />
      </StudyDetailSection>
      <StudyDetailSection label="연속체결 매물대 분포" testId="volume-distribution">
        <VolumeDistributionCard
          profile={cutoffVolumeDistribution}
          cursorMs={detailCursorMs}
          closePoints={volumeClosePoints}
          color={volumeDistributionColor}
          maxColor={volumeDistributionMaxColor}
        />
      </StudyDetailSection>
      <StudyDetailSection label="프로그램" testId="program">
        <ProgramTradeSummaryCard
          series={bundle.program_trade}
          cursorMs={detailCursorMs}
        />
      </StudyDetailSection>
    </div>
  );
}

function StudyDetailSection({ label, testId, children }: SectionProps) {
  return (
    <PanelCard
      data-testid={`study-detail-card-${testId}`}
      className="flex flex-col"
    >
      <DataSection title={label} className="flex flex-1 flex-col border-t-0" contentClassName="flex-1">
        <div data-testid={`study-detail-content-${testId}`} className="flex-1">
          {children}
        </div>
      </DataSection>
    </PanelCard>
  );
}
