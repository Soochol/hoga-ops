import { describe, it, expect } from 'vitest';
import { captureHealthLabel, captureHealthSeverity } from './captureHealthPill';

describe('captureHealthPill', () => {
  it('healthy → ok, 라벨 LIVE', () => {
    expect(captureHealthSeverity(true, 'healthy')).toBe('ok');
    expect(captureHealthLabel(true, 'healthy')).toMatch(/LIVE|실시간/);
  });
  it('registration_incomplete → error + 한글 라벨 (WS 는 붙었는데 REG ACK 미완)', () => {
    expect(captureHealthSeverity(false, 'registration_incomplete')).toBe('error');
    expect(captureHealthLabel(false, 'registration_incomplete')).toBe('구독 등록 미완');
  });
  it('미지 reason 은 원문 + error 로 떨어진다 (계약 스큐를 감추지 않는다)', () => {
    // 서버가 프론트보다 앞서 나가 새 reason 을 보낸 경우. 한글로 얼버무리면 스큐가
    // 안 보이므로, 낯선 토큰을 그대로 빨간 pill 에 노출한다.
    expect(captureHealthSeverity(false, 'brand_new_reason')).toBe('error');
    expect(captureHealthLabel(false, 'brand_new_reason')).toBe('brand_new_reason');
  });
  it('offline/closed → ok-회색 (미기동·장마감은 장애 아님)', () => {
    expect(captureHealthSeverity(false, 'offline')).toBe('ok');
    expect(captureHealthSeverity(false, 'closed')).toBe('ok');  // 밤·주말 거짓-앰버 방지
  });
});
