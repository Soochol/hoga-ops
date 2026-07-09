import { describe, expect, it } from 'vitest';
import { PHASE, GROUP_ORDER, getPhase, phaseToCalendarStatus } from './phase';
import type { CapturePhase } from '../api/types';

describe('PHASE descriptor table', () => {
  it('covers every CapturePhase (exhaustive Record)', () => {
    const expected: CapturePhase[] = [
      'queued', 'deciding', 'capturing', 'parsing',
      'done', 'failed', 'cancelled', 'skipped',
    ];
    for (const p of expected) {
      expect(PHASE[p]).toBeDefined();
    }
  });

  it('icon mapping per phase', () => {
    expect(PHASE.done.icon).toBe('✓');
    expect(PHASE.failed.icon).toBe('✕');
    expect(PHASE.cancelled.icon).toBe('✕');
    expect(PHASE.skipped.icon).toBe('⚠');
    expect(PHASE.capturing.icon).toBe('●');
    expect(PHASE.parsing.icon).toBe('●');
    expect(PHASE.deciding.icon).toBe('●');
    expect(PHASE.queued.icon).toBe('○');
  });

  it('chipColor: shared selection tint for in-progress, up tint for done, down tint for failed', () => {
    expect(PHASE.capturing.chipColor).toBe('var(--tint-selection)');
    expect(PHASE.parsing.chipColor).toBe('var(--tint-selection)');
    expect(PHASE.deciding.chipColor).toBe('var(--tint-selection)');
    expect(PHASE.done.chipColor).toContain('34,197,94');
    expect(PHASE.failed.chipColor).toContain('244,63,94');
  });

  it('group: active for in-flight, queued for waiting, terminal for resolved', () => {
    expect(PHASE.deciding.group).toBe('active');
    expect(PHASE.capturing.group).toBe('active');
    expect(PHASE.parsing.group).toBe('active');
    expect(PHASE.queued.group).toBe('queued');
    expect(PHASE.done.group).toBe('terminal');
    expect(PHASE.failed.group).toBe('terminal');
    expect(PHASE.cancelled.group).toBe('terminal');
    expect(PHASE.skipped.group).toBe('terminal');
  });

  it('terminal flag matches the terminal phase set', () => {
    const terminals: CapturePhase[] = ['done', 'failed', 'cancelled', 'skipped'];
    for (const p of Object.keys(PHASE) as CapturePhase[]) {
      expect(PHASE[p].terminal).toBe(terminals.includes(p));
    }
  });
});

describe('getPhase (wire-drift fallback)', () => {
  it('returns the matching descriptor for a known phase', () => {
    expect(getPhase('done')).toBe(PHASE.done);
    expect(getPhase('capturing')).toBe(PHASE.capturing);
  });

  it('returns a safe fallback descriptor for an unknown phase string', () => {
    // Backend ships a new phase before the frontend's CapturePhase union
    // is updated — getPhase must not throw or return undefined.
    const unknown = getPhase('paused-future-phase');
    expect(unknown).toBeDefined();
    expect(unknown.icon).toBe('?');
    expect(unknown.terminal).toBe(true);
    expect(unknown.group).toBe('terminal');
  });

  it('fallback keeps queue rendering alive (no exception on property access)', () => {
    // Regression guard for the pre-helper crash: PHASE[unknown] → undefined →
    // accessing .terminal threw TypeError mid-render.
    expect(() => {
      const d = getPhase('totally-bogus');
      void d.icon;
      void d.chipColor;
      void d.group;
      void d.terminal;
    }).not.toThrow();
  });
});

describe('GROUP_ORDER (display order: active → queued → terminal)', () => {
  it('active < queued < terminal', () => {
    expect(GROUP_ORDER.active).toBeLessThan(GROUP_ORDER.queued);
    expect(GROUP_ORDER.queued).toBeLessThan(GROUP_ORDER.terminal);
  });
});

describe('phaseToCalendarStatus', () => {
  it('done → complete', () => {
    expect(phaseToCalendarStatus('done', null)).toBe('complete');
  });

  it('skipped + source_partial → source_partial (preserves disk state)', () => {
    expect(phaseToCalendarStatus('skipped', 'source_partial')).toBe('source_partial');
  });

  it('skipped + already_complete → complete', () => {
    expect(phaseToCalendarStatus('skipped', 'already_complete')).toBe('complete');
  });

  it('skipped + upstream_gap → source_partial (ADR-0093: confirmed gap stays partial)', () => {
    expect(phaseToCalendarStatus('skipped', 'upstream_gap')).toBe('source_partial');
  });

  it('failed / cancelled → client_incomplete', () => {
    expect(phaseToCalendarStatus('failed', null)).toBe('client_incomplete');
    expect(phaseToCalendarStatus('cancelled', null)).toBe('client_incomplete');
  });

  it('non-terminal phases return null (no calendar update yet)', () => {
    expect(phaseToCalendarStatus('queued', null)).toBeNull();
    expect(phaseToCalendarStatus('deciding', null)).toBeNull();
    expect(phaseToCalendarStatus('capturing', null)).toBeNull();
    expect(phaseToCalendarStatus('parsing', null)).toBeNull();
  });
});

describe('phaseToCalendarStatus (no_upstream_data)', () => {
  it('maps skipped + no_upstream_data to no_upstream_data calendar status', () => {
    expect(phaseToCalendarStatus('skipped', 'no_upstream_data')).toBe('no_upstream_data');
  });

  it('regression: skipped + source_partial still maps to source_partial', () => {
    expect(phaseToCalendarStatus('skipped', 'source_partial')).toBe('source_partial');
  });

  it('regression: skipped + already_complete still maps to complete', () => {
    expect(phaseToCalendarStatus('skipped', 'already_complete')).toBe('complete');
  });
});
