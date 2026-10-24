import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ApiError } from '../api/client';
import {
  boardId,
  createBoard,
  writeBoard,
  type WhiteboardDocument,
  type WhiteboardWrite,
} from '../api/whiteboards';
import { clearDraft, draftKey, findDraft, tabDraftId, writeLocal, type BoardDraft } from './drafts';
import { loadImages, persistImages } from './images';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export interface SessionState {
  status: SaveStatus;
  name: string;
  message: string;
  localError: boolean;
  generation: number;
}
const sessions = new Map<string, BoardSession>();
const listeners = new Set<() => void>();
export const subscribeBoardSaves = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const publish = () => listeners.forEach((fn) => fn());

/** Outlives route unmounts. Only the editor owns the scene; saves use snapshots. */
export class BoardSession {
  document: WhiteboardDocument;
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  appState: Record<string, unknown>;
  state: SessionState;
  readonly key: string;
  private subscribers = new Set<() => void>();
  private generation = 0;
  private localGeneration = -1;
  private signature = '';
  private timer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private pending?: { request: WhiteboardWrite; generation: number };
  private readonly draftOwner = boardId();
  recoveredDraft?: { key: string; token: string };
  private retired = false;

  constructor(doc: WhiteboardDocument, files: BinaryFiles, key: string, draft?: BoardDraft) {
    this.key = key;
    this.document = doc;
    this.elements = (draft?.elements ?? doc.scene.elements) as readonly ExcalidrawElement[];
    this.files = draft?.files ?? files;
    this.appState = draft?.appState ?? doc.scene.appState;
    this.state = {
      status: draft ? (draft.revision === doc.revision ? 'dirty' : 'conflict') : 'saved',
      name: draft?.name ?? doc.name,
      message: draft ? '이전 편집 초안을 복원했습니다' : '',
      localError: false,
      generation: 0,
    };
    this.signature = this.contentSignature(this.elements);
    if (draft) {
      this.localGeneration = 0;
      if (draft.revision === doc.revision) this.schedule();
    }
  }

  subscribe = (fn: () => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };
  isObserved() {
    return this.subscribers.size > 0;
  }
  getSnapshot = () => this.state;
  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch, generation: this.generation };
    this.subscribers.forEach((fn) => fn());
  }
  private contentSignature(elements: readonly ExcalidrawElement[]) {
    return elements.map((el) => `${el.id}:${el.version}:${el.versionNonce}:${el.isDeleted}`).join('|');
  }

  change(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) {
    if (this.retired) return;
    const signature = this.contentSignature(elements);
    this.files = files;
    if (signature === this.signature) return;
    this.signature = signature;
    this.elements = elements;
    this.appState = { viewBackgroundColor: appState.viewBackgroundColor };
    this.changed();
  }
  rename(name: string) {
    if (this.retired) return;
    if (name === this.state.name) return;
    this.update({ name });
    this.changed();
  }
  private changed() {
    this.generation++;
    if (this.state.status !== 'conflict') this.update({ status: 'dirty', message: '' });
    else this.update({});
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      void this.persistDraft();
    }, 180);
    if (this.state.status !== 'conflict') this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 750);
    this.maxTimer ??= setTimeout(() => {
      void this.flush();
    }, 5000);
  }
  private draft(): BoardDraft {
    return {
      id: this.document.id,
      revision: this.document.revision,
      name: this.state.name,
      elements: this.elements,
      files: this.files,
      assets: this.document.scene.files,
      appState: this.appState,
      changedAt: Date.now(),
      token: `${this.draftOwner}:${this.generation}`,
    };
  }
  async persistDraft() {
    if (this.retired || this.state.status === 'saved') return;
    const generation = this.generation;
    try {
      await writeLocal(this.key, this.draft());
      this.localGeneration = generation;
      this.update({ localError: false });
    } catch {
      this.update({
        localError: true,
        message: '브라우저 초안을 보관하지 못했습니다. 서버 저장 또는 편집 파일 백업을 확인해 주세요',
      });
    }
  }
  needsUnloadWarning() {
    return this.state.status !== 'saved' && this.localGeneration !== this.generation;
  }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
    if (this.retired) return;
    if (this.saving) return this.saving;
    if (this.state.status === 'saved' || this.state.status === 'conflict') return;
    this.saving = this.save();
    await this.saving;
    this.saving = undefined;
    if (this.state.status === 'dirty') this.schedule();
  };
  private async save() {
    this.update({ status: 'saving' });
    try {
      await this.persistDraft();
      if (!this.pending) {
        const generation = this.generation;
        const draft = structuredClone(this.draft());
        const assets = await persistImages(draft.files, this.document.scene.files);
        this.pending = {
          generation,
          request: {
            mutation_id: boardId(),
            expected_revision: this.document.revision,
            name: draft.name.trim() || '새 보드',
            scene: {
              elements: draft.elements as unknown as Record<string, unknown>[],
              appState: draft.appState,
              files: assets,
            },
            deleted: false,
          },
        };
      }
      const pending = this.pending;
      this.document = await writeBoard(this.document.id, pending.request);
      this.pending = undefined;
      if (this.recoveredDraft) {
        await clearDraft(this.recoveredDraft.key, this.recoveredDraft.token).catch(() => {});
        this.recoveredDraft = undefined;
      }
      if (this.generation === pending.generation) {
        this.update({
          status: 'saved',
          name: this.document.name,
          message: this.state.localError ? this.state.message : '',
        });
        await clearDraft(this.key, `${this.draftOwner}:${pending.generation}`).catch(() => {});
      } else {
        this.update({ status: 'dirty' });
        await this.persistDraft();
      }
      publish();
    } catch (error) {
      this.update({
        status: (error as ApiError).code === 'whiteboard_conflict' ? 'conflict' : 'error',
        message: error instanceof Error ? error.message : '보드를 저장하지 못했습니다',
      });
    }
  }
  async fork(name = `${this.state.name.slice(0, 117)} 복사`) {
    const draft = structuredClone(this.draft());
    const assets = await persistImages(draft.files, this.document.scene.files);
    return createBoard(name, {
      elements: draft.elements as unknown as Record<string, unknown>[],
      appState: draft.appState,
      files: assets,
    });
  }
  retire() {
    this.retired = true;
    clearTimeout(this.timer);
    clearTimeout(this.maxTimer);
    clearTimeout(this.draftTimer);
  }
  async trash(deleted: boolean) {
    await this.flush();
    if (this.state.status !== 'saved') throw new Error('저장 또는 충돌 해결 후 보드를 삭제해 주세요');
    this.document = await writeBoard(this.document.id, {
      mutation_id: boardId(),
      expected_revision: this.document.revision,
      name: this.document.name,
      scene: this.document.scene,
      deleted,
    });
    await writeLocal(this.key, null).catch(() => {});
    this.retire();
    sessions.delete(this.key);
    publish();
  }
}

export async function openBoardSession(doc: WhiteboardDocument): Promise<BoardSession> {
  const base = await draftKey(doc.id);
  const key = `${base}::${tabDraftId()}`;
  const existing = sessions.get(key);
  if (existing && (existing.state.status !== 'saved' || existing.document.revision === doc.revision))
    return existing;
  let draft: BoardDraft | undefined;
  let located: Awaited<ReturnType<typeof findDraft>>;
  let localError = false;
  try {
    located = await findDraft(base, key);
    draft = located?.value;
  } catch {
    localError = true;
  }
  if (
    draft &&
    draft.name === doc.name &&
    JSON.stringify(draft.elements) === JSON.stringify(doc.scene.elements)
  ) {
    if (located) void clearDraft(located.key, located.value.token).catch(() => {});
    draft = undefined;
  }
  const files = draft?.files ?? (await loadImages(doc.scene));
  const current = sessions.get(key);
  if (current && (current.state.status !== 'saved' || current.document.revision >= doc.revision)) return current;
  const session = new BoardSession(doc, files, key, draft);
  if (draft && located) session.recoveredDraft = { key: located.key, token: draft.token };
  if (localError)
    session.state = { ...session.state, localError, message: '브라우저 복구 저장소를 사용할 수 없습니다' };
  sessions.set(key, session);
  if (sessions.size > 4) {
    for (const [cachedKey, cached] of sessions) {
      if (cached !== session && cached.state.status === 'saved' && !cached.isObserved())
        sessions.delete(cachedKey);
      if (sessions.size <= 4) break;
    }
  }
  return session;
}

export async function discardBoardSession(session: BoardSession) {
  session.retire();
  sessions.delete(session.key);
  if (session.recoveredDraft) await clearDraft(session.recoveredDraft.key, session.recoveredDraft.token);
  await writeLocal(session.key, null);
}

window.addEventListener('beforeunload', (event) => {
  if ([...sessions.values()].some((s) => s.needsUnloadWarning())) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('online', () => {
  sessions.forEach((s) => {
    if (s.state.status === 'error') void s.flush();
  });
});
