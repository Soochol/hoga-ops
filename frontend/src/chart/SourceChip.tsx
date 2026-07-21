import type { SourceName } from '../api/types';
import { getSourceCapability } from '../api/sourceCapabilities';

interface Props {
  source: SourceName | undefined;
}

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
  const capability = getSourceCapability(source);
  const bgVar = `var(--source-${capability.cssTokenName}-bg)`;

  return (
    <span
      data-testid={`source-chip-${source}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-xs)',
        padding: '0 var(--space-sm)',
        height: '1.2rem',
        // 외곽선 제거(2026-07-15 borderless) — 소스별 bg 틴트(kis_live=accent 12%,
        // hogaplay=bg-card)가 칩을 구분한다.
        background: bgVar,
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-xs)',
        // Was a literal 'monospace' — the design system has no monospace face
        // as of 2026-07-21, so that resolved to whatever the OS picked.
        fontFamily: 'var(--font-data)',
        color: 'var(--fg-dim)',
      }}
    >
      <span>{capability.label}</span>
      <span aria-hidden style={{ color: 'var(--fg-dimmer)' }}>·</span>
      <span style={{ color: 'var(--fg-dimmer)' }}>{capability.resolutionLabel}</span>
    </span>
  );
}
