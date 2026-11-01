import { Fragment, useId, type ReactNode } from 'react';
import { AppIcon } from '../../ui/AppIcon';
import './SettingsGroup.css';

/** The same group rail is used by application and indicator settings. */
export function SettingsGroup({ label, description, children, className = '' }: {
  label: ReactNode; description?: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  const hasLabel = label != null;
  return <section className={`settings-property-group ${hasLabel ? '' : 'settings-property-group-unlabeled'} ${className}`.trim()} aria-labelledby={hasLabel ? id : undefined}>
    {hasLabel && <h4 id={id} className="settings-property-group-label">
      {typeof label === 'string'
        ? label.split('·').map((part, i) => <Fragment key={i}>{i > 0 && <>·<wbr /></>}{part}</Fragment>) : label}
      {description && <button type="button" className="ui-icon-button settings-group-help"
        aria-label={`${label} 설명`} data-tooltip={description}><AppIcon name="help" /></button>}
    </h4>}
    <div className="settings-property-group-body">{children}</div>
  </section>;
}
