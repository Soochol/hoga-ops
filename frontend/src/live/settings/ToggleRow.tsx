/** Single binary toggle row for registry-driven prefs.
 *  Stateless — owner passes the current checked value and a click handler.
 *  Shared (both via `IndicatorPrefRows`) by `LiveSettingsSections` (⚙️ Settings
 *  modal) and the 「지표」 modal's hoga Configs, so one row style serves both. */
import { SettingsRow, ToggleSwitch } from './SettingsRow';

export default function ToggleRow({
  label,
  description,
  checked,
  onToggle,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  /** Optional data-testid override. `IndicatorPrefRows` passes
   *  `settings-toggle-{key}` for registry-driven rows. */
  testId?: string;
}) {
  return (
    <SettingsRow label={label} description={description} testId={testId}>
      <ToggleSwitch label={label} checked={checked} onClick={onToggle} />
    </SettingsRow>
  );
}
