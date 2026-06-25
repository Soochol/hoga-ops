import { describe, it, expect } from 'vitest';
import {
  CALENDAR_STATUS,
  LEGEND_ORDER,
  markerFor,
  tooltipFor,
  isDisabled,
  legendText,
  baseColorVarFor,
} from './calendarStatus';
import type { CalendarStatus } from '../api/types';

describe('CALENDAR_STATUS table', () => {
  // Exhaustiveness is enforced at compile time by Record<CalendarStatus, _>,
  // but a runtime sanity check guards against accidental object-literal drift.
  it('has a row for every CalendarStatus union member', () => {
    const expected: CalendarStatus[] = [
      'complete', 'source_partial', 'client_incomplete', 'invalid',
      'none', 'weekend', 'holiday', 'future', 'today_locked', 'no_upstream_data',
    ];
    for (const s of expected) {
      expect(CALENDAR_STATUS[s]).toBeDefined();
    }
    expect(Object.keys(CALENDAR_STATUS).sort()).toEqual([...expected].sort());
  });

  it('every row has the required fields', () => {
    for (const [status, descriptor] of Object.entries(CALENDAR_STATUS)) {
      expect(typeof descriptor.disabled, status).toBe('boolean');
      expect(typeof descriptor.baseColorVar, status).toBe('string');
      // marker is either null or one of the 5 allowed glyphs
      expect([null, '✓', '⚠', '✕', '🔒', '–'], status).toContain(descriptor.marker);
      // tooltipSuffix is null or string
      expect(['object', 'string'], status).toContain(typeof descriptor.tooltipSuffix);
      // legendLabel is null or string
      expect(['object', 'string'], status).toContain(typeof descriptor.legendLabel);
    }
  });
});

describe('markerFor', () => {
  it('returns the descriptor marker for known statuses', () => {
    expect(markerFor('complete')).toBe('✓');
    expect(markerFor('source_partial')).toBe('⚠');
    expect(markerFor('client_incomplete')).toBe('✕');
    expect(markerFor('today_locked')).toBe('🔒');
    expect(markerFor('no_upstream_data')).toBe('–');
    expect(markerFor('weekend')).toBeNull();
    expect(markerFor('holiday')).toBeNull();
    expect(markerFor('future')).toBeNull();
    expect(markerFor('none')).toBeNull();
  });

  it('invalid reuses the broken glyph (ADR-0020 — distinct via tooltip)', () => {
    expect(markerFor('invalid')).toBe('✕');
    expect(markerFor('client_incomplete')).toBe('✕');
    // Distinguished by tooltip, not by marker.
    expect(tooltipFor('invalid', '20260319')).not.toBe(tooltipFor('client_incomplete', '20260319'));
  });
});

describe('tooltipFor', () => {
  it('joins `${date} · ${suffix}` when suffix is non-null', () => {
    expect(tooltipFor('complete', '20260319')).toBe('20260319 · captured (complete)');
    expect(tooltipFor('no_upstream_data', '20260319')).toBe('20260319 · no upstream data (retry on capture)');
  });

  it('returns just `${date}` when suffix is null (`none` status)', () => {
    expect(tooltipFor('none', '20260319')).toBe('20260319');
  });
});

describe('isDisabled', () => {
  it('disabled = true for weekend/holiday/future/today_locked', () => {
    expect(isDisabled('weekend')).toBe(true);
    expect(isDisabled('holiday')).toBe(true);
    expect(isDisabled('future')).toBe(true);
    expect(isDisabled('today_locked')).toBe(true);
  });

  it('no_upstream_data stays clickable so the next capture can retry', () => {
    expect(isDisabled('no_upstream_data')).toBe(false);
  });

  it('captured statuses (complete/source_partial/client_incomplete/invalid) are clickable', () => {
    expect(isDisabled('complete')).toBe(false);
    expect(isDisabled('source_partial')).toBe(false);
    expect(isDisabled('client_incomplete')).toBe(false);
    expect(isDisabled('invalid')).toBe(false);
  });
});

describe('legendText', () => {
  it('joins the visible legend chunks in LEGEND_ORDER', () => {
    expect(legendText()).toBe(
      'Legend: ✓ complete · ⚠ partial · ✕ broken · – no upstream data · 🔒 today < 17:00 KST'
    );
  });

  it('LEGEND_ORDER references real statuses only', () => {
    for (const s of LEGEND_ORDER) {
      expect(CALENDAR_STATUS[s]).toBeDefined();
    }
  });
});

describe('baseColorVarFor', () => {
  it('uses --fg-dim for today_locked and no_upstream_data (semi-dimmed)', () => {
    expect(baseColorVarFor('today_locked')).toBe('var(--fg-dim)');
    expect(baseColorVarFor('no_upstream_data')).toBe('var(--fg-dim)');
  });

  it('uses --fg-dimmer for non-trading days (most dimmed)', () => {
    expect(baseColorVarFor('weekend')).toBe('var(--fg-dimmer)');
    expect(baseColorVarFor('holiday')).toBe('var(--fg-dimmer)');
    expect(baseColorVarFor('future')).toBe('var(--fg-dimmer)');
  });
});
