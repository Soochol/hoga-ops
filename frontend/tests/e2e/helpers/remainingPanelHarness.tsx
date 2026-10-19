import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { IndexSectorRankingPane } from '../../../src/live/IndexSectorRankingPane';
import { MajorIndicesWindow } from '../../../src/live/workspace/MajorIndicesWindow';
import { VolumeDistributionCard } from '../../../src/sidebar/VolumeDistributionCard';
import { PatternDrawer } from '../../../src/pattern/PatternDrawer';
import SignalAlertsDrawer from '../../../src/signalAlerts/SignalAlertsDrawer';
import { useLivePageStore } from '../../../src/state/livePage';
import type { IndexSectorRankingResponse } from '../../../src/api/indexSectorRankings';

export type Kind = 'sector' | 'indices' | 'volume' | 'pattern' | 'alerts';
const noop = () => {};
const ranking: IndexSectorRankingResponse = { date:'20261019', source:'daily_adjusted', unavailable_reason:null,
  sectors:Array.from({ length:100 }, (_, i) => ({ folder_id:String(i), folder_name:`반도체와 장비 긴 섹터 ${i}`, order:i,
    change_pct:i === 0 ? -1234.56 : 1.2, finite_count:2, total_count:2,
    stocks:['삼성전자', '이름이아주긴테스트종목'].map((name, j) => ({ code:j ? '000660' : '005930', name,
      folder_id:String(i), folder_name:'반도체', order:j, close:100, previous_close:99, change_pct:j ? -1234.56 : 1.2, missing_reason:null })) })) };

export function mount(kind: Kind, initialWidth: number, fontSize: number) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), client = new QueryClient({ defaultOptions:{ queries:{ retry:false } } });
  document.documentElement.style.fontSize = `${fontSize}px`;
  useLivePageStore.getState().setActiveCode('005930');
  let width = initialWidth, cursorMs: number | null = null;
  const render = () => {
    document.documentElement.style.setProperty('--watchlist-panel-w', `${width}px`);
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <div data-testid="panel-host" className="live-window relative" style={{ width, height:650 }}>
        {kind === 'sector' && <IndexSectorRankingPane variant="fill" basisDate="20261019" basisMode="latest" ranking={ranking}
          isLoading={false} error={null} onClearDatePin={noop} onOpenStock={code => (host.firstElementChild as HTMLElement).dataset.opened = code} />}
        {kind === 'indices' && <MajorIndicesWindow frameProps={{ id:'indices', kind:'market-indices', group:1,
          rect:{ x:0, y:0, w:width, h:400 }, zIndex:1, focused:true, symbolLabel:null, symbolCode:null,
          paletteOpen:false, onHandleDown:noop, onFocus:noop, onClose:noop, onTogglePalette:noop, onPickGroup:noop }} />}
        {kind === 'volume' && <VolumeDistributionCard cursorMs={cursorMs} profile={{ date:'20261019', range_count:2,
          price_min:12345678, price_max:123456789, session_open_ms:1792368000000, session_close_ms:1792391400000,
          bins:[{ price_low:12345678, price_high:67890123, qty:30 }, { price_low:67890123, price_high:123456789, qty:10 }] }}
          color="var(--fg-dim)" maxColor="var(--accent)" />}
        {kind === 'pattern' && <PatternDrawer />}
        {kind === 'alerts' && <SignalAlertsDrawer today="20261019" />}
      </div>
    </MemoryRouter></QueryClientProvider>));
  };
  render();
  return { resize(next: number) { width = next; render(); }, cursor(next: number) { cursorMs = next; render(); } };
}
