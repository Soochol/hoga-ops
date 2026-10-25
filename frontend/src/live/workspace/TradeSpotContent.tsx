import { useEffect } from 'react';
import { useTradeSpot } from '../../api/tradeSpot';
import TradeTickTable from '../../sidebar/TradeTickTable';
import { unixMsToKSTClock } from '../../util/time';
import { useTradeHighlight } from '../tradeHighlight';
import type { TradeSpotScope } from '../tradeSpotScope';
import { useOrderflowSourcePref } from '../../state/sourcePreference';
import { useTradeBrowseStore, type TradeBrowseSession } from '../tradeBrowse';
import { TradeBrowseContent } from './TradeBrowseContent';

export function TradeSpotContent({ code, scope, minAmountManwon, session, onHandoffReady }: {
  code: string; scope: TradeSpotScope; minAmountManwon: number;
  session?: TradeBrowseSession | null; onHandoffReady?: (pref: string) => void;
}) {
  const query = useTradeSpot(code, scope, minAmountManwon, !session);
  const pref = useOrderflowSourcePref();
  useEffect(() => {
    if (pref !== undefined) onHandoffReady?.(pref);
    if (session && (pref !== session.sourcePref || minAmountManwon !== session.minAmountManwon)) {
      useTradeBrowseStore.getState().end(session.ownerId);
    }
  }, [pref, session?.sourcePref, session?.ownerId, session?.minAmountManwon, minAmountManwon, onHandoffReady]);
  const highlight = useTradeHighlight();
  if (session) return <TradeBrowseContent code={code} session={session} initial={query.data} />;
  const data = query.data;
  const aggregate = data?.representation === 'second_price_aggregate';
  const empty = query.isPending ? '선택 봉 체결 조회 중…' : query.isError ? '선택 봉 체결 조회 실패'
    : data?.status === 'insufficient_resolution' ? '10초 집계만 저장되어 이 봉의 체결을 조회할 수 없습니다'
      : data?.status === 'unavailable' ? '저장된 상세 체결 데이터 없음'
        : minAmountManwon > 0 && !aggregate ? '선택 구간에 조건을 만족하는 체결 없음' : '선택 구간의 관측 체결 없음';
  const dateLabel = `${scope.date.slice(4, 6)}/${scope.date.slice(6)}`;
  return <div data-testid="trade-window" data-mode="spot" className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div className="px-2.5 py-1 text-xs text-fg-dim" role="status">
      <div>{dateLabel} · {unixMsToKSTClock(scope.fromMs)}–{unixMsToKSTClock(scope.toMs)} · {scope.venue}</div>
      {data?.source && <div>{data.source === 'hogaplay' ? 'hogaplay · 원본 체결' : 'WS · 1초 집계'} · 실제 체결가</div>}
      {aggregate && (minAmountManwon > 0 || highlight !== null) && <div>개별 체결금액 필터·대량 체결 강조 일시 중지</div>}
      {data?.storage_error && <div>WS 저장 상태 확인 필요 · 관측한 데이터 표시</div>}
    </div>
    <div aria-label="선택 봉 체결 목록" className="min-h-0 flex-1 overflow-auto">
      <TradeTickTable key={`${scope.fromMs}:${scope.toMs}:${data?.representation}`} view={{
        ticks: !query.isError ? (data?.rows ?? []).map(row => ({ key: row.event_id, tMs: row.t_ms, price: row.price,
          qty: row.qty, side: row.side, count: row.count })) : [], prevClose: data?.prev_close ?? null,
      }} highlight={aggregate ? null : highlight} aggregate={aggregate} emptyText={empty} />
      {data?.has_more && <div className="px-2.5 py-1 text-xs text-fg-dim">선택 봉의 최근 200행 표시 · 추가 내역 있음</div>}
      {query.isError && <button className="ui-choice m-1" type="button" onClick={() => { void query.refetch(); }}>다시 조회</button>}
    </div>
  </div>;
}
