import { describe, it, expect } from 'vitest';
import { cycleLagSeverity, type CycleLagSeverity } from './cycleLagPill';

describe('cycleLagSeverity', () => {
  it.each<[number, CycleLagSeverity]>([
    [0, 'ok'],
    [1_000, 'ok'],
    [1_999, 'ok'],
    [2_000, 'warn'],
    [9_999, 'warn'],
    [10_000, 'error'],
    [30_000, 'error'],
  ])('cycle_lag_ms %d → %s', (lag, expected) => {
    expect(cycleLagSeverity(lag)).toBe(expected);
  });
});
