import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { WhiteboardFile, ReviewNote } from '../api/whiteboards';
import { apiUrl } from '../api/client';
import { randomId } from '../util/randomId';

export interface BoardDraft {
  id: string;
  revision: number;
  name: string;
  review?: ReviewNote | null;
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  assets: Record<string, WhiteboardFile>;
  appState: Record<string, unknown>;
  changedAt: number;
  token: string;
}
export type BoardView = Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>;
type Stored = BoardDraft | BoardView;
let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ticklane-whiteboards-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  });
  return database;
}
export async function draftKey(id: string) {
  return `${await apiUrl('/api/whiteboards')}::${id}`;
}
let tabId: string | undefined;
export function tabDraftId() {
  if (tabId) return tabId;
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    // A duplicated/new tab can inherit sessionStorage. Reuse the owner only on
    // reload, otherwise give this document its own journal namespace.
    tabId = navigation?.type === 'reload' ? sessionStorage.getItem('whiteboard.tab.v1') ?? randomId() : randomId();
    sessionStorage.setItem('whiteboard.tab.v1', tabId);
  } catch {
    tabId = randomId();
  }
  return tabId;
}
export async function findDraft(base: string, ownKey: string): Promise<{ key: string; value: BoardDraft } | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('drafts');
    const store = tx.objectStore('drafts');
    const range = IDBKeyRange.bound(base + '::', base + '::\uffff');
    const keys = store.getAllKeys(range), values = store.getAll(range);
    tx.oncomplete = () => {
      const drafts = values.result
        .map((value, index) => ({ key: String(keys.result[index]), value: value as BoardDraft }))
        .filter((row) => row.key.startsWith(base + '::') && Array.isArray(row.value.elements));
      resolve(
        drafts.find((row) => row.key === ownKey) ??
          drafts.sort((a, b) => b.value.changedAt - a.value.changedAt)[0],
      );
    };
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearDraft(key: string, token: string): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('drafts', 'readwrite'),
      store = tx.objectStore('drafts');
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.token === token) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function readLocal<T extends Stored>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const req = database.transaction('drafts').objectStore('drafts').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}
export async function writeLocal(key: string, value: Stored | null): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('drafts', 'readwrite');
    if (value === null) tx.objectStore('drafts').delete(key);
    else tx.objectStore('drafts').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
