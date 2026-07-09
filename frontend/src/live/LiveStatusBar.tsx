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
import { liveVenueDisplayLabel, liveVenueKeepsHogaKrx } from './liveVenuePolicy';
import { resolveLiveCurrentPrice } from './deriveCurrentPriceLine';
import type { CaptureHealthView } from './liveStatusProjection';
import { hogaCoverageGapTitle } from './hogaCoverageGap';

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
}

export function LiveStatusBar({ activeCode, captureHealth, bundle, venue, hogaGapDates = [], liveTradePrice }: Props) {
  // Threshold MUST exceed the 30s server ping so a connected-but-idle
  // socket (e.g. market closed) stays realtime; only a real disconnect
  // (no frame for >35s) flips it to disconnected. (plan-review cross-task flag)
  const live = useConnectionLiveness(LIVE_STALE_MS);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const { data: symbolsData } = useSymbols();
  const symbolName = activeCode
    ? symbolsData?.symbols.find((s) => s.code === activeCode)?.name
    : undefined;
  const symbolLabel = activeCode
    ? (symbolName ? `${symbolName}(${activeCode})` : activeCode)
    : '—';

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
    kisApiTargets: liveStatusData?.kis_api_targets ?? [],
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

  return (
    <div
      data-testid="live-status-bar"
      className="flex items-center gap-2 border-b px-3"
      style={{
        height: 'var(--h-pricestrip)',
        borderColor: 'var(--border)',
        background: 'var(--bg-subtle)',
        fontSize: 'var(--text-sm)',
        color: 'var(--fg-dim)',
        fontVariantNumeric: 'tabular-nums',
        boxShadow: 'inset 0 -1px 0 rgba(255, 255, 255, 0.015)',
      }}
    >
      <span className="inline-flex min-h-[1.2rem] items-center gap-1">
        <CollectionDot status={collection.displayStatus} />
        <span className="font-mono" style={{ color: 'var(--fg)' }}>
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
          className="font-mono"
          style={{ color: 'var(--fg)', fontWeight: 600, fontSize: 'var(--text-lg)', letterSpacing: 0 }}
        >
          {currentPrice.toLocaleString('ko-KR')}
        </span>
      ) : (
        <span>가격 (대기 중)</span>
      )}
      {quote && (
        <span className="font-mono whitespace-nowrap shrink-0" data-testid="live-change">
          {/* 헤더는 등락률(%)만 — 현재가가 이미 옆에 있고 좁은 상태바라
              등락액은 생략(관심·스크리너 패널은 등락액+등락률 둘 다). */}
          <QuoteChange won={null} pct={quote.change_pct} />
        </span>
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
              호가 KRX
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <SourceChip source={lastSegmentSource} />
      </span>
      {hogaGapDates.length > 0 && (() => {
        // 과거 미캡처일 공백 알림 — 캡처 헬스 pill과 동일한 warn 팔레트(새 색 없음).
        const gapPill = captureHealthPillColor('warn');
        return (
          <>
            <span aria-hidden>·</span>
            <span
              data-testid="hoga-coverage-gap-chip"
              title={hogaCoverageGapTitle(hogaGapDates)}
              className="font-mono px-2 py-0.5 rounded whitespace-nowrap shrink-0"
              style={{
                background: gapPill.bg, border: `1px solid ${gapPill.border}`,
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
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: capPill.bg, border: `1px solid ${capPill.border}`,
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
