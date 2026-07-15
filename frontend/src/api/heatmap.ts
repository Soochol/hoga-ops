import { apiCall, apiAction } from './client';
import type { WatchlistFolder } from './watchlist';

// 히트맵은 watchlist와 독립 스토어(ADR-0068)다. 폴더·엔트리의 프론트 표시 타입은
// 백엔드 wire와 같은 최소 필드만 가진다. WatchlistEntry의 capture fields를 재사용하면
// 실제 /api/heatmap payload보다 넓은 타입이 되어 wire drift를 숨긴다.
// v3 (ADR-0112): folder_id 는 항상 실폴더 — 미분류(null) 상태가 타입에서 사라졌다.
export type HeatmapFolder = WatchlistFolder;
export interface HeatmapEntry {
  code: string;
  name: string;
  folder_id: string;
  order: number;
}

export interface HeatmapResponse {
  folders: HeatmapFolder[];
  entries: HeatmapEntry[];
  // watchlist 와 달리 next_run_at_ms 없음 — 히트맵은 스케줄러 비구동.
}

export function getHeatmap(): Promise<HeatmapResponse> {
  return apiCall<HeatmapResponse>('/api/heatmap');
}

// v3 유일한 추가 커맨드 — 폴더 지정 추가(없으면 추가, 있으면 이동). 폴더 없는 추가
// (구 addToHeatmap → 미분류)는 백엔드 라우트와 함께 제거됐다(ADR-0112).
export function addToHeatmapFolder(code: string, folderId: string): Promise<HeatmapEntry> {
  return apiCall<HeatmapEntry>(`/api/heatmap/folders/${folderId}/members`, {
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
export function moveHeatmapEntries(codes: string[], folderId: string): Promise<void> {
  return apiAction('/api/heatmap/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, folder_id: folderId }),
  });
}
export function reorderHeatmapEntries(folderId: string, orderedCodes: string[]): Promise<void> {
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
