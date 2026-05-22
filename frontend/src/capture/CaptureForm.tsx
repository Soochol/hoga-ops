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
    <div className="flex flex-col gap-4 font-ui">
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
        <label className="flex gap-2 items-center text-sm text-fg">
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
        }}
        className="border-none rounded-lg py-2.5 px-4.5 font-semibold text-base cursor-pointer disabled:cursor-not-allowed"
      >
        ▶ Start Capture
      </button>

      {error !== null && (
        <div role="alert" className="text-xs text-down">{error}</div>
      )}

      <div className="mt-3 text-xs text-fg-dim">
        Legend: ✓ complete · ⚠ partial · ✕ broken · 🔒 today &lt; 18:00 KST
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div className="font-semibold text-xs tracking-widest uppercase text-fg-dim mb-1.5">{children}</div>
  );
}
