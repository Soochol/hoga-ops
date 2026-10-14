/** Display a trading date without parsing it in the host timezone. */
export function formatTradingDate(value: string | null | undefined): string {
  if (!value) return '—';
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6, 8)}` : value;
}
