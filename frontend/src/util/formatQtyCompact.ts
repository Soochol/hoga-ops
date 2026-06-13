/** 호가 물량(주)을 컴팩트 k/M 단위로. 차트 선 라벨용(좁은 폭).
 *  < 1,000: 천단위 콤마. ≥1,000: `N.Nk`. ≥1,000,000: `N.NM`. (정수면 소수 생략)
 *  음수·비유한값은 '0'. 예: 13,600 → "13.6k", 153,125 → "153.1k", 1,234,567 → "1.2M". */
export function formatQtyCompact(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  const trim = (n: number): string =>
    (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (qty >= 1_000_000) return `${trim(qty / 1_000_000)}M`;
  if (qty >= 1_000) return `${trim(qty / 1_000)}k`;
  return qty.toLocaleString('en-US');
}
