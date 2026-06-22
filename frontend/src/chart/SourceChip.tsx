import type { SourceName } from '../api/types';

interface Props {
  source: SourceName | undefined;
}

const SOURCE_LABEL: Record<SourceName, string> = {
  hogaplay: 'hogaplay',
  kis_live: 'KIS WS',
  kis_api: 'KIS API',
};

const RESOLUTION: Record<SourceName, string> = {
  hogaplay: 'tick',
  kis_live: '10s',
  kis_api: '30s',
};

/**
 * Source identity chip — surfaces which capture source produced the
 * currently-displayed Stock-Date segment. ADR-0039 makes Source Preference
 * a preference (not a filter), so fallbacks happen silently; the chip is
 * how users see what actually got rendered.
 *
 * Resolution suffix (Audit Addendum C2) prevents the "data lost?" confusion
 * users might have when toggling kis_live and seeing sparser data.
 */
export function SourceChip({ source }: Props) {
  if (!source) return null;
  const bgVar = `var(--source-${source.replace('_', '-')}-bg)`;
  const borderVar = `var(--source-${source.replace('_', '-')}-border)`;

  return (
    <span
      data-testid={`source-chip-${source}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-xs)',
        padding: '0 var(--space-sm)',
        height: '1.2rem',
        background: bgVar,
        border: `1px solid ${borderVar}`,
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-xs)',
        fontFamily: 'monospace',
        color: 'var(--fg-dim)',
      }}
    >
      <span>{SOURCE_LABEL[source]}</span>
      <span aria-hidden style={{ color: 'var(--fg-dimmer)' }}>·</span>
      <span style={{ color: 'var(--fg-dimmer)' }}>{RESOLUTION[source]}</span>
    </span>
  );
}
