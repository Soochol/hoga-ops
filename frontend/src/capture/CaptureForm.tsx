import { useState } from 'react';
import { SymbolSearch } from './SymbolSearch';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useCaptureQueue } from './useCaptureQueue';
import type { SymbolHit } from '../api/types';

export interface CaptureFormProps {
  /** Reference month for DateRangePicker's left grid. Defaults to current KST month. */
  referenceYear: number;
  referenceMonth: number;
}

export function CaptureForm({ referenceYear, referenceMonth }: CaptureFormProps) {
  const [symbol, setSymbol] = useState<SymbolHit | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [forceRetry, setForceRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { addItems } = useCaptureQueue();
  const valid = symbol !== null && range !== null && range.end !== null;

  const onStart = () => {
    if (!valid) return;
    setError(null);
    addItems.mutate(
      {
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        force_retry: forceRetry,
      },
      {
        onSuccess: () => {
          setSymbol(null);
          setRange(null);
          setForceRetry(false);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Failed to enqueue';
          setError(msg);
        },
      },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'Geist Sans, sans-serif' }}>
      <section>
        <Label>Symbol</Label>
        <SymbolSearch value={symbol} onChange={setSymbol} />
      </section>

      <section>
        <Label>Date Range</Label>
        <DateRangePicker
          code={symbol?.code ?? null}
          referenceYear={referenceYear}
          referenceMonth={referenceMonth}
          value={range}
          onChange={setRange}
        />
      </section>

      <section>
        <Label>Options</Label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--fg)' }}>
          <input
            type="checkbox"
            checked={forceRetry}
            onChange={(e) => setForceRetry(e.target.checked)}
          />
          <span>⚠ Force re-capture source-partial dates</span>
        </label>
      </section>

      <button
        type="button"
        onClick={onStart}
        disabled={!valid}
        style={{
          background: valid ? 'var(--accent)' : 'var(--bg-input)',
          color: valid ? 'var(--bg)' : 'var(--fg-dimmer)',
          border: 'none', borderRadius: 6,
          padding: '10px 18px',
          font: '600 13px "Geist Sans", sans-serif',
          cursor: valid ? 'pointer' : 'not-allowed',
        }}
      >
        ▶ Start Capture
      </button>

      {error !== null && (
        <div role="alert" style={{ fontSize: 11, color: 'var(--down)' }}>{error}</div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-dim)' }}>
        Legend: ✓ complete · ⚠ partial · ✕ broken · 🔒 today &lt; 18:00 KST
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div style={{
      font: '600 10.5px "Geist Sans", sans-serif',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--fg-dim)', marginBottom: 6,
    }}>{children}</div>
  );
}
