import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TimeframeControl } from '../../../src/live/TimeframeControl';
import { ViewedDateChip } from '../../../src/live/workspace/ViewedDateChip';
import { SavedRangeChip } from '../../../src/live/workspace/SavedRangeChip';
import { MinuteJumpChip } from '../../../src/live/workspace/MinuteJumpChip';

// This browser-test entry point exports mount rather than a Fast Refresh component.
// eslint-disable-next-line react-refresh/only-export-components
function Toolbar() {
  const [visible, setVisible] = useState(['past', 'saved', 'jump']);
  const clear = (id: string) => setVisible(previous => previous.filter(item => item !== id));
  return <div className="live-chart-toolbar flex flex-wrap items-center" data-testid="chip-toolbar">
    <TimeframeControl timeframe="3m" rememberedMinute="3m" onChange={() => {}} />
    {visible.includes('past') && <div className="ml-1 flex min-w-0 items-center">
      <ViewedDateChip date="20261013" onReturn={() => clear('past')} />
    </div>}
    {visible.includes('saved') && <div className="ml-1 flex min-w-0 items-center">
      <SavedRangeChip label="삼성전자" fromDate="20261013" toDate="20261015" krxPinned
        notice={null} onClear={() => clear('saved')} />
    </div>}
    {visible.includes('jump') && <div className="ml-1 flex min-w-0 items-center">
      <MinuteJumpChip state={{ date: '20261013', status: 'seeking' }} onClear={() => clear('jump')} />
    </div>}
  </div>;
}

export function mount(width: number) {
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.width = `${width}px`;
  document.body.append(host);
  flushSync(() => createRoot(host).render(<Toolbar />));
}
