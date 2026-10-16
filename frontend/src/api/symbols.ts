import { apiCall } from './client';
import type { CaptureCountsInfo, SymbolHit, SymbolMasterInfo, SymbolsAllResponse } from './types';

export function getCaptureCountsInfo(): Promise<CaptureCountsInfo> {
  return apiCall<CaptureCountsInfo>('/api/symbols/capture-counts');
}

export function refreshCaptureCounts(): Promise<CaptureCountsInfo> {
  return apiCall<CaptureCountsInfo>('/api/symbols/capture-counts/refresh', { method: 'POST' });
}

export function getAllSymbols(): Promise<SymbolsAllResponse> {
  return apiCall<SymbolsAllResponse>('/api/symbols/all');
}

export function searchSymbols(q: string, limit = 20): Promise<SymbolHit[]> {
  return apiCall<SymbolHit[]>(`/api/symbols?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function refreshSymbols(): Promise<SymbolsAllResponse> {
  return apiCall<SymbolsAllResponse>('/api/symbols/refresh', { method: 'POST' });
}

export function getSymbolMasterInfo(): Promise<SymbolMasterInfo> {
  return apiCall<SymbolMasterInfo>('/api/symbols/info');
}
