import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TradeSpotResponse } from '../../api/tradeSpot';
import type { ApiError } from '../../api/client';
import { useTradeBrowsePages } from '../../api/tradeBrowse';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { useTradeBrowseStore, type TradeBrowseSession } from '../tradeBrowse';
import { tradeSpotScope } from '../tradeSpotScope';
import { useTradeHighlight } from '../tradeHighlight';
import TradeTickTable from '../../sidebar/TradeTickTable';
import { unixMsToKSTClock } from '../../util/time';

export function TradeBrowseContent({ code, session, initial }: {
  code: string; session: TradeBrowseSession; initial: TradeSpotResponse | undefined;
}) {
  const query = useTradeBrowsePages(code, session.seed, session.sourcePref, session.minAmountManwon, initial);
  const highlight = useTradeHighlight();
  const scroll = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const pages = query.data?.pages ?? [];
  const first = pages[0]?.data;
  const aggregate = first?.representation === 'second_price_aggregate';
  const current = tradeSpotScope(session.cursorMs, session.origin, code, session.origin.group ?? undefined, session.seed.venue) ?? session.seed;
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap(page => page.data.rows.flatMap(row => {
      const key = `${page.scope.date}:${page.data.source}:${row.event_id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, tMs: row.t_ms, price: row.price, qty: row.qty, side: row.side, count: row.count, scope: page.scope }];
    }));
  }, [query.data]);
  const scopes = useMemo(() => new Map(rows.map(row => [row.key, row.scope])), [rows]);
  const [rowHeight, setRowHeight] = useState(24);
  const [headerHeight, setHeaderHeight] = useState(24);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight, overscan: 8, paddingStart: headerHeight,
    getItemKey: index => rows[index].key });
  const items = virtual.getVirtualItems();
  useLayoutEffect(() => {
    const root = scroll.current;
    const row = root?.querySelector('[data-tape-event]');
    const header = root?.querySelector('[role="columnheader"]')?.parentElement;
    if (row) setRowHeight(row.getBoundingClientRect().height || 24);
    if (header) setHeaderHeight(header.getBoundingClientRect().height || 24);
  }, [rows.length, items[0]?.key]);
  useEffect(() => { virtual.measure(); }, [rowHeight, headerHeight, virtual]);
  const gesture = useRef(false);
  const hasScrolled = useRef(session.browsing);
  hasScrolled.current ||= session.browsing;

  const publishReadingPosition = useCallback(() => {
    const root = scroll.current;
    if (!root || !hasScrolled.current) return;
    const top = root.getBoundingClientRect().top;
    const header = root.querySelector('[role="columnheader"]')?.parentElement?.getBoundingClientRect().height ?? 0;
    const firstVisible = [...root.querySelectorAll<HTMLElement>('[data-tape-event]')]
      .find(row => row.getBoundingClientRect().top >= top + header - 0.5);
    const scope = firstVisible?.dataset.tapeEvent ? scopes.get(firstVisible.dataset.tapeEvent) : null;
    if (scope) useTradeBrowseStore.getState().move(session.ownerId, scope);
  }, [scopes, session.ownerId]);

  const loadMore = useCallback(async () => {
    if (loading.current || query.isFetching || !query.hasNextPage || query.isError) return;
    loading.current = true;
    try { await query.fetchNextPage({ cancelRefetch: false }); }
    finally { loading.current = false; }
  }, [query.isFetching, query.hasNextPage, query.isError, query.fetchNextPage]);
  const startReading = () => {
    if (!hasScrolled.current) {
      hasScrolled.current = true;
      useTradeBrowseStore.getState().move(session.ownerId, current);
    }
  };
  const onScroll = () => {
    if (!hasScrolled.current && !gesture.current) return;
    startReading();
    publishReadingPosition();
    const root = scroll.current;
    if (root && root.scrollHeight - root.clientHeight - root.scrollTop < 80) void loadMore();
  };
  useEffect(() => {
    // Appending below does not change scrollTop or the existing row identity.
    publishReadingPosition();
  }, [rows, items[0]?.index, publishReadingPosition]);
  const reset = () => {
    if (scroll.current) scroll.current.scrollTop = 0;
    useTradeBrowseStore.getState().move(session.ownerId, session.seed);
    void query.restart();
  };
  const error = query.error as ApiError | null;
  return <div data-testid="trade-window" data-mode={session.browsing ? 'browse' : 'spot'}
    data-reading-ms={current.fromMs} data-loaded-count={rows.length} className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div className="flex shrink-0 items-start justify-between gap-1 px-2.5 py-1 text-xs text-fg-dim">
      <div role="status">
        <div>{session.browsing ? '체결 탐색' : '선택 봉'} · {current.date} · {unixMsToKSTClock(current.fromMs)} · {current.timeframe} · {current.venue}</div>
        {first?.source && <div>{aggregate ? 'WS · 1초 집계' : 'hogaplay · 원본 체결'} · 실제 체결가</div>}
        {first?.storage_error && <div>WS 저장 상태 확인 필요 · 관측한 데이터 표시</div>}
        {aggregate && (session.minAmountManwon > 0 || highlight !== null) && <div>개별 체결금액 필터·대량 체결 강조 일시 중지</div>}
      </div>
      <button type="button" className="ui-choice shrink-0" onClick={() => {
        useLiveCursorStore.getState().resetCursorFrom(session.origin.windowId);
        useTradeBrowseStore.getState().end(session.ownerId);
      }}>최신으로</button>
    </div>
    <div ref={scroll} aria-label="체결 탐색 목록" className="min-h-0 flex-1 overflow-auto" style={{ overflowAnchor: 'none' }} onScroll={onScroll} tabIndex={0}
      onPointerDown={() => { gesture.current = true; }}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
          gesture.current = true;
          startReading();
        }
      }}
      onWheel={event => {
        startReading();
        const root = scroll.current;
        if (event.deltaY > 0 && root && root.scrollHeight - root.clientHeight - root.scrollTop < 80) void loadMore();
      }}>
      <TradeTickTable view={{ ticks: rows, prevClose: first?.prev_close ?? null }} aggregate={aggregate}
        highlight={aggregate ? null : highlight}
        windowing={{ start: items[0]?.index ?? 0, end: items.length ? items[items.length - 1].index + 1 : 0,
          before: Math.max(0, (items[0]?.start ?? headerHeight) - headerHeight),
          after: Math.max(0, virtual.getTotalSize() - (items.at(-1)?.end ?? headerHeight)) }} emptyText={query.isPending ? '선택 봉 체결 조회 중…'
          : first?.status === 'insufficient_resolution' ? '10초 집계만 저장되어 이 봉의 체결을 조회할 수 없습니다'
            : first?.status === 'unavailable' ? '저장된 상세 체결 데이터 없음' : '선택 구간의 관측 체결 없음'} />
    </div>
    {query.isFetching && <div role="status" className="px-2.5 py-1 text-xs text-fg-dim">이전 체결 불러오는 중…</div>}
      {query.isError && <div role="alert" className="px-2.5 py-1 text-xs text-fg-dim">
        <span>{error?.status === 409 ? '체결 데이터가 변경되었습니다' : '이전 체결 조회 실패'}</span>
        <button type="button" className="ui-choice ml-1" onClick={() => {
          if (error?.status === 409) reset();
          else void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch());
        }}>{error?.status === 409 ? '처음부터 다시 조회' : '다시 조회'}</button>
      </div>}
      {first?.source && !query.hasNextPage && !query.isPending && !query.isError && <div className="px-2.5 py-1 text-xs text-fg-dim">해당 거래일의 처음입니다</div>}
  </div>;
}
