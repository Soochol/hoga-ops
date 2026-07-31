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

// v3 유일한 추가 커맨드 — 폴더 지정 추가. 다른 그룹에 이미 있어도 **이동이 아니라 추가**
// (한 종목이 여러 그룹에 동시 등록된다). 같은 그룹에 다시 추가하면 멱등(이름만 갱신).
// 폴더 없는 추가(구 addToHeatmap → 미분류)는 백엔드 라우트와 함께 제거됐다(ADR-0112).
export function addToHeatmapFolder(code: string, folderId: string): Promise<HeatmapEntry> {
  return apiCall<HeatmapEntry>(`/api/heatmap/folders/${folderId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

/** 한 그룹에서만 해제 — 다른 그룹의 등록은 남는다. 행 삭제/⋯메뉴가 쓰는 표면. */
export function removeFromHeatmapFolder(code: string, folderId: string): Promise<void> {
  return apiAction(`/api/heatmap/folders/${folderId}/members/${code}`, { method: 'DELETE' });
}

/** 모든 그룹에서 해제(히트맵에서 완전 제거). 그룹 스코프가 없는 호출자용. */
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
/** 출발 그룹 → 도착 그룹 이동. fromFolderId 는 필수 — 한 종목이 여러 그룹에 등록될 수
 *  있어 "005930 을 X 로 이동"만으로는 어느 등록을 옮길지 정해지지 않는다. */
export function moveHeatmapEntries(
  codes: string[], fromFolderId: string, folderId: string,
): Promise<void> {
  return apiAction('/api/heatmap/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, from_folder_id: fromFolderId, folder_id: folderId }),
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
