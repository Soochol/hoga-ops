import { describe, expect, it } from 'vitest';
import { formatLiveViewLabel, formatTimeframeLabel } from './liveViewLabel';

describe('liveViewLabel', () => {
  it('formats minute and calendar timeframe labels', () => {
    expect(formatTimeframeLabel('1m')).toBe('1분봉');
    expect(formatTimeframeLabel('5m')).toBe('5분봉');
    expect(formatTimeframeLabel('D')).toBe('일봉');
    expect(formatTimeframeLabel('W')).toBe('주봉');
    expect(formatTimeframeLabel('M')).toBe('월봉');
  });

  it('appends the timeframe label when available', () => {
    expect(formatLiveViewLabel('삼성전자', 'D')).toBe('삼성전자 일봉');
    expect(formatLiveViewLabel('005930', null)).toBe('005930');
  });
});
