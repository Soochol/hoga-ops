import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { BoardEditor, type BoardEditorHandle } from './BoardEditor';
import { BoardEditorBoundary } from './BoardEditorBoundary';
import type { BoardSession } from './session';
import { pageSkeleton, reviewCanvasPlan, reviewPages } from './reviewCanvas';
import { readPreference, writePreference } from './review';
import { boardId } from '../api/whiteboards';
import { TooltipButton } from '../ui/TextTooltip';
import { downloadBlob, safeFilename } from './files';
import './whiteboard.css';
import './reviewCanvas.css';

const tools = [
  ['selection', '선택'], ['text', '텍스트'], ['freedraw', '연필'], ['eraser', '지우개'],
  ['rectangle', '도형'], ['arrow', '화살표'],
] as const;
const colors = [['#1e1e1e', '기본색'], ['#2f9e44', '초록색'], ['#e03131', '빨간색'], ['#1971c2', '파란색']] as const;

export default function ReviewCanvas({ session, readOnly, onReady, onError }: {
  session: BoardSession; readOnly: boolean; onReady: (handle: BoardEditorHandle | null) => void; onError: (message: string) => void;
}) {
  const [initialElements] = useState(() => [...session.elements, ...convertToExcalidrawElements(
    reviewCanvasPlan(session.document.id, session.state.name, session.state.review!, session.document.scene, session.elements),
    { regenerateIds: false },
  )]);
  const [handle, setHandle] = useState<BoardEditorHandle | null>(null);
  const [properties, setProperties] = useState({ tool: 'selection', color: '#1e1e1e', width: 1 });
  const [pages, setPages] = useState(() => reviewPages(initialElements));
  const [activePage, setActivePage] = useState(() => readPreference<string>(session.key + ':page', '') || reviewPages(initialElements)[0]?.id || '');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const callbacks = useRef({ onReady, onError });
  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);
  const ready = useCallback((value: BoardEditorHandle | null) => { setHandle(value); callbacks.current.onReady(value); }, []);

  useEffect(() => {
    if (!handle) return;
    return handle.api.onChange((elements, state) => {
      setProperties(previous => previous.tool === state.activeTool.type && previous.color === state.currentItemStrokeColor && previous.width === state.currentItemStrokeWidth
        ? previous : { tool: state.activeTool.type, color: state.currentItemStrokeColor, width: state.currentItemStrokeWidth });
      const next = reviewPages(elements);
      setPages(previous => previous.length === next.length && previous.every((p, i) => p.id === next[i].id && p.name === next[i].name) ? previous : next);
    });
  }, [handle]);

  function tool(type: typeof tools[number][0]) { handle?.api.setActiveTool({ type }); }
  function style(patch: Pick<Partial<AppState>, 'currentItemStrokeColor' | 'currentItemStrokeWidth'>) {
    if (!handle || readOnly) return;
    const api = handle.api, ids = api.getAppState().selectedElementIds;
    const selected = api.getSceneElementsIncludingDeleted().map(element => ids[element.id] && !element.locked
      ? newElementWith(element, { ...(patch.currentItemStrokeColor ? { strokeColor: patch.currentItemStrokeColor } : {}),
        ...(patch.currentItemStrokeWidth ? { strokeWidth: patch.currentItemStrokeWidth } : {}) }) : element);
    api.updateScene({ appState: { ...api.getAppState(), ...patch }, elements: selected, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function openPage(id: string, api: ExcalidrawImperativeAPI | undefined = handle?.api) {
    const target = api?.getSceneElements().find(el => el.id === id);
    if (!target || !api) return;
    setActivePage(id); writePreference(session.key + ':page', id);
    const state = api.getAppState(), zoom = Math.min(0.85, Math.max(0.3, (state.width - 80) / target.width));
    api.updateScene({ appState: { selectedElementIds: {}, scrollX: -target.x + 40 / zoom, scrollY: -target.y + 60 / zoom,
      zoom: { value: zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  function addPage() {
    if (!handle) return;
    const elements = handle.api.getSceneElementsIncludingDeleted();
    const x = Math.max(0, ...elements.filter(el => !el.isDeleted).map(el => el.x + el.width)) + 100;
    const id = boardId(), newPage = convertToExcalidrawElements([pageSkeleton(id, x, `페이지 ${pages.length + 1}`)], { regenerateIds: false });
    handle.api.updateScene({ elements: [...elements, ...newPage], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    openPage(id);
  }
  async function png() {
    if (!handle) return;
    try {
      const { exportToBlob } = await import('@excalidraw/excalidraw');
      const blob = await exportToBlob({ elements: handle.api.getSceneElements(), files: handle.api.getFiles(),
        appState: { ...handle.api.getAppState(), exportBackground: true, viewBackgroundColor: '#ffffff' }, mimeType: 'image/png' });
      downloadBlob(blob, safeFilename(session.state.name) + '.png');
    } catch (error) { callbacks.current.onError(error instanceof Error ? error.message : '이미지를 내보내지 못했습니다'); }
  }
  return <div className="rn-canvas" data-testid="review-canvas" data-active-tool={properties.tool}>
    {!readOnly && <div className="rn-canvas-tools" role="toolbar" aria-label="캔버스 편집 도구">
      <div className="rn-canvas-tool-group">{tools.map(([type, label]) => <button type="button" key={type} className="rn-button" aria-pressed={properties.tool === type} disabled={!handle} onClick={() => tool(type)}>{label}</button>)}
        <button type="button" className="rn-button" disabled={!handle} onClick={() => handle?.addNote()}>메모 추가</button>
      </div>
      <div className="rn-canvas-tool-group"><label className="rn-pen-width">굵기<select aria-label="선 굵기" value={properties.width} disabled={!handle} onChange={event => style({ currentItemStrokeWidth: Number(event.target.value) })}>
        <option value={1}>가는 선</option><option value={2}>보통</option><option value={4}>굵은 선</option>
      </select></label><div className="rn-pen-colors" aria-label="선 색상">{colors.map(([color, label]) => <TooltipButton key={color} title={`${label} 선`} className="rn-pen-color" style={{ backgroundColor: color }} aria-label={`${label} 선`} aria-pressed={properties.color === color} disabled={!handle} onClick={() => style({ currentItemStrokeColor: color })} />)}
        <label className="rn-custom-color">직접 선택<input type="color" aria-label="직접 선택할 선 색상" value={properties.color} onChange={event => style({ currentItemStrokeColor: event.target.value })} /></label></div>
        <button type="button" className="rn-button" disabled={!handle} aria-expanded={templatesOpen} onClick={() => setTemplatesOpen(value => !value)}>템플릿</button>
      </div>
    </div>}
    {templatesOpen && !readOnly && <div className="rn-canvas-templates" aria-label="복기 템플릿">{['하루 결론', '잘한 판단', '바꿀 행동', '다음에 적용할 원칙'].map(label =>
      <button type="button" key={label} className="rn-button" onClick={() => { handle?.addNote(`${label}\n\n자유롭게 적어보세요`); setTemplatesOpen(false); }}>{label} 추가</button>)}<button type="button" className="rn-button" onClick={() => { addPage(); setTemplatesOpen(false); }}>빈 페이지 추가</button></div>}
    <div className="rn-canvas-heading"><input aria-label="하루 노트 제목" maxLength={120} value={session.state.name} readOnly={readOnly}
      onChange={event => session.rename(event.target.value)} onBlur={() => session.rename(session.state.name.trim() || `${session.state.review!.date} 복기`)} /><span>{session.state.review!.completed ? '복기 완료' : '작성 중'}</span></div>
    <div className="wb-editor-area rn-canvas-area"><BoardEditorBoundary key={session.document.id} backup={() => { void import('./files').then(file => file.exportBoardFile(session)); }}>
      <BoardEditor session={session} initialElements={initialElements} viewOnly={readOnly} freehandEraser fitOnFirstOpen onReady={ready} onError={onError} />
    </BoardEditorBoundary></div>
    <footer className="rn-canvas-footer"><div className="rn-canvas-pages" aria-label="노트 페이지">{pages.map((p, i) => <button type="button" key={p.id} className="rn-button" aria-pressed={p.id === activePage} onClick={() => openPage(p.id)}>{p.name || `페이지 ${i + 1}`}</button>)}
      {!readOnly && <button type="button" className="rn-button" disabled={!handle} onClick={addPage}>+ 페이지</button>}</div><span>{readOnly ? '읽기 모드 · 이동과 확대 가능' : properties.tool === 'freedraw' ? '연필로 자유롭게 그리기 · Ctrl/⌘ Z로 실행 취소' : properties.tool === 'eraser' ? '문질러서 지우기 · Ctrl/⌘ Z로 복원' : '끌어서 배치 · 더블클릭으로 글 수정'}</span>
      <button type="button" className="rn-button" disabled={!handle} onClick={() => handle?.api.scrollToContent(undefined, { fitToContent: true })}>전체 보기</button>
      <button type="button" className="rn-button" disabled={!handle} onClick={() => void png()}>PNG 내보내기</button></footer>
  </div>;
}
