import { apiUrl } from './client';
import type { SymbolHit, SymbolsAllResponse } from './types';

export async function getAllSymbols(): Promise<SymbolsAllResponse> {
  const url = await apiUrl('/api/symbols/all');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/symbols/all failed: ${r.status}`);
  return r.json();
}

export async function searchSymbols(q: string, limit = 20): Promise<SymbolHit[]> {
  const base = await apiUrl('/api/symbols');
  const url = `${base}?q=${encodeURIComponent(q)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/symbols?q=${q} failed: ${r.status}`);
  return r.json();
}

export async function refreshSymbols(): Promise<SymbolsAllResponse> {
  const url = await apiUrl('/api/symbols/refresh');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`POST /api/symbols/refresh failed: ${r.status}`);
  return r.json();
}
