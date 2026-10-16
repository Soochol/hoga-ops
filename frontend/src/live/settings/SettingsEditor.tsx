import type { ReactNode } from 'react';
import { WORKSPACE_PANEL_SHELL_CLASS } from '../workspacePanel';
import { SettingsUndoContext } from './settingsUndoContext';
import type { SettingsUndo } from './useSettingsUndo';
import './SettingsEditor.css';

export function SettingsEditor({ title, scope, onClose, actions, sidebar, children, undo, testId, footer }: {
  title: string; scope: ReactNode; onClose?: () => void; actions?: ReactNode;
  sidebar: ReactNode; children: ReactNode; undo: SettingsUndo; testId: string; footer: string;
}) {
  return <SettingsUndoContext.Provider value={undo.record}>
    <div className={WORKSPACE_PANEL_SHELL_CLASS} data-testid={testId} {...undo.captureProps}>
      <header className="settings-editor-heading">
        <h2>{title}</h2>
        <div className="settings-editor-heading-actions"><span className="settings-editor-scope">{scope}</span>{actions}
          {onClose && <button type="button" aria-label="닫기" onClick={onClose} className="ui-icon-button text-lg leading-none">✕</button>}
        </div>
      </header>
      <div className="settings-editor-body">
        <div className="settings-editor-sidebar">{sidebar}</div>
        <div className="settings-editor-main">{children}</div>
      </div>
      <footer className="settings-editor-footer">
        <span role="status" aria-live="polite"><span aria-hidden="true" className="settings-editor-saved">✓</span> {undo.message ?? footer}</span>
        <button type="button" data-settings-undo disabled={!undo.canUndo} onClick={() => void undo.undo()}>{undo.busy ? '되돌리는 중…' : '되돌리기'}</button>
      </footer>
    </div>
  </SettingsUndoContext.Provider>;
}
