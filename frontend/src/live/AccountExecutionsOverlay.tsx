import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import { useTradingAccounts } from '../api/trading';
import { useAccountExecutions, type AccountExecution } from '../api/accountExecutions';
import type { RangeBundle } from '../api/types';
import { AccountExecutionsPrimitive } from '../chart/AccountExecutionsPrimitive';
import { projectAccountExecutions } from '../chart/projectors/accountExecutions';
import { candlePosition } from '../chart/candlePosition';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useChartTradeAccounts } from '../state/chartTradeAccounts';
import { useActivePrefs } from '../state/chartPrefs';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { VirtualAxis } from '../util/virtualAxis';
import { useWindowScopeId } from './workspace/windowView';
import { realMsToYyyymmdd, todayKstYyyymmdd } from './liveDateTime';
import type { AdjustFactors } from './scaleRangeBundlePrices';
import type { LiveVenueOption } from '../state/liveVenue';
import './workspace/ChartTradeAccountControl.css';

type Props = { chart: IChartApi; bundle: RangeBundle; axis: VirtualAxis; paneSeries: PaneSeriesMap;
  timeframe: LiveTimeframe; code: string; factors?: AdjustFactors; venue: LiveVenueOption };

function AccountExecutionsOverlay(props: Props) {
  const enabled = useActivePrefs(p => p.accountExecutionsEnabled);
  const windowId = useWindowScopeId();
  const account = useChartTradeAccounts(s => windowId ? s.byWindow[windowId] ?? '' : '');
  return enabled && account && /^[A-Za-z0-9]{6}$/.test(props.code)
    && (props.timeframe === 'D' || isMinuteTimeframe(props.timeframe))
    ? <ExecutionLayer key={`${account}:${props.code}:${props.timeframe}:${props.venue}`} {...props} account={account} /> : null;
}

function ExecutionLayer({ chart, bundle, axis, paneSeries, timeframe, code, factors, venue, account }: Props & { account: string }) {
  const accounts = useTradingAccounts('live');
  const known = accounts.data?.accounts.some(a => a.account_seq === account) ?? false;
  const [dates, setDates] = useState<readonly string[]>([]);
  const [detail, setDetail] = useState<readonly AccountExecution[] | null>(null);
  const series = paneSeries.get('candle');
  const primitive = useRef<AccountExecutionsPrimitive | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const range = chart.timeScale().getVisibleRange();
      const first = range && typeof range.from === 'number' ? range.from : -Infinity;
      const last = range && typeof range.to === 'number' ? range.to : Infinity;
      const source = range ? bundle.candles : bundle.candles.slice(-60);
      const next = [...new Set(source.filter(c => {
        const p = candlePosition(c, axis);
        return p.contained && p.virtual / 1000 >= first && p.virtual / 1000 <= last;
      }).map(c => realMsToYyyymmdd(c.ts_ms)))].filter(date => date <= todayKstYyyymmdd()).sort().reverse();
      setDates(prev => prev.join(',') === next.join(',') ? prev : next);
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { update(); setDetail(null); }, 200); };
    update(); chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    return () => { clearTimeout(timer); chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule); };
  }, [chart, bundle.candles, axis]);
  const query = useAccountExecutions(account, code, dates, known && !!series, venue);
  const projection = useMemo(() => projectAccountExecutions(query.rows, bundle.candles, axis, timeframe,
    factors, query.rawCloses, todayKstYyyymmdd()), [query.rows, bundle.candles, axis, timeframe, factors, query.rawCloses]);
  useEffect(() => {
    if (!series) return;
    const next = new AccountExecutionsPrimitive();
    series.attachPrimitive(next); primitive.current = next;
    return () => { primitive.current = null; try { series.detachPrimitive(next); } catch { /* Chart already disposed. */ } };
  }, [series]);
  useEffect(() => { primitive.current?.setMarkers(known ? projection.markers : []); }, [series, known, projection.markers]);
  useEffect(() => {
    if (!series) return;
    const element = series.getPane().getHTMLElement();
    if (!element) return;
    let down: { x: number; y: number } | null = null;
    const start = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const click = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - series.getPane().priceScale('left').width();
      const hit = primitive.current?.detailAt(x, event.clientY - rect.top);
      if (hit) setDetail([...hit.barExecutions].sort((a, b) => a.t_ms - b.t_ms));
    };
    element.addEventListener('pointerdown', start); element.addEventListener('pointerup', click);
    return () => { element.removeEventListener('pointerdown', start); element.removeEventListener('pointerup', click); };
  }, [series]);
  const missing = [...projection.unmatched, ...projection.unscaled];
  const detailRows = detail?.map(row => query.rows.find(latest => latest.execution_id === row.execution_id) ?? row);
  const orderAverage = detailRows?.some(row => row.basis === 'order_average');
  const status = !known ? accounts.isLoading ? '매매 계좌 확인 중…' : '선택한 매매 계좌의 연결을 확인하세요.'
    : dates.length === 0 ? '보이는 캔들 범위 확인 중…'
      : query.error ? '체결 조회 실패 · 확인된 내역만 표시'
      : query.message ?? (query.loading || query.pending ? `매매내역 조회 중 · ${query.rows.length}건 확인`
        : query.more ? '매매내역 일부 조회됨' : query.rows.length === 0 ? '조회된 매매내역 없음'
          : missing.length ? `현재 봉·가격 기준에 대응하지 않는 체결 ${missing.length}건` : null);
  return <>
    {status && <div className="account-execution-notice" role="status" data-testid="account-execution-status">{status}
      {query.error && <button type="button" onClick={query.retry}>다시 조회</button>}
      {query.more && !query.loading && <button type="button" onClick={query.loadMore}>더 조회</button>}
      {missing.length > 0 && <button type="button" onClick={() => setDetail(missing)}>미표시 체결 내역</button>}
    </div>}
    {detail && <section className="account-execution-detail" aria-label="이 봉의 매매내역" onPointerDown={e => e.stopPropagation()}>
      <header><span>매매내역 · {accounts.data?.accounts.find(a => a.account_seq === account)?.label}</span>
        <button type="button" aria-label="매매내역 닫기" onClick={() => setDetail(null)}>닫기</button></header>
      <table>
        {orderAverage && <caption>주문 평균가 기준 · 마지막 체결 시각에 표시합니다.</caption>}
        <thead><tr><th>{orderAverage ? '마지막 체결 시각' : '체결 시각'}</th><th>구분</th>
          <th>{orderAverage ? '평균 체결가' : '실제 체결가'}</th><th>{orderAverage ? '총 체결 수량' : '수량'}</th><th>시장</th></tr></thead>
        <tbody>{detailRows?.map(row => <tr key={row.execution_id}><td>{new Date(row.t_ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}</td>
          <td className={row.side === 'BUY' ? 'text-price-up' : 'text-price-down'}>{row.side === 'BUY' ? 'B 매수' : 'S 매도'}</td>
          <td>{Number(row.price).toLocaleString('ko-KR', { maximumFractionDigits: 20 })}원</td><td>{Number(row.quantity).toLocaleString('ko-KR')}주</td><td>{row.venue ?? '미확인'}</td></tr>)}</tbody></table>
    </section>}
  </>;
}

export default memo(AccountExecutionsOverlay);
