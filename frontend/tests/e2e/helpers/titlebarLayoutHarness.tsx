import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WindowFrame } from '../../../src/live/workspace/WindowFrame';
import { publishWindowWarnings } from '../../../src/live/workspace/windowWarningsSource';
import { liveQuotesQueryKey } from '../../../src/api/liveQuotes';

/** Production header, CSS, fonts and stores; no chart or vendor connection. */
export function mount(width: number) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const quotesKey = liveQuotesQueryKey(['005930'], 'KRX');
  client.setQueryData(quotesKey, { phase: 'open', quotes: [] });
  client.setQueryData(['watchlist'], { folders: [], entries: [], memos: [], next_run_at_ms: 0 });
  client.setQueryData(['live', 'status'], { running: false, live_set: [] });
  client.setQueryData(['heatmap'], { folders: [{ id: 'f1', name: '반도체 · 대형주', order: 0 }],
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }],
    capture_markers: {}, next_run_at_ms: 0 });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <WindowFrame id="layout" kind="chart" group={1} rect={{ x: 0, y: 0, w: width, h: 180 }}
      zIndex={1} focused symbolLabel="LIG디펜스앤에어로스페이스" symbolCode="005930" paletteOpen={false}
      onHandleDown={noop} onFocus={noop} onClose={noop} onTogglePalette={noop} onPickGroup={noop}
      onToggleAlwaysOnTop={noop} onToggleMaximize={noop} onTogglePin={noop}>
      <div />
    </WindowFrame>
  </QueryClientProvider>));
  return {
    update(date: string | null, price: number | null, pct: number | null) {
      flushSync(() => {
        publishWindowWarnings('layout', { backfillEarliestDate: date });
        client.setQueryData(quotesKey, { phase: 'open', quotes: price === null ? [] : [
          { code: '005930', price, change_pct: pct, change_won: null },
        ] });
      });
    },
  };
}
