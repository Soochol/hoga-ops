import { useState } from 'react';
import type { ReactNode } from 'react';
import { SymbolSearch } from './SymbolSearch';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useCaptureQueue } from './useCaptureQueue';
import { enqueueErrorHints } from '../api/upstream-hints';
import type { ApiError } from '../api/client';
import type { BlockedItem, EnqueueResponse, SymbolHit, UpstreamCode } from '../api/types';
import { loadForceRetryDefault } from './forceRetryDefault';
import { legendText } from './calendarStatus';

function formatBlockedMessage(items: BlockedItem[]): string {
  // Noun-phrase + em-dash + cause, matching the existing tone from
  // CaptureRowDetail.test.tsx:154 ("캡처 실패 — hogaplay 쿠키 만료")
  // and DESIGN.md L249-250's "Korean single words" guidance.
  const pairs = items.map((b) => `${b.code}/${b.date}`).join(', ');
  return `5회 연속 실패 — 인벤토리에서 잠금 해제 필요 (${pairs})`;
}

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
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);

  const { addItems } = useCaptureQueue();
  const valid = symbol !== null && range !== null && range.end !== null;

  const onStart = async () => {
    if (!valid) return;
    setError(null);
    setInlineError(null);
    setBlockedMessage(null);
    try {
      const resp = await addItems.mutateAsync({
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        // Read at submit time so a Settings change between mount and submit
        // is honored without remounting the form.
        force_retry: loadForceRetryDefault(),
      });
      // ADR-0042: 201 partial-success path — some items accepted, some blocked.
      if (resp.blocked && resp.blocked.length > 0) {
        setBlockedMessage(formatBlockedMessage(resp.blocked));
      }
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      // ADR-0042: 409 all-blocked path — the entire request body is the
      // EnqueueResponse with non-empty `blocked`. ApiError carries it as .data.
      if (apiErr.status === 409 && apiErr.data) {
        const body = apiErr.data as Partial<EnqueueResponse>;
        if (body.blocked && body.blocked.length > 0) {
          setBlockedMessage(formatBlockedMessage(body.blocked));
          return;
        }
      }
      const code = apiErr.code;
      if (code && code in enqueueErrorHints) {
        setInlineError(enqueueErrorHints[code as UpstreamCode]);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to enqueue';
      setError(msg);
    }
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

      {blockedMessage !== null && (
        <div
          role="alert"
          className="mt-2 px-3 py-2 rounded border border-error bg-tint-error text-error text-sm"
        >
          {blockedMessage}
        </div>
      )}

      {inlineError !== null && (
        <div
          role="alert"
          className="mt-2 px-3 py-2 rounded border bg-bg-input text-error text-sm"
        >
          {inlineError}
        </div>
      )}

      <div className="mt-3 text-xs text-fg-dim">
        {legendText()}
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div className="font-semibold text-xs tracking-widest uppercase text-fg-dim mb-1.5">{children}</div>
  );
}
