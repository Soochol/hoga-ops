import { useEffect, useState } from 'react';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';
import TimeframeSelector from './TimeframeSelector';
import SettingsModal from './SettingsModal';
import type { Timeframe } from '../api/types';

export default function Toolbar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const draft = useToolbarDraftStore((s) => s.getDraft(active.id));
  const [rangeError, setRangeError] = useState<string | null>(null);
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
  const setTimeframe = (tf: Timeframe) =>
    useToolbarDraftStore.getState().setTimeframe(active.id, tf);

  const ready = !!(draft.code && draft.from && draft.to && draft.timeframe);
  const loaded = active.status === 'loaded';

  const onLoad = () => {
    if (!ready) return;
    const dFrom = new Date(
      Number(draft.from!.slice(0, 4)),
      Number(draft.from!.slice(4, 6)) - 1,
      Number(draft.from!.slice(6, 8)),
    );
    const dTo = new Date(
      Number(draft.to!.slice(0, 4)),
      Number(draft.to!.slice(4, 6)) - 1,
      Number(draft.to!.slice(6, 8)),
    );
    const days = Math.round((dTo.getTime() - dFrom.getTime()) / 86_400_000);
    if (days > 30) {
      setRangeError('최대 30일까지 조회 가능합니다');
      return;
    }
    setRangeError(null);
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <span className="flex-1" />
      {rangeError && <span className="text-error text-sm ml-2">{rangeError}</span>}
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
