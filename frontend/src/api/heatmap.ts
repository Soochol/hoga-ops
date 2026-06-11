import { apiCall, apiAction } from './client';
import type { WatchlistEntry, WatchlistFolder } from './watchlist';

// 히트맵은 watchlist와 독립 스토어(ADR-0068)다. 폴더·엔트리의 프론트 표시 타입은
// 동형이라 재사용(re-export)한다 — 스펙 §4.1. 백엔드 HeatmapEntry는 캡처 필드
// (registered_at_kst_date / last_success_date)를 내려보내지 않지만, 히트맵 UI는 그
// 필드를 절대 읽지 않으므로(heat.ts/HeatmapRow 는 code·name·folder_id·order·시세만 사용)
// 동형 타입 재사용이 안전하다. 독립성은 store·query key·API·mutation 분리로 보장된다.
export type HeatmapFolder = WatchlistFolder;
export type HeatmapEntry = WatchlistEntry;

export interface HeatmapResponse {
  folders: HeatmapFolder[];
  entries: HeatmapEntry[];
  // watchlist 와 달리 next_run_at_ms 없음 — 히트맵은 스케줄러 비구동.
}

export function getHeatmap(): Promise<HeatmapResponse> {
  return apiCall<HeatmapResponse>('/api/heatmap');
}

export function addToHeatmap(code: string): Promise<HeatmapEntry> {
  return apiCall<HeatmapEntry>('/api/heatmap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function removeFromHeatmap(code: string): Promise<void> {
  return apiAction(`/api/heatmap/${code}`, { method: 'DELETE' });
}

// --- folders + bulk move/reorder/remove (mirror /api/watchlist, ADR-0068) ---

export function createHeatmapFolder(name: string): Promise<HeatmapFolder> {
  return apiCall<HeatmapFolder>('/api/heatmap/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function renameHeatmapFolder(folderId: string, name: string): Promise<void> {
  return apiAction(`/api/heatmap/folders/${folderId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function deleteHeatmapFolder(folderId: string): Promise<void> {
  return apiAction(`/api/heatmap/folders/${folderId}`, { method: 'DELETE' });
}
export function reorderHeatmapFolders(orderedIds: string[]): Promise<void> {
  return apiAction('/api/heatmap/folders/order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });
}
export function moveHeatmapEntries(codes: string[], folderId: string | null): Promise<void> {
  return apiAction('/api/heatmap/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, folder_id: folderId }),
  });
}
export function reorderHeatmapEntries(folderId: string | null, orderedCodes: string[]): Promise<void> {
  return apiAction('/api/heatmap/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId, ordered_codes: orderedCodes }),
  });
}
export function removeHeatmapEntries(codes: string[]): Promise<void> {
  return apiAction('/api/heatmap/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}
