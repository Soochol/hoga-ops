import { describe, expect, it } from 'vitest';
import { fmtDate, fmtShortDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';

describe('format', () => {
  it('fmtDate: YYYYMMDD → YYYY-MM-DD', () => {
    expect(fmtDate('20260522')).toBe('2026-05-22');
  });

  it('fmtShortDate: YYYYMMDD → MM-DD', () => {
    expect(fmtShortDate('20260522')).toBe('05-22');
  });

  it('fmtTime: ms → fixed-width "MM-DD HH:mm" in KST', () => {
    // 고정폭 24h — 로케일 기본형(오전/오후)은 값마다 폭이 달라 tnum 열 리듬을 깬다.
    expect(fmtTime(Date.UTC(2026, 4, 22, 6, 30))).toBe('05-22 15:30'); // 15:30 KST
    // KST 자정 경계 — UTC 22일 20:00 = KST 23일 05:00 (날짜가 하루 넘어간다)
    expect(fmtTime(Date.UTC(2026, 4, 22, 20, 0))).toBe('05-23 05:00');
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
