import type { ReactNode } from 'react';
import { lineVisible, type IndicatorLineKey } from '../../state/indicatorLineVisibility';
import { ToggleSwitch } from '../settings/SettingsRow';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** The switch affects drawing only; style controls stay editable when hidden. */
export default function LineVisibilityRow({ lineKey, label, toggleLabel, children }: {
  lineKey: IndicatorLineKey; label: string; toggleLabel?: string; children?: ReactNode;
}) {
  const visible = useWindowIndicator(s => lineVisible(s.indicatorLineVisibility, lineKey));
  const actions = useIndicatorActions();
  const toggle = () => {
    actions.setIndicatorLineVisible(lineKey, !visible);
    if (!visible && lineKey.startsWith('bollinger')) actions.setBollingerHidden(false);
    if (!visible && lineKey.startsWith('supertrend')) actions.setSupertrendHidden(false);
  };
  return <LineDisplayRow label={label} toggleLabel={toggleLabel} checked={visible} onToggle={toggle}>{children}</LineDisplayRow>;
}

export function LineDisplayRow({ label, toggleLabel = `${label} 표시`, checked, onToggle, children, testId }: {
  label: string; toggleLabel?: string; checked: boolean; onToggle: () => void; children?: ReactNode; testId?: string;
}) {
  return <div className="indicator-line-row" data-testid={testId}>
    <ToggleSwitch size="sm" label={toggleLabel} checked={checked} onClick={onToggle} />
    <span className={`min-w-0 flex-1 text-sm ${checked ? 'text-fg' : 'text-fg-dim'}`}>{label}</span>
    {children}
  </div>;
}
