import { useLayoutEffect } from 'react';
import { useWindowSettingsStore, WindowSettingsScope } from '../../state/windowSettings';
import { normalizeChartDisplayPrefs } from '../../state/chartDisplayPrefs';
import { seedSettingsForWindow } from '../../state/windowSettingsLifecycle';
import { SettingsUndoContext } from '../settings/settingsUndoContext';
import { useSettingsUndo, type SettingsSnapshot } from '../settings/useSettingsUndo';
import { WindowSettingsEditor } from './WindowSettingsEditor';
import { ChartWindowSettingsRows } from './ChartWindowSettingsRows';
const subscribe = (changed: () => void) => useWindowSettingsStore.subscribe(changed);

/** The title bar is outside the chart's view provider, so bind its window explicitly. */
export function ChartDisplaySettings({ windowId }: { windowId: string }) {
  useLayoutEffect(() => seedSettingsForWindow({ id: windowId, kind: 'chart' }), [windowId]);
  const read = () => ({ ...normalizeChartDisplayPrefs(useWindowSettingsStore.getState().byWindow[windowId]?.chart) });
  const restore = (patch: SettingsSnapshot) => useWindowSettingsStore.getState().patch(windowId, 'chart', patch);
  const undo = useSettingsUndo({ scopeKey: `chart-display:${windowId}`, read, restore, subscribe });
  return <WindowSettingsScope.Provider value={windowId}><SettingsUndoContext.Provider value={undo.record}>
    <WindowSettingsEditor className="chart-display-settings" {...undo.captureProps} footer={<>
        <span role="status" aria-live="polite"><span className="window-settings-saved" aria-hidden>✓</span> {undo.message ?? '변경 즉시 반영'}</span>
        <div className="window-settings-footer-actions"><button type="button" data-settings-undo disabled={!undo.canUndo}
          onClick={() => void undo.undo()}>{undo.busy ? '되돌리는 중…' : '되돌리기'}</button></div>
      </>}><ChartWindowSettingsRows /></WindowSettingsEditor>
  </SettingsUndoContext.Provider></WindowSettingsScope.Provider>;
}
