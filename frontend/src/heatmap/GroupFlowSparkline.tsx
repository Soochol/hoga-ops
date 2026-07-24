/**
 * 히트맵 그룹 헤더의 당일 흐름 미니 그래프 — 기준선 면적형(선 + 0선 위 틴트 면적).
 * series = 그룹 멤버 평균 등락률(%)의 당일 시계열(버킷 순, 무데이터 버킷은 호출부가 제거).
 * 데이터<2점(장마감·수집 전)이면 흐린 점선. 색은 마지막 값 부호 → 옆의 avg% 칩과 정합.
 * lightweight-charts 미사용(글리프 규모라 sidebar Sparkline 과 같은 순수 SVG 기법).
 */

const W = 64;
const H = 16;

/** series(등락률 %) → SVG 좌표. Y 도메인은 항상 0 포함(기준선 가시). */
function geometryOf(series: number[]) {
  let lo = 0;
  let hi = 0;
  for (const p of series) {
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  const span = hi - lo || 1;
  const n = series.length;
  const toX = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const toY = (p: number) => H - ((p - lo) / span) * H;
  return { toX, toY, zeroY: toY(0) };
}

export function GroupFlowSparkline({ series }: { series: number[] }) {
  if (series.length < 2) {
    return (
      <svg width={W} height={15} viewBox={`0 0 ${W} 15`} preserveAspectRatio="none"
        className="flex-none opacity-40" aria-hidden>
        <line x1={0} y1={8} x2={W} y2={8} stroke="var(--grid)" strokeWidth={1}
          strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  const g = geometryOf(series);
  const last = series[series.length - 1];
  const stroke = last >= 0 ? 'var(--price-up)' : 'var(--price-down)';
  const fill = last >= 0 ? 'var(--tint-price-up)' : 'var(--tint-price-down)';
  const line = series.map((p, i) => `${g.toX(i)},${g.toY(p)}`).join(' ');
  const area = `${g.toX(0)},${g.zeroY} ${line} ${g.toX(series.length - 1)},${g.zeroY}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      className="flex-none" aria-hidden>
      <polygon fill={fill} stroke="none" points={area} />
      <line x1={0} y1={g.zeroY} x2={W} y2={g.zeroY} stroke="var(--grid)" strokeWidth={1}
        vectorEffect="non-scaling-stroke" />
      <polyline fill="none" stroke={stroke} strokeWidth={1.2} strokeLinejoin="round"
        strokeLinecap="round" vectorEffect="non-scaling-stroke" points={line} />
    </svg>
  );
}
