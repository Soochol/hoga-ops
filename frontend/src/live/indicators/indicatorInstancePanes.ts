import type { BoundPaneSpec } from '../../chart/paneSpecs';
import type { PaneId, BasePaneId } from '../../chart/drawing/types';
import type { IndicatorInstance } from '../../state/indicatorInstances';
import { instanceSettings } from '../../state/indicatorInstances';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { LiveTimeframe } from '../../state/livePage';
import { paneSpecsForTimeframe } from '../paneSpecsForTimeframe';
import { resolvePaneToggles } from './indicatorPaneProfiles';
import { peakWallPaneHasContent } from '../../state/indicatorOps';
import type { CategoryId } from './IndicatorPanelHelpers';

export const CATEGORY_PANE: Partial<Record<CategoryId, BasePaneId>> = {
  volume: 'volume', 'trade-value': 'trade-value', 'quote-totals': 'quote-totals', ratio: 'ratio',
  'fill-strength': 'fill-strength', 'program-trade': 'program-trade', 'program-daily': 'program-daily',
  'foreign-net': 'investor-foreign', 'institution-net': 'investor-institution',
  'broker-late-entry': 'ratio', 'peak-walls': 'peak-wall',
};
export function instancePaneId(id: string, pane: BasePaneId): PaneId { return `indicator:${id}:${pane}`; }
const specs = new Map<string, BoundPaneSpec>();
function instanceSpec(spec: BoundPaneSpec, id: string): BoundPaneSpec {
  const key = `${id}:${spec.name}`;
  let bound = specs.get(key);
  if (!bound) { bound = { ...spec, name: instancePaneId(id, spec.name as BasePaneId) }; specs.set(key, bound); }
  return bound;
}
export function indicatorInstancePanes(base: IndicatorSettings, row: IndicatorInstance, tf: LiveTimeframe, hogaPanes: boolean, priceOnly = false): BoundPaneSpec[] {
  if (row.hidden || !indicatorInstanceApplicable(row.category, tf, hogaPanes, priceOnly)) return [];
  const pane = CATEGORY_PANE[row.category]; if (!pane) return [];
  const settings = instanceSettings(base, row);
  const toggles = resolvePaneToggles({ indicators: settings, peakWallPaneHasContent: peakWallPaneHasContent(settings), hogaPanes });
  if (row.category === 'broker-late-entry') toggles.ratioEnabled = true;
  return paneSpecsForTimeframe(tf, toggles).filter(spec => spec.name === pane).map(spec => instanceSpec(spec, row.id));
}

const singleGroups = new WeakMap<BoundPaneSpec, readonly BoundPaneSpec[]>();
export function instancePaneGroup(spec: BoundPaneSpec): readonly BoundPaneSpec[] {
  let group = singleGroups.get(spec); if (!group) { group = Object.freeze([spec]); singleGroups.set(spec, group); }
  return group;
}

/** Additional panes append after the existing shared layout. Hide never changes membership. */
export function filterPrimaryPaneGroups(groups: readonly (readonly BoundPaneSpec[])[], hidden: readonly CategoryId[] | undefined) {
  if (!hidden?.length) return groups;
  const hiddenPanes = new Set(hidden.map(category => CATEGORY_PANE[category]).filter(Boolean));
  return groups.map(group => {
    const kept = group.filter(spec => !hiddenPanes.has(spec.name as BasePaneId));
    if (kept.length === group.length) return group;
    if (kept.length === 1) return instancePaneGroup(kept[0]);
    return kept;
  }).filter(group => group.length > 0);
}
export function indicatorInstanceApplicable(category: CategoryId, tf: LiveTimeframe, hogaPanes: boolean, priceOnly = false): boolean {
  if (priceOnly) return ['moving-average', 'bollinger', 'envelope', 'supertrend'].includes(category);
  if (tf.endsWith('s')) return ['moving-average', 'bollinger', 'envelope', 'supertrend', 'volume', 'fill-strength'].includes(category);
  if (category === 'daily-moving-average') return !['D', 'W', 'M'].includes(tf);
  if (category === 'foreign-net' || category === 'institution-net' || category === 'program-daily') return tf === 'D';
  if (category === 'trade-value') return ['D', 'W', 'M'].includes(tf);
  if (['moving-average', 'bollinger', 'envelope', 'supertrend', 'volume'].includes(category)) return true;
  return hogaPanes && !['D', 'W', 'M'].includes(tf);
}

export function releaseInstancePaneSpecs(id: string) { for (const key of specs.keys()) if (key.startsWith(`${id}:`)) specs.delete(key); }
