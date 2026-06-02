/** 부호 → KRX 색상 클래스(DESIGN.md 결정): >0 = text-price-up(빨강) / <0 =
 *  text-price-down(파랑) / 0 = 중립 text-fg-dim. 서구식 green=up 아님. 우측 패널
 *  QuoteChange 와 스크리너 ResultTable ChangeCell 의 공용 출처(컨벤션이 한 곳). */
export function priceDirClass(n: number): string {
  return n > 0 ? 'text-price-up' : n < 0 ? 'text-price-down' : 'text-fg-dim';
}
