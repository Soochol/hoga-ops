import { describe, expect, it } from 'vitest';
import { normalizeOrderSettings, quantityForAmount } from './orderWindowSettings';

describe('주문 금액 변환과 설정 복구', () => {
  it('백만원을 클릭 호가의 정수 주수로 변환하고 한 주 미만·잘못된 금액을 구분한다', () => {
    expect(quantityForAmount(5, 67200)).toBe(74);
    expect(quantityForAmount(5, 68000)).toBe(73);
    expect(quantityForAmount(1, 1469000)).toBe(0);
    expect(quantityForAmount(2, 100000)).toBe(20);
    for (const amount of [0, -1, 1.5, Infinity, 1000001]) expect(quantityForAmount(amount, 100000)).toBeNull();
    for (const price of [0, -1, Infinity, 0.5]) expect(quantityForAmount(1, price)).toBeNull();
  });
  it('손상된 저장 필드만 복구하고 수량·금액 프리셋 사본을 만든다', () => {
    const raw = { unit: 'amount', quantityPresets: [25, 1.5, -1], amountPresets: [2, 6, 12] };
    const restored = normalizeOrderSettings(raw);
    expect(restored).toEqual({ unit: 'amount', quantityPresets: [25, 50, 100], amountPresets: [2, 6, 12] });
    restored.amountPresets[0] = 99;
    expect(raw.amountPresets[0]).toBe(2);
    expect(normalizeOrderSettings({ unit: 'invalid', amountPresets: null }).unit).toBe('quantity');
  });
});
