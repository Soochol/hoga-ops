import { describe, it, expect } from 'vitest';
import { captureHealthLabel, captureHealthSeverity } from './captureHealthPill';

describe('captureHealthPill', () => {
  it('healthy → ok, 라벨 LIVE', () => {
    expect(captureHealthSeverity(true, 'healthy')).toBe('ok');
    expect(captureHealthLabel(true, 'healthy')).toMatch(/LIVE|실시간/);
  });
  it('sub_failed/stale → error (캡처 죽음, 빨강)', () => {
    expect(captureHealthSeverity(false, 'sub_failed')).toBe('error');
    expect(captureHealthSeverity(false, 'stale')).toBe('error');
  });
  it('reconnecting/subscribing → warn (전환 중, 앰버)', () => {
    expect(captureHealthSeverity(false, 'reconnecting')).toBe('warn');
    expect(captureHealthSeverity(false, 'subscribing')).toBe('warn');
  });
  it('offline/closed → ok-회색 (미기동·장마감은 장애 아님)', () => {
    expect(captureHealthSeverity(false, 'offline')).toBe('ok');
    expect(captureHealthSeverity(false, 'closed')).toBe('ok');  // 밤·주말 거짓-앰버 방지
  });
});
