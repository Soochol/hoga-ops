import { describe, it, expect } from 'vitest';
import { parseReplayUrl, emitReplayUrl } from './url';

describe('parseReplayUrl — timeframe (4-part format with legacy fallback)', () => {
  it('parses 4-part segment with timeframe', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520:5m&active=0');
    expect(r.tabs).toHaveLength(1);
    expect(r.tabs[0].timeframe).toBe('5m');
  });

  it('defaults timeframe to 1m on legacy 3-part segment', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520&active=0');
    expect(r.tabs).toHaveLength(1);
    expect(r.tabs[0].timeframe).toBe('1m');
  });

  it('drops segment with invalid timeframe', () => {
    const r = parseReplayUrl('?tabs=005930:20260512:20260520:99m&active=0');
    expect(r.tabs).toHaveLength(0);
  });

  it('handles all six valid timeframes', () => {
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m'] as const) {
      const r = parseReplayUrl(`?tabs=005930:20260512:20260520:${tf}&active=0`);
      expect(r.tabs[0].timeframe).toBe(tf);
    }
  });
});

describe('emitReplayUrl — timeframe (always 4-part)', () => {
  it('always emits 4-part segments', () => {
    const s = emitReplayUrl(
      [{ code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '5m' }],
      0,
    );
    expect(s).toBe('?tabs=005930:20260512:20260520:5m&active=0');
  });

  it('round-trip preserves timeframe', () => {
    const tabs = [
      { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '5m' as const },
      { code: '000660', fromDate: '20260513', toDate: '20260513', timeframe: '1m' as const },
    ];
    const url = emitReplayUrl(tabs, 1);
    const parsed = parseReplayUrl(url);
    expect(parsed.tabs).toHaveLength(2);
    expect(parsed.tabs[0].timeframe).toBe('5m');
    expect(parsed.tabs[1].timeframe).toBe('1m');
    expect(parsed.active).toBe(1);
  });
});
