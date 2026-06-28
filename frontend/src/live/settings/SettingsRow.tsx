import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function SettingsRow({
  label,
  description,
  disabled = false,
  className = '',
  children,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0 ${disabled ? 'opacity-50' : ''} ${className}`.trim()}
    >
      <div className="min-w-0 flex-1">
        <div className="text-fg text-sm">{label}</div>
        {description !== undefined && (
          <div className="text-fg-dim text-xs mt-0.5">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export function ToggleSwitch({
  label,
  checked,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-checked'> & {
  label: string;
  checked: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      {...props}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-border bg-bg-input-hover'
      } ${className}`.trim()}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
          checked ? 'bg-accent-fg translate-x-[18px]' : 'bg-fg-dim translate-x-[2px]'
        }`}
      />
    </button>
  );
}
