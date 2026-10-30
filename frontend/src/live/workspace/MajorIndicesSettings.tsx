import type { MajorIndicesSettings as Settings } from '../../state/majorIndicesSettings';
import { MAJOR_INDICES } from './majorIndicesModel';

export function MajorIndicesSettings({ settings, onChange }: {
  settings: Settings; onChange: (patch: Partial<Settings>) => void;
}) {
  return <div className="major-indices-settings space-y-3 p-3 text-sm">
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium">표시 지수</legend>
      {MAJOR_INDICES.map(index => {
        const checked = settings.indices.includes(index.id);
        return <label key={index.id} className="flex items-center gap-2">
          <input type="checkbox" checked={checked} disabled={checked && settings.indices.length === 1}
            onChange={event => onChange({ indices: event.target.checked
              ? [...settings.indices, index.id] : settings.indices.filter(id => id !== index.id) })} />
          <span>{index.label}</span>
        </label>;
      })}
      <p className="text-xs text-fg-dim">지수는 1개 이상 선택합니다.</p>
    </fieldset>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={settings.showStock}
        onChange={event => onChange({ showStock: event.target.checked })} />
      <span>그룹 종목 표시</span>
    </label>
  </div>;
}
