import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/studyViews', () => ({
  createStudyView: vi.fn(),
  deleteStudyView: vi.fn(async () => undefined),
  getStudyViewSnapshot: vi.fn(),
  listStudyViews: vi.fn(),
  updateStudyViewMetadata: vi.fn(),
  updateStudyView: vi.fn(),
}));

import { deleteStudyView, updateStudyViewMetadata } from '../api/studyViews';
import { STUDY_VIEW_SAVES_QUERY, studyViewSnapshotQuery, useStudyViewMutations } from './useStudyViews';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useStudyViewMutations', () => {
  it('updates metadata and invalidates only the saves list', async () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const mutateAsync = vi.fn();
    vi.mocked(updateStudyViewMetadata).mockImplementation(mutateAsync);

    const { result } = renderHook(() => useStudyViewMutations(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });

    await act(async () => {
      await result.current.updateMetadata.mutateAsync({ id: 'a', body: { name: '새 이름' } });
    });

    expect(mutateAsync).toHaveBeenCalledWith('a', { name: '새 이름' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: STUDY_VIEW_SAVES_QUERY });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: studyViewSnapshotQuery('a') });
  });

  it('removes the deleted view snapshot query after delete succeeds', async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    qc.setQueryData(STUDY_VIEW_SAVES_QUERY, { schema_version: 1, saves: [{ id: 'view1' }] });
    qc.setQueryData(studyViewSnapshotQuery('view1'), { schema_version: 1, code: '005930' });

    const { result } = renderHook(() => useStudyViewMutations(), { wrapper: wrap(qc) });

    result.current.remove.mutate('view1');

    await waitFor(() => expect(deleteStudyView).toHaveBeenCalled());
    expect(vi.mocked(deleteStudyView).mock.calls[0][0]).toBe('view1');
    await waitFor(() => expect(qc.getQueryData(studyViewSnapshotQuery('view1'))).toBeUndefined());
    expect(qc.getQueryState(STUDY_VIEW_SAVES_QUERY)?.isInvalidated).toBe(true);
  });
});
