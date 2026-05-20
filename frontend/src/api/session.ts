import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { SessionBundle } from './types';

export function useSession(
  code: string | null,
  date: string | null,
  priceRange?: { min: number; max: number },
) {
  const enabled = !!code && !!date;
  const qs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';
  return useQuery({
    queryKey: ['session', code, date, priceRange?.min, priceRange?.max],
    queryFn: () => apiGet<SessionBundle>(`/api/session?code=${code}&date=${date}${qs}`),
    enabled,
    staleTime: Infinity,
  });
}
