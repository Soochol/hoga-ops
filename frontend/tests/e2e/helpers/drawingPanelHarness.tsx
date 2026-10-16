import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DrawingPropertyPanel from '../../../src/chart/DrawingPropertyPanel';
import { useDrawingsStore } from '../../../src/state/drawings';

export function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let scope = '005930|minute';
  const seed = () => {
    const state = useDrawingsStore.getState();
    state.setActiveTool('select');
    for (const id of ['a', 'b']) if (!state.drawingsFor(scope).some(d => d.id === id)) {
      state.add(scope, { id, kind: 'hline', price: 70000, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    }
    state.setSelection(scope, ['a']);
  };
  const render = () => flushSync(() => root.render(<div className="flex gap-4">
    {['first', 'second'].map(id => <div key={id} data-testid={`chart-${id}`}
      className="relative border border-border" style={{ width: 650, height: 320 }}>
      <DrawingPropertyPanel scope={scope} positionKey={id} />
    </div>)}
  </div>));
  seed(); render();
  return {
    select(ids: string[]) { flushSync(() => useDrawingsStore.getState().setSelection(scope, ids)); },
    changeScope() { scope = '000660|D'; seed(); render(); },
    remount() { flushSync(() => root.render(null)); render(); },
    selected() { return useDrawingsStore.getState().selectedFor(scope); },
  };
}
