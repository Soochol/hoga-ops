import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReviewNote, ReviewRecord } from '../api/whiteboards';
import type { BoardSession, SessionState } from './session';
import { BoardIcon } from './BoardIcon';
import { ModalShell } from '../ui/ModalShell';
import { noteViewKey, readPreference, writePreference, dateLabel } from './review';

interface ReaderView { expanded: string[]; scroll: number }
function RecordCodeInput({ value, onChange, onError }: { value: string; onChange: (value: string) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState(value);
  return <input aria-label="기록 종목 코드" value={draft} maxLength={6} inputMode="numeric" onChange={e => {
    if (/^\d{0,6}$/.test(e.target.value)) { setDraft(e.target.value); if (!e.target.value || e.target.value.length === 6) onChange(e.target.value); }
  }} onBlur={() => { if (draft && draft.length !== 6) onError('종목 코드는 6자리로 입력해 주세요. 완성된 코드만 저장합니다'); }} />;
}
export function ReviewDocument({ session, save, editing, server, onError, previous, next, onNavigate }: {
  session: BoardSession; save: SessionState; editing: boolean; server: string; onError: (message: string) => void;
  previous?: { id: string; date: string }; next?: { id: string; date: string }; onNavigate: (id: string) => void;
}) {
  const note = save.review!;
  const key = noteViewKey(server, session.document.id);
  const [view, setView] = useState<ReaderView>(() => {
    const stored = readPreference<ReaderView | null>(key, null);
    return stored && Array.isArray(stored.expanded) && typeof stored.scroll === 'number'
      ? stored : { expanded: note.records.slice(0, 1).map(r => r.id), scroll: 0 };
  });
  const [image, setImage] = useState<{ src: string; title: string } | null>(null);
  const [removed, setRemoved] = useState<{ record: ReviewRecord; index: number } | null>(null);
  const body = useRef<HTMLElement>(null);
  const currentView = useRef(view);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = currentView.current.scroll; }, []);
  useEffect(() => () => {
    clearTimeout(timer.current);
    writePreference(key, currentView.current);
    void session.persistDraft();
    void session.flush();
  }, [key, session]);
  function change(patch: Partial<ReviewNote>) { session.editReview({ ...session.state.review!, ...patch }); }
  function recordChange(id: string, patch: Partial<ReviewRecord>) {
    change({ records: session.state.review!.records.map(record => record.id === id ? { ...record, ...patch } : record) });
  }
  function expand(ids: string[]) {
    const next = { ...currentView.current, expanded: ids };
    currentView.current = next;
    setView(next);
    if (!writePreference(key, next)) onError('읽기 위치를 기억하지 못했습니다. 노트 내용은 별도로 자동 저장합니다');
  }
  const allOpen = note.records.length > 0 && note.records.every(r => view.expanded.includes(r.id));
  return <article className="rn-document" ref={body} data-testid="review-document" onScroll={() => {
    currentView.current = { ...currentView.current, scroll: body.current?.scrollTop ?? 0 };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => writePreference(key, currentView.current), 250);
  }}>
    <div className="rn-paper">
      <div className="rn-meta"><span>{dateLabel(note.date, true)}</span><span className="rn-state">{note.completed ? '복기 완료' : '작성 중'}</span></div>
      {editing ? <input className="rn-title-input" aria-label="하루 노트 제목" maxLength={120} value={save.name}
        onChange={e => session.rename(e.target.value)} onBlur={() => session.rename(session.state.name.trim() || `${note.date} 복기`)} />
        : <h1>{save.name}</h1>}
      <section className="rn-summary"><label htmlFor="review-summary">하루 결론</label>
        {editing ? <textarea id="review-summary" maxLength={10000} rows={2} value={note.summary} onChange={e => change({ summary: e.target.value })} placeholder="오늘 가장 크게 남은 생각 한 줄" />
          : <p>{note.summary || '아직 하루 결론을 작성하지 않았습니다'}</p>}</section>
      <section><div className="rn-section-heading"><h2>종목별 기록 <small>{note.records.length}</small></h2>
        <button type="button" className="rn-button" disabled={!note.records.length} onClick={() => expand(allOpen ? [] : note.records.map(r => r.id))}><BoardIcon name="menu" />{allOpen ? '전체 접기' : '전체 펼치기'}</button></div>
        {!note.records.length && <p className="rn-empty-records">차트/이미지 또는 기록을 추가해 보세요. 종목 없이 하루 생각만 남겨도 괜찮습니다.</p>}
        {note.records.map(record => {
          const src = record.image_file_id ? session.files[record.image_file_id]?.dataURL : undefined;
          const open = view.expanded.includes(record.id);
          return <section className="rn-record" key={record.id} data-testid={`review-record-${record.id}`}>
            <button type="button" className="rn-record-summary" aria-expanded={open} aria-controls={`record-${record.id}`} onClick={() => expand(open ? view.expanded.filter(id => id !== record.id) : [...view.expanded, record.id])}>
              {src ? <img className="rn-thumbnail" src={src} alt="" loading="lazy" /> : <span className="rn-thumbnail rn-thumbnail-empty"><BoardIcon name="note" /></span>}
              <span><strong>{record.stock || record.code || '관찰 기록'}</strong><small>{record.title || '제목 없는 기록'}</small></span>
              <span className={open ? 'rn-chevron open' : 'rn-chevron'}><BoardIcon name="chevron" /></span>
            </button>
            {open && <div id={`record-${record.id}`} className="rn-record-body">
              {src && <button type="button" className="rn-image-button" aria-label={`${record.stock || '기록'} 이미지 크게 보기`} onClick={() => setImage({ src, title: record.stock || '기록 이미지' })}><img src={src} alt={record.title || '복기 차트 이미지'} loading="lazy" /></button>}
              {(record.code || record.captured_at_ms) && <div className="rn-image-meta"><span>{[record.code, record.timeframe].filter(Boolean).join(' · ')}{record.captured_at_ms ? ` · 캡처 ${new Date(record.captured_at_ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST` : ''}</span>
                {record.code && <a href={`/live?code=${encodeURIComponent(record.code)}`} target="_blank" rel="noreferrer">종목 차트 열기</a>}</div>}
              {editing && <div className="rn-record-fields"><label>종목명<input aria-label="기록 종목명" value={record.stock} maxLength={120} onChange={e => recordChange(record.id, { stock: e.target.value })} /></label>
                <label>종목 코드<RecordCodeInput value={record.code} onChange={code => recordChange(record.id, { code })} onError={onError} /></label>
                <label className="rn-record-title-field">기록 제목<input value={record.title} maxLength={300} aria-label="기록 제목" onChange={e => recordChange(record.id, { title: e.target.value })} /></label></div>}
              <dl className="rn-record-copy">{(['judgment', 'action', 'result'] as const).map((field, index) => <div key={field}><dt>{['당시 판단', '행동', '결과'][index]}</dt><dd>{editing ? <textarea aria-label={['당시 판단', '행동', '결과'][index]} rows={2} maxLength={20000} value={record[field]} onChange={e => recordChange(record.id, { [field]: e.target.value })} /> : record[field] || '기록하지 않음'}</dd></div>)}</dl>
              {editing && <button type="button" className="rn-button" onClick={() => {
                const records = session.state.review!.records;
                setRemoved({ record, index: records.findIndex(r => r.id === record.id) });
                change({ records: records.filter(r => r.id !== record.id) });
              }}><BoardIcon name="trash" />기록 삭제</button>}
            </div>}
          </section>;
        })}
        {removed && editing && <div className="rn-inline-notice">기록을 삭제했습니다 <button type="button" className="rn-button" onClick={() => {
          const records = [...session.state.review!.records]; records.splice(removed.index, 0, removed.record);
          change({ records }); setRemoved(null);
        }}>삭제 취소</button></div>}
      </section>
      <section className="rn-reflection"><h2>하루 마무리</h2><div className="rn-reflection-grid">{(['good', 'change'] as const).map((field, i) => <div key={field}><label htmlFor={`review-${field}`}>{i ? '바꿀 행동' : '잘한 판단'}</label>
        {editing ? <textarea id={`review-${field}`} rows={3} maxLength={10000} value={note[field]} onChange={e => change({ [field]: e.target.value })} /> : <p>{note[field] || '아직 작성하지 않았습니다'}</p>}</div>)}</div></section>
      <section className="rn-principle"><label htmlFor="review-principle">다음에 적용할 원칙</label>{editing ? <textarea id="review-principle" rows={2} maxLength={10000} value={note.principle} onChange={e => change({ principle: e.target.value })} placeholder="다음에 바꿀 행동 한 가지" /> : <p>{note.principle || '아직 원칙을 작성하지 않았습니다'}</p>}</section>
      <footer className="rn-paper-footer"><div className="rn-bottom-navigation">
        <button type="button" className="rn-button" disabled={!previous} onClick={() => previous && onNavigate(previous.id)}><span className="rn-left-chevron"><BoardIcon name="chevron" /></span>{previous ? `${dateLabel(previous.date)} 기록` : '이전 기록 없음'}</button>
        <span>기록이 있는 날짜로 이동</span>
        <button type="button" className="rn-button" disabled={!next} onClick={() => next && onNavigate(next.id)}>{next ? `${dateLabel(next.date)} 기록` : '다음 기록 없음'}<BoardIcon name="chevron" /></button>
      </div>{editing ? '입력은 자동 저장됩니다. 복기 완료는 하루 정리를 마쳤다는 표시입니다.' : '기록된 이미지는 당시 화면입니다. 종목 차트 열기는 저장 기간을 복원하지 않습니다.'}</footer>
    </div>
    {image && <ModalShell ariaLabel="복기 이미지 크게 보기" title={image.title} width="w-[90vw]" onClose={() => setImage(null)}><img className="rn-large-image" src={image.src} alt={image.title} /></ModalShell>}
  </article>;
}
