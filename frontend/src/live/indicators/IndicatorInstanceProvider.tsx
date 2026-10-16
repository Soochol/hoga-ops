import { releaseInstancePaneSpecs } from './indicatorInstancePanes';
import { useEffect, useMemo, type ReactNode } from 'react';
import { IndicatorEditorDraftContext } from '../../state/indicatorEditorDraftContext';
import { useMaSeriesRegistry } from './maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './dailyMaSeriesRegistry';
import { clearWindowFlagLegendValues } from './flagLegendValueRegistry';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { bindIndicatorOps } from '../../state/indicatorOps';
import { bucketsForScope, resolveIndicatorSettings, type IndicatorScope, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import { captureIndicatorSettings, captureIndicatorPrefs, instanceSettings, displayIndicatorSettings } from '../../state/indicatorInstances';
import { useScopedChartPrefs, type IndicatorModalPrefKey } from '../../state/chartPrefs';
import { useWindowIndicators, useWindowIndicatorScope, useWindowIndicatorTimeframe, useWindowScopeId } from '../workspace/windowView';

/** All existing forms/projectors read the selected instance through the same scoped hooks. */
export function IndicatorInstanceProvider({ id, children, manageRegistry = false }: { id: string; children: ReactNode; manageRegistry?: boolean }) {
  const base = useWindowIndicators();
  const prefs = useScopedChartPrefs();
  const scope = useWindowIndicatorScope();
  const tf = useWindowIndicatorTimeframe();
  const instance = base.indicatorInstances?.find(row => row.id === id);
  const parentId = useWindowScopeId() ?? 'ambient';
  useEffect(() => () => {
    if (!manageRegistry) return;
    const registryScope = `${parentId}:indicator:${id}`;
    releaseInstancePaneSpecs(id);
    clearWindowFlagLegendValues(registryScope);
    useMaSeriesRegistry.getState().clearScope(registryScope);
    useDailyMaSeriesRegistry.getState().clearScope(registryScope);
  }, [id, parentId, manageRegistry]);
  const { windowKey, instrumentKind } = scope;
  const actions = useMemo(() => {
    const scope: IndicatorScope = { windowKey, instrumentKind };
    const read = () => readInstanceBase(scope, tf);
    const patch = (settings: Partial<IndicatorSettings>) => updateIndicatorInstance(scope, tf, id, row => ({
      ...row, settings: { ...row.settings, ...captureIndicatorSettings(row.category, { ...instanceSettings(read(), row), ...settings }) },
    }));
    return {
      ops: bindIndicatorOps(() => {
        const settings = read();
        const row = settings.indicatorInstances?.find(item => item.id === id);
        return row ? instanceSettings(settings, row) : settings;
      }, patch),
      setPref: (key: IndicatorModalPrefKey, value: boolean | number) => updateIndicatorInstance(scope, tf, id, row => ({
        ...row, prefs: { ...row.prefs, ...captureIndicatorPrefs(row.category, { [key]: value }) },
      })),
      resetPrefs: () => updateIndicatorInstance(scope, tf, id, row => ({ ...row, prefs: {} })),
    };
  }, [id, windowKey, instrumentKind, tf]); // primitive scope keys keep bound actions stable
  const value = useMemo(() => instance ? ({
    instanceId: id, settings: displayIndicatorSettings({ ...instanceSettings(base, instance), ...(instance.category === 'ratio' ? { brokerLateEntries: [] } : {}), indicatorPrimaryHidden: instance.hidden ? [instance.category] : [] }), prefs: { ...prefs, ...instance.prefs },
    actions: actions.ops, setPref: actions.setPref, resetPrefs: actions.resetPrefs,
  }) : null, [id, base, instance, prefs, actions]);
  return instance ? <IndicatorEditorDraftContext.Provider value={value}>{children}</IndicatorEditorDraftContext.Provider> : null;
}

function readInstanceBase(scope: IndicatorScope, tf: LiveTimeframe | null): IndicatorSettings {
  const s = useLivePageStore.getState();
  return tf ? resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope), tf) : s;
}
function updateIndicatorInstance(scope: IndicatorScope, tf: LiveTimeframe | null, id: string,
  update: (row: NonNullable<IndicatorSettings['indicatorInstances']>[number]) => NonNullable<IndicatorSettings['indicatorInstances']>[number]) {
  const s = useLivePageStore.getState();
  const cur = readInstanceBase(scope, tf);
  if (!cur.indicatorInstances?.some(row => row.id === id)) return;
  s.patchIndicatorsScoped(scope, tf ?? s.indicatorTimeframe, { indicatorInstances: cur.indicatorInstances.map(row => row.id === id ? update(row) : row) });
}
