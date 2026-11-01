import { createContext } from 'react';
import type { IndicatorSettings } from './indicatorSettingsV2';
import type { BoundIndicatorOps } from './indicatorOps';
import type { ChartViewPrefs, IndicatorModalPrefKey } from './chartPrefs';
import type { VolumeOverlayPrefs } from './chartDisplayPrefs';

/** Only the catalog form is wrapped. Charts and the rest of the editor keep reading live state. */
export const IndicatorEditorDraftContext = createContext<{
  instanceId?: string;
  settings: IndicatorSettings;
  prefs: ChartViewPrefs;
  actions: BoundIndicatorOps;
  setPref: (key: IndicatorModalPrefKey, value: boolean | number) => void;
  resetPrefs: () => void;
  volumeOverlay?: VolumeOverlayPrefs;
  volumeOverlayEditable?: boolean;
  patchVolumeOverlay?: (patch: Partial<VolumeOverlayPrefs>) => void;
} | null>(null);
