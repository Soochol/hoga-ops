import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/studyViews', () => ({
  createStudyView: vi.fn(),
  deleteStudyView: vi.fn(async () => undefined),
  getStudyViewSnapshot: vi.fn(),
  listStudyViews: vi.fn(),
  updateStudyView: vi.fn(),
}));

import { deleteStudyView } from '../api/studyViews';
import { STUDY_VIEW_SAVES_QUERY, studyViewSnapshotQuery, useStudyViewMutations } from './useStudyViews';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useStudyViewMutations', () => {
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
