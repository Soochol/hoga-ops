import { useLivePageStore } from '../state/livePage';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { captureHealthPillColor } from './captureHealthPill';
import { SourceChip } from '../chart/SourceChip';
import { useSymbols } from '../capture/useSymbols';
import type { RangeBundle } from '../api/types';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { useWatchlist } from '../watchlist/useWatchlist';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { HeartIcon } from '../ui/HeartIcon';
import { useQuoteByCode } from '../api/liveQuotes';
import { QuoteChange } from '../rightrail/QuoteChange';
import { useLiveStatus } from '../api/liveStatus';
import { deriveCollectionView } from './collectionStatus';
import { CollectionDot } from './CollectionDot';
import { useLiveVenueStore, type LiveVenueOption } from '../state/liveVenue';
import { liveHogaVenueNow, liveVenueDisplayLabel, liveVenueKeepsHogaKrx } from './liveVenuePolicy';
import { resolveLiveCurrentPrice } from './deriveCurrentPriceLine';
import type { CaptureHealthView } from './liveStatusProjection';
import { hogaCoverageGapTitle } from './hogaCoverageGap';
import { useHeatmap } from '../heatmap/useHeatmap';
import { heatmapGroupNameOf } from '../heatmap/heat';

interface Props {
  activeCode: string | null;
  captureHealth: CaptureHealthView;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. */
  bundle: RangeBundle | null;
  venue?: LiveVenueOption;
  /** useLiveBundle.hogaCoverageGapDates — 캔들은 있는데 10호가 캡처가 없는 과거
   * 거래일. 있으면 warn 칩으로 표시해 "지표가 최신 날짜에만 나온다" 오인을 막는다. */
  hogaGapDates?: readonly string[];
  /** LivePage 가 live.trade 를 환원한 fresh 체결가. 현재가 라인과 동일한
   * resolveLiveCurrentPrice 산출식을 공유해 "라인=상태바" invariant 를 유지한다. */
  liveTradePrice?: number | null;
  /** useLiveBundle.isExtending — 좌측 팬 과거 확장 한 스텝이 진행 중. 느린 백엔드
   * (KIS rate-limit·무거운 사이드카)에서 딥 워크백은 수십 초 무반응처럼 보이므로,
   * "과거 로딩 중 · N까지 로드됨" 진행 칩으로 '고장'이 아니라 '진행 중'임을 알린다. */
  isExtending?: boolean;
  /** 좌측 팬 딥 백필의 from-date — 플립 후 창 발행 채널이 공급(리뷰 #1).
   *  undefined 면 전역 스토어 폴백(플립 전·/study 경로). */
  historicalFromDate?: string | null;
}

export function LiveStatusBar({ activeCode, captureHealth, bundle, venue, hogaGapDates = [], liveTradePrice, isExtending = false, historicalFromDate: historicalFromDateProp }: Props) {
  // Threshold MUST exceed the 30s server ping so a connected-but-idle
  // socket (e.g. market closed) stays realtime; only a real disconnect
  // (no frame for >35s) flips it to disconnected. (plan-review cross-task flag)
  const live = useConnectionLiveness(LIVE_STALE_MS);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  // 과거 확장 진행 칩 게이트. historicalFromDate != null 은 "좌측 팬 확장 중"을
  // 뜻한다(초기 로드/종목·타임프레임 전환은 null). isExtending 과 AND 로 걸어
  // 확장이 아닌 최초 콜드 로드를 진행 칩으로 오인하지 않는다.
  const globalHistoricalFromDate = useLivePageStore((s) => s.historicalFromDate);
  const historicalFromDate = historicalFromDateProp !== undefined
    ? historicalFromDateProp
    : globalHistoricalFromDate;
  const { data: symbolsData } = useSymbols();
  const symbolName = activeCode
    ? symbolsData?.symbols.find((s) => s.code === activeCode)?.name
    : undefined;
  const symbolLabel = activeCode
    ? (symbolName ? `${symbolName}(${activeCode})` : activeCode)
    : '—';

  // 현재 포커스 종목이 속한 히트맵 그룹명(없으면 '없음'). 지수(index:)는 히트맵
  // 대상이 아니라 칩 자체를 숨긴다. 데이터 로드 전(heatmapData undefined)에도 숨겨
  // '없음'→그룹명 플리커를 막는다(한 종목=한 그룹이라 역조회는 find 한 번, heat.ts).
  const { data: heatmapData } = useHeatmap();
  const isIndexCode = !!activeCode && activeCode.startsWith('index:');
  const showHeatmapChip = !!activeCode && !isIndexCode && !!heatmapData;
  const heatmapGroupName = showHeatmapChip
    ? heatmapGroupNameOf(activeCode!, heatmapData!.folders, heatmapData!.entries)
    : null;

  const { isMember } = useWatchlistMembership();
  const member = !!activeCode && isMember(activeCode);

  // ADR-0067: collection-status badge — activeCode가 보이는 중이므로 viewedCodes=[activeCode]
  const { data: watchlistData } = useWatchlist();
  const watchlistCodes = watchlistData?.entries.map((e) => e.code) ?? [];
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const collection = deriveCollectionView({
    code: activeCode,
    liveSet,
    watchlistCodes,
    viewedCodes: activeCode ? [activeCode] : [],
    kiwoomCodes: liveStatusData?.kiwoom?.subscribed_codes ?? [],
    captureCandidate: watchlistData?.entries.some((e) =>
      e.code === activeCode && e.capture_candidate !== false) ?? member,
    liveConnection: live,
  });

  // 종목명·현재가 옆 전일대비(등락액·등락률) — 관심/스크리너 패널과 동일한
  // 라이브 quote 단일 출처(ADR-0056). 현재가는 bundle(WS) 이라 별개.
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const selectedVenue = venue ?? liveVenue;
  const quoteByCode = useQuoteByCode(activeCode ? [activeCode] : [], selectedVenue);
  const quote = activeCode ? quoteByCode.get(activeCode) : undefined;

  // ADR-0039: surface the active source through the last segment's tag.
  const lastCandle = bundle && bundle.candles.length > 0
    ? bundle.candles[bundle.candles.length - 1]
    : null;
  // 현재가 라인과 동일 산출(fresh 체결가 > 사용가능 quote.price > 캔들 종가) —
  // "라인=상태바" invariant. lastCandle 없으면 null → '가격 (대기 중)'.
  const currentPrice = resolveLiveCurrentPrice(lastCandle?.close ?? null, quote, liveTradePrice);
  const lastSegmentSource = bundle && bundle.segments.length > 0
    ? bundle.segments[bundle.segments.length - 1].source
    : undefined;
  // 진행 칩용 최고(最古) 로드 날짜 — segments 는 오름차순이라 [0] 이 가장 과거.
  // 확장 중이고 실제 확장 상태(historicalFromDate)이며 로드된 세그먼트가 있을 때만.
  const showBackfillProgress = isExtending && historicalFromDate != null && !!bundle && bundle.segments.length > 0;
  const earliestLoadedDate = showBackfillProgress ? bundle!.segments[0].date : null;

  return (
    <div
      data-testid="live-status-bar"
      className="flex items-center gap-2 px-3"
      style={{
        height: 'var(--h-pricestrip)',
        // 종목명 스트립을 --bg 로 통일(2026-07-15 배경 통일 확장) — 이전엔 --bg-subtle 로
        // nav·탭과 함께 "크롬 존"에 묶였으나, 스트립+차트가 한 콘텐츠 존으로 읽히도록
        // 페이지 배경(=워크에어리어)과 동일 톤으로 당긴다. 경계는 위쪽 탭 바(--bg-subtle
        // 거터, 칩 어포던스로 유지)↔스트립 톤 스텝으로 올라간다. 차트 카드는 그 아래에서
        // 4px gap + --shadow-panel 로 계속 부유한다.
        background: 'var(--bg)',
        fontSize: 'var(--text-sm)',
        color: 'var(--fg-dim)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span className="inline-flex min-h-[1.2rem] items-center gap-1">
        <CollectionDot status={collection.displayStatus} />
        <span className="font-data" style={{ color: 'var(--fg)' }}>
          {symbolLabel}
        </span>
      </span>
      {activeCode && (
        <WatchlistHeartButton code={activeCode} name={symbolName} variant="status" />
      )}
      <span aria-hidden>·</span>
      {currentPrice !== null ? (
        <span
          data-testid="live-current-price"
          className="font-data"
          style={{ color: 'var(--fg)', fontWeight: 600, fontSize: 'var(--text-lg)', letterSpacing: 0 }}
        >
          {currentPrice.toLocaleString('ko-KR')}
        </span>
      ) : (
        <span>가격 (대기 중)</span>
      )}
      {quote && (
        <span className="font-data whitespace-nowrap shrink-0" data-testid="live-change">
          {/* 헤더는 등락률(%)만 — 현재가가 이미 옆에 있고 좁은 상태바라
              등락액은 생략(관심·스크리너 패널은 등락액+등락률 둘 다). */}
          <QuoteChange won={null} pct={quote.change_pct} />
        </span>
      )}
      {showHeatmapChip && (
        <>
          <span aria-hidden>·</span>
          <span
            data-testid="live-heatmap-group"
            title={heatmapGroupName ? `히트맵 그룹: ${heatmapGroupName}` : '히트맵 그룹 없음'}
            className="shrink-0 whitespace-nowrap"
            style={heatmapGroupName === null ? { color: 'var(--fg-dimmer)' } : undefined}
          >
            히트맵 · {heatmapGroupName ?? '없음'}
          </span>
        </>
      )}
      <span className="inline-flex min-w-0 shrink items-center gap-2 whitespace-nowrap overflow-hidden">
        <span aria-hidden>·</span>
        <span>{timeframe}</span>
        <span aria-hidden>·</span>
        <span data-testid="live-venue-label" title="KIS 캔들 기준" className="min-w-0 truncate">
          캔들 {liveVenueDisplayLabel(selectedVenue)}
        </span>
        {liveVenueKeepsHogaKrx(selectedVenue) && (
          <>
            <span aria-hidden>·</span>
            <span data-testid="live-venue-ws-note" style={{ color: 'var(--fg-dimmer)' }}>
              호가 {liveHogaVenueNow(selectedVenue)}
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <SourceChip source={lastSegmentSource} />
      </span>
      {showBackfillProgress && earliestLoadedDate && (() => {
        // 과거 확장 진행 — 중립(ok) 팔레트 재사용(새 색 없음). 캔들·호가·사이드카가
        // 모두 settle될 때까지 홀드되는 딥 워크백이 '고장'으로 오인되지 않게 한다.
        const pill = captureHealthPillColor('ok');
        const md = `${Number(earliestLoadedDate.slice(4, 6))}/${Number(earliestLoadedDate.slice(6, 8))}`;
        return (
          <>
            <span aria-hidden>·</span>
            <span
              data-testid="past-backfill-progress-chip"
              title={`과거 데이터 불러오는 중 — ${md}까지 로드됨`}
              className="font-data px-2 py-0.5 rounded whitespace-nowrap shrink-0"
              style={{
                background: pill.bg, border: pill.border,
                color: pill.fg, fontSize: 'var(--text-xs)',
              }}
            >
              과거 로딩 중 · {md}까지
            </span>
          </>
        );
      })()}
      {hogaGapDates.length > 0 && (() => {
        // 과거 미캡처일 공백 알림 — 캡처 헬스 pill과 동일한 warn 팔레트(새 색 없음).
        const gapPill = captureHealthPillColor('warn');
        return (
          <>
            <span aria-hidden>·</span>
            <span
              data-testid="hoga-coverage-gap-chip"
              title={hogaCoverageGapTitle(hogaGapDates)}
              className="font-data px-2 py-0.5 rounded whitespace-nowrap shrink-0"
              style={{
                background: gapPill.bg, border: gapPill.border,
                color: gapPill.fg, fontSize: 'var(--text-xs)',
              }}
            >
              호가 미수집 {hogaGapDates.length}일
            </span>
          </>
        );
      })()}
      {activeCode && !member && (
        <>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
            <HeartIcon filled={false} className="w-[1em] h-[1em]" /> 관심 추가 시 실시간
          </span>
        </>
      )}
      <span aria-hidden>·</span>
      {(() => {
        if (captureHealth.showDot) {
          return (
            <span
              data-testid="capture-health-dot"
              title={captureHealth.title}
              aria-label="캡처 정상"
              className="inline-block rounded-full"
              style={{
                width: '6px', height: '6px',
                background: 'var(--success)', boxShadow: '0 0 4px var(--success)',
              }}
            />
          );
        }
        const capPill = captureHealthPillColor(captureHealth.severity);
        return (
          <span
            data-testid="capture-health-pill"
            title={captureHealth.title}
            className="font-data px-2 py-0.5 rounded"
            style={{
              background: capPill.bg, border: capPill.border,
              color: capPill.fg, fontSize: 'var(--text-xs)',
            }}
          >
            {captureHealth.label}
          </span>
        );
      })()}
    </div>
  );
}
