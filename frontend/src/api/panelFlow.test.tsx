import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { panelFlowRevision, usePanelFlow, type PanelFlowResponse } from './panelFlow';
import * as client from './client';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('shares one batch across rerenders and follows existing list invalidations', async () => {
  const response: PanelFlowResponse = { date: '2026-10-21', venue: 'KRX', bucket_ms: 300000, t_base_ms: 0, as_of_ms: 1, stocks: [], groups: [] };
  const request = vi.spyOn(client, 'apiCall').mockResolvedValue(response);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(() => usePanelFlow('watchlist', 'KRX', 'f1:005930', true), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  rerender(); rerender();
  expect(request).toHaveBeenCalledTimes(1);
  await act(() => qc.invalidateQueries({ queryKey: ['watchlist'] }));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith('/api/panel-flow?source=watchlist&venue=KRX');
  qc.clear();
});

it('membership revision ignores display order but distinguishes groups', () => {
  const a = { code: '005930', folder_id: 'f1' }, b = { code: '005930', folder_id: 'f2' };
  expect(panelFlowRevision([a, b])).toBe(panelFlowRevision([b, a]));
  expect(panelFlowRevision([a])).not.toBe(panelFlowRevision([b]));
});
