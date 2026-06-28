import type { ButtonHTMLAttributes, RefObject, ReactNode } from 'react';

export function WorkspaceRoot({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`h-full min-w-0 bg-bg text-fg ${className}`.trim()}
    >
      {children}
    </section>
  );
}

export function WorkspaceHeader({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <header
      data-testid={testId}
      className={`flex items-center gap-3 border-b border-border bg-bg-card/80 px-4 backdrop-blur ${className}`.trim()}
      style={{ height: 'var(--h-live-header)' }}
    >
      {children}
    </header>
  );
}

export function WorkspaceToolbar({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-center gap-2 overflow-x-auto border-b border-border bg-bg-card/80 px-3 backdrop-blur ${className}`.trim()}
      style={{ height: '2.375rem' }}
    >
      {children}
    </div>
  );
}

export function IconToolbarButton({
  children,
  icon,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1 rounded-md border border-border-strong bg-bg-input px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:opacity-50 ${className}`.trim()}
    >
      {icon}
      {children}
    </button>
  );
}

export function DropOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-20 flex items-center justify-center"
      style={{
        pointerEvents: 'none',
        background: 'var(--tint-selection)',
        border: '2px dashed var(--accent)',
      }}
    >
      <span
        className="rounded-md text-sm font-semibold"
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        {children}
      </span>
    </div>
  );
}

export function WorkspaceState({
  children,
  tone = 'neutral',
  className = '',
  testId,
  dropTargetRef,
  showDropOverlay = false,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'error';
  className?: string;
  testId?: string;
  dropTargetRef?: RefObject<HTMLDivElement>;
  showDropOverlay?: boolean;
}) {
  const toneClass = tone === 'error' ? 'text-error' : 'text-fg-dimmer';
  return (
    <WorkspaceRoot testId={testId} className={className}>
      <div ref={dropTargetRef} data-testid="study-drop-target" className="relative h-full">
        <div className={`flex h-full items-center justify-center text-sm ${toneClass}`}>
          {children}
        </div>
        {showDropOverlay && <DropOverlay>여기에 놓아 학습뷰 열기</DropOverlay>}
      </div>
    </WorkspaceRoot>
  );
}
