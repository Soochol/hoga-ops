import { useMutation } from '@tanstack/react-query';
import { runScreener, type ScreenerFilters } from '../api/screener';

export const useScreener = () =>
  useMutation({ mutationFn: (f: ScreenerFilters) => runScreener(f) });
