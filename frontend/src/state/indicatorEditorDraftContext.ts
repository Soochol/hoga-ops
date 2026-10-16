import { createContext } from 'react';
import type { IndicatorSettings } from './indicatorSettingsV2';
import type { BoundIndicatorOps } from './indicatorOps';
import type { ChartViewPrefs, IndicatorModalPrefKey } from './chartPrefs';

/** Only the catalog form is wrapped. Charts and the rest of the editor keep reading live state. */
export const IndicatorEditorDraftContext = createContext<{
  settings: IndicatorSettings;
  prefs: ChartViewPrefs;
  actions: BoundIndicatorOps;
  setPref: (key: IndicatorModalPrefKey, value: boolean | number) => void;
  resetPrefs: () => void;
} | null>(null);
