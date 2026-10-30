import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { CompactSettingsContext, SettingsDescriptionTooltipContext } from '../settings/SettingsRow';
import './WindowSettingsEditor.css';

/** Shared property sheet; settings and persistence remain owned by each window. */
export function WindowSettingsEditor({ children, footer, className = '', ...props }: HTMLAttributes<HTMLDivElement> & {
  footer?: ReactNode;
}) {
  return <CompactSettingsContext.Provider value><SettingsDescriptionTooltipContext.Provider value>
    <div className={`window-settings-editor ${className}`.trim()} {...props}>
      <div className="window-settings-body">{children}</div>
      {footer && <footer className="window-settings-footer">{footer}</footer>}
    </div>
  </SettingsDescriptionTooltipContext.Provider></CompactSettingsContext.Provider>;
}

export function WindowSettingsGroup({ title, children, className = '' }: {
  title: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  return <section className={`window-settings-group ${className}`.trim()} aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <div className="window-settings-fields">{children}</div>
  </section>;
}
