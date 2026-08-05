/** 시장 종합의 색 슬롯과 포맷터 (#1102).
 *
 * 컴포넌트와 분리한 이유는 fast-refresh 규칙이다 — 한 파일이 컴포넌트와 상수를
 * 함께 내보내면 HMR 이 모듈 전체를 갈아끼운다.
 */
/** 주체·계열 색 — 한 화면에서 색 하나가 한 의미만 갖도록 슬롯을 나눠 쓴다. */
export const SERIES_COLORS = {
  foreign: 'var(--ma-3)',
  institution: 'var(--ma-4)',
  individual: 'var(--ma-8)',
  arb: 'var(--ma-6)',
  nonArb: 'var(--ma-7)',
  index: 'var(--fg-dim)',
  deposit: 'var(--ma-1)',
  credit: 'var(--ma-2)',
  cma: 'var(--ma-5)',
} as const;

export function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function fmtSigned(n: number | null): string {
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('ko-KR')}`;
}

/** 원 → 조. KOFIA 는 원(raw)으로 주고 환산은 표시 계층의 몫이다(#1098). */
export function wonToJo(won: number | null): number | null {
  return won === null ? null : won / 1e12;
}
