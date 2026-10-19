import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { BrokerSeriesEntry } from '../../../src/api/types';
import BrokerTrajectoryTable from '../../../src/sidebar/BrokerTrajectoryTable';
import { BrokerScrollArea } from '../../../src/live/workspace/BrokerScrollArea';

let root: Root;
let rows: BrokerSeriesEntry[];
export const open = Date.parse('2026-10-19T00:00:00Z');

export function setCursor(cursorMs: number) {
  flushSync(() => root.render(<div className="flex h-full flex-col bg-bg-card">
    <BrokerScrollArea><BrokerTrajectoryTable series={rows} cursorMs={cursorMs} venue="KRX" /></BrokerScrollArea>
  </div>));
}

export function mount(large: boolean, many: boolean) {
  const scale = large ? 10000 : 1;
  rows = ['모건스탠리증권', '크레디트스위스', '신한투자증권', '키움증권'].map((broker, i) => {
    const points = i < 2
      ? [{ ts_ms: open + i * 300000, net: 999999999 * scale }, { ts_ms: open + (i + 2) * 300000, net: 0 }]
      : [{ ts_ms: open, net: -12345 * scale }, { ts_ms: open + 900000, net: -56789 * scale }];
    return { broker, points, final_net: points.at(-1)!.net, dominant_side: i < 2 ? 'buy' : 'sell' };
  });
  if (many) rows = [...rows, ...Array.from({ length: 20 }, (_, i) => ({
    ...rows[3], broker: `거래${i}`, points: rows[3].points,
  }))];
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = 'width:720px;height:360px;background:var(--bg-card)';
  document.body.append(host);
  root = createRoot(host);
  setCursor(open + 900000);
}
