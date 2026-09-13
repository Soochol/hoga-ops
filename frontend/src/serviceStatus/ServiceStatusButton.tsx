import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveStatus, type LiveStatus } from '../api/liveStatus';
import StatusDot from '../nav/StatusDot';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { STATUS_STALE_MS } from '../api/liveness';
import { useAnchoredPopover } from '../util/useAnchoredPopover';
import { useServiceStatusPanel } from './controls';
import { clearedIssues, CONNECTION_COPY, issueReport, serviceIssues, type ClearedIssue, type ServiceIssue } from './model';

function stamp(ms: number) {
  return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function Issue({ issue, clearedAt, expanded }: { issue: ServiceIssue; clearedAt?: number; expanded: boolean }) {
  const [copy, setCopy] = useState<'idle' | 'done' | 'fallback'>('idle');
  const report = issueReport(issue);
  const copyReport = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(report);
      setCopy('done');
    } catch { setCopy('fallback'); }
  };
  return <article className="border-b border-border px-lg py-md">
    <div className="flex items-start justify-between gap-sm">
      <strong className="text-base text-fg">{issue.title}</strong>
      <span className={`shrink-0 text-xs ${clearedAt ? 'text-fg-dim' : issue.tone === 'error' ? 'text-error' : 'text-warn'}`}>
        {clearedAt ? '관측 해제' : '확인 필요'}
      </span>
    </div>
    <p className="mt-2 text-sm text-fg-dim">{issue.cause}</p>
    <p className="mt-1 text-sm text-fg-dim">{issue.action}</p>
    <p className="mt-2 text-xs text-fg-dim">{issue.at ? `마지막 실패 ${stamp(issue.at)}` : '상태 조회에서 확인'}{clearedAt ? ` · 관측 해제 ${stamp(clearedAt)}` : ''}</p>
    <details className="mt-3 text-sm" open={expanded || undefined}>
      <summary className="w-fit cursor-pointer text-fg-dim">상세 보기</summary>
      <div className="mt-2 rounded bg-bg-subtle p-md text-fg-dim">
        {issue.operation && <p>API · {issue.operation}</p>}
        {issue.code && <p>오류 코드 · {issue.code}</p>}
        <p className="mt-1 text-xs">{issue.source === 'provider'
          ? '공급사의 최근 관측 기록입니다. 다른 계정·종목의 조회 상태와 다를 수 있습니다. 재조회 전에는 현재 복구 여부를 알 수 없습니다.'
          : '상태 서버에서 확인한 운영 정보입니다.'}</p>
        <button type="button" onClick={() => { void copyReport(); }} className="mt-2 rounded border border-border-strong px-2 py-1 text-xs text-fg hover:bg-bg-input-hover">
          {copy === 'done' ? '복사됨' : '진단 복사'}
        </button>
        {copy === 'fallback' && <textarea aria-label="복사할 진단" readOnly value={report} onFocus={(event) => event.target.select()}
          className="mt-2 h-28 w-full rounded border border-border bg-bg-input p-2 text-xs text-fg" />}
      </div>
    </details>
  </article>;
}

export function ServiceStatusButton() {
  const { data, isError, dataUpdatedAt } = useLiveStatus();
  const eventLive = useConnectionLiveness(STATUS_STALE_MS, 5000);
  const { open, operation, show, close } = useServiceStatusPanel();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dismiss = useCallback(() => { close(); trigger.current?.focus({ preventScroll: true }); }, [close]);
  const { ref, style } = useAnchoredPopover<HTMLElement>(open, trigger, dismiss, 380);
  const [view, setView] = useState<'current' | 'cleared'>('current');
  const [observed, setObserved] = useState<{ data?: LiveStatus; issues: ServiceIssue[]; history: ClearedIssue[] }>({ issues: [], history: [] });
  // Store transitions, not another copy of live availability. Failed polls cannot clear history.
  if (data && data !== observed.data && !isError) {
    const next = serviceIssues(data);
    const cleared = clearedIssues(observed.issues, next, data, dataUpdatedAt);
    const ids = new Set([...next, ...cleared].map((issue) => issue.id));
    setObserved({ data, issues: next, history: [...cleared, ...observed.history.filter((issue) => !ids.has(issue.id))].slice(0, 20) });
  }
  const issues = isError ? observed.issues : serviceIssues(data);
  const provider = data?.provider_status;
  const count = issues.length + (isError ? 1 : 0);
  const notice = provider?.notice;
  const selectedView = operation ? 'current' : view;
  return <>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={`서비스 상태${count ? ` · 문제 ${count}건` : ''}`}
      onClick={() => { if (open) dismiss(); else { setView('current'); show(); } }}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-border px-2 py-1 text-sm font-semibold text-fg-dim hover:bg-bg-input-hover hover:text-fg">
      <StatusDot />
      상태 {count > 0 && <span className="rounded bg-tint-warn px-1 text-xs text-warn">{count}</span>}
      {!count && notice && <span className="text-xs text-warn">공지</span>}
    </button>
    {open && createPortal(<section ref={ref} id={id} role="dialog" aria-label="서비스 상태" style={{ ...style, maxHeight: 'min(640px, calc(100dvh - 64px))' }}
      className="overflow-y-auto rounded-lg border border-border-strong bg-bg-card text-fg shadow-overlay">
      <header className="flex items-center justify-between px-lg pb-2 pt-md"><strong className="text-md">서비스 상태</strong>
        <button type="button" aria-label="서비스 상태 닫기" onClick={dismiss} className="rounded px-2 py-1 text-lg text-fg-dim hover:bg-bg-input-hover">×</button>
      </header>
      <div className="flex gap-lg border-b border-border px-lg pb-2">
        {(['current', 'cleared'] as const).map((tab) => <button key={tab} type="button" aria-pressed={selectedView === tab}
          onClick={() => { show(); setView(tab); }} className={`border-b px-0 py-1 text-sm ${selectedView === tab ? 'border-warn text-fg' : 'border-transparent text-fg-dim'}`}>
          {tab === 'current' ? `현재 문제 ${count}` : `최근 해제 ${observed.history.length}`}
        </button>)}
      </div>
      {isError && <div role="status" className="border-b border-border px-lg py-md text-sm text-warn">상태 서버 연결 실패 · 이전 정보입니다. 현재 상태와 복구 여부를 확인할 수 없습니다.</div>}
      {selectedView === 'current' ? <>
        {!data && !isError && <p className="px-lg py-lg text-sm text-fg-dim">상태 확인 중</p>}
        {data && !isError && !count && <p className="px-lg py-lg text-center text-sm text-fg-dim">{provider ? '현재 확인된 문제가 없습니다' : '공급사 상태 정보가 없습니다'}</p>}
        {operation && <p className="px-lg pt-md text-xs text-fg-dim">선택한 데이터의 관련 API: {operation} · 아래는 공급사 전체 관측입니다.</p>}
        {issues.map((issue) => <Issue key={issue.id} issue={issue} expanded={issue.operation === operation} />)}
      </> : <>
        <p className="px-lg pt-md text-xs text-fg-dim">이 탭에서 확인한 최근 20건입니다. 관측 해제는 전체 API의 복구를 보장하지 않습니다.</p>
        {!observed.history.length && <p className="px-lg py-lg text-center text-sm text-fg-dim">최근 해제된 기록이 없습니다</p>}
        {observed.history.map((issue) => <Issue key={issue.id} issue={issue} clearedAt={issue.clearedAt} expanded={false} />)}
      </>}
      {notice && <div className="border-b border-border px-lg py-md text-sm">
        <strong>{provider.notice_phase === 'scheduled' ? '키움 점검 예정' : provider.notice_phase === 'active' ? '키움 점검 시간' : '키움 점검 종료 예정 시각 경과'}</strong>
        <p className="mt-1 text-fg-dim">{stamp(notice.starts_at_ms)}–{stamp(notice.ends_at_ms)} KST 예정</p>
        <p className="mt-1 text-fg-dim">{notice.reason}</p>
        <details className="mt-2 text-xs text-fg-dim"><summary className="cursor-pointer">공지 출처</summary><p>{notice.source}</p><p>종료 시간과 영향 범위는 공지에 따릅니다. 전체 API의 장애 또는 복구를 뜻하지 않습니다.</p></details>
      </div>}
      <div className="px-lg py-md text-sm"><p className="mb-2 text-xs text-fg-dim">연결 상태</p>
        <div className="flex justify-between gap-sm"><span>상태 서버</span><span className="text-fg-dim">{isError ? '확인 불가' : data ? '응답 확인' : '확인 중'}</span></div>
        <div className="mt-2 flex justify-between gap-sm"><span>앱 이벤트 연결</span><span className="text-fg-dim">{eventLive ? '수신 확인' : '재연결 중'}</span></div>
        <div className="mt-2 flex justify-between gap-sm"><span>키움 실시간</span><span className="text-fg-dim">{isError ? '확인 불가' : provider ? CONNECTION_COPY[provider.connection] : '정보 없음'}</span></div>
        {provider && <p className="mt-1 text-right text-xs text-fg-dim">{isError ? '이전 정보 · ' : ''}연결 {provider.connected_accounts}/{provider.configured_accounts}계정</p>}
      </div>
      <footer className="bg-bg-subtle px-lg py-2 text-xs text-fg-dim">{dataUpdatedAt > 0 ? `마지막 상태 응답 ${stamp(dataUpdatedAt)}` : '상태 응답 대기 중'} · 휴장 대기는 오류에 포함되지 않습니다.</footer>
    </section>, document.body)}
  </>;
}
