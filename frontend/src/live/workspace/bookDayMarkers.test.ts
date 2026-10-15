import { describe, expect, it } from 'vitest';
import { EMPTY_TRADE_SUMMARY } from '../liveSidebarAdapters';
import { bookDayMarkers } from './bookDayMarkers';

describe('시고저 최근접 호가', () => {
  it('정확한 가격을 유지하고 원본 가격을 설명한다', () => {
    const markers = bookDayMarkers([223000, 222500, 222000], {
      ...EMPTY_TRADE_SUMMARY, dayHigh: 223000, dayOpen: 222500, dayLow: 222000,
    });
    expect([...markers].map(([price, marker]) => [price, marker.label, marker.tooltip])).toEqual([
      [223000, '고', '고가 223,000원'], [222000, '저', '저가 222,000원'], [222500, '시', '시가 222,500원'],
    ]);
  });

  it.each([[223000, 222000], [222000, 223000]])('중간 체결은 호가 순서 %j와 무관하게 동률이면 낮은 가격을 고른다', (...prices) => {
    const markers = bookDayMarkers(prices, { ...EMPTY_TRADE_SUMMARY, dayOpen: 222500 });
    expect([...markers.keys()]).toEqual([222000]);
    expect(markers.get(222000)?.tooltip).toBe('시가 222,500원 · 가장 가까운 호가 222,000원');
  });

  it('모든 유효 호가 중 거리로 고르므로 더 가까운 위쪽 가격도 선택한다', () => {
    const markers = bookDayMarkers([224000, 223000, 222000, 221000], {
      ...EMPTY_TRADE_SUMMARY, dayHigh: 223800, dayOpen: 222600, dayLow: 221100,
    });
    expect([...markers].map(([price, marker]) => [price, marker.label])).toEqual([
      [224000, '고'], [221000, '저'], [223000, '시'],
    ]);
  });

  it('전체 범위 밖은 끝 행으로 당기지 않고 경계 가격은 표시한다', () => {
    expect(bookDayMarkers([222000, 223000], {
      ...EMPTY_TRADE_SUMMARY, dayHigh: 223001, dayLow: 221999,
    }).size).toBe(0);
    expect(bookDayMarkers([222000, 223000], {
      ...EMPTY_TRADE_SUMMARY, dayHigh: 223000, dayLow: 222000,
    }).size).toBe(2);
  });

  it('서로 다른 실제 가격이 같은 행에 모여도 고 > 저 > 시 하나만 표시한다', () => {
    const prices = [226000, 223000, 220000];
    const summary = { ...EMPTY_TRADE_SUMMARY, dayHigh: 223400, dayLow: 223100, dayOpen: 223200 };
    expect([...bookDayMarkers(prices, summary).values()].map(marker => marker.label)).toEqual(['고']);
    expect([...bookDayMarkers(prices, { ...summary, dayHigh: null }).values()].map(marker => marker.label)).toEqual(['저']);
  });

  it.each([null, 0, -1, NaN, Infinity])('미제공·잘못된 시고저 %s는 숨긴다', value => {
    expect(bookDayMarkers([222000, 223000], {
      ...EMPTY_TRADE_SUMMARY, dayOpen: value, dayHigh: value, dayLow: value,
    }).size).toBe(0);
  });

  it('빈 호가와 패딩을 제외하고 중복된 가격은 하나로 계산한다', () => {
    const summary = { ...EMPTY_TRADE_SUMMARY, dayOpen: 222500 };
    expect(bookDayMarkers([], summary).size).toBe(0);
    expect(bookDayMarkers([0, -1, NaN, Infinity], summary).size).toBe(0);
    expect([...bookDayMarkers([0, 223000, 222000, 222000, NaN], summary).keys()]).toEqual([222000]);
    expect(bookDayMarkers([0, 223000], summary).size).toBe(0);
  });
});
