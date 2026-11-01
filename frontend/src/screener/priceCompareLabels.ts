import type { MaSource, PriceCompareOperand, PriceCompareRelation } from '../api/screener';

export const PRICE_LABELS: Record<MaSource, string> = { open: '시가', high: '고가', low: '저가', close: '종가' };
export const PRICE_COMPARE_SYMBOLS: Record<PriceCompareRelation, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };
export const operandLabel = (operand: PriceCompareOperand) => `${operand.offset}봉 전 ${PRICE_LABELS[operand.source]}`;
