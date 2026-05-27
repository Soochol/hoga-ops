import { useLivePageStore } from '../state/livePage';
import { cycleLagSeverity, cycleLagPillColor } from './cycleLagPill';
import { useLiveCandles } from '../api/liveCandles';

interface Props {
  activeCode: string | null;
  cycleLagMs: number;
}

export function LiveStatusBar({ activeCode, cycleLagMs }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const severity = cycleLagSeverity(cycleLagMs);
  const pill = cycleLagPillColor(severity);

  const { data: candleData } = useLiveCandles(activeCode ?? '', timeframe);
  const latestCandles = candleData?.candles ?? [];
  const lastCandle = latestCandles.length > 0 ? latestCandles[latestCandles.length - 1] : null;
  const currentPrice = lastCandle?.close ?? null;

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
