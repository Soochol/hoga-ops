import { useLayoutEffect } from 'react';
import { CHART_DISPLAY_GROUP_IDS, CHART_TOGGLE_GROUPS, CHART_TOGGLES, groupOf } from '../../state/chartPrefs';
import { useWindowSettingsStore, WindowSettingsScope } from '../../state/windowSettings';
import { normalizeChartDisplayPrefs } from '../../state/chartDisplayPrefs';
import { seedSettingsForWindow } from '../../state/windowSettingsLifecycle';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { SettingsUndoContext } from '../settings/settingsUndoContext';
import { useSettingsUndo, type SettingsSnapshot } from '../settings/useSettingsUndo';
import '../settings/SettingsEditor.css';

const groups = CHART_TOGGLE_GROUPS.filter(group => CHART_DISPLAY_GROUP_IDS.includes(group.id))
  .map(group => ({ ...group, keys: CHART_TOGGLES.filter(toggle => groupOf(toggle) === group.id).map(toggle => toggle.key) }));
const subscribe = (changed: () => void) => useWindowSettingsStore.subscribe(changed);

/** The title bar is outside the chart's view provider, so bind its window explicitly. */
export function ChartDisplaySettings({ windowId }: { windowId: string }) {
  useLayoutEffect(() => seedSettingsForWindow({ id: windowId, kind: 'chart' }), [windowId]);
  const read = () => ({ ...normalizeChartDisplayPrefs(useWindowSettingsStore.getState().byWindow[windowId]?.chart) });
  const restore = (patch: SettingsSnapshot) => useWindowSettingsStore.getState().patch(windowId, 'chart', patch);
  const undo = useSettingsUndo({ scopeKey: `chart-display:${windowId}`, read, restore, subscribe });
  return <WindowSettingsScope.Provider value={windowId}><SettingsUndoContext.Provider value={undo.record}>
    <div className="settings-editor window-settings-editor chart-display-settings" {...undo.captureProps}>
      <div className="settings-editor-content">
        {groups.map(group => <section key={group.id} className="settings-editor-group" aria-label={group.label}>
          <h4>{group.label}</h4>
          <IndicatorPrefRows toggleKeys={group.keys} />
        </section>)}
      </div>
      <footer className="settings-editor-footer">
        <span role="status" aria-live="polite"><span className="settings-editor-saved" aria-hidden>✓</span> {undo.message ?? '변경 즉시 반영'}</span>
        <div className="settings-editor-footer-actions"><button type="button" data-settings-undo disabled={!undo.canUndo}
          onClick={() => void undo.undo()}>{undo.busy ? '되돌리는 중…' : '되돌리기'}</button></div>
      </footer>
    </div>
  </SettingsUndoContext.Provider></WindowSettingsScope.Provider>;
}
