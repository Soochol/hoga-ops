import type { BookIssue, BookRetryTarget, OrderbookAvailability } from '../orderbookAvailability';
import { useServiceStatusPanel } from '../../serviceStatus/controls';
import { unixMsToKSTClock } from '../../util/time';
import './BookAvailabilityState.css';

function toneFor(kind: BookIssue['kind']) {
  return ['query_error', 'rest_error', 'status_error', 'single_price_error', 'saved_error'].includes(kind) ? 'error'
    : ['waiting_slot', 'reference_limit', 'unconfigured', 'display_delayed', 'recovering', 'provider_error', 'storage_error'].includes(kind) ? 'warn' : 'neutral';
}

/** One surface for live, REST and saved-book states. Hosts decide overlay vs empty placement. */
export function BookAvailabilityState({ state, onRetry, reference, testId }: {
  state: OrderbookAvailability | null; onRetry: (target?: BookRetryTarget) => void;
  reference?: { text: string; testId: string };
  testId?: string;
}) {
  const clock = state?.lastBookMs !== undefined ? unixMsToKSTClock(state.lastBookMs) : state?.lastBookClock;
  if (!reference && (!state || (state.quiet && !clock))) return null;
  const issues = state?.issues ?? (state ? [state] : []);
  const status = () => {
    const panel = useServiceStatusPanel.getState();
    if (state?.diagnostics) panel.showBook(state.diagnostics); else panel.show();
  };
  const tone = state ? toneFor(state.kind) : 'neutral';
  return <div className="book-notice-surface" data-tone={tone} data-testid={testId}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {reference && <div data-testid={reference.testId} className="text-fg-dim">{reference.text}</div>}
    {state?.quiet ? clock && <div className="text-fg-dim" data-testid="book-last-update">마지막 호가 · {clock}</div>
      : state && <div data-testid="book-availability" data-state={state.kind}>
        <div className="book-notice-heading" role={tone === 'error' ? 'alert' : 'status'}>
          <span>{state.message}</span>
          {clock && <span className="text-fg-dim">마지막 호가 · {clock}</span>}
        </div>
        <div className="book-notice-actions">
          {issues.some(issue => issue.action === 'status') && <button type="button" onClick={status}>{state.kind === 'waiting_slot' ? '구독 현황' : '연결 상태'}</button>}
          {(state.retryTarget || state.action === 'retry') && <button type="button" onClick={() => onRetry(state.retryTarget)}>다시 조회</button>}
          {(issues.length > 1 || state.detail) && <details key={`${state.diagnostics?.code}:${state.diagnostics?.venue}:${state.kind}`}>
            <summary>상세</summary>
            <div className="book-notice-details">
              {issues.map(issue => <div key={`${issue.kind}:${issue.retryTarget}`}>
                <div>{issue.message}</div>
                {issue.detail && <p className="text-fg-dim">{issue.detail}</p>}
                {issue !== issues[0] && issue.retryTarget && <button type="button" onClick={() => onRetry(issue.retryTarget)}>{issue.message} 다시 조회</button>}
              </div>)}
            </div>
          </details>}
        </div>
      </div>}
  </div>;
}
