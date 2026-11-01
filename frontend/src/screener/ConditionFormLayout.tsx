import { createContext, useContext, type ReactNode } from 'react';
import { SettingsGroup } from '../live/settings/SettingsGroup';

export const ConditionSettingsContext = createContext(false);

export function ConditionFormLayout({ basis, children }: { basis: ReactNode; children: ReactNode }) {
  const settings = useContext(ConditionSettingsContext);
  return settings ? <>
    <SettingsGroup label="기준"><div className="condition-form">{basis}</div></SettingsGroup>
    <SettingsGroup label="조건"><div className="condition-form">{children}</div></SettingsGroup>
  </> : <div className="condition-form">{basis}{children}</div>;
}
