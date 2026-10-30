import { useId } from 'react';
import type { MajorIndicesSettings as Settings } from '../../state/majorIndicesSettings';
import { MAJOR_INDICES } from './majorIndicesModel';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import { WindowSettingsEditor, WindowSettingsGroup } from './WindowSettingsEditor';

export function MajorIndicesSettings({ settings, onChange }: {
  settings: Settings; onChange: (patch: Partial<Settings>) => void;
}) {
  const id = useId();
  return <WindowSettingsEditor className="major-indices-settings" footer={<span>변경 즉시 반영</span>}>
    <WindowSettingsGroup title="표시 지수">
      {MAJOR_INDICES.map(index => {
        const checked = settings.indices.includes(index.id);
        const controlId = `${id}-${index.id}`;
        return <SettingsRow key={index.id} controlId={controlId} label={index.label} disabled={checked && settings.indices.length === 1}>
          <input id={controlId} type="checkbox" className="window-settings-checkbox" checked={checked} disabled={checked && settings.indices.length === 1}
            onChange={event => onChange({ indices: event.target.checked
              ? [...settings.indices, index.id] : settings.indices.filter(id => id !== index.id) })} />
        </SettingsRow>;
      })}
      <p className="window-settings-hint">지수는 1개 이상 선택합니다.</p>
    </WindowSettingsGroup>
    <WindowSettingsGroup title="종목">
      <SettingsRow controlId={`${id}-stock`} label="그룹 종목 표시">
        <ToggleSwitch id={`${id}-stock`} label="그룹 종목 표시" checked={settings.showStock}
          onClick={() => onChange({ showStock: !settings.showStock })} />
      </SettingsRow>
    </WindowSettingsGroup>
  </WindowSettingsEditor>;
}
