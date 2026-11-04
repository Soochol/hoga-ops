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

export const SELL_COST_HELP = '현재가 × 전체 보유수량에서 입력한 예상 매도 수수료·거래세를 각각 원 미만 절사해 차감합니다. 원본 평단가 기준이며 매입비용을 추가 차감하지 않습니다. 실제 정산·최소수수료·슬리피지·양도/배당소득세는 포함하지 않습니다.';
export const SELL_COST_UNAVAILABLE = '비용 확인 필요 · 주문 설정에서 오늘의 계좌·상장시장·시세시장·주문경로별 추정 매도율을 입력하세요. ETF·ETN과 상품 미확인은 지원하지 않습니다.';

/** One hypothetical sale of all holdings. This does not predict execution or mutate balances. */
export function estimateHoldingSale({ quantity, price, averagePrice, profiles, context }: {
  quantity: number | null; price: number | null; averagePrice: string | null | undefined;
  profiles: OrderCostProfiles; context: SellCostContext;
}): { kind: 'available'; gross: number; net: number; commission: number; tax: number; profitWon: number | null; profitPercent: number | null }
  | { kind: 'unavailable' } {
  const scope = sellCostScope(context);
  const rates: OrderCostRates | undefined = scope ? profiles[scope] : undefined;
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
