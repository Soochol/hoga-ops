import type { ReactNode } from 'react';

export function SidebarState({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid h-full place-items-center text-xs text-fg-dimmer ${className}`.trim()}>
      {children}
    </div>
  );
}

export function SidebarCard({
  testId,
  className = '',
  children,
}: {
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className={`mx-[var(--space-sm)] mb-[var(--space-sm)] flex flex-col bg-bg-card border rounded overflow-hidden ${className}`.trim()}
    >
      {children}
    </section>
  );
}

export function SidebarCardHeader({
  title,
  meta,
  className = '',
}: {
  title: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex items-center justify-between gap-2 px-3 py-2 border-b text-xs ${className}`.trim()}>
      <h2 className="font-semibold text-fg">{title}</h2>
      {meta !== undefined && <span className="font-mono text-fg-dimmer">{meta}</span>}
    </header>
  );
}

export function SidebarCardFooter({
  left,
  right,
  className = '',
}: {
  left: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <footer className={`flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-fg-dimmer ${className}`.trim()}>
      <span>{left}</span>
      {right !== undefined && <span className="font-mono">{right}</span>}
    </footer>
  );
}
