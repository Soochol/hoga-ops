import { describe, it, expect } from 'vitest';
import { captureHealthLabel, captureHealthSeverity } from './captureHealthPill';

describe('captureHealthPill', () => {
  it('healthy → ok, 라벨은 SSE "LIVE●"와 구분되는 "수신●"', () => {
    expect(captureHealthSeverity(true, 'healthy')).toBe('ok');
    // SSE 연결 span이 이미 'LIVE●'를 표시하므로(LiveStatusBar) 캡처 pill이
    // 같은 글자면 'LIVE● · LIVE●' 중복 글리치 → 도메인어 '수신●'으로 분리.
    expect(captureHealthLabel(true, 'healthy')).toBe('수신●');
    expect(captureHealthLabel(true, 'healthy')).not.toBe('LIVE●');
    // healthy '수신●' ↔ stale '수신 끊김' 도메인 쌍 일관.
    expect(captureHealthLabel(false, 'stale')).toBe('수신 끊김');
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
