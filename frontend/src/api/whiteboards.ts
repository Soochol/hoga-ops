import { apiCall, apiUrl } from './client';
import { randomId } from '../util/randomId';

export interface WhiteboardAsset {
  asset_id: string;
  mime_type: string;
  width: number;
  height: number;
  size: number;
}
export interface WhiteboardFile extends WhiteboardAsset {
  created: number;
}
export interface WhiteboardScene {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, WhiteboardFile>;
}
export interface WhiteboardSummary {
  id: string;
  name: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  element_count: number;
}
export interface WhiteboardDocument extends WhiteboardSummary {
  schema_version: number;
  engine_version: string;
  scene: WhiteboardScene;
  last_mutation_id: string;
  last_mutation_hash: string;
}
export interface WhiteboardList {
  boards: WhiteboardSummary[];
  unreadable_ids: string[];
}
export interface WhiteboardCreate {
  id: string;
  mutation_id: string;
  name: string;
  scene: WhiteboardScene;
}
export interface WhiteboardWrite {
  mutation_id: string;
  expected_revision: number;
  name: string;
  scene: WhiteboardScene;
  deleted: boolean;
}

export const boardId = randomId;
export const emptyScene = (): WhiteboardScene => ({ elements: [], appState: {}, files: {} });
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const listBoards = (deleted = false) => apiCall<WhiteboardList>(`/api/whiteboards?deleted=${deleted}`);
export const readBoard = (id: string) => apiCall<WhiteboardDocument>(`/api/whiteboards/${id}`);
export const createBoard = (name = '새 보드', scene = emptyScene(), id = boardId()) =>
  apiCall<WhiteboardDocument>(
    '/api/whiteboards',
    json({ id, mutation_id: id, name, scene } satisfies WhiteboardCreate),
  );
export const writeBoard = (id: string, req: WhiteboardWrite) =>
  apiCall<WhiteboardDocument>(`/api/whiteboards/${id}`, json(req, 'PUT'));
export async function uploadBoardImage(blob: Blob): Promise<WhiteboardAsset> {
  const response = await fetch(await apiUrl('/api/whiteboards/assets'), {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.message ?? '이미지 업로드에 실패했습니다');
  }
  return response.json();
}
export async function readBoardImage(id: string): Promise<Blob> {
  const response = await fetch(await apiUrl(`/api/whiteboards/assets/${id}`));
  if (!response.ok) throw new Error('저장된 이미지를 읽지 못했습니다');
  return response.blob();
}
