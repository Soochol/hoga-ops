import { forwardRef } from 'react';
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
      className={`flex items-center gap-3 border-b border-border bg-bg-subtle/80 px-3 backdrop-blur ${className}`.trim()}
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
      style={{ height: 'var(--h-toolbar)' }}
    >
      {children}
    </div>
  );
}

/** ref 를 전달받는다 — 드롭다운 트리거가 메뉴를 닫은 뒤 포커스를 되돌리는 데 쓴다
 *  (WindowAddMenu). React 18 이라 함수 컴포넌트는 forwardRef 가 있어야 ref 를 받는다. */
export const IconToolbarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }
>(function IconToolbarButton({ children, icon, className = '', ...props }, ref) {
  return (
    <button
      type="button"
      ref={ref}
      {...props}
      // 테두리 없는 ghost 버튼(2026-07-15) — 라이트에서 bg-input=툴바 bg라 보더 없이 채우면
      // 안 보이므로 투명 배경 + hover 시 배경으로 어포던스. 분리는 hover 상태가 담당.
      className={`inline-flex items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:opacity-50 ${className}`.trim()}
    >
      {icon}
      {children}
    </button>
  );
});

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
          boxShadow: 'var(--shadow-overlay)',
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
