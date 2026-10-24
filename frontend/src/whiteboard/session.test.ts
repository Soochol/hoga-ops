import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { WhiteboardDocument, WhiteboardWrite } from '../api/whiteboards';

vi.mock('./drafts', () => ({
  draftKey: vi.fn(async (id: string) => id),
  findDraft: vi.fn(async () => undefined),
  tabDraftId: () => 'tab',
  clearDraft: vi.fn(async () => {}),
  writeLocal: vi.fn(async () => {}),
}));
vi.mock('./images', () => ({ persistImages: vi.fn(async () => ({})), loadImages: vi.fn(async () => ({})) }));
vi.mock('../api/whiteboards', () => ({
  boardId: vi.fn(() => crypto.randomUUID()),
  createBoard: vi.fn(),
  writeBoard: vi.fn(),
}));
import { writeBoard, createBoard } from '../api/whiteboards';
import { writeLocal } from './drafts';
import { BoardSession } from './session';

function document(): WhiteboardDocument {
  return {
    id: 'test',
    name: '복기',
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    deleted_at_ms: null,
    element_count: 0,
    schema_version: 1,
    engine_version: 'excalidraw/0.18.1',
    scene: { elements: [], appState: {}, files: {} },
    last_mutation_id: 'first',
    last_mutation_hash: '',
  };
}
function element(version: number) {
  return [
    { id: 'memo', version, versionNonce: version, isDeleted: false, type: 'text', text: `내용 ${version}` },
  ] as unknown as ExcalidrawElement[];
}
function acknowledgement(doc: WhiteboardDocument, req: WhiteboardWrite) {
  return { ...doc, name: req.name, scene: req.scene, revision: req.expected_revision + 1 };
}

describe('whiteboard durable saves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(writeLocal).mockResolvedValue();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not mark a newer edit saved when an older acknowledgement arrives', async () => {
    const doc = document(),
      session = new BoardSession(doc, {}, 'race');
    let resolve!: (doc: WhiteboardDocument) => void;
    vi.mocked(writeBoard).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    session.change(element(1), {} as AppState, {});
    const saving = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    const req = vi.mocked(writeBoard).mock.calls[0][1];
    session.change(element(2), {} as AppState, {});
    resolve(acknowledgement(doc, req));
    await saving;
    expect(session.state.status).toBe('dirty');
    expect(session.document.revision).toBe(2);
    vi.mocked(writeBoard).mockImplementationOnce(async (_, req) => acknowledgement(doc, req));
    await session.flush();
    expect(session.state.status).toBe('saved');
    expect(vi.mocked(writeBoard).mock.calls[1][1].expected_revision).toBe(2);
    expect(vi.mocked(writeBoard).mock.calls[1][1].scene.elements[0].text).toBe('내용 2');
  });

  it('retries an ambiguous failure with the same mutation and keeps the draft', async () => {
    const doc = document(),
      session = new BoardSession(doc, {}, 'retry');
    session.rename('수정한 이름');
    vi.mocked(writeBoard).mockRejectedValueOnce(new Error('connection lost'));
    await session.flush();
    expect(session.state.status).toBe('error');
    expect(writeLocal).toHaveBeenCalledWith('retry', expect.objectContaining({ name: '수정한 이름' }));
    const req = vi.mocked(writeBoard).mock.calls[0][1];
    vi.mocked(writeBoard).mockResolvedValueOnce(acknowledgement(doc, req));
    await session.flush();
    expect(vi.mocked(writeBoard).mock.calls[1][1]).toEqual(req);
    expect(session.state.status).toBe('saved');
  });

  it('stops automatic writes on conflict and forks the local content', async () => {
    const doc = document(),
      session = new BoardSession(doc, {}, 'conflict');
    session.change(element(2), {} as AppState, {});
    vi.mocked(writeBoard).mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'whiteboard_conflict' }),
    );
    await session.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await session.flush();
    expect(writeBoard).toHaveBeenCalledTimes(1);
    expect(session.state.status).toBe('conflict');
    vi.mocked(createBoard).mockResolvedValueOnce(doc);
    await session.fork();
    expect(createBoard).toHaveBeenCalledWith(
      '복기 복사',
      expect.objectContaining({
        elements: expect.arrayContaining([expect.objectContaining({ text: '내용 2' })]),
      }),
    );
  });

  it('does not dirty the document on viewport and selection-only changes', () => {
    const session = new BoardSession(document(), {}, 'view');
    session.change([], { scrollX: 100, scrollY: 100 } as AppState, {});
    expect(session.state.status).toBe('saved');
    expect(writeBoard).not.toHaveBeenCalled();
  });

  it('reports local storage failure and still saves to the server', async () => {
    const doc = document(),
      session = new BoardSession(doc, {}, 'quota');
    session.rename('복구');
    vi.mocked(writeLocal).mockRejectedValue(new Error('quota'));
    vi.mocked(writeBoard).mockImplementationOnce(async (_, req) => acknowledgement(doc, req));
    await session.flush();
    expect(session.state.status).toBe('saved');
    expect(session.state.localError).toBe(true);
  });
});
