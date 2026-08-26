/** Single binary toggle row for registry-driven prefs.
 *  Stateless — owner passes the current checked value and a click handler.
 *  Shared (both via `IndicatorPrefRows`) by `SettingsSections` (⚙️ Settings
 *  modal) and the 「지표」 modal's hoga Configs, so one row style serves both. */
import { SettingsRow, ToggleSwitch, highlightLabel } from './SettingsRow';

export default function ToggleRow({
  label,
  description,
  checked,
  onToggle,
  testId,
  disabled = false,
  highlight,
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
  /** 설정 필터의 검색어 — 라벨의 일치 구간을 표시한다. 시각 라벨에만 적용하고
   *  스위치의 `aria-label` 은 원본 문자열을 유지한다(마크업이 섞이면 안 된다). */
  highlight?: string;
}) {
  return (
    <SettingsRow label={highlightLabel(label, highlight)} description={description} testId={testId} disabled={disabled}>
      <ToggleSwitch label={label} checked={checked} onClick={onToggle} disabled={disabled} />
    </SettingsRow>
  );
}
