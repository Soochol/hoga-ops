import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useExecutionHistory } from '../../api/executionHistory';
import { oneYearAgo, useExecutionHistoryRange } from '../../api/executionHistoryRange';
import { useSymbols } from '../../capture/useSymbols';
import { useWorkspaceStore, windowSymbolOf } from '../../state/workspace';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { useKstDay } from '../../util/useKstDay';
import { unixMsToKSTClock } from '../../util/time';
import { recentTradedSymbols, recentTradedSymbolsForRange } from './recentTradedSymbols';

const dayText = (date: string) => `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6)}`;

export function ChartRecentTrades({ windowId, account }: { windowId: string; account: string | null }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dismiss = useCallback(() => setOpen(false), []);
  const closeAndFocus = useCallback(() => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  }, []);
  return <>
    <button ref={anchor} className="chart-recent-trades-trigger" type="button" disabled={!account}
      title={account ? '선택 계좌의 최근 1년 체결 종목' : '매매 계좌를 먼저 선택하세요.'}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={() => setOpen(value => !value)}>최근 매매 <span aria-hidden="true">▾</span></button>
    {open && account && createPortal(<RecentTradeList id={id} anchor={anchor} windowId={windowId}
      account={account} onDismiss={dismiss} onSelect={closeAndFocus} />, document.body)}
  </>;
}

function navigateRows(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-recent-code]:not(:disabled)')];
  if (!rows.length) return;
  event.preventDefault(); event.stopPropagation();
  const current = rows.findIndex(row => row === document.activeElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
    : event.key === 'ArrowDown' ? (current + 1) % rows.length : (current <= 0 ? rows.length : current) - 1;
  rows[index].focus();
}

function RecentTradeList({ id, anchor, windowId, account, onDismiss, onSelect }: {
  id: string; anchor: RefObject<HTMLButtonElement | null>; windowId: string; account: string;
  onDismiss: () => void; onSelect: () => void;
}) {
  const date = useKstDay();
  const { first, older, rows, hasMore, loadMore, paused } = useExecutionHistory(account, date);
  const from = oneYearAgo(date);
  const history = useExecutionHistoryRange(account, from, date, !paused);
  const historyPages = history.data?.pages;
  const scanning = history.isPending || history.hasNextPage;
  const { data: symbols } = useSymbols();
  const names = useMemo(() => new Map((symbols?.symbols ?? []).map(s => [s.code, s.name])), [symbols]);
  const recent = useMemo(() => recentTradedSymbolsForRange([
    ...recentTradedSymbols(rows, date).map(item => ({ code: item.code, name: item.name, date,
      filled_at: item.filledAt === null ? null : new Date(item.filledAt).toISOString() })),
    ...(historyPages ?? []).flatMap(page => page.rows),
  ], from, date), [rows, date, from, historyPages]);
  const currentCode = useWorkspaceStore(state => windowSymbolOf(state, state.windows.find(w => w.id === windowId))?.code);
  const pinned = useWorkspaceStore(state => !!state.windows.find(w => w.id === windowId)?.pinned);
  // Measure in the query owner so arriving rows/pagination also re-clamp the portal.
  const { ref, style } = useAnchoredPopover(true, anchor, onDismiss, 288);
  useLayoutEffect(() => {
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
  }, [ref]);
  const select = (code: string, name: string) => {
    const state = useWorkspaceStore.getState();
    const win = state.windows.find(w => w.id === windowId);
    if (!win || win.pinned) return;
    state.setWindowSymbol(windowId, { kind: 'stock', code, name });
    state.focusWindow(windowId);
    onSelect();
  };
  return <div ref={ref} id={id} style={style} tabIndex={-1}
    className="chart-recent-trades-popover" role="dialog" aria-label="최근 매매 종목"
    onPointerDown={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onSelect(); }
      else navigateRows(e);
    }}>
    <header><strong>최근 매매 종목</strong><span>최근 1년 · 최신 체결순</span></header>
    <div className="chart-recent-trades-period"><span>{dayText(from)} ~ {dayText(date)}</span>
      <button type="button" disabled={paused || history.isFetching} onClick={() => void history.restart()}>새로 조회</button></div>
    {pinned && <p role="status">종목 고정을 해제하면 선택할 수 있습니다.</p>}
    {paused && <p role="status">주문 처리 중 · 조회 대기</p>}
    {first.isPending && !paused && <p role="status">체결내역 불러오는 중…</p>}
    {first.isError && <p role="alert">체결내역 조회 실패 <button type="button" disabled={paused || first.isFetching}
      onClick={() => void first.refetch()}>다시 조회</button></p>}
    {scanning && !history.isError && !paused && <p role="status">과거 내역 조회 중… {historyPages?.at(-1)?.scanned_through
      ? `· ${dayText(historyPages.at(-1)!.scanned_through!)}` : ''}</p>}
    {history.isError && <p role="alert">과거 내역 조회 실패 · 확인된 종목만 표시 중 <button type="button" disabled={paused}
      onClick={() => void history.retryPage()}>다시 조회</button></p>}
    <div className="chart-recent-trades-list">
      {recent.map(item => {
        const name = item.name || names.get(item.code) || item.code;
        return <button key={item.code} type="button" data-recent-code={item.code} disabled={pinned}
          aria-pressed={currentCode === item.code} onClick={() => select(item.code, name)}>
          <span className="chart-recent-trades-name"><span>{name}</span><small>{item.code}</small></span>
          <time dateTime={item.filledAt === null ? undefined : new Date(item.filledAt).toISOString()}>
            <span>{dayText(item.date)}</span>
            <span>{item.filledAt === null ? '' : unixMsToKSTClock(item.filledAt).slice(0, 5)}</span></time>
        </button>;
      })}
      {!first.isPending && !first.isError && !history.isError && !scanning && !recent.length && <p role="status">
        {hasMore ? '현재 조회분에 체결 종목 없음' : '최근 1년 조회 범위에 체결 종목이 없습니다.'}</p>}
    </div>
    {older.isError && <p role="alert">이전 체결내역 조회 실패 · 다시 조회하세요.</p>}
    {hasMore && <footer><span>조회된 내역 기준</span><button type="button" disabled={older.isFetching || paused}
      onClick={loadMore}>{older.isFetching ? '불러오는 중…' : '더 조회'}</button></footer>}
    {!hasMore && !scanning && !history.isError && <footer><span>증권사 제공 내역 기준</span></footer>}
  </div>;
}
