/**
 * /study 데이터 창 콘텐츠 (ADR-0123 PR-3).
 *
 * 구 StudyReferenceDetailPanel(우측 aside 4카드 스택)의 카드 resolver 들을 창 단위로
 * 이관한 것. 커서(`sidebarCursorMs`)는 전 창이 암묵 단일 그룹으로 소비한다 —
 * /live 의 `useGroupCursor`(origin.group 게이트)가 필요 없다(활성 저장뷰 하나뿐).
 *
 * 다만 **해석 봉은 발행 창의 것**을 쓴다(#801). 차트 창이 여럿이면 마지막에 호버한
 * 창이 커서를 발행하는데, 그 커서를 다른 창의 봉으로 읽으면 일봉 커서를 분봉으로
 * 오해하는 식의 어긋남이 난다. `sidebarCursorOrigin` 이 이미 발행 창의 봉을 싣고
 * 있으므로(ADR-0119 PR-D) 그걸 쓴다.
 * 각 kind 가 자기 데이터 훅만 부른다 — react-query 가 중복 조회를 dedupe 하므로
 * 동종 창 중복도 안전하다.
 */
import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useMemo } from 'react';
import {
  useLiveBrokersAtCursor,
  useLiveOrderbookAtCursor,
} from '../api/useLiveCursor';
import type { RangeBundle } from '../api/types';
import type { StudyViewReference } from '../api/studyViews';
import type { GroupId } from '../workspace/groupId';
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
import { isMinuteTimeframe, type MinuteTimeframe } from '../state/livePage';
import { STUDY_DATA_WINDOW_TEST_ID, type StudyDataWindowKind } from './studyWindowMeta';
import { STUDY_VENUE } from './studyVenuePolicy';

type ContentProps = {
  save: StudyViewReference;
  bundle: RangeBundle;
};

/** 커서 스코프 공용 파생 — 구 패널 상단 로직 그대로(창별 호출·값 동일). */
function useStudyCursorScope(save: StudyViewReference) {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const cursorTimeframe = useLiveCursorStore((s) => s.sidebarCursorOrigin?.timeframe ?? null);
  const cursorScope = resolveCursorDetailScope({
    cursorMs,
    timeframe: cursorTimeframe ?? save.timeframe,
  });
  const detailCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;
  const minuteTimeframe: MinuteTimeframe | null = cursorScope.kind === 'minute-cursor'
    ? cursorScope.minuteTimeframe
    : isMinuteTimeframe(cursorTimeframe ?? save.timeframe)
      ? (cursorTimeframe ?? save.timeframe) as MinuteTimeframe
      : null;
  const volumeDistributionDate = detailCursorMs !== null
    ? realMsToYyyymmdd(detailCursorMs)
    : save.range.to_date;
  return { cursorScope, detailCursorMs, minuteTimeframe, volumeDistributionDate };
}

function BookContent({ save, bundle }: ContentProps) {
  const { cursorScope, detailCursorMs, minuteTimeframe, volumeDistributionDate } = useStudyCursorScope(save);
  const { spot: spotOrderbook, stale: orderbookStale, error: orderbookError } =
    useLiveOrderbookAtCursor({
      code: save.code,
      timeframe: minuteTimeframe,
      // 복기는 KRX 고정이다(`studyVenuePolicy`, ADR-0144). 차트(`useStudyReferenceBundle`)
      // 와 **같은 상수**를 읽는 것이 요점이다 — 여기만 하드코딩으로 남겨 뒀던 시기에
      // 차트는 NXT, 이 카드는 KRX 를 보는 화면이 실제로 있었다.
      venue: STUDY_VENUE,
    });
  const orderbookSnapshot = resolveOrderbookCardSnapshot({
    scope: cursorScope,
    spotSnapshot: spotOrderbook?.snapshot,
    inactiveSnapshot: null,
    bufferFallbackSnapshot: null,
  });
  // 10호가 가격색·등락률의 분모 = **사다리 자신의 날짜**의 전일 종가.
  //
  // 커서 날짜(`volumeDistributionDate`)를 쓰면 안 된다. 이 카드에서 사다리만
  // 네트워크고 나머지는 전부 로컬 파생이라, 커서가 날짜를 넘어가는 동안 **분자는
  // 옛 날짜 · 분모는 새 날짜**인 프레임이 뜬다. 2026-08-20 실측: 같은 가격
  // 26,050 이 −1.51% 에서 +2.76% 로 바뀌는데 잔량 10줄은 한 자리도 안 움직였다.
  // 사다리 시각을 분모의 출처로 삼으면 늦은 프레임도 **그 시점의 정합한 화면**이
  // 되고, 낡았다는 사실은 딤이 따로 말한다.
  //
  // 부수 효과로 쿼리 키가 줄어든다 — 조회가 비행 중이면 사다리 날짜가 그대로라
  // 커서가 스쳐 간 날짜마다 키가 생기지 않는다.
  const ladderDate =
    orderbookSnapshot != null
      ? realMsToYyyymmdd(orderbookSnapshot.ts_ms)
      : volumeDistributionDate;
  // 15일 창(주말·공휴일 커버).
  const baselineFrom = subtractDaysKst(ladderDate, 15);
  const prevCloseQuery = useScreenerDailyCandles(
    orderbookSnapshot ? save.code : null,
    baselineFrom,
    ladderDate,
  );
  const baselinePrice = useMemo(
    () => prevCloseBeforeDate(prevCloseQuery.data?.candles ?? [], ladderDate),
    [prevCloseQuery.data, ladderDate],
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
        // 이 요약은 **커서 시점** 값인데 분모는 위에서 사다리 시점으로 옮겼다 —
        // 비행 중 잠깐 두 시점이 갈린다. `BookPanel` 은 `summary.prevClose` 를
        // 읽지 않으므로(요약 패널은 절대값만 그린다) 화면에 나타나지 않고,
        // 분모를 한 벌 더 조회해 맞추는 것은 날짜별 쿼리를 되살리는 값이라
        // 하지 않는다. 눈에 보이는 잔여물은 최고/최저 색조뿐이고, 그동안
        // 사다리는 딤이 걸려 있다(`BookPanel.stale` 주석).
        prevClose: baselinePrice,
      },
      lastPrice: upTo[upTo.length - 1].close,
    };
  }, [dayCandles, cursorLimitMs, bundle.segments, bundle.fill_strength, volumeDistributionDate, baselinePrice]);
  // 실패는 로딩과 **다른 문구**여야 한다. `useSpot` 은 실패분을 비우므로(옛 호가를
  // 남기지 않는다) 그냥 두면 `snapshot === undefined` 로 떨어져 "커서 위치 불러오는
  // 중…" 이 영원히 뜨는데, 이 훅에는 재시도가 없어서 그 문구가 거짓말이 된다.
  // 재시도 경로가 곧 커서 이동이라 그것을 안내한다.
  if (cursorScope.kind === 'minute-cursor' && orderbookError !== null) {
    return (
      <div
        data-testid="study-orderbook-error"
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center"
      >
        <span className="font-data text-xs" style={{ color: 'var(--error)' }}>
          호가 불러오기 실패
        </span>
        <span className="text-2xs text-fg-dim">커서를 다시 움직이면 재시도합니다</span>
      </div>
    );
  }
  return (
    <BookPanel
      snapshot={orderbookSnapshot}
      baselinePrice={baselinePrice}
      summary={summary}
      trades={[]}
      maskRatio={false}
      lastPrice={lastPrice}
      stale={orderbookStale}
    />
  );
}

function BrokerContent({ save }: ContentProps) {
  const { cursorScope, minuteTimeframe } = useStudyCursorScope(save);
  const spotBrokers = useLiveBrokersAtCursor({
    code: save.code,
    timeframe: minuteTimeframe,
    // 복기는 KRX 고정 — 위 BookContent 와 같은 근거(ADR-0144).
    venue: STUDY_VENUE,
  });
  const brokerCard = resolveBrokerCardProps({
    scope: cursorScope,
    spotSeries: spotBrokers,
    inactiveSeries: null,
    inactiveCursorMs: null,
  });
  // 표시 창(세션 경계)도 같은 상수를 쓴다 — 조회 venue 와 표시 창이 갈리면 있는
  // 데이터가 창 밖으로 밀려 빈 표가 된다.
  return (
    <BrokerTrajectoryTable
      series={brokerCard.series}
      cursorMs={brokerCard.cursorMs}
      venue={STUDY_VENUE}
    />
  );
}

function VdistContent({ save, bundle }: ContentProps) {
  const { detailCursorMs, minuteTimeframe, volumeDistributionDate } = useStudyCursorScope(save);
  // 데이터 창도 차트 창 설정을 읽는다(#904) — 같은 지표를 두 창이 다르게 그리면
  // 안 된다.
  const {
    volumeDistributionEnabled,
    volumeDistributionHoverCutoffEnabled,
    volumeDistributionRangeCount,
    volumeDistributionColor,
    volumeDistributionMaxColor,
  } = useStudyChartIndicators();
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
  // 당일 종가 오버레이 — program_trade 와 같은 번들의 candles(카드가 anchorT
  // 날짜로 잘라 쓴다).
  const closePoints = useMemo(
    () => volumeDistributionClosePointsFromCandles(bundle.candles ?? []),
    [bundle.candles],
  );
  return (
    <ProgramTradeSummaryCard
      series={bundle.program_trade}
      cursorMs={detailCursorMs}
      closePoints={closePoints}
    />
  );
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
 * 데이터 창 본문 — 자기 그룹의 저장뷰 번들이 준비되기 전엔 로딩 카드.
 * testid 는 구 카드 계약(`study-detail-card-*`/`study-detail-content-*`)을 승계해
 * 커서 스팟 테스트가 창 전환을 넘어 그대로 통과한다.
 *
 * `save`/`bundle` 은 **이 창의 그룹** 것이다(ADR-0154) — 그룹의 포커스 차트 창이
 * 먹이는 번들. 그룹을 무시하면 그룹 2 의 10호가에 그룹 1 의 데이터가 뜬다.
 */
export function StudyDataWindowContent({
  kind,
  group,
  emptyReason,
  save,
  bundle,
}: {
  kind: StudyDataWindowKind;
  group: GroupId;
  /**
   * 그릴 것이 없는 **이유**. null 이면 정상(로딩 포함).
   *
   * 로딩과 반드시 구분한다 — 둘 다 쿼리가 아예 안 걸리는 상태라, 로딩 문구를 쓰면
   * 영영 끝나지 않는 거짓말이 된다.
   *
   * - `no-view` — 이 그룹에 저장뷰가 없다.
   * - `no-chart` — 저장뷰는 있는데 이 그룹에 **차트 창이 없다**. 데이터 창의 번들은
   *   그룹의 포커스 차트 창에서 오므로(봉이 쿼리 키다) 소스가 통째로 없다. 팔레트로
   *   차트 창만 다른 그룹에 옮기면 도달한다.
   */
  emptyReason: 'no-view' | 'no-chart' | null;
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
}) {
  const testId = STUDY_DATA_WINDOW_TEST_ID[kind];
  if (emptyReason) {
    return (
      <div
        data-testid={`study-data-window-${emptyReason}`}
        className="flex h-full w-full flex-col items-center justify-center gap-1 bg-bg-subtle/40 text-xs text-fg-dim"
      >
        <span className="font-data">그룹 {group}</span>
        <span>
          {emptyReason === 'no-view' ? '저장뷰를 선택하세요' : '이 그룹에 차트 창을 추가하세요'}
        </span>
      </div>
    );
  }
  if (!save || !bundle) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-xs text-fg-dim">
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
