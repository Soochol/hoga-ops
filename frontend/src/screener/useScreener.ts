import { useMutation } from '@tanstack/react-query';
import { runScan, type ScanRequest } from '../api/screener';

export const useScreener = () => useMutation({ mutationFn: (b: ScanRequest) => runScan(b) });
