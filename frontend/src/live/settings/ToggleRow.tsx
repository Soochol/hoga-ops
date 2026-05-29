/** Single binary toggle row used inside Settings modal sections.
 *  Stateless — owner passes the current checked value and a click handler.
 *  Extracted from SettingsModal so both the "차트" auto-rendered loop and
 *  the "보조지표" IndicatorsSection can share one source. */
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
  /** Optional data-testid override. SettingsModal/IndicatorsSection pass
   *  `settings-toggle-{key}` for registry-driven rows. */
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2" data-testid={testId}>
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{label}</div>
        <div className="text-fg-dim text-xs mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={
          checked
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            checked
              ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
    </div>
  );
}
