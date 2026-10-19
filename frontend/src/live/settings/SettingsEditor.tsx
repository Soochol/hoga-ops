import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { WORKSPACE_PANEL_SHELL_CLASS } from '../workspacePanel';
import { SettingsUndoContext } from './settingsUndoContext';
import type { SettingsUndo } from './useSettingsUndo';
import './SettingsEditor.css';

export function SettingsEditorNavItem({ active, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return <button type="button" {...props} aria-current={active ? 'true' : undefined}
    className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
      active ? 'bg-tint-selection font-medium text-fg' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
    } ${className}`.trim()}>{children}</button>;
}

export function SettingsEditor({ title, scope, onClose, closeLabel = '닫기', actions, sidebar, children, undo, testId, footer, footerAction, statusIcon, className = '' }: {
  title: string; scope?: ReactNode; onClose?: () => void; closeLabel?: string; actions?: ReactNode;
  sidebar: ReactNode; children: ReactNode; undo?: SettingsUndo; testId: string; footer?: string; footerAction?: ReactNode; statusIcon?: ReactNode; className?: string;
}) {
  return <SettingsUndoContext.Provider value={undo?.record ?? null}>
    <div className={`${WORKSPACE_PANEL_SHELL_CLASS} ${className}`.trim()} data-testid={testId} {...undo?.captureProps}>
      <header className="settings-editor-heading">
        <h2>{title}</h2>
        <div className="settings-editor-heading-actions">{scope && <span className="settings-editor-scope">{scope}</span>}{actions}
          {onClose && <button type="button" aria-label={closeLabel} onClick={onClose} className="ui-icon-button text-lg leading-none">✕</button>}
        </div>
      </header>
      <div className="settings-editor-body">
        <div className="settings-editor-sidebar">{sidebar}</div>
        <div className="settings-editor-main">{children}</div>
      </div>
      {footer !== undefined && <footer className="settings-editor-footer">
        <span role="status" aria-live="polite">{statusIcon === undefined ? <span aria-hidden="true" className="settings-editor-saved">✓</span> : statusIcon} {undo?.message ?? footer}</span>
        <div className="settings-editor-footer-actions">{undo && <button type="button" data-settings-undo disabled={!undo.canUndo} onClick={() => void undo.undo()}>{undo.busy ? '되돌리는 중…' : '되돌리기'}</button>}{footerAction}</div>
      </footer>}
    </div>
  </SettingsUndoContext.Provider>;
}
