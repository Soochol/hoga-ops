import { apiCall } from './client';
import type { SymbolHit, SymbolsAllResponse } from './types';

export function getAllSymbols(): Promise<SymbolsAllResponse> {
  return apiCall<SymbolsAllResponse>('/api/symbols/all');
}

export function searchSymbols(q: string, limit = 20): Promise<SymbolHit[]> {
  return apiCall<SymbolHit[]>(`/api/symbols?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function refreshSymbols(): Promise<SymbolsAllResponse> {
  return apiCall<SymbolsAllResponse>('/api/symbols/refresh', { method: 'POST' });
}
