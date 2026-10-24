import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { exportToBlob } from '@excalidraw/excalidraw';
import { createBoard, listBoards, readBoard, type WhiteboardSummary } from '../api/whiteboards';
import { BoardEditor, type BoardEditorHandle } from '../whiteboard/BoardEditor';
import {
  discardBoardSession,
  openBoardSession,
  subscribeBoardSaves,
  type BoardSession,
} from '../whiteboard/session';
import {
  downloadBlob,
  exportBoardFile,
  importBoardFile,
  safeFilename,
  selectedElements,
} from '../whiteboard/files';
import { BoardIcon } from '../whiteboard/BoardIcon';
import { takeChartTransfer } from '../whiteboard/chartTransfer';
import { BoardEditorBoundary } from '../whiteboard/BoardEditorBoundary';
import { TooltipButton } from '../ui/TextTooltip';
import { ModalShell } from '../ui/ModalShell';
import '../whiteboard/whiteboard.css';

const statusNames = {
  saved: '저장됨',
  saving: '저장 중…',
  dirty: '변경됨',
  error: '저장 실패',
  conflict: '다른 창의 변경과 충돌',
};
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export default function Whiteboard() {
  const [params, setParams] = useSearchParams();
  const id = params.get('board');
  const [boards, setBoards] = useState<WhiteboardSummary[]>([]);
  const [loadedSession, setSession] = useState<BoardSession | null>(null);
  const session = loadedSession?.document.id === id ? loadedSession : null;
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [trash, setTrash] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const imageOperation = useRef<BoardEditorHandle | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [background, setBackground] = useState(true);
  const [retry, setRetry] = useState(0);
  const editor = useRef<BoardEditorHandle | null>(null);
  const listRequest = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null),
    importInput = useRef<HTMLInputElement>(null);
  const save = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
  );

  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const result = await listBoards(trash);
      if (request !== listRequest.current) return;
      setBoards(result.boards.filter(board => !board.review));
      if (result.unreadable_ids.length)
        setNotice(`${result.unreadable_ids.length}개 보드를 읽지 못했습니다. 원본 파일은 보존했습니다`);
    } catch (error) {
      if (request !== listRequest.current) return;
      setError(error instanceof Error ? error.message : '보드 목록을 불러오지 못했습니다');
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, [trash]);
  useEffect(() => {
    void refresh();
    return subscribeBoardSaves(() => {
      void refresh();
    });
  }, [refresh]);
  useEffect(() => {
    const refreshOnFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [refresh]);

  useEffect(() => {
    let mounted = true;
    setLoading(Boolean(id));
    setError('');
    setSession(null);
    editor.current = null;
    if (id)
      void readBoard(id)
        .then(openBoardSession)
        .then((value) => {
          if (mounted) {
            setSession(value);
            setLoading(false);
          }
        })
        .catch((error) => {
          if (mounted) {
            setError(error instanceof Error ? error.message : '보드를 열지 못했습니다');
            setLoading(false);
          }
        });
    return () => {
      mounted = false;
    };
  }, [id, retry]);

  const select = useCallback(
    (next: string | null) => {
      if (session) {
        void session.persistDraft();
        void session.flush();
      }
      setParams(next ? { board: next, legacy: '1' } : { legacy: '1' });
    },
    [session, setParams],
  );
  useEffect(() => {
    if (!id && !listLoading && !busy && boards.length) setParams({ board: boards[0].id, legacy: '1' }, { replace: true });
  }, [id, listLoading, busy, boards, setParams]);

  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (error) {
      setError(error instanceof Error ? error.message : '작업에 실패했습니다');
    } finally {
      setBusy(false);
    }
  }
  async function makeBoard() {
    await action(async () => {
      const doc = await createBoard();
      setTrash(false);
      select(doc.id);
      await refresh();
    });
  }
  async function duplicate() {
    if (!session) return;
    await action(async () => {
      const doc = await session.fork();
      setTrash(false);
      select(doc.id);
      await refresh();
      setNotice('내 편집을 새 보드에 복사했습니다');
    });
  }
  async function toggleTrash() {
    if (!session) return;
    await action(async () => {
      const deleted = !session.document.deleted_at_ms;
      await session.trash(deleted);
      await refresh();
      select(null);
      setNotice(
        deleted ? '보드를 휴지통으로 옮겼습니다. 휴지통에서 복원할 수 있습니다' : '보드를 복원했습니다',
      );
    });
  }
  async function images(files: File[]) {
    const handle = editor.current;
    if (!handle) return;
    await action(async () => {
      setImagesBusy(true);
      imageOperation.current = handle;
      try {
        setNotice('이미지를 불러오는 중…');
        await handle.addImages(files);
        setNotice('이미지 처리를 마쳤습니다');
      } finally {
        setImagesBusy(false);
        imageOperation.current = null;
      }
    });
  }
  async function png() {
    if (!editor.current || !session) return;
    await action(async () => {
      const api = editor.current!.api;
      const elements = selectedElements(api, selectionOnly);
      if (!elements.length)
        throw new Error(selectionOnly ? '내보낼 객체를 먼저 선택해 주세요' : '보드에 객체를 추가해 주세요');
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: {
          ...api.getAppState(),
          viewBackgroundColor: '#ffffff',
          exportBackground: background,
          exportWithDarkMode: api.getAppState().theme === 'dark',
        },
        maxWidthOrHeight: 4096,
      });
      downloadBlob(blob, safeFilename(session.state.name) + '.png');
      setNotice('PNG 파일을 만들었습니다');
      setExportOpen(false);
    });
  }
  const isDeleted = Boolean(session?.document.deleted_at_ms);

  return (
    <section className={`whiteboard-page ${collapsed ? 'wb-list-collapsed' : ''}`} aria-label="화이트보드">
      <aside className="wb-list" aria-label="보드 목록">
        <div className="wb-list-heading">
          <span>
            <BoardIcon name="folder" />
            {trash ? '휴지통' : '내 보드'} <small>{boards.length}</small>
          </span>
          <TooltipButton
            aria-label="새 보드"
            title="새 보드"
            disabled={busy}
            onClick={() => void makeBoard()}
          >
            <BoardIcon name="plus" />
          </TooltipButton>
        </div>
        <div className="wb-list-items">
          {boards.map((board) => (
            <button
              type="button"
              key={board.id}
              data-testid={`whiteboard-row-${board.id}`}
              className={`wb-list-item ${id === board.id ? 'selected' : ''}`}
              aria-current={id === board.id ? 'page' : undefined}
              onClick={() => select(board.id)}
            >
              <BoardIcon name="board" />
              <span>
                <strong>{board.name}</strong>
                <small>
                  {board.element_count ? `객체 ${board.element_count}개` : '빈 보드'} ·{' '}
                  {new Date(board.updated_at_ms).toLocaleDateString('ko-KR', {
                    month: 'numeric',
                    day: 'numeric',
                  })}
                </small>
              </span>
            </button>
          ))}
          {listLoading && <p className="wb-list-empty">보드 목록을 불러오는 중…</p>}
          {!listLoading && !boards.length && (
            <p className="wb-list-empty">{trash ? '휴지통이 비어 있습니다' : '첫 보드를 만들어 보세요'}</p>
          )}
        </div>
        <div className="wb-list-footer">
          <button
            type="button"
            className="wb-action"
            onClick={() => {
              setBoards([]);
              setListLoading(true);
              setTrash((value) => !value);
              select(null);
            }}
          >
            <BoardIcon name={trash ? 'folder' : 'trash'} />
            {trash ? '내 보드로' : '휴지통'}
          </button>
          <button
            type="button"
            className="wb-action"
            disabled={busy}
            onClick={() => importInput.current?.click()}
          >
            <BoardIcon name="upload" />
            보드 가져오기
          </button>
        </div>
      </aside>
      <div className="wb-content">
        <header className="wb-header">
          <div className="wb-heading-left">
            <TooltipButton
              className="wb-action wb-list-toggle"
              aria-label="보드 목록 열기/접기"
              title="보드 목록 열기/접기"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              <BoardIcon name="menu" />
            </TooltipButton>
            {session && save ? (
              <>
                <input
                  aria-label="보드 이름"
                  className="wb-name"
                  value={save.name}
                  maxLength={120}
                  disabled={isDeleted || busy}
                  onChange={(event) => session.rename(event.target.value)}
                  onBlur={() => session.rename(save.name.trim() || '새 보드')}
                />
                <span className={`wb-save-state wb-save-${save.status}`} role="status">
                  {isDeleted ? '휴지통에 있는 보드' : statusNames[save.status]}
                </span>
              </>
            ) : (
              <span className="wb-page-label">화이트보드</span>
            )}
          </div>
          <div className="wb-header-actions">
            {imagesBusy && (
              <button
                type="button"
                className="wb-action"
                onClick={() => {
                  imageOperation.current?.cancelImages();
                  setNotice('아직 추가하지 않은 이미지 처리를 취소했습니다');
                }}
              >
                이미지 처리 취소
              </button>
            )}
            {session && !isDeleted && (
              <>
                <TooltipButton
                  className="wb-action"
                  aria-label="메모 추가"
                  title="메모 추가 — 두 번 눌러 내용을 편집합니다"
                  onClick={() => editor.current?.addNote()}
                  disabled={busy}
                >
                  <BoardIcon name="note" />
                  <span>메모</span>
                </TooltipButton>
                <TooltipButton
                  className="wb-action"
                  title="이미지 추가"
                  onClick={() => imageInput.current?.click()}
                  disabled={busy}
                >
                  <BoardIcon name="image" />
                  <span>이미지 추가</span>
                </TooltipButton>
                <TooltipButton
                  className="wb-action"
                  title="보드 복제"
                  aria-label="보드 복제"
                  onClick={() => void duplicate()}
                  disabled={busy}
                >
                  <BoardIcon name="copy" />
                </TooltipButton>
                <button
                  type="button"
                  className="wb-action"
                  onClick={() => setExportOpen(true)}
                  disabled={busy}
                >
                  <BoardIcon name="download" />
                  <span>내보내기</span>
                </button>
              </>
            )}
            {session && (
              <TooltipButton
                className="wb-action"
                aria-label={isDeleted ? '보드 복원' : '보드 삭제'}
                title={isDeleted ? '보드 복원' : '휴지통으로 이동'}
                disabled={busy}
                onClick={() => void toggleTrash()}
              >
                <BoardIcon name={isDeleted ? 'restore' : 'trash'} />
              </TooltipButton>
            )}
            <button
              type="button"
              className="wb-action wb-primary"
              onClick={() => void makeBoard()}
              disabled={busy}
            >
              <BoardIcon name="plus" />새 보드
            </button>
          </div>
        </header>
        {(error || notice || save?.message || save?.localError) && (
          <div
            className={`wb-message ${error || save?.status === 'error' || save?.status === 'conflict' || save?.localError ? 'wb-message-error' : ''}`}
            role={error || save?.status === 'error' || save?.status === 'conflict' ? 'alert' : 'status'}
          >
            <span>{error || save?.message || notice}</span>
            {(error || save?.status === 'error') && (
              <button
                type="button"
                className="wb-action"
                onClick={() => {
                  if (session) void session.flush();
                  else {
                    setRetry((v) => v + 1);
                    void refresh();
                  }
                }}
              >
                다시 시도
              </button>
            )}
            {save?.status === 'conflict' && (
              <button type="button" className="wb-action" disabled={busy} onClick={() => void duplicate()}>
                내 편집을 새 보드로 저장
              </button>
            )}
            {save?.status === 'conflict' && (
              <button
                type="button"
                className="wb-action"
                disabled={busy}
                onClick={() => {
                  if (session) {
                    void action(async () => {
                      await session.fork(`${session.state.name.slice(0, 116)} 복구본`);
                      await discardBoardSession(session);
                      await refresh();
                      setNotice('내 편집을 별도 복구 보드에 보관했습니다');
                      setRetry((v) => v + 1);
                    });
                  }
                }}
              >
                초안 보관 후 최신본 열기
              </button>
            )}
            <button
              type="button"
              className="wb-action"
              aria-label="안내 닫기"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <BoardIcon name="close" />
            </button>
          </div>
        )}
        <div className="wb-editor-area">
          {loading ? (
            <div className="wb-empty">
              <span>보드를 불러오는 중…</span>
            </div>
          ) : session ? (
            isDeleted ? (
              <div className="wb-empty">
                <BoardIcon name="trash" size={32} />
                <h1>{session.state.name}</h1>
                <p>휴지통에 있는 보드입니다. 이미지와 메모는 보존되어 있습니다.</p>
                <button
                  type="button"
                  className="wb-action wb-primary"
                  onClick={() => void toggleTrash()}
                  disabled={busy}
                >
                  <BoardIcon name="restore" />
                  보드 복원
                </button>
              </div>
            ) : (
              <BoardEditorBoundary key={session.document.id} backup={() => exportBoardFile(session)}>
                <BoardEditor
                  key={session.document.id}
                  session={session}
                  onReady={(handle) => {
                    editor.current = handle;
                    const token = params.get('transfer');
                    if (handle && token) {
                      const transfer = takeChartTransfer(token);
                      setParams({ board: session.document.id, legacy: '1' }, { replace: true });
                      if (transfer)
                        void handle.addImages([transfer.blob], transfer.source).then(() => {
                          void session.persistDraft();
                          void session.flush();
                          setNotice('차트 이미지를 보드에 추가했습니다');
                        });
                      else setError('전달 중인 이미지를 찾지 못했습니다. 차트에서 다시 추가해 주세요');
                    }
                  }}
                  onError={setError}
                />
              </BoardEditorBoundary>
            )
          ) : (
            <div className="wb-empty">
              <BoardIcon name="board" size={36} />
              <h1>생각을 펼쳐 놓는 공간</h1>
              <p>차트 이미지를 붙이고, 메모와 화살표로 연결해 보세요.</p>
              <button
                type="button"
                className="wb-action wb-primary"
                onClick={() => void makeBoard()}
                disabled={busy}
              >
                <BoardIcon name="plus" />첫 보드 만들기
              </button>
              <button type="button" className="wb-action" onClick={() => importInput.current?.click()}>
                저장한 보드 가져오기
              </button>
            </div>
          )}
        </div>
        <footer className="wb-statusbar">
          <span>
            {session
              ? '드래그로 이동 · 두 번 눌러 텍스트 편집 · Ctrl+Z 실행 취소'
              : '이미지 · 메모 · 텍스트 · 도형'}
          </span>
          <span>
            {busy
              ? '처리 중…'
              : session
                ? `객체 ${session.elements.filter((el) => !el.isDeleted).length}개`
                : '화이트보드'}
          </span>
        </footer>
      </div>
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        aria-label="이미지 파일 선택"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void images(files);
        }}
      />
      <input
        ref={importInput}
        type="file"
        accept=".json,.whiteboard"
        hidden
        aria-label="보드 파일 선택"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file)
            void action(async () => {
              const doc = await importBoardFile(file);
              setTrash(false);
              if (doc.review) {
                if (session) { void session.persistDraft(); void session.flush(); }
                setParams({ board: doc.id });
              } else select(doc.id);
              await refresh();
              setNotice('보드를 새로 가져왔습니다');
            });
        }}
      />
      {exportOpen && session && (
        <ModalShell
          ariaLabel="보드 내보내기"
          title="보드 내보내기"
          width="w-[440px]"
          onClose={() => setExportOpen(false)}
        >
          <div className="wb-export-options">
            <p>이미지와 다시 편집할 수 있는 파일로 저장합니다.</p>
            <label>
              <input
                type="checkbox"
                checked={selectionOnly}
                onChange={(event) => setSelectionOnly(event.target.checked)}
              />
              PNG에 선택한 객체만 포함
            </label>
            <label>
              <input
                type="checkbox"
                checked={background}
                onChange={(event) => setBackground(event.target.checked)}
              />
              PNG에 배경 포함
            </label>
            <button type="button" className="wb-action wb-primary" disabled={busy} onClick={() => void png()}>
              <BoardIcon name="image" />
              PNG로 저장
            </button>
            <button
              type="button"
              className="wb-action"
              onClick={() => {
                exportBoardFile(session);
                setExportOpen(false);
              }}
            >
              <BoardIcon name="download" />
              편집 파일로 저장 (이미지 포함)
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
