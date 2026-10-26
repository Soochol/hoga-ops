export type OrderInputUnit = 'quantity' | 'amount';
export type OrderPresets = [number, number, number];
export interface OrderWindowSettings {
  /** Selects quick-entry presets only; the order input and payload always use shares. */
  unit: OrderInputUnit;
  quantityPresets: OrderPresets;
  amountPresets: OrderPresets;
  showAveragePrice: boolean;
  showPriceSeparators: boolean;
  showPriceChangePercent: boolean;
  orderReceiptSound: boolean;
  buyFillSound: boolean;
  sellFillSound: boolean;
  rememberQuantity: boolean;
}

export const MILLION_WON = 1_000_000;
export const MAX_ORDER_QUANTITY = 1_000_000_000;
export const MAX_AMOUNT_MILLIONS = 1_000_000;
export const DEFAULT_ORDER_SETTINGS: OrderWindowSettings = {
  unit: 'quantity', quantityPresets: [10, 50, 100], amountPresets: [1, 5, 10], showAveragePrice: true,
  showPriceSeparators: false, showPriceChangePercent: true,
  orderReceiptSound: false, buyFillSound: false, sellFillSound: false, rememberQuantity: false,
};

export const validOrderInput = (value: number, unit: OrderInputUnit) => Number.isSafeInteger(value)
  && value >= 1 && value <= (unit === 'quantity' ? MAX_ORDER_QUANTITY : MAX_AMOUNT_MILLIONS);

export function validOrderSettings(value: OrderWindowSettings): boolean {
  return (value.unit === 'quantity' || value.unit === 'amount')
    && typeof value.showAveragePrice === 'boolean'
    && typeof value.showPriceSeparators === 'boolean'
    && typeof value.showPriceChangePercent === 'boolean'
    && typeof value.orderReceiptSound === 'boolean'
    && typeof value.buyFillSound === 'boolean'
    && typeof value.sellFillSound === 'boolean'
    && typeof value.rememberQuantity === 'boolean'
    && value.quantityPresets.length === 3 && value.amountPresets.length === 3
    && value.quantityPresets.every(n => validOrderInput(n, 'quantity'))
    && value.amountPresets.every(n => validOrderInput(n, 'amount'));
}

/** Stored window settings are untrusted; a corrupt field must not discard the window. */
export function normalizeOrderSettings(raw: unknown): OrderWindowSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<OrderWindowSettings> : {};
  const presets = (source: unknown, unit: OrderInputUnit, fallback: OrderPresets): OrderPresets => {
    if (!Array.isArray(source) || source.length !== 3) return [...fallback];
    return source.map((n, i) => typeof n === 'number' && validOrderInput(n, unit) ? n : fallback[i]) as OrderPresets;
  };
  return {
    unit: value.unit === 'amount' ? 'amount' : 'quantity',
    quantityPresets: presets(value.quantityPresets, 'quantity', DEFAULT_ORDER_SETTINGS.quantityPresets),
    amountPresets: presets(value.amountPresets, 'amount', DEFAULT_ORDER_SETTINGS.amountPresets),
    showAveragePrice: typeof value.showAveragePrice === 'boolean' ? value.showAveragePrice : DEFAULT_ORDER_SETTINGS.showAveragePrice,
    showPriceSeparators: typeof value.showPriceSeparators === 'boolean' ? value.showPriceSeparators : DEFAULT_ORDER_SETTINGS.showPriceSeparators,
    showPriceChangePercent: typeof value.showPriceChangePercent === 'boolean' ? value.showPriceChangePercent : DEFAULT_ORDER_SETTINGS.showPriceChangePercent,
    orderReceiptSound: typeof value.orderReceiptSound === 'boolean' ? value.orderReceiptSound : DEFAULT_ORDER_SETTINGS.orderReceiptSound,
    buyFillSound: typeof value.buyFillSound === 'boolean' ? value.buyFillSound : DEFAULT_ORDER_SETTINGS.buyFillSound,
    sellFillSound: typeof value.sellFillSound === 'boolean' ? value.sellFillSound : DEFAULT_ORDER_SETTINGS.sellFillSound,
    rememberQuantity: typeof value.rememberQuantity === 'boolean' ? value.rememberQuantity : DEFAULT_ORDER_SETTINGS.rememberQuantity,
  };
}

/** Convert at the current price when a preset is applied, using whole shares. */
export function quantityForAmount(millions: number, price: number): number | null {
  if (!validOrderInput(millions, 'amount') || !Number.isSafeInteger(price) || price <= 0) return null;
  return Math.floor(millions * MILLION_WON / price);
}
