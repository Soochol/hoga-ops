// frontend/src/live/settings/SourcePreferenceRadio.tsx
import { getSourcePreferenceLabel } from '../../api/sourceCapabilities';
import { useSourcePreferenceStore, type SourcePreference } from '../../state/sourcePreference';

export default function SourcePreferenceRadio({ value }: { value: SourcePreference }) {
  const current = useSourcePreferenceStore((s) => s.sourcePreference);
  const setPref = useSourcePreferenceStore((s) => s.setSourcePreference);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="source-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>{getSourcePreferenceLabel(value)}</span>
    </label>
  );
}
