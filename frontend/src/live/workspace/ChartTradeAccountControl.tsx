import { useTradingAccounts } from '../../api/trading';
import { useChartTradeAccounts } from '../../state/chartTradeAccounts';
import { useWindowSettingsStore } from '../../state/windowSettings';
import './ChartTradeAccountControl.css';

export function ChartTradeAccountControl({ windowId }: { windowId: string }) {
  const enabled = useWindowSettingsStore(s => s.byWindow[windowId]?.chart?.accountExecutionsEnabled ?? false);
  return enabled ? <AccountSelect windowId={windowId} /> : null;
}

function AccountSelect({ windowId }: { windowId: string }) {
  const accounts = useTradingAccounts('live');
  const selected = useChartTradeAccounts(s => s.byWindow[windowId] ?? '');
  const known = accounts.data?.accounts.some(a => a.account_seq === selected);
  return <div className="chart-trade-account" onPointerDown={event => event.stopPropagation()}>
    <label><span>매매 계좌</span><select aria-label="매매 계좌" value={selected}
      onChange={event => useChartTradeAccounts.getState().select(windowId, event.target.value)}>
      <option value="">{accounts.isLoading ? '계좌 조회 중…' : '계좌 선택'}</option>
      {selected && !known && <option value={selected}>선택 계좌 연결 확인</option>}
      {accounts.data?.accounts.filter(a => typeof a.account_seq === 'string').map(a =>
        <option key={a.account_seq} value={a.account_seq}>{a.label}</option>)}
    </select></label>
    {accounts.isError && <span role="status">계좌 조회 실패 <button type="button" onClick={() => void accounts.refetch()}>다시 조회</button></span>}
    {accounts.data && accounts.data.accounts.length === 0 && <span role="status">연결된 계좌 없음</span>}
  </div>;
}
