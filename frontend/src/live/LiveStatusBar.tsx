import { useLivePageStore } from '../state/livePage';

interface Props {
  activeCode: string | null;
}

export function LiveStatusBar({ activeCode }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
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
      <span className="font-mono" style={{ color: 'var(--fg)' }}>{activeCode ?? '—'}</span>
      <span aria-hidden>·</span>
      <span>가격 (대기 중)</span>
      <span aria-hidden>·</span>
      <span>{timeframe}</span>
      <span aria-hidden>·</span>
      <span style={{ color: 'var(--fg-dimmer)' }}>LIVE● (대기 중)</span>
    </div>
  );
}
