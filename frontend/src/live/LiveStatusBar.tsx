import { useLivePageStore } from '../state/livePage';
import { cycleLagSeverity, cycleLagPillColor } from './cycleLagPill';
import { useLiveCandles } from '../api/liveCandles';
import { useLiveBundle } from './useLiveBundle';
import { SourceChip } from '../chart/SourceChip';

interface Props {
  activeCode: string | null;
  cycleLagMs: number;
}

function todayKstYyyymmdd(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function LiveStatusBar({ activeCode, cycleLagMs }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const severity = cycleLagSeverity(cycleLagMs);
  const pill = cycleLagPillColor(severity);

  const { candles } = useLiveCandles(activeCode ?? '', timeframe);
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const currentPrice = lastCandle?.close ?? null;

  // ADR-0039: surface the active source through the last segment's tag.
  // /replay shows the same chip in PriceStrip; /live now mirrors that.
  const { bundle } = useLiveBundle(activeCode, timeframe, todayKstYyyymmdd());
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
