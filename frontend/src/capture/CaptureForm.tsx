import { useState } from 'react';
import type { ReactNode } from 'react';
import { SymbolSearch } from './SymbolSearch';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useCaptureQueue } from './useCaptureQueue';
import { enqueueErrorHints } from '../api/upstream-hints';
import type { ApiError } from '../api/client';
import type { SymbolHit, UpstreamCode } from '../api/types';
import { loadForceRetryDefault } from './forceRetryDefault';

export interface CaptureFormProps {
  /** Reference month for DateRangePicker's left grid. Defaults to current KST month. */
  referenceYear: number;
  referenceMonth: number;
}

export function CaptureForm({ referenceYear, referenceMonth }: CaptureFormProps) {
  const [symbol, setSymbol] = useState<SymbolHit | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<ReactNode>(null);

  const { addItems } = useCaptureQueue();
  const valid = symbol !== null && range !== null && range.end !== null;

  const onStart = () => {
    if (!valid) return;
    setError(null);
    setInlineError(null);
    addItems.mutate(
      {
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        // Read at submit time so a Settings change between mount and submit
        // is honored without remounting the form.
        force_retry: loadForceRetryDefault(),
      },
      {
        onError: (err: unknown) => {
          const apiErr = err as ApiError;
          const code = apiErr.code;
          if (code && code in enqueueErrorHints) {
            setInlineError(enqueueErrorHints[code as UpstreamCode]);
            return;
          }
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
        <div role="alert" className="text-xs text-error">{error}</div>
      )}

      {inlineError !== null && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            padding: '8px 12px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm, 4px)',
            color: 'var(--error)',
            fontSize: 'var(--font-size-sm, 0.875rem)',
          }}
        >
          {inlineError}
        </div>
      )}

      <div className="mt-3 text-xs text-fg-dim">
        Legend: ✓ complete · ⚠ partial · ✕ broken · – no upstream data · 🔒 today &lt; 18:00 KST
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div className="font-semibold text-xs tracking-widest uppercase text-fg-dim mb-1.5">{children}</div>
  );
}
