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
      className={`flex items-center justify-between py-2 ${disabled ? 'opacity-50' : ''} ${className}`.trim()}
    >
      <div className="flex-1 pr-4">
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
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-bg-input-hover'
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
