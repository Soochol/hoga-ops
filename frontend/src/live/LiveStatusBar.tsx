import { useLivePageStore } from '../state/livePage';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { cycleLagSeverity, cycleLagPillColor } from './cycleLagPill';
import { SourceChip } from '../chart/SourceChip';
import { useSymbols } from '../capture/useSymbols';
import type { RangeBundle } from '../api/types';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '../watchlist/useWatchlist';
import { HeartIcon } from '../ui/HeartIcon';

interface Props {
  activeCode: string | null;
  cycleLagMs: number;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. */
  bundle: RangeBundle | null;
}

export function LiveStatusBar({ activeCode, cycleLagMs, bundle }: Props) {
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

  const { data: watchlist } = useWatchlist();
  const isMember = !!activeCode && (watchlist?.entries.some((e) => e.code === activeCode) ?? false);
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();
  const toggleMember = () => {
    if (!activeCode) return;
    if (isMember) removeM.mutate(activeCode);
    else addM.mutate(activeCode);
  };

  const severity = cycleLagSeverity(cycleLagMs);
  const pill = cycleLagPillColor(severity);

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
          aria-label={isMember ? '관심종목 해제' : '관심종목 추가'}
          aria-pressed={isMember}
          onClick={toggleMember}
          className={`leading-none ${isMember ? 'text-fg' : 'text-fg-dimmer hover:text-fg'}`}
        >
          <HeartIcon filled={isMember} className="w-[1em] h-[1em]" />
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
      <span aria-hidden>·</span>
      <span>{timeframe}</span>
      <span aria-hidden>·</span>
      <SourceChip source={lastSegmentSource} />
      <span aria-hidden>·</span>
      {activeCode && !isMember ? (
        <span style={{ color: 'var(--fg-dimmer)' }}>
          과거 차트 · 실시간 ✕
          <span className="ml-2" style={{ color: 'var(--accent)' }}>♡ 눌러 실시간 추적</span>
        </span>
      ) : (
        <span style={{ color: live ? 'var(--success)' : 'var(--warn)' }}>
          {live ? 'LIVE●' : '재연결 중…'}
        </span>
      )}
      <span aria-hidden>·</span>
      <span
        data-testid="cycle-lag-pill"
        title={`cycle_lag_ms = ${cycleLagMs}`}
        className="font-mono px-2 py-0.5 rounded"
        style={{
          background: pill.bg,
          border: `1px solid ${pill.border}`,
          color: pill.fg,
          fontSize: 'var(--text-xs)',
        }}
      >
        lag {cycleLagMs}ms
      </span>
    </div>
  );
}
