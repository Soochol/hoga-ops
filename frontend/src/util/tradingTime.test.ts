import { describe, it, expect } from 'vitest';
import { formatHhmm, parseTradingTimeInput } from './tradingTime';

describe('formatHhmm', () => {
  it('HHMM 정수를 zero-padded HH:MM으로', () => {
    expect(formatHhmm(900)).toBe('09:00');
    expect(formatHhmm(930)).toBe('09:30');
    expect(formatHhmm(1005)).toBe('10:05');
    expect(formatHhmm(1520)).toBe('15:20');
  });
});

describe('parseTradingTimeInput', () => {
  it('네 자리/세 자리 HHMM 입력', () => {
    expect(parseTradingTimeInput('0900')).toBe(900);
    expect(parseTradingTimeInput('930')).toBe(930);
    expect(parseTradingTimeInput('1520')).toBe(1520);
  });

  it('콜론 형식 입력', () => {
    expect(parseTradingTimeInput('09:00')).toBe(900);
    expect(parseTradingTimeInput('9:30')).toBe(930);
    expect(parseTradingTimeInput('10:05')).toBe(1005);
  });

  it('장중 창(09:00–15:20) 밖은 null', () => {
    expect(parseTradingTimeInput('0859')).toBeNull(); // 개장 전
    expect(parseTradingTimeInput('1521')).toBeNull(); // 마감 동시호가 이후
    expect(parseTradingTimeInput('16:00')).toBeNull();
    expect(parseTradingTimeInput('09:75')).toBeNull(); // 분 범위 초과
  });

  it('빈 문자열/비수치는 null', () => {
    expect(parseTradingTimeInput('')).toBeNull();
    expect(parseTradingTimeInput('  ')).toBeNull();
    expect(parseTradingTimeInput('abc')).toBeNull();
  });
});
