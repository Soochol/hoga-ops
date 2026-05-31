import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StalenessChip } from './StalenessChip';
import type { ScreenerStatus } from '../api/screener';

const base: ScreenerStatus = { status: 'ok', last_raw_date: '20260514' };

function chip(status: ScreenerStatus) {
  render(<StalenessChip status={status} />);
  return screen.getByTestId('staleness-chip');
}

describe('StalenessChip', () => {
  it('days_behind === 0 → neutral (--fg-dim), no behind text', () => {
    const el = chip({ ...base, days_behind: 0 });
    expect(el.style.color).toBe('var(--fg-dim)');
    expect(el.textContent).not.toMatch(/거래일 뒤처짐/);
    expect(el.textContent).toContain('20260514');
  });

  it('days_behind >= 1 → amber (--warn) + shows count', () => {
    const el = chip({ ...base, days_behind: 2 });
    expect(el.style.color).toBe('var(--warn)');
    expect(el.textContent).toMatch(/2거래일 뒤처짐/);
  });

  it('days_behind === null (KRX outage / unknown) → neutral, no amber', () => {
    const el = chip({ ...base, days_behind: null });
    expect(el.style.color).toBe('var(--fg-dim)');
    expect(el.textContent).not.toMatch(/거래일 뒤처짐/);
  });

  it('days_behind undefined-but-status-ok → neutral', () => {
    const el = chip({ ...base });
    expect(el.style.color).toBe('var(--fg-dim)');
    expect(el.textContent).not.toMatch(/거래일 뒤처짐/);
  });
});
