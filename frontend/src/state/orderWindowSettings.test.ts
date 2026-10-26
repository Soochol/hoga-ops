import { describe, expect, it } from 'vitest';
import { normalizeOrderSettings, quantityForAmount, validOrderSettings } from './orderWindowSettings';

describe('주문 금액 변환과 설정 복구', () => {
  it.each([['showPriceSeparators', false], ['showPriceChangePercent', true]] as const)('%s는 구 저장값과 손상값을 기본값으로 복구하고 명시적 false도 유지한다', (key, fallback) => {
    expect(normalizeOrderSettings(undefined)[key]).toBe(fallback);
    for (const value of ['true', 'false', 1, null]) expect(normalizeOrderSettings({ [key]: value })[key]).toBe(fallback);
    for (const value of [true, false]) {
      const settings = normalizeOrderSettings({ [key]: value });
      expect(settings[key]).toBe(value);
      expect(validOrderSettings(settings)).toBe(true);
    }
    expect(validOrderSettings({ ...normalizeOrderSettings(null), [key]: undefined })).toBe(false);
  });
  it.each(['buyFillSound', 'sellFillSound'] as const)('%s는 기본 끔이며 명시적 켜기와 유효성 검사를 보존한다', key => {
    expect(normalizeOrderSettings(undefined)[key]).toBe(false);
    expect(normalizeOrderSettings({ [key]: true })[key]).toBe(true);
    for (const value of ['true', 1, null]) expect(normalizeOrderSettings({ [key]: value })[key]).toBe(false);
    expect(validOrderSettings(normalizeOrderSettings({ [key]: true }))).toBe(true);
    expect(validOrderSettings({ ...normalizeOrderSettings(null), [key]: undefined })).toBe(false);
  });
  it('수량 기억은 기존·손상된 설정에서 끄기로 복구하고 명시적 켜기를 보존한다', () => {
    expect(normalizeOrderSettings(undefined).rememberQuantity).toBe(false);
    expect(normalizeOrderSettings({ rememberQuantity: true }).rememberQuantity).toBe(true);
    for (const value of ['true', 1, null]) expect(normalizeOrderSettings({ rememberQuantity: value }).rememberQuantity).toBe(false);
    expect(validOrderSettings(normalizeOrderSettings({ rememberQuantity: true }))).toBe(true);
    expect(validOrderSettings({ ...normalizeOrderSettings(null), rememberQuantity: undefined } as unknown as ReturnType<typeof normalizeOrderSettings>)).toBe(false);
  });
  it('백만원을 적용 시점 현재가의 정수 주수로 변환하고 한 주 미만·잘못된 금액을 구분한다', () => {
    expect(quantityForAmount(1, 67300)).toBe(14);
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
    expect(restored).toEqual({ unit: 'amount', quantityPresets: [25, 50, 100], amountPresets: [2, 6, 12], showAveragePrice: true, showPriceSeparators: false, showPriceChangePercent: true, orderReceiptSound: false, buyFillSound: false, sellFillSound: false, rememberQuantity: false });
    restored.amountPresets[0] = 99;
    expect(raw.amountPresets[0]).toBe(2);
    expect(normalizeOrderSettings({ unit: 'invalid', amountPresets: null }).unit).toBe('quantity');
  });
  it('기존 저장 설정은 평단가 표시를 켜고 명시적으로 끈 설정은 유지한다', () => {
    expect(normalizeOrderSettings(undefined).showAveragePrice).toBe(true);
    expect(normalizeOrderSettings({ showAveragePrice: false }).showAveragePrice).toBe(false);
    for (const value of ['false', 0, null]) expect(normalizeOrderSettings({ showAveragePrice: value }).showAveragePrice).toBe(true);
    expect(validOrderSettings(normalizeOrderSettings({ showAveragePrice: false }))).toBe(true);
    expect(validOrderSettings({ ...normalizeOrderSettings(null), showAveragePrice: undefined } as unknown as ReturnType<typeof normalizeOrderSettings>)).toBe(false);
  });
  it('기존·손상된 소리 설정은 끄기로 복구하고 저장된 켜기를 유지한다', () => {
    expect(normalizeOrderSettings(undefined).orderReceiptSound).toBe(false);
    expect(normalizeOrderSettings({ orderReceiptSound: true }).orderReceiptSound).toBe(true);
    for (const value of ['true', 1, null]) expect(normalizeOrderSettings({ orderReceiptSound: value }).orderReceiptSound).toBe(false);
    expect(validOrderSettings(normalizeOrderSettings({ orderReceiptSound: true }))).toBe(true);
    expect(validOrderSettings({ ...normalizeOrderSettings(null), orderReceiptSound: undefined } as unknown as ReturnType<typeof normalizeOrderSettings>)).toBe(false);
  });
});
