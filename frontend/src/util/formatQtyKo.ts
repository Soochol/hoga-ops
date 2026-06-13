/** 호가 물량(주)을 컴팩트 한국어 단위로. 차트 선 라벨용(좁은 폭).
 *  < 1만: 천단위 콤마. 1만~1억: `N.N만`(정수면 소수 생략). ≥1억: `N.N억`.
 *  음수·비유한값은 '0'. */
export function formatQtyKo(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  const trim = (n: number): string =>
    (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (qty >= 100_000_000) return `${trim(qty / 100_000_000)}억`;
  if (qty >= 10_000) return `${trim(qty / 10_000)}만`;
  return qty.toLocaleString('en-US');
}
