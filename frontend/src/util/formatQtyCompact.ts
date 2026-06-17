/** 호가 물량(주)을 컴팩트 k/M 단위로. 차트 선 라벨용(좁은 폭).
 *  >0: `N.Nk`. ≥1,000,000: `N.NM`. (정수면 소수 생략)
 *  음수·비유한값은 '0'. 예: 1 → "<0.1k", 900 → "0.9k", 13,600 → "13.6k", 1,234,567 → "1.2M". */
export function formatQtyCompact(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  if (qty < 50) return '<0.1k';
  const trim = (n: number): string =>
    (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (qty >= 1_000_000) return `${trim(qty / 1_000_000)}M`;
  return `${trim(qty / 1_000)}k`;
}
