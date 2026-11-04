import { describe, expect, it } from 'vitest';
import { normalizeCostProfiles, parseCostPercent, validCostRates } from '../../state/orderCostRates';
import { normalizeOrderSettings } from '../../state/orderWindowSettings';
import { defaultSellCostRates, resolveSellCostRates, SELL_COST_DEFAULT_BASIS, estimateHoldingSale, sellCostScope, type SellCostContext } from './orderValuationCosts';
import { holdingProfitPercent, holdingProfitWon } from './orderRules';

const context: SellCostContext = { account: 'acc_test', broker: 'kiwoom', environment: 'real',
  symbol: { market: 'KOSPI', security_type: 'stock' }, venue: 'UN', route: 'SOR', date: '20261104' };
const scope = sellCostScope(context)!;
const rates = { commissionPercent: '0.01', taxPercent: '0.2' };
const input = { quantity: 10, price: 10000, averagePrice: '9000.125', profiles: { [scope]: rates }, context };

describe('사용자 입력 추정 매도 평가', () => {
  it('전체 보유수량에 매도비용만 반영하고 원본 소수평단으로 손익과 수익률을 계산한다', () => {
    expect(estimateHoldingSale(input)).toEqual({ kind: 'available', gross: 100000, net: 99790,
      commission: 10, tax: 200, profitWon: 9789, profitPercent: 10.88 });
    expect(holdingProfitWon(10, 10000, input.averagePrice)).toBe(9999);
    expect(holdingProfitPercent(10, 10000, input.averagePrice)).toBe(11.11);
  });
  it('비용별로 원미만을 절사하며 매우 긴 평단 소수도 반올림 전에 보존한다', () => {
    expect(estimateHoldingSale({ ...input, quantity: 1, price: 9999, averagePrice: '10000.0000000000000000001',
      profiles: { [scope]: { commissionPercent: '0.01', taxPercent: '0.01' } } })).toMatchObject({
      kind: 'available', net: 9999, commission: 0, tax: 0, profitWon: -1, profitPercent: -0.01,
    });
  });
  it('면제 확인 0과 미설정·잘못된 비율을 구분하며 보유중 손익0도 제공한다', () => {
    expect(estimateHoldingSale({ ...input, quantity: 1, price: 100, averagePrice: '99',
      profiles: { [scope]: { commissionPercent: '1', taxPercent: '0' } } })).toMatchObject({ kind: 'available', net: 99, profitWon: 0, profitPercent: 0 });
    for (const profiles of [{ [scope]: { ...rates, taxPercent: '' } }, { [scope]: { ...rates, taxPercent: '-1' } },
      { [scope]: { commissionPercent: '60', taxPercent: '41' } }]) {
      expect(estimateHoldingSale({ ...input, profiles })).toEqual({ kind: 'unavailable' });
    }
    expect(estimateHoldingSale({ ...input, profiles: { [scope]: { commissionPercent: '0', taxPercent: '0' } } }))
      .toMatchObject({ kind: 'available', net: 100000, commission: 0, tax: 0 });
  });
  it('미보유·미수신·음수·분수·정밀도 초과 값에는 추정하지 않는다', () => {
    for (const quantity of [null, 0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(estimateHoldingSale({ ...input, quantity })).toEqual({ kind: 'unavailable' });
    }
    for (const price of [null, 0, -1, 1.1, NaN, Infinity]) {
      expect(estimateHoldingSale({ ...input, price })).toEqual({ kind: 'unavailable' });
    }
    expect(estimateHoldingSale({ ...input, price: Number.MAX_SAFE_INTEGER })).toEqual({ kind: 'unavailable' });
    for (const averagePrice of [null, '', '-1', 'NaN']) {
      expect(estimateHoldingSale({ ...input, averagePrice })).toMatchObject({ kind: 'available', profitWon: null, profitPercent: null });
    }
  });
  it('계좌·실전모의·상장시장·시세시장·주문경로·KST일자 전환에 이전 비용을 적용하지 않는다', () => {
    const changes: Partial<SellCostContext>[] = [{ account: 'acc_other' }, { account: 1 }, { broker: 'toss' },
      { environment: 'mock' }, { environment: undefined }, { symbol: { market: 'KOSDAQ', security_type: 'stock' } },
      { venue: 'NXT' }, { venue: 'KRX' }, { route: 'NXT' }, { route: 'KRX' }, { date: '20261105' }];
    for (const change of changes) {
      const changed = { ...context, ...change };
      expect(resolveSellCostRates(input.profiles, changed)).toEqual(defaultSellCostRates(changed));
      expect(estimateHoldingSale({ ...input, context: changed })).toMatchObject({ kind: 'available', commission: changed.route === 'NXT' ? 14 : 15 });
    }
    expect(sellCostScope({ ...context, account: 1 })).not.toBe(sellCostScope({ ...context, account: '1' }));
  });
  it('ETF·ETN·상품미확인을 거래세 면제만으로 주식 비용과 섞지 않는다', () => {
    for (const security_type of ['etf', 'etn', undefined] as const) {
      const changed = { ...context, symbol: { market: 'KOSPI' as const, security_type } };
      expect(sellCostScope(changed)).toBeNull();
      expect(estimateHoldingSale({ ...input, context: changed })).toEqual({ kind: 'unavailable' });
    }
    expect(sellCostScope({ ...context, symbol: undefined })).toBeNull();
    expect(sellCostScope({ ...context, account: 0 })).toBeNull();
  });
});

describe('비용 설정 경계', () => {
  it('공식 표본 중앙값과 법정 상장시장 세율로 지원 범위의 누락값을 채우고 수동0·빈칸을 우선한다', () => {
    expect(SELL_COST_DEFAULT_BASIS.tax.KOSPI).toEqual({ transactionPercent: '0.05', ruralPercent: '0.15', totalPercent: '0.2' });
    expect(SELL_COST_DEFAULT_BASIS.tax.KOSDAQ).toEqual({ transactionPercent: '0.2', ruralPercent: '0', totalPercent: '0.2' });
    expect(resolveSellCostRates({}, context)).toEqual({ commissionPercent: '0.015', taxPercent: '0.2' });
    expect(estimateHoldingSale({ ...input, profiles: {} })).toMatchObject({ kind: 'available', commission: 15, tax: 200, net: 99785, profitWon: 9784, profitPercent: 10.87 });
    for (const venue of ['KRX', 'NXT', 'UN']) {
      expect(defaultSellCostRates({ ...context, venue, route: 'KRX' })?.commissionPercent).toBe('0.015');
      expect(defaultSellCostRates({ ...context, venue, route: 'NXT' })?.commissionPercent).toBe('0.014');
      expect(defaultSellCostRates({ ...context, venue, route: 'SOR' })?.commissionPercent).toBe('0.015');
    }
    const partial = normalizeCostProfiles({ [scope]: { commissionPercent: '0' } });
    expect(resolveSellCostRates(partial, context)).toEqual({ commissionPercent: '0', taxPercent: '0.2' });
    expect(resolveSellCostRates({ [scope]: { taxPercent: '0' } }, context)).toEqual({ commissionPercent: '0.015', taxPercent: '0' });
    expect(resolveSellCostRates({ [scope]: { taxPercent: '' } }, context)).toEqual({ commissionPercent: '0.015', taxPercent: '' });
    expect(resolveSellCostRates({}, { ...context, date: '20261105' })).toEqual({ commissionPercent: '0.015', taxPercent: '0.2' });
    for (const date of ['20251231', '20270101', 'bad', '20261301']) {
      expect(defaultSellCostRates({ ...context, date })).toBeNull();
      expect(estimateHoldingSale({ ...input, profiles: {}, context: { ...context, date } })).toEqual({ kind: 'unavailable' });
    }
    expect(defaultSellCostRates({ ...context, route: 'unknown' })).toBeNull();
  });

  it('비율은 0~100%, 소수 6자리의 명시적 decimal만 허용한다', () => {
    expect(parseCostPercent('0')).toBe(0n);
    expect(parseCostPercent('0.000001')).toBe(1n);
    expect(parseCostPercent('100.000000')).toBe(100000000n);
    for (const value of ['', '.', '1.', '1e-2', '-0', ' 0', '100.000001', '0.0000001']) expect(parseCostPercent(value)).toBeNull();
    expect(validCostRates({ commissionPercent: '50', taxPercent: '50' })).toBe(true);
  });
  it('레거시·손상 필드는 OFF이며 중간 편집을 이전 정상율로 되돌리지 않고 깊은 복사한다', () => {
    const legacy = normalizeOrderSettings({ showAveragePrice: false });
    expect(legacy.reflectSellCosts).toBe(false);
    expect(legacy.sellCostProfiles).toEqual({});
    const raw = { [scope]: { ...rates, taxPercent: '1.' }, bad: rates };
    const normalized = normalizeCostProfiles(raw);
    expect(normalized).toEqual({ [scope]: { ...rates, taxPercent: '1.' } });
    normalized[scope].commissionPercent = '9';
    expect(raw[scope].commissionPercent).toBe('0.01');
    expect(normalizeCostProfiles({ [scope]: { commissionPercent: null, taxPercent: 0 } })).toEqual({ [scope]: { commissionPercent: '', taxPercent: '' } });
    expect(normalizeCostProfiles(null)).toEqual({});
  });
});
