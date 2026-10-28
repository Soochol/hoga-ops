import { Fragment, useMemo, useRef, useState } from 'react';
import { useTradingAccounts, type TradingAccount } from '../../api/trading';
import { useExecutionHistory, type ExecutionHistoryRow } from '../../api/executionHistory';
import { useSymbols } from '../../capture/useSymbols';
import { useKstDay } from '../../util/useKstDay';
import { useWorkspaceStore, windowSymbolOf, type WorkspaceWindow, type ExecutionWindowConfig } from '../../state/workspace';
import './ExecutionHistoryWindow.css';
const accountDisplayLabel = (label: string) => label.replace(' · 실전 ·', ' ·');

const numberText = (v: string | null) => v !== null && v.trim() !== '' && Number.isFinite(Number(v))
  ? Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : '';
const clock = (v: string | null) => v && Number.isFinite(Date.parse(v))
  ? new Date(v).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' }) : '';

export function ExecutionHistoryWindow({ win }: { win: WorkspaceWindow }) {
  const windows = useWorkspaceStore(s => s.windows);
  const groupSymbols = useWorkspaceStore(s => s.groupSymbols);
  const setConfig = useWorkspaceStore(s => s.setExecutionWindowConfig);
  const accounts = useTradingAccounts('live');
  const date = useKstDay();
  const config = win.executionHistory ?? {};
  const source = windows.find(w => w.id === config.sourceOrderId && w.kind === 'order');
  const accountId = source ? source.orderAccount : config.account;
  const account = accounts.data?.accounts.find(a => a.account_seq === accountId);
  const symbol = source ? windowSymbolOf({ groupSymbols }, source) : config.symbol ?? null;
  const bind = (id: string) => {
    const order = windows.find(w => w.id === id && w.kind === 'order');
    setConfig(win.id, { ...config, sourceOrderId: id, account: order?.orderAccount,
      symbol: order ? windowSymbolOf({ groupSymbols }, order) ?? undefined : undefined });
  };
  return <div className="execution-history-window" data-testid="execution-history-window">
    <div className="execution-history-account"><span>{account ? accountDisplayLabel(account.label) : accounts.isLoading ? '계좌 확인 중…' : '선택 계좌 없음'}</span>
      <span className="text-fg-dim">{account?.environment === 'mock' ? '모의 · ' : ''}전체 거래소</span></div>
    <div className="execution-history-source"><label>연결 호가주문 <select aria-label="체결내역 연결 호가주문" value={source?.id ?? ''} onChange={e => bind(e.target.value)}>
      <option value="">{config.sourceOrderId ? '연결 종료 · 마지막 계좌 유지' : '호가주문 선택'}</option>
      {windows.filter(w => w.kind === 'order').map((w, i) => <option value={w.id} key={w.id}>{i + 1} · {windowSymbolOf({ groupSymbols }, w)?.name ?? '종목 없음'}</option>)}
    </select></label></div>
    {accounts.isError ? <p role="alert" className="execution-history-message text-error">계좌 조회 실패 · <button type="button" onClick={() => void accounts.refetch()}>다시 조회</button></p>
      : accounts.isLoading ? <p role="status" className="execution-history-message">계좌 불러오는 중…</p>
        : !account ? <p role="status" className="execution-history-message">{accountId ? '선택 계좌의 연결을 확인하세요.' : '호가주문창에서 계좌를 선택하고 내 체결을 여세요.'}</p>
          : typeof account.account_seq !== 'string' ? <p role="alert" className="execution-history-message">현재 연결은 내 체결내역 조회를 지원하지 않습니다. 계좌 연결을 새로 확인하세요.</p>
          : <AccountExecutions key={`${account.account_seq}:${date}`} account={account} date={date} config={config}
            code={symbol?.code ?? null} name={symbol?.name ?? null} onConfig={next => setConfig(win.id, next)} />}
  </div>;
}

function AccountExecutions({ account, date, config, code, name, onConfig }: {
  account: TradingAccount; date: string; config: ExecutionWindowConfig; code: string | null; name: string | null;
  onConfig: (config: ExecutionWindowConfig) => void;
}) {
  const { first, older, rows, paused, hasMore, loadMore } = useExecutionHistory(account.account_seq, date);
  const { data: symbols } = useSymbols();
  const names = useMemo(() => new Map(symbols?.symbols.map(s => [s.code, s.name]) ?? []), [symbols]);
  const scroll = useRef<HTMLDivElement>(null);
  const [frozen, setFrozen] = useState<ExecutionHistoryRow[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const side = config.side ?? 'ALL';
  const retained = frozen ? new Map(frozen.map(row => [row.order_ref, row])) : null;
  if (retained) for (const page of older.data?.pages ?? []) for (const row of page.rows) {
    if (!retained.has(row.order_ref)) retained.set(row.order_ref, row);
  }
  const displayed = retained ? [...retained.values()] : rows;
  const filtered = displayed.filter(row => (side === 'ALL' || row.side === side) && (!config.currentSymbolOnly || (!!code && row.code === code)));
  const changes = frozen ? (first.data?.rows ?? []).filter(row => {
    const before = frozen.find(old => old.order_ref === row.order_ref);
    return !before || before.quantity !== row.quantity || before.price !== row.price || before.amount !== row.amount;
  }).length : 0;
  const latest = () => { setFrozen(null); scroll.current?.scrollTo?.({ top: 0 }); };
  const updateFilter = (next: Partial<ExecutionWindowConfig>) => { latest(); onConfig({ ...config, ...next }); };
  return <>
    <div className="execution-history-controls"><div role="group" aria-label="내 체결 매매 구분">{(['ALL', 'BUY', 'SELL'] as const).map(value => <button type="button" key={value}
      aria-pressed={side === value} onClick={() => updateFilter({ side: value })}>{value === 'ALL' ? '전체' : value === 'BUY' ? '매수' : '매도'}</button>)}</div>
      <label><input type="checkbox" checked={config.currentSymbolOnly ?? false} onChange={e => updateFilter({ currentSymbolOnly: e.target.checked })} />현재 종목만</label>
      <span className="execution-history-date">오늘 · {date.slice(4, 6)}.{date.slice(6)}</span>
      <button type="button" disabled={first.isFetching || paused} onClick={() => void first.refetch()}>새로고침</button></div>
    <div className="execution-history-count"><span>{config.currentSymbolOnly ? name ?? '종목 없음' : '계좌 전체'} · {filtered.length}건</span><span>주문별 체결 누계</span></div>
    {changes > 0 && <button className="execution-history-update" type="button" onClick={latest}>새 체결·갱신 {changes}건 확인</button>}
    {first.isError && <p className="execution-history-message text-error" role="alert">체결내역 조회 실패{rows.length ? ' · 수신된 내역 표시 중' : ''}</p>}
    {first.isPending && <p className="execution-history-message" role="status">체결내역 불러오는 중…</p>}
    <div className="execution-history-scroll" ref={scroll} role="region" aria-label="내 체결내역 목록"
      onScroll={e => { if (e.currentTarget.scrollTop > 6 && !frozen) setFrozen(rows); else if (e.currentTarget.scrollTop === 0 && frozen) setFrozen(null); }}>
      <table className="execution-history-table"><thead><tr><th>체결시각</th><th>종목</th><th>구분</th><th>체결수량</th><th>체결가</th><th>체결금액</th></tr></thead><tbody>{filtered.map(row => <Fragment key={row.order_ref}>
        <tr data-execution-order={row.order_ref}><td className="font-data">{clock(row.filled_at)}</td>
          <td><button type="button" className="execution-history-symbol" aria-expanded={expanded === row.order_ref} onClick={() => setExpanded(expanded === row.order_ref ? null : row.order_ref)}>{row.name || names.get(row.code) || row.code}<small>{row.code}</small></button></td>
          <td className={row.side === 'BUY' ? 'text-price-up' : 'text-price-down'}>{row.side === 'BUY' ? '매수' : '매도'}</td>
          <td className="font-data">{numberText(row.quantity)}주</td><td className="font-data">{numberText(row.price)}</td><td className="font-data">{numberText(row.amount)}</td></tr>
        {expanded === row.order_ref && <tr className="execution-history-details"><td colSpan={6}><dl>
          <div><dt>주문번호</dt><dd className="select-text">{row.broker_order_id}</dd></div><div><dt>주문수량</dt><dd>{numberText(row.order_quantity)}주</dd></div>
          <div><dt>주문시각</dt><dd>{clock(row.ordered_at)}</dd></div><div><dt>주문 경로</dt><dd>{row.route}</dd></div>
          <div><dt>가격 기준</dt><dd>{row.price_basis === 'average' ? '평균체결가' : '증권사 체결단가'}</dd></div></dl></td></tr>}
      </Fragment>)}</tbody></table>
      {!first.isPending && !first.isError && !filtered.length && <p className="execution-history-message" role="status">{config.currentSymbolOnly && !code ? '연결된 호가주문의 종목을 확인하세요.' : hasMore ? '현재 조회분에 체결내역 없음 · 이전 내역을 추가로 조회하세요.' : '조회 조건에 맞는 체결내역 없음'}</p>}
      {older.isError && <p className="execution-history-message text-error" role="alert">이전 체결내역 조회 실패 · 다시 조회할 수 있습니다.</p>}
      {hasMore && <div className="execution-history-more"><button type="button" disabled={older.isFetching || paused} onClick={loadMore}>{older.isFetching ? '이전 내역 불러오는 중…' : '이전 내역 더 보기'}</button></div>}
    </div>
    <div className="execution-history-footer"><span>{paused ? '주문 처리 중 · 조회 대기' : first.data?.events_connected ? '실시간 연결' : '주기 조회 중'}</span>
      <span>{first.data ? `${clock(new Date(first.data.fetched_at_ms).toISOString())} 기준` : ''}</span></div>
  </>;
}
