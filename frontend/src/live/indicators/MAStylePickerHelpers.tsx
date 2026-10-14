


/** 8 hue × 4 shade. shade 인덱스 0=darkest → 3=lightest. mockup의
 *  컬러 palette layout과 1:1 일치. tokens.css의 --ma-N 8색 (단일 행)
 *  과는 별개의 확장 set — 사용자가 슬롯당 색상을 더 풍부하게 고를 수
 *  있도록 한다. tokens.css의 --ma-N 은 default 슬롯 자동 배정용으로
 *  남는다. */
export const MA_COLOR_ROWS: readonly (readonly string[])[] = [
  ['#374151', '#1E3A8A', '#581C87', '#7F1D1D', '#7C2D12', '#78350F', '#134E4A', '#14532D'],
  ['#6B7280', '#1D4ED8', '#7E22CE', '#B91C1C', '#C2410C', '#B45309', '#0F766E', '#15803D'],
  ['#9CA3AF', '#3B82F6', '#A855F7', '#EF4444', '#F97316', '#FBBF24', '#14B8A6', '#22C55E'],
  ['#D1D5DB', '#93C5FD', '#D8B4FE', '#FCA5A5', '#FDBA74', '#FDE68A', '#5EEAD4', '#86EFAC'],
];
