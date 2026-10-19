import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ProgramTradeTickTable } from '../../../src/sidebar/ProgramTradeTickTable';
import type { ProgramTradeTick } from '../../../src/live/programTradeTicks';

let root: Root;
const t = Date.parse('2026-10-19T00:00:00Z');
export function render(mode: 'normal' | 'large' | 'small' | 'empty', scope = 'same') {
  const ticks: ProgramTradeTick[] = mode === 'empty' ? [] : mode === 'small'
    ? [{ key: 'small', tMs: t, price: null, deltaQty: 10 }]
    : [0, 1, 2].map(i => ({ key: `program-${i}`, tMs: t + (2 - i) * 1000,
      price: i === 2 ? null : i === 0 ? 1234500 : 70100,
      deltaQty: (i === 1 ? -1 : 1) * (i === 2 ? 25 : mode === 'large' ? 1234567890123 : 123456789) }));
  flushSync(() => root.render(<div className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div aria-label="프로그램 체결 목록" className="min-h-0 flex-1 overflow-auto">
      <ProgramTradeTickTable key={scope} ticks={ticks} emptyText="새 수신 대기" />
    </div>
  </div>));
}

export function mount() {
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = 'width:720px;height:240px;background:var(--bg-card)';
  document.body.append(host);
  root = createRoot(host);
  render('normal');
}
