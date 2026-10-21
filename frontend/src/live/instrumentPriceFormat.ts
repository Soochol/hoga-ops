import { formatKoreanInt } from '../util/koreanNumber';
import { isUsIndexId } from './liveInstrument';

export const formatUsPrice = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format;

export function isUsWorkareaCode(code: string | null | undefined): boolean {
  return !!code && (code.startsWith('us-stock:') || (code.startsWith('index:') && isUsIndexId(code.slice(6))));
}
export function formatInstrumentPrice(price: number, code: string | null | undefined): string {
  return isUsWorkareaCode(code) ? formatUsPrice(price) : formatKoreanInt(price);
}
export function instrumentPriceUnit(code: string | null | undefined): string {
  return code?.startsWith('us-stock:') ? ' USD' : isUsWorkareaCode(code) ? ' pt' : '원';
}
