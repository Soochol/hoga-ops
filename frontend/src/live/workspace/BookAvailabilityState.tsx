import type { OrderbookAvailability } from '../orderbookAvailability';
import { InlineState } from '../../ui/DataSurface';
import { useServiceStatusPanel } from '../../serviceStatus/controls';
import { unixMsToKSTClock } from '../../util/time';

export function BookAvailabilityState({ state, onRetry }: {
  state: OrderbookAvailability | null; onRetry: () => void;
}) {
  if (!state) return null;
  const tone = state.kind === 'query_error' ? 'error' : ['waiting_slot', 'reference_limit', 'unconfigured', 'display_delayed'].includes(state.kind) ? 'warn' : 'neutral';
  return <InlineState tone={tone} data-testid="book-availability" data-state={state.kind} className="m-2 text-xs">
    <div>{state.message}</div>
    {state.detail && <div className="mt-1 text-xs text-fg-dim">{state.detail}</div>}
    {state.lastBookMs !== undefined && <div className="mt-1 text-xs text-fg-dim">마지막 호가 · {unixMsToKSTClock(state.lastBookMs)}</div>}
    {state.action && <button type="button" className="mt-2 rounded-sm border border-border px-2 py-1 text-xs text-fg hover:bg-bg-input-hover"
      onClick={state.action === 'retry' ? onRetry : () => {
        const panel = useServiceStatusPanel.getState();
        if (state.diagnostics) panel.showBook(state.diagnostics); else panel.show();
      }}>
      {state.action === 'retry' ? '다시 조회' : state.kind === 'waiting_slot' ? '구독 현황' : '연결 상태'}
    </button>}
    {(state.kind === 'display_delayed' || state.kind === 'stale') && <button type="button" onClick={onRetry}
      className="ml-2 mt-2 rounded-sm border border-border px-2 py-1 text-xs text-fg hover:bg-bg-input-hover">다시 조회</button>}
  </InlineState>;
}
