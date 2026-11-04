/** User estimates, never a broker tariff. Empty/invalid inputs remain unknown. */
export interface OrderCostRates { commissionPercent: string; taxPercent: string }
export type OrderCostProfiles = Record<string, Partial<OrderCostRates>>;
export const EMPTY_COST_RATES: OrderCostRates = { commissionPercent: '', taxPercent: '' };

/** Percent in millionths: 0 is an explicit exemption, null is not a rate. */
export function parseCostPercent(value: string): bigint | null {
  const match = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const rate = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return rate <= 100_000_000n ? rate : null;
}

export function validCostRates(rates: OrderCostRates): boolean {
  const commission = parseCostPercent(rates.commissionPercent), tax = parseCostPercent(rates.taxPercent);
  return commission !== null && tax !== null && commission + tax <= 100_000_000n;
}

export function normalizeCostProfiles(raw: unknown): OrderCostProfiles {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const profiles: OrderCostProfiles = {};
  for (const [key, value] of Object.entries(raw).slice(-64)) {
    if (key.length > 512 || !key.startsWith('["sell-estimate-v1",') || !value || typeof value !== 'object'
      || (!('commissionPercent' in value) && !('taxPercent' in value))) continue;
    // Preserve incomplete/invalid edits as unknown rather than reviving an older valid tariff.
    profiles[key] = {
      ...('commissionPercent' in value ? { commissionPercent: typeof value.commissionPercent === 'string' ? value.commissionPercent.slice(0, 16) : '' } : {}),
      ...('taxPercent' in value ? { taxPercent: typeof value.taxPercent === 'string' ? value.taxPercent.slice(0, 16) : '' } : {}),
    };
  }
  return profiles;
}
