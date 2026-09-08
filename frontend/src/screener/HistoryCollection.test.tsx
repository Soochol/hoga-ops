import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiCall } from '../api/client';
import type { HistoryJob, ScanRequest } from '../api/screener';
import { HistoryCollection } from './HistoryCollection';

vi.mock('../api/client', () => ({ apiCall: vi.fn() }));

const request: ScanRequest = {
  conditions: [{ id: 'v', type: 'new_high_vol', params: {
    mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31',
    record_period: { unit: 'years', value: 2 },
  } }, { id: 'ma', type: 'ma', params: { period: 20, relation: 'above' } },
  { id: 'price', type: 'price_range', params: { min: 1000 } },
  { id: 'pct', type: 'change_pct', params: { op: 'gte', pct: 5 } }],
  universe: {},
};

// ScanRequest.model_dump(mode='json'): reordered leaf fields plus model defaults.
const returnedRequest: ScanRequest = JSON.parse(`{
  "conditions": [
    {"type":"new_high_vol","id":"v","params":{"mode":"date_range","start_date":"2019-01-01","end_date":"2022-12-31","record_period":{"unit":"years","value":2}}},
    {"type":"ma","id":"ma","params":{"period":20,"relation":"above","source":"close"}},
    {"type":"price_range","id":"price","params":{"min":1000,"max":null}},
    {"type":"change_pct","id":"pct","params":{"op":"gte","pct":5,"lo":null,"hi":null}}
  ],
  "universe":{"markets":[],"exclude_etf":true,"exclude_halted":false,"scopes":[]},
  "limit":1000,"basis":"eod"
}`);

const job = (status: HistoryJob['status']): HistoryJob => ({
  id: 'job1', status, request: returnedRequest, codes: ['005930'], total: 1, done: 1,
  written_rows: 1475, errors: {}, current_code: null, started_at_ms: 1,
  cancel_requested: false, coverage: null,
});

function setup(currentJob: HistoryJob) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['screener-history-job'], currentJob);
  const onComplete = vi.fn();
  const view = (body: ScanRequest) => <QueryClientProvider client={client}>
    <HistoryCollection request={body} onComplete={onComplete} />
  </QueryClientProvider>;
  const result = render(view(request));
  return { ...result, onComplete, changeRequest: (body: ScanRequest) => result.rerender(view(body)) };
}

describe('HistoryCollection server job lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rescans once when the real backend-shaped completed request matches the editor', async () => {
    const { onComplete, changeRequest } = setup(job('complete'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    changeRequest(structuredClone(request));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('offers a new collection after changing an interrupted job’s universe', async () => {
    const { changeRequest, onComplete } = setup(job('interrupted'));
    expect(screen.getByRole('button', { name: '남은 일봉 수집 재개' })).toBeVisible();
    const changed: ScanRequest = { ...request, universe: { markets: ['KOSDAQ'] } };
    changeRequest(changed);
    expect(screen.queryByRole('button', { name: '남은 일봉 수집 재개' })).not.toBeInTheDocument();
    expect(screen.getByText(/다른 검색 조건의 수집입니다/)).toBeVisible();
    vi.mocked(apiCall).mockResolvedValue({ ...job('queued'), request: changed });
    fireEvent.click(screen.getByRole('button', { name: '과거 일봉 수집' }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/screener/history/jobs', {
      method: 'POST', body: JSON.stringify(changed),
    }));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not rescan when completion belongs to a different filter value', () => {
    const other = job('complete');
    other.request = { ...returnedRequest, universe: { exclude_etf: false } };
    const { onComplete } = setup(other);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(/다른 검색 조건의 수집입니다/)).toBeVisible();
  });
});
