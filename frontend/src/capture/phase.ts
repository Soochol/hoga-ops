import type { CalendarStatus, CapturePhase, SkipReason } from '../api/types';

/** Display-time descriptor for a CapturePhase. The single source of truth for
 *  phase presentation in the frontend — adding a new phase means adding one row
 *  to PHASE; TypeScript's Record<CapturePhase, _> exhaustiveness flags any miss.
 */
export interface PhaseDescriptor {
  icon: string;          // ○ ● ✓ ✕ ⚠
  chipColor: string;     // rgba(...) tint for the phase chip background
  group: 'active' | 'queued' | 'terminal';
  terminal: boolean;
}

const TEAL_TINT = 'rgba(20,184,166,0.12)';
const UP_TINT = 'rgba(34,197,94,0.10)';
const DOWN_TINT = 'rgba(244,63,94,0.10)';
const NEUTRAL_TINT = 'rgba(148,163,184,0.10)';

export const PHASE: Record<CapturePhase, PhaseDescriptor> = {
  queued:    { icon: '○', chipColor: NEUTRAL_TINT, group: 'queued',   terminal: false },
  deciding:  { icon: '●', chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  capturing: { icon: '●', chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  parsing:   { icon: '●', chipColor: TEAL_TINT,    group: 'active',   terminal: false },
  done:      { icon: '✓', chipColor: UP_TINT,      group: 'terminal', terminal: true  },
  failed:    { icon: '✕', chipColor: DOWN_TINT,    group: 'terminal', terminal: true  },
  cancelled: { icon: '✕', chipColor: NEUTRAL_TINT, group: 'terminal', terminal: true  },
  skipped:   { icon: '⚠', chipColor: NEUTRAL_TINT, group: 'terminal', terminal: true  },
};

/** Fallback for wire drift — a backend phase added before the frontend's
 *  CapturePhase union is updated would otherwise hit `PHASE[unknown]` →
 *  undefined → TypeError mid-render. Renders as a `?` neutral chip so the
 *  queue stays alive while the type mismatch is noticed. terminal=true so
 *  the row gets no action button (safer than offering cancel on something
 *  we don't understand). */
const UNKNOWN_PHASE: PhaseDescriptor = {
  icon: '?',
  chipColor: NEUTRAL_TINT,
  group: 'terminal',
  terminal: true,
};

/** Look up a phase descriptor with runtime safety. Always returns a
 *  PhaseDescriptor — falls back to UNKNOWN_PHASE for any string outside
 *  the CapturePhase union (defends against wire drift mid-deploy). */
export function getPhase(phase: string): PhaseDescriptor {
  return PHASE[phase as CapturePhase] ?? UNKNOWN_PHASE;
}

/** Display order: active items first, then queued, then terminals at the bottom. */
export const GROUP_ORDER: Record<PhaseDescriptor['group'], number> = {
  active: 0,
  queued: 1,
  terminal: 2,
};

/** Map a terminal CapturePhase + skip_reason to the CalendarStatus that should
 *  appear in the picker. Returns null for non-terminal phases (no calendar
 *  update is owed until the item resolves).
 */
export function phaseToCalendarStatus(
  phase: CapturePhase,
  skipReason: SkipReason | null,
): CalendarStatus | null {
  if (phase === 'done') return 'complete';
  if (phase === 'skipped') return skipReason === 'source_partial' ? 'source_partial' : 'complete';
  if (phase === 'failed' || phase === 'cancelled') return 'client_incomplete';
  return null;
}
