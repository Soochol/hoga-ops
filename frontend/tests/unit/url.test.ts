import { describe, it, expect } from 'vitest';
import { parseReplayUrl, emitReplayUrl } from '../../src/state/url';

describe('parseReplayUrl', () => {
  it('returns empty when no tabs param', () => {
    expect(parseReplayUrl('')).toEqual({ tabs: [], active: 0 });
    expect(parseReplayUrl('?foo=bar')).toEqual({ tabs: [], active: 0 });
  });

  it('parses single tab', () => {
    expect(parseReplayUrl('?tabs=005930:20260518:20260520&active=0')).toEqual({
      tabs: [{ code: '005930', fromDate: '20260518', toDate: '20260520' }],
      active: 0,
    });
  });

  it('parses two tabs with active=1', () => {
    const r = parseReplayUrl('?tabs=005930:20260518:20260520,000660:20260520:20260520&active=1');
    expect(r.tabs).toHaveLength(2);
    expect(r.active).toBe(1);
  });

  it('drops invalid entries silently', () => {
    const r = parseReplayUrl('?tabs=BAD,005930:20260518:20260520,xx:yy:zz&active=0');
    expect(r.tabs).toEqual([{ code: '005930', fromDate: '20260518', toDate: '20260520' }]);
  });

  it('clamps out-of-range active to 0', () => {
    const r = parseReplayUrl('?tabs=005930:20260518:20260520&active=5');
    expect(r.active).toBe(0);
  });
});

describe('emitReplayUrl', () => {
  it('returns empty when all tabs are null', () => {
    expect(emitReplayUrl([null, null], 0)).toBe('');
  });

  it('skips null tabs and remaps active', () => {
    const sel = { code: '005930', fromDate: '20260518', toDate: '20260520' };
    expect(emitReplayUrl([null, sel, null], 1)).toBe('?tabs=005930:20260518:20260520&active=0');
  });

  it('round-trips a 2-tab URL', () => {
    const url = '?tabs=005930:20260518:20260520,000660:20260520:20260520&active=1';
    const parsed = parseReplayUrl(url);
    const sel: (typeof parsed.tabs[0] | null)[] = parsed.tabs;
    expect(emitReplayUrl(sel, parsed.active)).toBe(url);
  });
});
