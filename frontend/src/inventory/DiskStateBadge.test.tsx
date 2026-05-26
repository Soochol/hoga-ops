import { describe, expect, it } from 'vitest';
import {
  aggregateDiskState,
  isRecapturable,
  RECAPTURABLE_DISK_STATES,
  STATE_SEVERITY,
} from './DiskStateBadge';

describe('STATE_SEVERITY', () => {
  it('orders states from worst (highest rank) to best (lowest)', () => {
    expect(STATE_SEVERITY.invalid).toBeGreaterThan(STATE_SEVERITY.client_incomplete);
    expect(STATE_SEVERITY.client_incomplete).toBeGreaterThan(STATE_SEVERITY.source_partial);
    expect(STATE_SEVERITY.source_partial).toBeGreaterThan(STATE_SEVERITY.complete);
  });
});

describe('aggregateDiskState', () => {
  it('returns invalid when any state is invalid', () => {
    expect(aggregateDiskState(['complete', 'invalid', 'source_partial'])).toBe('invalid');
  });
  it('returns client_incomplete when no invalid but some client_incomplete', () => {
    expect(aggregateDiskState(['complete', 'client_incomplete', 'source_partial'])).toBe('client_incomplete');
  });
  it('returns source_partial when only source_partial is non-complete', () => {
    expect(aggregateDiskState(['complete', 'source_partial', 'complete'])).toBe('source_partial');
  });
  it('returns complete when all are complete', () => {
    expect(aggregateDiskState(['complete', 'complete'])).toBe('complete');
  });
  it('returns complete for empty input', () => {
    expect(aggregateDiskState([])).toBe('complete');
  });
});

describe('isRecapturable', () => {
  it('returns false for complete', () => {
    expect(isRecapturable('complete')).toBe(false);
  });
  it('returns true for source_partial', () => {
    expect(isRecapturable('source_partial')).toBe(true);
  });
  it('returns true for client_incomplete', () => {
    expect(isRecapturable('client_incomplete')).toBe(true);
  });
  it('returns true for invalid', () => {
    expect(isRecapturable('invalid')).toBe(true);
  });
});

describe('RECAPTURABLE_DISK_STATES', () => {
  it('excludes complete', () => {
    expect(RECAPTURABLE_DISK_STATES).not.toContain('complete');
  });
  it('includes source_partial, client_incomplete, invalid', () => {
    expect(RECAPTURABLE_DISK_STATES).toEqual(
      expect.arrayContaining(['source_partial', 'client_incomplete', 'invalid']),
    );
    expect(RECAPTURABLE_DISK_STATES).toHaveLength(3);
  });
  it('is the source of truth — isRecapturable derives from it', () => {
    for (const s of RECAPTURABLE_DISK_STATES) {
      expect(isRecapturable(s)).toBe(true);
    }
    expect(isRecapturable('complete')).toBe(false);
  });
});
