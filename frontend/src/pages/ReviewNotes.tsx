import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiUrl } from '../api/client';
import { listBoards, openDailyNote, readBoard, type WhiteboardSummary } from '../api/whiteboards';
import { discardBoardSession, openBoardSession, subscribeBoardSaves, type BoardSession } from '../whiteboard/session';
import { BoardIcon } from '../whiteboard/BoardIcon';
import { ReviewDocument } from '../whiteboard/ReviewDocument';
import { DISPLAY_KEY, dateLabel, initialDisplay, readPreference, sortedNotes, todayKst, writePreference, type ListDisplay } from '../whiteboard/review';
import type { BoardEditorHandle } from '../whiteboard/BoardEditor';
import { takeChartTransfer } from '../whiteboard/chartTransfer';
import { TooltipButton } from '../ui/TextTooltip';
import { useDismissablePopover } from '../util/useDismissablePopover';
import '../whiteboard/review.css';

const ReviewCanvas = lazy(() => import('../whiteboard/ReviewCanvas'));
const LegacyWhiteboard = lazy(() => import('./LegacyWhiteboard'));
const noSubscribe = () => () => {};
const noSnapshot = () => null;
const statuses = { saved: '저장됨', dirty: '변경됨', saving: '저장 중…', error: '저장 실패', conflict: '다른 창의 변경과 충돌' };

export default function ReviewNotes() {
  const [params, setParams] = useSearchParams();
  const id = params.get('board'), date = params.get('date'), transfer = params.get('transfer');
  const legacy = params.get('legacy') === '1', editing = params.get('mode') !== 'read', sourceView = params.get('source') === '1';
  const [boards, setBoards] = useState<WhiteboardSummary[]>([]);
  const [server, setServer] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadedSession, setSession] = useState<BoardSession | null>(null);
  const session = !legacy && loadedSession?.document.id === id ? loadedSession : null;
  const [display, setDisplay] = useState<ListDisplay>(initialDisplay);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<BoardEditorHandle | null>(null);
  const editorReady = useCallback((handle: BoardEditorHandle | null) => setEditor(handle), []);
  const displayRef = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const requestNumber = useRef(0);
  const current = useRef(session);
  useLayoutEffect(() => { current.current = session; }, [session]);
  const save = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? noSnapshot);
  const closeDisplay = useCallback(() => setDisplayOpen(false), []);
  useDismissablePopover(displayOpen, displayRef, closeDisplay);
  const refresh = useCallback(async () => {
    const request = ++requestNumber.current;
    try {
      const [result, origin] = await Promise.all([listBoards(trash), apiUrl('/api/whiteboards')]);
      if (request !== requestNumber.current) return;
      setBoards(result.boards); setServer(origin);
      if (result.unreadable_ids.length) setError(`${result.unreadable_ids.length}개 문서를 읽지 못했습니다. 원본 파일은 보존되어 있습니다`);
    } catch (e) { if (request === requestNumber.current) setError(e instanceof Error ? e.message : '노트 목록을 불러오지 못했습니다'); }
    finally { if (request === requestNumber.current) setListLoading(false); }
  }, [trash]);
  useEffect(() => { void refresh(); return subscribeBoardSaves(() => { void refresh(); }); }, [refresh]);
  useEffect(() => { const focus = () => { void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh]);
  const navigate = useCallback((next: string | null, edit = false, targetDate?: string) => {
    if (current.current) { void current.current.persistDraft(); void current.current.flush(); }
    const nextParams = new URLSearchParams();
    if (next) { nextParams.set('board', next); if (server) writePreference(`ticklane.review.last.v1:${server}`, next); }
    if (targetDate) nextParams.set('date', targetDate);
    if (edit) nextParams.set('mode', 'edit');
    setParams(nextParams);
  }, [server, setParams]);
  useEffect(() => {
    if (legacy || id || date || listLoading || !server) return;
    const last = readPreference<string>(`ticklane.review.last.v1:${server}`, '');
    const notes = sortedNotes(boards), target = notes.find(b => b.id === last) ?? notes[0];
    if (target) setParams({ board: target.id }, { replace: true });
  }, [legacy, id, date, listLoading, boards, server, setParams]);
  useEffect(() => {
    let active = true;
    setSession(null); setLoading(Boolean(id) && !legacy); setError('');
    if (id && !legacy) void readBoard(id).then(openBoardSession).then(value => {
      if (active) { setSession(value); setLoading(false); }
    }).catch(e => { if (active) { setError(e instanceof Error ? e.message : '노트를 열지 못했습니다'); setLoading(false); } });
    return () => { active = false; };
  }, [id, legacy, retry]);
  useEffect(() => {
    if (!session || !transfer || !session.state.review || !editor || editor.documentId !== session.document.id || sourceView) return;
    const chart = takeChartTransfer(transfer);
    setParams(previous => { const next = new URLSearchParams(previous); if (next.get('transfer') === transfer) next.delete('transfer'); return next; }, { replace: true });
    if (!chart) { setError('전달 중인 이미지를 찾지 못했습니다. 차트에서 다시 추가해 주세요'); return; }
    setNotice('차트 이미지를 추가하는 중…');
    void editor.addImages([chart.blob], chart.source).then(() => {
      const note = session.state.review!;
      session.editReview({ ...note, completed: false, stocks: [...new Set([...note.stocks, chart.source.code])] });
      void session.persistDraft(); void session.flush();
      if (current.current === session) setNotice('차트를 캔버스에 추가했습니다');
    }).catch(e => { if (current.current === session) setError(e instanceof Error ? e.message : '차트 추가에 실패했습니다'); });
  }, [session, transfer, editor, sourceView, setParams]);
  async function action(fn: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '작업에 실패했습니다'); }
    finally { setBusy(false); }
  }
  function daily(targetDate = todayKst()) {
    void action(async () => { const document = await openDailyNote(targetDate); setTrash(false); navigate(document.id, true); await refresh(); });
  }
  async function addImages(files: File[]) {
    if (!session || !editor || editor.documentId !== session.document.id) return;
    const target = session;
    await action(async () => {
      await editor.addImages(files);
      await target.persistDraft();
      if (current.current === target) setNotice('이미지를 캔버스에 추가했습니다');
    });
  }
  const notes = sortedNotes(boards), index = notes.findIndex(b => b.id === id);
  const previous = index >= 0 ? notes[index + 1] : undefined, next = index > 0 ? notes[index - 1] : undefined;
  const shown = notes.filter(b => `${b.name} ${b.review!.stocks.join(' ')} ${b.review!.summary} ${b.review!.date}`.toLowerCase().includes(query.toLowerCase()));
  const selectedDate = save?.review?.date ?? date ?? todayKst();
  const deleted = Boolean(session?.document.deleted_at_ms);
  if (legacy || (id && session?.document.id === id && !save?.review)) return <div className="rn-legacy"><div className="rn-legacy-bar"><Link to="/whiteboard">← 복기 노트 목록</Link><span>기존 자유 배치 보드</span></div><Suspense fallback={<p>보드를 불러오는 중…</p>}><LegacyWhiteboard /></Suspense></div>;
  function move(target?: WhiteboardSummary) { if (target) navigate(target.id); }
  return <section className={`review-page${collapsed ? ' rn-list-collapsed' : ''}`} aria-label="복기 노트">
    <aside className="rn-library" data-list-display={display} aria-label="날짜별 노트 목록">
      <div className="rn-library-heading"><span><BoardIcon name="note" />내 복기 노트</span><div ref={displayRef} className="rn-display-wrap" onKeyDown={e => { if (e.key === 'Escape') { setDisplayOpen(false); displayButton.current?.focus(); } }}>
        <TooltipButton ref={displayButton} className="rn-button rn-icon" aria-label="목록 표시 방식" title="목록 표시 방식" aria-expanded={displayOpen} aria-controls="review-display-options" onClick={() => setDisplayOpen(v => !v)}><BoardIcon name="menu" /></TooltipButton>
        {displayOpen && <div className="rn-display-options" id="review-display-options" role="group" aria-label="목록 표시 방식 선택">{(['compact', 'detail'] as const).map(option => <button key={option} type="button" aria-pressed={display === option} onClick={() => {
          setDisplay(option); setDisplayOpen(false); displayButton.current?.focus();
          if (!writePreference(DISPLAY_KEY, option)) setError('표시 옵션을 저장하지 못했습니다. 브라우저 저장소 설정을 확인해 주세요');
        }}><BoardIcon name={option === 'compact' ? 'menu' : 'note'} /><span><strong>{option === 'compact' ? '간단히' : '자세히'}</strong><small>{option === 'compact' ? '날짜 · 제목 · 상태' : '종목 · 하루 결론까지'}</small></span>{display === option && <BoardIcon name="check" />}</button>)}</div>}
      </div></div>
      <button type="button" className="rn-button rn-primary rn-today" disabled={busy} onClick={() => daily()}><BoardIcon name="note" />오늘 작성</button>
      <input type="search" className="rn-search" placeholder="제목·종목 찾기" aria-label="노트 검색" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="rn-date-picker"><label htmlFor="review-open-date">날짜로 이동</label><div className="rn-date-control">
        <input ref={dateInput} id="review-open-date" type="date" aria-label="열어볼 날짜" value={selectedDate} onChange={e => {
          if (!e.target.value) return;
          const found = notes.find(b => b.review!.date === e.target.value);
          if (found) navigate(found.id); else navigate(null, false, e.target.value);
        }} />
        <TooltipButton className="rn-date-button" aria-label="날짜 선택 달력 열기" title="날짜 선택" onClick={() => {
          dateInput.current?.focus();
          try { dateInput.current?.showPicker(); } catch { /* Keep keyboard entry available in embedded browsers without a picker. */ }
        }}><BoardIcon name="calendar" /></TooltipButton>
      </div></div>
      <div className="rn-date-list">{listLoading && <p>목록을 불러오는 중…</p>}{shown.map((board, i) => <div key={board.id}>
        {(i === 0 || shown[i - 1].review!.date.slice(0, 7) !== board.review!.date.slice(0, 7)) && <h3>{board.review!.date.slice(0, 4)}년 {Number(board.review!.date.slice(5, 7))}월</h3>}
          <button type="button" disabled={busy} data-testid={`review-row-${board.id}`} className={`rn-date-row${board.id === id ? ' selected' : ''}`} aria-current={board.id === id ? 'page' : undefined} onClick={() => navigate(board.id)}>
          <span className="rn-row-top"><strong>{board.review!.date === todayKst() ? '오늘' : dateLabel(board.review!.date)}</strong><small>{board.review!.completed ? '완료' : '작성 중'}</small></span>
          <strong className="rn-row-title">{board.name}</strong><small className="rn-row-stocks">{board.review!.stocks.join(' · ') || '관찰 기록'}</small><small className="rn-row-summary">{board.review!.summary || '하루 결론 미작성'}</small>
        </button></div>)}{!listLoading && !shown.length && <p className="rn-list-empty">{query ? '검색한 노트가 없습니다' : trash ? '휴지통이 비어 있습니다' : '아직 작성한 노트가 없습니다'}</p>}</div>
      <div className="rn-library-footer"><button type="button" className="rn-button" disabled={busy} onClick={() => { setTrash(!trash); setListLoading(true); navigate(null, false, todayKst()); }}><BoardIcon name={trash ? 'folder' : 'trash'} />{trash ? '내 노트로' : '휴지통'}</button><Link to="/whiteboard?legacy=1" className="rn-button"><BoardIcon name="board" />기존 보드</Link></div>
    </aside>
    <div className="rn-main">
      <header className="rn-toolbar"><div className="rn-navigation"><TooltipButton className="rn-button rn-icon" title="날짜 목록 열기/접기" aria-label="날짜 목록 열기/접기" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}><BoardIcon name="menu" /></TooltipButton>
        <button type="button" className="rn-button rn-prev" disabled={!previous || busy} onClick={() => move(previous)}><span className="rn-left-chevron"><BoardIcon name="chevron" /></span>이전 기록</button>
        <span>{dateLabel(selectedDate)}</span><button type="button" className="rn-button rn-next" disabled={!next || busy} onClick={() => move(next)}>다음 기록<BoardIcon name="chevron" /></button></div>
        {session && save?.review && <div className="rn-toolbar-actions"><span role="status" className={`rn-save rn-save-${save.status}`}>{statuses[save.status]}</span>
          {!deleted && <><button type="button" className="rn-button" onClick={() => setParams(p => { const nextParams = new URLSearchParams(p); nextParams.set('mode', editing ? 'read' : 'edit'); nextParams.delete('source'); return nextParams; })}>{editing ? '읽기로 전환' : '수정'}</button>
            {editing && !sourceView && <button type="button" className="rn-button" disabled={busy || !editor} onClick={() => input.current?.click()}><BoardIcon name="image" />차트/이미지 추가</button>}
            {editing && <button type="button" className="rn-button rn-primary" disabled={busy} onClick={() => { session.editReview({ ...session.state.review!, completed: true }); void session.persistDraft(); void session.flush(); setParams({ board: session.document.id, mode: 'read' }); }}><BoardIcon name="check" />복기 완료</button>}</>}
          {(save.review.summary || save.review.good || save.review.change || save.review.principle || save.review.records.length > 0) && <button type="button" className="rn-button" onClick={() => setParams(p => { const nextParams = new URLSearchParams(p); if (sourceView) nextParams.delete('source'); else nextParams.set('source', '1'); return nextParams; })}>{sourceView ? '캔버스로 돌아가기' : '기존 기록 원문'}</button>}
          <details className="rn-more"><summary aria-label="노트 더보기">더보기</summary><div>
            <button type="button" className="rn-button" disabled={busy} onClick={() => void action(async () => { const file = await import('../whiteboard/files'); file.exportBoardFile(session); })}><BoardIcon name="download" />편집 파일 내보내기</button>
            <button type="button" className="rn-button" disabled={busy} onClick={() => void action(async () => { await session.trash(!deleted); if (current.current === session) navigate(null, false, selectedDate); await refresh(); })}><BoardIcon name={deleted ? 'restore' : 'trash'} />{deleted ? '노트 복원' : '휴지통으로 이동'}</button>
          </div></details>
        </div>}
      </header>
      {(error || notice || save?.message) && <div className="rn-message" role={error || save?.status === 'error' || save?.status === 'conflict' ? 'alert' : 'status'}><span>{error || save?.message || notice}</span>
        {(error || save?.status === 'error') && <button type="button" className="rn-button" onClick={() => { setError(''); if (session) void session.flush(); else setRetry(v => v + 1); void refresh(); }}>다시 시도</button>}
        {save?.status === 'conflict' && <><button type="button" className="rn-button" disabled={busy} onClick={() => void action(async () => { const fork = await session!.fork(`${session!.state.name.slice(0, 115)} 복구본`); navigate(fork.id, true); await refresh(); })}>내 편집을 별도 노트로 저장</button>
          <button type="button" className="rn-button" disabled={busy} onClick={() => void action(async () => { await session!.fork(`${session!.state.name.slice(0, 115)} 복구본`); await discardBoardSession(session!); setRetry(v => v + 1); await refresh(); })}>초안 보관 후 최신본 열기</button></>}
        <button type="button" className="rn-button" aria-label="안내 닫기" onClick={() => { setError(''); setNotice(''); }}><BoardIcon name="close" /></button></div>}
      {loading || listLoading ? <div className="rn-empty">노트를 불러오는 중…</div> : session && save?.review ? deleted ? <div className="rn-empty"><h1>휴지통에 있는 노트입니다</h1><p>더보기에서 복원할 수 있습니다. 내용과 이미지는 보존되어 있습니다.</p></div> : sourceView ? <ReviewDocument key={session.document.id} session={session} save={save} editing={false} server={server} onError={setError}
        previous={previous ? { id: previous.id, date: previous.review!.date } : undefined} next={next ? { id: next.id, date: next.review!.date } : undefined} onNavigate={navigate} />
        : <Suspense fallback={<div className="rn-empty">캔버스를 불러오는 중…</div>}><ReviewCanvas key={session.document.id} session={session} readOnly={!editing} onReady={editorReady} onError={setError} /></Suspense>
        : <div className="rn-empty"><BoardIcon name="note" size={32} /><h1>{date ? '아직 작성한 노트가 없습니다' : '하루의 판단을 기록해 보세요'}</h1><p>{date ? dateLabel(date, true) : '차트와 짧은 메모를 모으고, 하루 끝에 다음 원칙을 정리하세요.'}</p><button type="button" className="rn-button rn-primary" disabled={busy} onClick={() => daily(date ?? todayKst())}>{date ? '이 날짜에 작성하기' : '오늘 작성하기'}</button></div>}
    </div>
    <input type="file" ref={input} hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="복기 이미지 파일 선택" onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void addImages(files); }} />
  </section>;
}
