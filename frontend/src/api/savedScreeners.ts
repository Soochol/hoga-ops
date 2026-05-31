import { apiCall, apiAction } from './client';
import type { ConditionLeaf, ScreenerUniverse } from './screener';

export interface SavedScreener {
  id: string;
  name: string;
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  created_at_ms: number;
  updated_at_ms: number;
}
export interface SavedScreenerListResponse { schema_version: number; saves: SavedScreener[] }
export interface SaveWriteRequest { name: string; conditions: ConditionLeaf[]; universe: ScreenerUniverse }

const J = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const listSaves = () => apiCall<SavedScreenerListResponse>('/api/screener/saves');
export const createSave = (b: SaveWriteRequest) =>
  apiCall<SavedScreener>('/api/screener/saves', { method: 'POST', ...J(b) });
export const updateSave = (id: string, b: SaveWriteRequest) =>
  apiCall<SavedScreener>(`/api/screener/saves/${id}`, { method: 'PUT', ...J(b) });
export const deleteSave = (id: string) =>
  apiAction(`/api/screener/saves/${id}`, { method: 'DELETE' });
