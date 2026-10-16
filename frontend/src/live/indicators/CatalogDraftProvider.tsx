import { useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { IndicatorEditorDraftContext } from '../../state/indicatorEditorDraftContext';
import type { CatalogDraft } from './indicatorCatalogDraft';

export function CatalogDraftProvider({ draft, children }: { draft: CatalogDraft; children: ReactNode }) {
  const snapshot = useStore(draft.store);
  const value = useMemo(() => ({ ...snapshot, actions: draft.actions, setPref: draft.setPref, resetPrefs: draft.resetPrefs }), [snapshot, draft]);
  return <IndicatorEditorDraftContext.Provider value={value}>{children}</IndicatorEditorDraftContext.Provider>;
}

