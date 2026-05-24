import { useEffect, useState } from 'react';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';
import { useReplayLayoutStore } from '../state/replayLayout';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';
import TimeframeSelector from './TimeframeSelector';
import SettingsModal from './SettingsModal';
import DrawingMenu from './DrawingMenu';
import type { Timeframe } from '../api/types';

export default function Toolbar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const draft = useToolbarDraftStore((s) => s.getDraft(active.id));
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Sync draft from the store-committed selection when the user switches tabs.
  // We seed the draft with the selection so a tab that already loaded data
  // shows its current values in the toolbar instead of empty fields.
  useEffect(() => {
    const cur = useToolbarDraftStore.getState().getDraft(active.id);
    const sel = active.selection;
    const isEmpty = cur.code === null && cur.from === null && cur.to === null;
    if (isEmpty && sel) {
      useToolbarDraftStore.getState().setDraft(active.id, {
        code: sel.code,
        from: sel.fromDate,
        to: sel.toDate,
        timeframe: sel.timeframe,
      });
    }
    // Note: we intentionally don't overwrite a non-empty draft — the user may
    // be mid-edit. Lifting from local state preserves the original behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id]);

  const setCode = (code: string) =>
    useToolbarDraftStore.getState().setStock(active.id, code);
  const setDates = (from: string, to: string) =>
    useToolbarDraftStore.getState().setDates(active.id, from, to);
  const setTimeframe = (tf: Timeframe) => {
    useToolbarDraftStore.getState().setTimeframe(active.id, tf);
    // 이미 데이터가 로드된 탭이면 timeframe만 갈아끼워 즉시 재요청.
    // selection의 code/from/to를 그대로 쓰는 이유: 사용자가 draft에서 stock/date를
    // 수정 중일 수도 있으므로 그 in-flight 편집은 Reload 전까지 draft에 남겨둔다.
    const sel = useTabsStore.getState().tabs.find((t) => t.id === active.id)?.selection;
    if (sel) {
      useTabsStore.getState().setSelection(active.id, { ...sel, timeframe: tf });
    }
  };

  const ready = !!(draft.code && draft.from && draft.to && draft.timeframe);
  const loaded = active.status === 'loaded';

  const sidebarCollapsed = useReplayLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = () => useReplayLayoutStore.getState().toggleSidebar();

  const onLoad = () => {
    if (!ready) return;
    useTabsStore.getState().setSelection(active.id, {
      code: draft.code!,
      fromDate: draft.from!,
      toDate: draft.to!,
      timeframe: draft.timeframe ?? '1m',
    });
  };

  return (
    <div className="flex items-center gap-2.5 px-4 bg-bg-card border-b h-toolbar">
      <StockCombobox value={draft.code} onChange={setCode} />
      <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
      <TimeframeSelector value={draft.timeframe ?? '1m'} onChange={setTimeframe} />
      <button
        type="button"
        aria-label="설정"
        onClick={() => setSettingsOpen(true)}
        className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded"
      >
        ⚙
      </button>
      <DrawingMenu />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <span className="flex-1" />
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? '사이드바 보이기' : '사이드바 숨기기'}
        aria-expanded={!sidebarCollapsed}
        aria-controls="replay-sidebar"
        title={sidebarCollapsed ? '사이드바 보이기' : '사이드바 숨기기'}
        className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded font-mono"
      >
        {sidebarCollapsed ? '◀' : '▶'}
      </button>
      <button
        disabled={!ready}
        onClick={onLoad}
        className="px-4 py-2 bg-accent text-accent-fg rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loaded ? 'Reload' : '데이터 불러오기'}
      </button>
    </div>
  );
}
