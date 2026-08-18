import { apiCall, apiAction } from './client';
import type { EnqueueResponse } from './types';

export type { EnqueueResponse } from './types';

export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
}

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
  folder_id: string | null;        // watchlist v3 와이어는 항상 실폴더(null 없음, ADR-0070);
                                   // heatmap 도 v3 부터 자체 HeatmapEntry(비-null)를 쓴다(ADR-0112)
                                   // — null 은 grouping.ts 제네릭 하위호환으로만 남아 있다
  order: number;                   // 폴더 items 인덱스(v4) — 메모 행이 차지한 자리를
                                   // 건너뛰므로 이 배열만 보면 띄엄띄엄하다. WatchlistMemo
                                   // 와 합치면 0..N-1 로 조밀하다. **정렬 키로만 쓸 것**
}

/** 리스트에 끼워 넣는 "빈칸" 행(v4). 종목명 자리에 `text` 가 보이고, `text: ''` 는
 *  빈 줄이라는 정상 상태다(폴더 이름과 정반대 — blank 를 거절하지 않는다).
 *
 *  `order` 는 WatchlistEntry.order 와 **같은 축**(폴더 items 인덱스)이다. 두 배열을
 *  각각 보면 값이 띄엄띄엄하지만, entries∪memos 는 폴더당 0..N-1 로 조밀하다 —
 *  order 로 정렬해 병합하면 원래 표시 순서가 그대로 복원된다. */
export interface WatchlistMemo {
  id: string;                      // m_ + 8 hex
  folder_id: string;
  order: number;
  text: string;
}

/** 메모 텍스트 상한 — 백엔드 models.py::WATCHLIST_MEMO_MAX_LEN 의 손 미러.
 *  input 의 maxLength 로 써서 초과 입력이 422 로 돌아오기 전에 막는다. 값이 갈리면
 *  넘치는 입력이 조용히 거절되므로 백엔드와 같은 PR 에서 함께 고친다(ADR-0004). */
export const WATCHLIST_MEMO_MAX_LEN = 80;

export interface WatchlistResponse {
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
  memos: WatchlistMemo[];
  next_run_at_ms: number;
}

export function getWatchlist(): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist');
}

/** v3 멤버십(ADR-0070): code를 folderId의 멤버로 추가. entry 없으면 백엔드가 생성.
 *
 *  `at` = 삽입할 items 인덱스(v4) — addMemo 와 **같은 축·같은 클램프 시맨틱**이다.
 *  생략하면 폴더 맨 아래(추가 폼·하트 버튼·히트맵 팝오버의 기존 경로). 패널 행
 *  우클릭 "위에 종목 추가" 만 값을 준다. 음수는 422(ge=0) — 클램프는 상한만이다.
 *
 *  ⚠ **이미 멤버인 코드에는 `at` 이 무시된다**(백엔드 add 는 멱등 no-op). 위치를
 *  옮기려면 reorderItems 를 쓴다. 호출부는 중복이면 아예 부르지 않는 편이 낫다 —
 *  "눌렀는데 아무 일도 안 일어난다" 가 되기 때문. */
export function addMember(folderId: string, code: string, at?: number): Promise<WatchlistEntry> {
  return apiCall<WatchlistEntry>(`/api/watchlist/folders/${folderId}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, at: at ?? null }),
  });
}

/** v3 멤버십: code를 folderId에서 제거. 어느 폴더에도 없으면 백엔드가 entry 삭제. */
export function removeMember(folderId: string, code: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}/members/${code}`, { method: 'DELETE' });
}

/** 폴더 멤버십을 **한 번에** 제거(한 락·한 save). 다중 선택이 N번 왕복하다 중간에
 *  실패해 "절반만 빠지는" 것을 막는다 — 단수형 `removeMember` 의 벌크판이다. */
export function removeMembers(folderId: string, codes: string[]): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}/members/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}

/** 관심종목에서 코드 전체 제거(모든 폴더에서 빼고 entry 삭제). 드로어 quick-remove. */
export function removeFromWatchlist(code: string): Promise<void> {
  return apiAction(`/api/watchlist/${code}`, { method: 'DELETE' });
}

// --- Folders + bulk move/reorder/remove (spec 2026-05-31) -----------------

export function createFolder(name: string): Promise<WatchlistFolder> {
  return apiCall<WatchlistFolder>('/api/watchlist/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function renameFolder(folderId: string, name: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function deleteFolder(folderId: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, { method: 'DELETE' });
}
export function reorderFolders(orderedIds: string[]): Promise<void> {
  return apiAction('/api/watchlist/folders/order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });
}
/** "이 폴더의 **종목 순서**를 이렇게" — 메모는 items 인덱스에 고정된다.
 *  편집 모달이 쓴다(그 화면은 메모를 표시하지 않아 메모 위치에 의견이 없다). */
export function reorderEntries(folderId: string, orderedCodes: string[]): Promise<void> {
  return apiAction('/api/watchlist/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId, ordered_codes: orderedCodes }),
  });
}

/** 재배열이 지목하는 항목 — 저장 모델(코드/메모)과 달리 메모 `text` 가 없다.
 *  순서만 옮기므로 내용을 실을 필요가 없다. BE 미러: models.py::WatchlistItemRef. */
export type WatchlistItemKind = 'code' | 'memo';
export type WatchlistItemRef =
  | { kind: 'code'; code: string }
  | { kind: 'memo'; id: string };

/** "이 폴더의 **표시 순서 전체**를 이렇게" — 코드와 메모를 한 리스트로 보낸다.
 *  패널 dnd 가 쓴다. 폴더의 현재 items 집합과 정확히 일치해야 한다(불일치 409). */
export function reorderItems(folderId: string, orderedItems: WatchlistItemRef[]): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}/items/order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_items: orderedItems }),
  });
}
// --- 메모("빈칸") 아이템 (v4) ---------------------------------------------
// 셋 다 Live Set 에 영향이 없다(메모는 Code 가 아니다) — 백엔드도 이 라우트들에선
// refresh_live_stream 을 부르지 않는다.

/** 폴더에 빈칸을 삽입. `at` = items 인덱스, 생략하면 맨 아래. 범위를 넘으면 끝으로
 *  클램프된다(422 아님 — 동시 편집으로 길이가 줄었을 뿐인 흔한 경우). */
export function addMemo(folderId: string, text = '', at?: number): Promise<WatchlistMemo> {
  return apiCall<WatchlistMemo>(`/api/watchlist/folders/${folderId}/memos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, at: at ?? null }),
  });
}

/** 메모 텍스트 교체. `''` 는 빈 줄로 정상 저장된다. */
export function updateMemo(memoId: string, text: string): Promise<WatchlistMemo> {
  return apiCall<WatchlistMemo>(`/api/watchlist/memos/${memoId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export function removeMemo(memoId: string): Promise<void> {
  return apiAction(`/api/watchlist/memos/${memoId}`, { method: 'DELETE' });
}

export function removeEntries(codes: string[]): Promise<void> {
  return apiAction('/api/watchlist/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}

// --- Manual catch-up (spec 2026-05-27) ------------------------------------
// EnqueueResponse / EnqueueDedupedRow / QueueItem live in ./types so the
// wire shape stays single-source-of-truth for both /api/captures/items and
// /api/watchlist/{code}/catchup. Re-exported above for ergonomic imports
// from this module.

/** Structured error envelope — mirrors hoga/api/models.py::ManualCatchupError.
 *  `code` is stable (e.g. `trading_days_unavailable`, `catchup_failed`); the
 *  panel can branch on it instead of regex-matching exception strings. */
export interface ManualCatchupError {
  code: string;
  message: string;
}

export interface ManualCatchupAllEntryResult {
  code: string;
  name: string;
  enqueued_count: number;
  deduped_count: number;
  error: ManualCatchupError | null;
}

export interface ManualCatchupAllResponse {
  results: ManualCatchupAllEntryResult[];
}

export function catchupNow(code: string): Promise<EnqueueResponse> {
  return apiCall<EnqueueResponse>(`/api/watchlist/${code}/catchup`, {
    method: 'POST',
  });
}

export function catchupAll(): Promise<ManualCatchupAllResponse> {
  return apiCall<ManualCatchupAllResponse>('/api/watchlist/catchup', {
    method: 'POST',
  });
}
