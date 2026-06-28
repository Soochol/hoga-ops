import { useMemo, type ReactNode } from 'react';
import {
  useLiveBrokersAtCursor,
  useLiveOrderbookAtCursor,
} from '../api/useLiveCursor';
import type { RangeBundle } from '../api/types';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { realMsToYyyymmdd } from '../live/liveDateTime';
import {
  selectVolumeDistributionProfile,
  volumeDistributionClosePoints,
} from '../live/continuousTradeVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../live/useVolumeDistributionCutoffProfile';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import { isMinuteTimeframe, type MinuteTimeframe } from '../state/livePage';
import { useLivePageStore } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';

type Props = {
  save: StudyViewReference;
  bundle: RangeBundle;
  isCursorActive: boolean;
};

type SectionProps = {
  label: string;
  testId: string;
  children: ReactNode;
};

export function StudyReferenceDetailPanel({ save, bundle, isCursorActive }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const minuteTimeframe: MinuteTimeframe | null = isMinuteTimeframe(save.timeframe)
    ? save.timeframe
    : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code: save.code, timeframe: minuteTimeframe });
  const detailCursorMs = isCursorActive && cursorMs !== null && minuteTimeframe !== null
    ? cursorMs
    : null;
  const volumeDistributionDate = detailCursorMs !== null
    ? realMsToYyyymmdd(detailCursorMs)
    : save.range.to_date;
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
    candles: bundle.candles,
    segment: bundle.segments.find((segment) => segment.date === volumeDistributionDate) ?? null,
  });
  const volumeClosePoints = useMemo(
    () => volumeDistributionClosePoints({
      date: volumeDistributionDate,
      candles: bundle.candles,
    }),
    [bundle.candles, volumeDistributionDate],
  );

  return (
    <div
      data-testid="study-reference-detail-cards"
      className="grid min-h-full bg-bg-card"
      style={{ gridTemplateRows: 'auto auto auto auto' }}
    >
      <StudyDetailSection label="10호가" testId="orderbook">
        <>
          <OrderbookTable snapshot={isCursorActive ? spotOrderbook?.snapshot : null} />
          <TotalQtyBar snapshot={isCursorActive ? spotOrderbook?.snapshot : null} maskRatio={false} />
        </>
      </StudyDetailSection>
      <StudyDetailSection label="거래원" testId="brokers">
        <BrokerTrajectoryTable
          series={isCursorActive ? spotBrokers : null}
          cursorMs={detailCursorMs}
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
    <section
      aria-label={label}
      data-testid={`study-detail-card-${testId}`}
      className="flex flex-col border-t border-border first:border-t-0"
    >
      <header className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer">
        {label}
      </header>
      <div
        data-testid={`study-detail-content-${testId}`}
        className="flex-1"
      >
        {children}
      </div>
    </section>
  );
}
