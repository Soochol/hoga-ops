import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCaptureJob } from './useCaptureJob';

vi.mock('../api/captures', () => ({
  getLatestCapture: vi.fn().mockResolvedValue(null),
  startCapture: vi.fn().mockResolvedValue({
    job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
    options: { allow_partial: false, resume: false, capture_only: false },
    started_at_ms: 0, progress: null, result: null, error: null,
  }),
  cancelLatest: vi.fn(),
  dismissLatest: vi.fn(),
}));

vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: vi.fn().mockReturnValue(() => {}),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCaptureJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null job initially', async () => {
    const { result } = renderHook(() => useCaptureJob(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.job).toBeNull();
  });
});
