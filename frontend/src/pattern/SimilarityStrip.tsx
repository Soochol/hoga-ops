/**
 * 유사도를 **분포 위 위치**로 읽히게 하는 미니 스트립.
 *
 * 0.986 은 "98.6% 닮음" 이 아니라 "비교한 것 중 최고" 다(ADR-0166 결정 7). 숫자만
 * 그리면 반드시 그렇게 오독되므로, 눈금(p95·p99)과 함께 점을 찍어 **무리에서 얼마나
 * 떨어졌는지**를 보게 한다. 그 거리가 신호고 절대값은 아니다.
 *
 * 축은 `p50`~`1.0` 이다 — 0 부터 그리면 관심 구간(상위 꼬리)이 오른쪽 끝에 뭉친다.
 */
type Props = {
  value: number;
  dist: { p50: number; p95: number; p99: number; p99_99: number | null };
  className?: string;
};

function toPercent(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0;
  return Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
}

export function SimilarityStrip({ value, dist, className = '' }: Props) {
  const lo = dist.p50;
  const hi = 1;
  const marks = [dist.p95, dist.p99, dist.p99_99].filter((m): m is number => m != null);
  return (
    <div
      className={`relative h-[3px] rounded-sm bg-grid ${className}`.trim()}
      // 스크린리더에는 위치가 아니라 값과 대조군을 말한다 — 그림의 요점이 그것이다.
      role="img"
      aria-label={`유사도 ${value.toFixed(3)} · 같은 분포의 상위 1%는 ${dist.p99.toFixed(3)}`}
    >
      {marks.map((m, i) => (
        <i
          key={i}
          className="absolute top-[-2px] h-[7px] w-px bg-border-strong"
          style={{ left: `${toPercent(m, lo, hi)}%` }}
        />
      ))}
      <u
        className="absolute top-[-3px] h-[9px] w-[5px] -translate-x-1/2 rounded-sm bg-accent"
        style={{ left: `${toPercent(value, lo, hi)}%` }}
      />
    </div>
  );
}
