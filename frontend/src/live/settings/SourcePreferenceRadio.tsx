// frontend/src/live/settings/SourcePreferenceRadio.tsx
import { useSourcePreferenceStore, type SourcePreference } from '../../state/sourcePreference';

export default function SourcePreferenceRadio({ value }: { value: SourcePreference }) {
  const current = useSourcePreferenceStore((s) => s.sourcePreference);
  const setPref = useSourcePreferenceStore((s) => s.setSourcePreference);
  const labelMap: Record<SourcePreference, string> = {
    hogaplay: 'hogaplay 우선',
    kis_live: 'kis_live 우선',
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="source-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>{labelMap[value]}</span>
    </label>
  );
}
