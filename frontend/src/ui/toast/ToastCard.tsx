import { AppIcon } from '../AppIcon';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { noticeColors } from '../noticeTone';
import { useToastPresence } from './useToastPresence';

export type ToastVariant = 'neutral' | 'warn' | 'success' | 'error';
const VARIANT_PROGRESS: Record<ToastVariant, string> = {
  neutral: 'bg-accent', warn: 'bg-warn', success: 'bg-success', error: 'bg-error',
};

type ToastCardProps = Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave' | 'onFocusCapture' | 'onBlurCapture'> & {
  visible: boolean;
  onExited?: () => void;
  variant?: ToastVariant;
  onClick?: () => void;
  role?: string;
  ariaLabel?: string;
  title?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  progress?: { durationMs: number; paused: boolean; resetKey?: number | string } | null;
  /** Compact undo notices keep the action beside the message. Titled notices use the footer. */
  action?: { label: string; onClick: () => void };
  actions?: ReactNode;
  children?: ReactNode;
};

export function ToastAction({ emphasis = 'default', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  emphasis?: 'default' | 'accent';
}) {
  return <button type="button" {...props}
    className={`shrink-0 rounded border px-2 py-1 text-xs font-medium hover:border-accent hover:text-accent ${emphasis === 'accent' ? 'border-accent text-accent' : 'border-border-strong text-fg'} ${className}`.trim()} />;
}

/** Shared chrome only. Hosts retain their event, recovery and deletion ownership. */
export function ToastCard({
  visible, onExited, variant = 'neutral', onClick, role, ariaLabel,
  title, onDismiss, dismissLabel = '닫기', progress, action, actions, children, ...interactionProps
}: ToastCardProps) {
  const { rendered, phase } = useToastPresence(visible, onExited);
  if (!rendered) return null;
  const colors = noticeColors(variant);
  const clickable = !!onClick && !action && !actions && !onDismiss;
  const className = 'toast-card pointer-events-auto relative w-full overflow-hidden rounded border bg-bg-card px-3 py-2 text-left shadow-overlay' +
    (clickable ? ' hover:bg-bg-input' : '');
  const dismiss = onDismiss && <button type="button" aria-label={dismissLabel} onClick={onDismiss}
    className="shrink-0 rounded px-1 text-base leading-none text-fg-dim hover:text-fg"><AppIcon name="close" /></button>;
  const actionButton = action && <ToastAction onClick={action.onClick}>{action.label}</ToastAction>;
  const inner = <>
    {title != null ? <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-medium" style={{ color: variant === 'neutral' ? 'var(--fg)' : colors.foreground }}>{title}</div>
        {dismiss}
      </div>
      {children != null && <div className="mt-1 text-xs text-fg-dim">{children}</div>}
      {(actionButton || actions) && <div className="mt-3 flex flex-wrap items-center gap-2">{actionButton}{actions}</div>}
    </> : <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">{children}</div>{actionButton}{dismiss}
    </div>}
    {title == null && actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    {progress && <span key={progress.resetKey} aria-hidden
      className={`toast-progress absolute inset-x-0 bottom-0 block h-[2px] ${VARIANT_PROGRESS[variant]}`}
      style={{ animationDuration: `${progress.durationMs}ms`, animationPlayState: progress.paused ? 'paused' : 'running' }} />}
  </>;
  const shared = { 'data-phase': phase, 'aria-label': ariaLabel, className, style: { borderColor: colors.border }, ...interactionProps };
  if (clickable) return <button type="button" {...shared} onClick={onClick}>{inner}</button>;
  return <div {...shared} role={role}>{inner}</div>;
}
