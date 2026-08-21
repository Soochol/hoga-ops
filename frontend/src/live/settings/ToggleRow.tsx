/** Single binary toggle row for registry-driven prefs.
 *  Stateless — owner passes the current checked value and a click handler.
 *  Shared (both via `IndicatorPrefRows`) by `SettingsSections` (⚙️ Settings
 *  modal) and the 「지표」 modal's hoga Configs, so one row style serves both. */
import { SettingsRow, ToggleSwitch } from './SettingsRow';

export default function ToggleRow({
  label,
  description,
  checked,
  onToggle,
  testId,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  /** Optional data-testid override. `IndicatorPrefRows` passes
   *  `settings-toggle-{key}` for registry-driven rows. */
  testId?: string;
  /** Gated row whose parent toggle is off — dimmed and unclickable, same
   *  semantics `NumericPrefRow` already had for `enabledBy` prefs. The stored
   *  value is preserved so turning the parent back on restores the choice. */
  disabled?: boolean;
}) {
  return (
    <SettingsRow label={label} description={description} testId={testId} disabled={disabled}>
      <ToggleSwitch label={label} checked={checked} onClick={onToggle} disabled={disabled} />
    </SettingsRow>
  );
}
