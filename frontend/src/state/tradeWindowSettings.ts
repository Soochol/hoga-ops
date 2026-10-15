/** 만원 단위. 0은 전체 표시이며 기존 체결창의 기본 동작이다. */
export const MAX_TRADE_MIN_AMOUNT_MANWON = 1_000_000;

export function isTradeMinAmountManwon(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 0 && value <= MAX_TRADE_MIN_AMOUNT_MANWON;
}

export function formatTradeMinAmount(manwon: number): string {
  return manwon >= 10_000 && manwon % 10_000 === 0
    ? `${(manwon / 10_000).toLocaleString('ko-KR')}억원`
    : `${manwon.toLocaleString('ko-KR')}만원`;
}
