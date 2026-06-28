import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function RailDrawer({
  id,
  testId,
  className = '',
  ariaLabel,
  children,
}: {
  id: string;
  testId?: string;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <aside
      id={id}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`h-full min-w-0 overflow-hidden border-l border-border bg-bg-card ${className}`.trim()}
      style={{ width: 'var(--watchlist-panel-w)' }}
    >
      <div className="flex h-full flex-col">{children}</div>
    </aside>
  );
}

export function RailDrawerHeader({
  title,
  actions,
  className = '',
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex items-center gap-sm border-b border-border px-md py-sm ${className}`.trim()}>
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-dim">{title}</h2>
      <span className="min-w-0 flex-1" />
      {actions}
    </header>
  );
}

export function RailDrawerSection({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`border-b border-border p-md ${className}`.trim()}>
      {children}
    </div>
  );
}

export function RailDrawerBody({
  className = '',
  testId,
  children,
}: {
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className={`min-h-0 flex-1 overflow-auto ${className}`.trim()}>
      {children}
    </div>
  );
}

export function RailButton({
  active,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...props}
      className={`w-full py-3 flex flex-col items-center gap-1 ${
        active ? 'bg-tint-selection text-fg font-medium' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
      } ${className}`.trim()}
    >
      {children}
    </button>
  );
}

export function RailState({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: 'neutral' | 'error' | 'warn';
  className?: string;
  children: ReactNode;
}) {
  const toneClass = tone === 'error' ? 'text-error' : tone === 'warn' ? '' : 'text-fg-dim';
  const style = tone === 'warn' ? { color: 'var(--warn)' } : undefined;
  return (
    <div className={`p-md text-sm ${toneClass} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}
