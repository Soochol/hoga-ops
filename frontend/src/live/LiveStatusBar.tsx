import { useLivePageStore } from '../state/livePage';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { captureHealthSeverity, captureHealthLabel, captureHealthPillColor } from './captureHealthPill';
import { SourceChip } from '../chart/SourceChip';
import { useSymbols } from '../capture/useSymbols';
import type { RangeBundle } from '../api/types';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { useWatchlist } from '../watchlist/useWatchlist';
import { HeartIcon } from '../ui/HeartIcon';
import { useQuoteByCode } from '../api/liveQuotes';
import { QuoteChange } from '../rightrail/QuoteChange';
import { useLiveStatus } from '../api/liveStatus';
import { deriveCollectionStatus } from './collectionStatus';

interface Props {
  activeCode: string | null;
  captureHealthy: boolean;
  captureReason: string;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. */
  bundle: RangeBundle | null;
}

export function LiveStatusBar({ activeCode, captureHealthy, captureReason, bundle }: Props) {
  // Threshold MUST exceed the 30s server ping so a connected-but-idle
  // socket (e.g. market closed) stays "LIVE●"; only a real disconnect
  // (no frame for >35s) flips it. (plan-review cross-task flag)
  const live = useConnectionLiveness(LIVE_STALE_MS);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const { data: symbolsData } = useSymbols();
  const symbolName = activeCode
    ? symbolsData?.symbols.find((s) => s.code === activeCode)?.name
    : undefined;
  const symbolLabel = activeCode
    ? (symbolName ? `${symbolName}(${activeCode})` : activeCode)
    : '—';

  const { isMember, toggle } = useWatchlistMembership();
  const member = !!activeCode && isMember(activeCode);

  // ADR-0067: collection-status badge — activeCode가 보이는 중이므로 viewedCodes=[activeCode]
  const { data: watchlistData } = useWatchlist();
  const watchlistCodes = watchlistData?.entries.map((e) => e.code) ?? [];
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const collectionStatus = deriveCollectionStatus(
    activeCode,
    liveSet,
    watchlistCodes,
    activeCode ? [activeCode] : [],
  );

  // 종목명·현재가 옆 전일대비(등락액·등락률) — 관심/스크리너 패널과 동일한
  // 라이브 quote 단일 출처(ADR-0056). 현재가는 bundle(WS) 이라 별개.
  const quoteByCode = useQuoteByCode(activeCode ? [activeCode] : []);
  const quote = activeCode ? quoteByCode.get(activeCode) : undefined;

  // ADR-0039: surface the active source through the last segment's tag.
  const lastCandle = bundle && bundle.candles.length > 0
    ? bundle.candles[bundle.candles.length - 1]
    : null;
  const currentPrice = lastCandle?.close ?? null;
  const lastSegmentSource = bundle && bundle.segments.length > 0
    ? bundle.segments[bundle.segments.length - 1].source
    : undefined;

  return (
    <div
      data-testid="live-status-bar"
      className="flex items-center gap-3 border-b px-3"
      style={{
        height: 'var(--h-pricestrip)',
        borderColor: 'var(--border)',
        background: 'var(--bg-subtle)',
        fontSize: 'var(--text-sm)',
        color: 'var(--fg-dim)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span className="font-mono" style={{ color: 'var(--fg)' }}>
        {symbolLabel}
      </span>
      {activeCode && (
        <button
          type="button"
          aria-label={member ? '관심종목 해제' : '관심종목 추가'}
          aria-pressed={member}
          onClick={() => { if (activeCode) toggle(activeCode); }}
          className={`leading-none ${member ? 'text-error' : 'text-fg-dimmer hover:text-fg'}`}
        >
          <HeartIcon filled className="w-[1em] h-[1em]" />
        </button>
      )}
      <span aria-hidden>·</span>
      {currentPrice !== null ? (
        <span
          data-testid="live-current-price"
          className="font-mono"
          style={{ color: 'var(--fg)', fontWeight: 600 }}
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
      <span aria-hidden>·</span>
      <span>{timeframe}</span>
      <span aria-hidden>·</span>
      <SourceChip source={lastSegmentSource} />
      <span aria-hidden>·</span>
      {activeCode && !member ? (
        <span style={{ color: 'var(--fg-dimmer)' }}>
          과거 차트 · 실시간 ✕
          <span className="ml-2 inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
            <HeartIcon filled={false} className="w-[1em] h-[1em]" /> 눌러 실시간 추적
          </span>
        </span>
      ) : (
        <span style={{ color: live ? 'var(--success)' : 'var(--warn)' }}>
          {live ? 'LIVE●' : '재연결 중…'}
        </span>
      )}
      <span aria-hidden>·</span>
      {(() => {
        const sev = captureHealthSeverity(captureHealthy, captureReason);
        const capPill = captureHealthPillColor(sev);
        return (
          <span
            data-testid="capture-health-pill"
            title={`capture_reason = ${captureReason}`}
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: capPill.bg, border: `1px solid ${capPill.border}`,
              color: capPill.fg, fontSize: 'var(--text-xs)',
            }}
          >
            {captureHealthLabel(captureHealthy, captureReason)}
          </span>
        );
      })()}
      {activeCode && (collectionStatus === 'realtime' || collectionStatus === 'polling') && (() => {
        // TODO(label): 배지 문구 확정
        const isRealtime = collectionStatus === 'realtime';
        return (
          <span
            data-testid="collection-status-badge"
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: isRealtime ? 'var(--tint-success)' : 'transparent',
              border: `1px solid ${isRealtime ? 'var(--tint-success-border)' : 'var(--border)'}`,
              color: isRealtime ? 'var(--success)' : 'var(--fg-dimmer)',
              fontSize: 'var(--text-xs)',
            }}
          >
            {isRealtime ? '실시간' : '준실시간'}
          </span>
        );
      })()}
    </div>
  );
}
