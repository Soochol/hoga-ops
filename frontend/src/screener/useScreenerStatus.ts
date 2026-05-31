import { useQuery } from '@tanstack/react-query';
import { getScreenerStatus } from '../api/screener';

export const useScreenerStatus = () =>
  useQuery({ queryKey: ['screener-status'], queryFn: getScreenerStatus, refetchInterval: 30_000 });
