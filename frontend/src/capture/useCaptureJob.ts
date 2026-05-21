import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelLatest,
  dismissLatest,
  getLatestCapture,
  startCapture,
} from '../api/captures';
import { subscribeToCaptureEvents } from '../api/sse';
import type { CaptureJob } from '../api/types';

const KEY = ['capture', 'latest'] as const;

export function useCaptureJob() {
  const qc = useQueryClient();

  const job = useQuery<CaptureJob | null>({
    queryKey: KEY,
    queryFn: getLatestCapture,
    staleTime: 0,
  });

  useEffect(() => {
    const off = subscribeToCaptureEvents((e) => {
      if (e.type === 'capture_progress') {
        // The event's `progress` field has the same shape as CaptureJob.progress
        // (both reference the CaptureProgress Wire Model), so we patch by nested
        // assignment — no field-by-field reconstruction needed.
        qc.setQueryData<CaptureJob | null>(KEY, (prev) =>
          prev && prev.job_id === e.job_id
            ? { ...prev, phase: e.phase, progress: e.progress }
            : prev,
        );
      } else if (e.type === 'capture_phase') {
        qc.setQueryData<CaptureJob | null>(KEY, (prev) =>
          prev && prev.job_id === e.job_id ? { ...prev, phase: e.phase } : prev,
        );
      } else if (e.type === 'capture_finished') {
        qc.invalidateQueries({ queryKey: KEY });
      }
    });
    return off;
  }, [qc]);

  const start = useMutation({
    mutationFn: startCapture,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const cancel = useMutation({
    mutationFn: cancelLatest,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const dismiss = useMutation({
    mutationFn: dismissLatest,
    onSuccess: () => qc.setQueryData(KEY, null),
  });

  return {
    job: job.data ?? null,
    isLoading: job.isLoading,
    start,
    cancel,
    dismiss,
  };
}
