import { useLivePageStore } from '../state/livePage';
import { cycleLagSeverity, cycleLagPillColor } from './cycleLagPill';
import { SourceChip } from '../chart/SourceChip';
import type { RangeBundle } from '../api/types';

interface Props {
  activeCode: string | null;
  cycleLagMs: number;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. */
  bundle: RangeBundle | null;
}

export function LiveStatusBar({ activeCode, cycleLagMs, bundle }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
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
        {activeCode ?? '—'}
      </span>
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
      <span style={{ color: 'var(--fg-dimmer)' }}>LIVE● (대기 중)</span>
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
