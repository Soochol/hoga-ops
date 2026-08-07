/**
 * 옵션 심리 패널의 숫자 포맷 — `market/marketFormat.ts` 와 같은 자리다.
 *
 * 컴포넌트 파일(`SentimentPanels.tsx`)에서 분리한 이유는 Fast Refresh 다: 컴포넌트
 * 외의 값을 같이 내보내는 모듈은 HMR 경계가 깨져 편집할 때마다 전체 리로드가 된다
 * (`react-refresh/only-export-components`). `/market` 이 이미 포맷 함수를 별도
 * 모듈로 갈라 둔 것과 같은 구조.
 */

/** 큰 원화 금액을 조/억/만 단위로 압축. 부호는 유지한다. */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return n.toFixed(0);
}
