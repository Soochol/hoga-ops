import { useEffect } from 'react';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';

export default function Toolbar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const draft = useToolbarDraftStore((s) => s.getDraft(active.id));

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

  const ready = !!(draft.code && draft.from && draft.to);
  const loaded = active.status === 'loaded';

  const onLoad = () => {
    if (!ready) return;
    useTabsStore.getState().setSelection(active.id, {
      code: draft.code!,
      fromDate: draft.from!,
      toDate: draft.to!,
    });
  };

  return (
    <div className="flex items-center gap-2.5 px-4 bg-bg-card border-b h-[60px]">
      <StockCombobox value={draft.code} onChange={setCode} />
      <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
      <span className="flex-1" />
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
