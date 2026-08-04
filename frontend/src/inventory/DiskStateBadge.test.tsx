import { describe, expect, it } from 'vitest';
import {
  aggregateDiskState,
  displayStateFor,
  isRecapturable,
  RECAPTURABLE_DISK_STATES,
  STATE_SEVERITY,
} from './DiskStateBadge';

describe('displayStateFor', () => {
  it('확정 결손만 별도 표시 키로 갈라진다', () => {
    expect(displayStateFor('source_partial', true)).toBe('source_partial_confirmed');
    expect(displayStateFor('source_partial', false)).toBe('source_partial');
    expect(displayStateFor('source_partial', undefined)).toBe('source_partial');
  });

  it('source_partial 이 아니면 플래그를 무시한다', () => {
    // 확정 판정은 SOURCE_PARTIAL 전용이다(eligibility.is_terminal_partial).
    // 다른 상태에 플래그가 실려 와도 표시가 흔들리면 안 된다.
    for (const s of ['complete', 'client_incomplete', 'invalid'] as const) {
      expect(displayStateFor(s, true)).toBe(s);
    }
  });
});

describe('severity/정렬 축은 확정 여부와 무관하다', () => {
  it('확정 결손도 severity 상으로는 여전히 source_partial 이다', () => {
    // 표시만 가른 이유 — 확정은 "얼마나 심각한가" 가 아니라 "고칠 수 있는가" 다.
    // 정렬·집계·재캡처 게이트가 wire 의 disk_state 를 그대로 쓰게 남겨 둔다.
    expect(STATE_SEVERITY.source_partial).toBe(1);
    expect(isRecapturable('source_partial')).toBe(true);
  });
});

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
