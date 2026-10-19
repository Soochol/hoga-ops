import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export const CAPTURE_COUNTS_QUERY_KEY = ['capture-counts'] as const;
/** Mirrors CaptureCountKey / CaptureCountsRequest / CaptureCount / CaptureCountsResponse. */
export interface CaptureCountKey { code: string; date: string }
export interface CaptureCountsRequest { items: CaptureCountKey[] }
export interface CaptureCount extends CaptureCountKey { full_capture_count: number | null }
export interface CaptureCountsResponse { items: CaptureCount[] }

export function useCaptureCounts(rows: readonly CaptureCountKey[]) {
  const keys = [...new Set(rows.map(row => `${row.code}|${row.date}`))].sort();
  return useQuery({
    queryKey: [...CAPTURE_COUNTS_QUERY_KEY, keys],
    enabled: keys.length > 0,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const requests = [];
      for (let i = 0; i < keys.length; i += 200) {
        const items = keys.slice(i, i + 200).map(key => {
          const [code, date] = key.split('|');
          return { code, date };
        });
        requests.push(apiCall<CaptureCountsResponse>('/api/capture-counts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items } satisfies CaptureCountsRequest), signal,
        }));
      }
      const responses = await Promise.all(requests);
      return new Map(responses.flatMap(response => response.items.map(item =>
        [`${item.code}|${item.date}`, item.full_capture_count] as const)));
    },
  });
}
