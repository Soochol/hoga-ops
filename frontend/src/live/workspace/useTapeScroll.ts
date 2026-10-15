import { useCallback, useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from 'react';

interface HistoryQuery {
  hasNextPage?: boolean;
  isFetching: boolean;
  isError: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;
}

/** Shared bottom-wheel pagination and reading-position preservation for both tapes. */
export function useTapeScroll<T extends { key: string }>(rows: readonly T[], history: HistoryQuery) {
  const [visible, setVisible] = useState(200);
  const scroll = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const hasMore = rows.length > visible || !!history.hasNextPage;
  const failed = history.isError || history.isFetchNextPageError;
  const { hasNextPage, isFetching, fetchNextPage } = history;
  const loadMore = useCallback(async () => {
    if (rows.length > visible) { setVisible(visible + 200); return; }
    if (!hasNextPage || isFetching || failed || loading.current) return;
    loading.current = true;
    try {
      const result = await fetchNextPage({ cancelRefetch: false });
      if (!result.isError) setVisible(n => n + 200);
    } finally { loading.current = false; }
  }, [rows.length, visible, hasNextPage, isFetching, fetchNextPage, failed]);
  const onScroll = () => {
    const root = scroll.current;
    if (!root) return;
    if (root.scrollTop === 0) anchor.current = null;
    else {
      const top = root.getBoundingClientRect().top;
      const header = root.querySelector('[role="columnheader"]')?.parentElement?.getBoundingClientRect().height ?? 0;
      for (const row of root.querySelectorAll<HTMLElement>('[data-tape-event]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > top + header) {
          anchor.current = { key: row.dataset.tapeEvent!, offset: rect.top - top }; break;
        }
      }
    }
    if (root.scrollHeight - root.clientHeight - root.scrollTop < 80) void loadMore();
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const root = scroll.current;
    if (root && event.deltaY > 0 && root.scrollHeight - root.clientHeight - root.scrollTop < 80) void loadMore();
  };
  useLayoutEffect(() => {
    const root = scroll.current;
    const saved = anchor.current;
    if (!root || !saved) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-tape-event]')].find(el => el.dataset.tapeEvent === saved.key);
    if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
  }, [rows, visible]);
  useEffect(() => {
    if (!hasMore || failed || !end.current || !scroll.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scroll.current, rootMargin: '0px 0px 80px 0px' });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [hasMore, failed, loadMore]);
  return { scroll, end, ticks: rows.slice(0, visible), onScroll, onWheel, failed };
}
