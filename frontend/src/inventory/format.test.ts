import { describe, expect, it } from 'vitest';
import { fmtDate, fmtShortDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';

describe('format', () => {
  it('fmtDate: YYYYMMDD → YYYY-MM-DD', () => {
    expect(fmtDate('20260522')).toBe('2026-05-22');
  });

  it('fmtShortDate: YYYYMMDD → MM-DD', () => {
    expect(fmtShortDate('20260522')).toBe('05-22');
  });

  it('fmtTime: ms → ko-KR short datetime in Asia/Seoul', () => {
    const result = fmtTime(Date.UTC(2026, 4, 22, 6, 30)); // 15:30 KST
    expect(result).toMatch(/26/); // ko-KR short = "26. 5. 22."
    expect(result).toMatch(/3:30/); // 15:30 KST → "PM 3:30" in ko-KR
  });

  it('fmtSize: bytes → "X.X MB"', () => {
    expect(fmtSize(13_421_772)).toBe('12.8 MB');
    expect(fmtSize(0)).toBe('0.0 MB');
  });

  it('fmtOHLC: close >= open uses ↑, else ↓', () => {
    expect(fmtOHLC(70_000, 72_400)).toBe('72,400 ↑');
    expect(fmtOHLC(72_000, 70_900)).toBe('70,900 ↓');
    expect(fmtOHLC(72_000, 72_000)).toBe('72,000 ↑'); // tie → up
  });

  it('fmtVolume: large numbers → K/M/B with ko-KR-style separators when small', () => {
    expect(fmtVolume(52_100_000)).toBe('52.1M');
    expect(fmtVolume(1_240_000_000)).toBe('1.24B');
    expect(fmtVolume(750)).toBe('750');
  });
});
