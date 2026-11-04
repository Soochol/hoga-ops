import type { TradingAccount, TradingAccountId } from '../../api/trading';
import type { SymbolHit } from '../../api/types';
import { parseCostPercent, validCostRates, type OrderCostRates, type OrderCostProfiles } from '../../state/orderCostRates';
import { holdingProfitPercent, holdingProfitWon } from './orderRules';

export interface SellCostContext {
  account: TradingAccountId;
  broker?: TradingAccount['broker'];
  environment?: TradingAccount['environment'];
  symbol?: Pick<SymbolHit, 'market' | 'security_type'>;
  venue: string;
  route: string;
  date: string;
}

export function sellCostScope(context: SellCostContext): string | null {
  const { account, broker, environment, symbol, venue, route, date } = context;
  if (!account || !symbol || symbol.security_type !== 'stock'
    || !['KOSPI', 'KOSDAQ'].includes(symbol.market)) return null;
  return JSON.stringify(['sell-estimate-v1', typeof account, account, broker ?? 'unknown', environment ?? 'unknown',
    symbol.market, symbol.security_type, venue, route, date]);
}

/** Median standard online fees; statutory tax by listing market, reviewed 2026-11-04.
 * See docs/plans/2026-11-04-order-valuation-costs.md for samples and applicability. */
export const SELL_COST_DEFAULT_BASIS = {
  reviewedAt: '20261104', validFrom: '20260101', validThrough: '20261231',
  commission: { KRX: '0.015', NXT: '0.014', SOR: '0.015' },
  tax: {
    KOSPI: { transactionPercent: '0.05', ruralPercent: '0.15', totalPercent: '0.2' },
    KOSDAQ: { transactionPercent: '0.2', ruralPercent: '0', totalPercent: '0.2' },
  },
} as const;

export function defaultSellCostRates(context: SellCostContext): OrderCostRates | null {
  const { date, route, symbol } = context, basis = SELL_COST_DEFAULT_BASIS;
  if (!sellCostScope(context) || !symbol || !/^\d{8}$/.test(date)
    || date < basis.validFrom || date > basis.validThrough) return null;
  if (route !== 'KRX' && route !== 'NXT' && route !== 'SOR') return null;
  return { commissionPercent: basis.commission[route], taxPercent: basis.tax[symbol.market].totalPercent };
}

/** Missing fields inherit defaults; an explicit zero, blank or invalid edit never does. */
export function resolveSellCostRates(profiles: OrderCostProfiles, context: SellCostContext): OrderCostRates | null {
  const scope = sellCostScope(context);
  if (!scope) return null;
  const defaults = defaultSellCostRates(context), manual = profiles[scope];
  return { commissionPercent: manual?.commissionPercent ?? defaults?.commissionPercent ?? '',
    taxPercent: manual?.taxPercent ?? defaults?.taxPercent ?? '' };
}

/** One hypothetical sale of all holdings. This does not predict execution or mutate balances. */
export function estimateHoldingSale({ quantity, price, averagePrice, profiles, context }: {
  quantity: number | null; price: number | null; averagePrice: string | null | undefined;
  profiles: OrderCostProfiles; context: SellCostContext;
}): { kind: 'available'; gross: number; net: number; commission: number; tax: number; profitWon: number | null; profitPercent: number | null }
  | { kind: 'unavailable' } {
  const rates = resolveSellCostRates(profiles, context);
  if (!rates || !validCostRates(rates) || quantity == null || !Number.isSafeInteger(quantity) || quantity <= 0
    || price == null || !Number.isSafeInteger(price) || price <= 0) return { kind: 'unavailable' };
  const gross = BigInt(price) * BigInt(quantity);
  const commissionRate = parseCostPercent(rates.commissionPercent), taxRate = parseCostPercent(rates.taxPercent);
  if (commissionRate === null || taxRate === null) return { kind: 'unavailable' };
  const commission = gross * commissionRate / 100_000_000n, tax = gross * taxRate / 100_000_000n;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'unavailable' };
  const costs = Number(commission + tax);
  return { kind: 'available', gross: Number(gross), net: Number(gross - commission - tax),
    commission: Number(commission), tax: Number(tax),
    profitWon: holdingProfitWon(quantity, price, averagePrice, costs),
    profitPercent: holdingProfitPercent(quantity, price, averagePrice, costs) };
}
