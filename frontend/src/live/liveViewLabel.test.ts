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

  it('formats live tab labels with change percent and active ratio multiple', () => {
    expect(formatLiveViewLabel('삼성전자', '1m', { changePct: 2.14, ratioX: 1.32 })).toBe('삼성전자 +2.14% · 1.32x');
    expect(formatLiveViewLabel('SK하이닉스', '1m', { changePct: -0.8 })).toBe('SK하이닉스 -0.80%');
  });

  it('omits the timeframe and metric suffix when live tab metrics are unavailable', () => {
    expect(formatLiveViewLabel('삼성전자', '1m', {})).toBe('삼성전자');
    expect(formatLiveViewLabel('삼성전자', '1m', { changePct: null, ratioX: 1.32 })).toBe('삼성전자');
  });
});
