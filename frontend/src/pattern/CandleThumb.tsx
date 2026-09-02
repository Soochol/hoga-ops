/**
 * 봉 패턴 썸네일 — 몸통 rect + 위아래 꼬리 line.
 *
 * **라인 스파크가 아니라 캔들인 이유**가 이 기능의 전부다. 매칭 축이 OHLC 4채널이라
 * 종가 궤적이 같아도 몸통·꼬리가 다르면 다른 패턴이고, 그 차이는 봉으로 그려야만
 * 눈에 보인다(ADR-0166 결정 1).
 *
 * 색은 KRX 관례(상승 빨강 · 하락 파랑)이고 토큰에서 온다 — 여기서 색을 정하지 않는다.
 */
type Props = {
  /** `[open, high, low, close]` × N. 백엔드 `PatternMatchRow.bars` 순서 그대로. */
  bars: number[][];
  /** 패턴 **뒤**에 이어 그릴 종가. 「그 다음에 뭐가 왔나」가 history 의 질문이다. */
  tail?: number[] | null;
  height?: number;
  className?: string;
};

const VIEW_W = 240;
/** 캔들 몸통이 슬롯을 다 채우면 봉 사이가 붙어 개수를 못 센다. */
const BODY_RATIO = 0.6;
/** 이후 구간이 아무리 길어도 **패턴 봉**이 이만큼은 차지한다 — 비례 배분하면
 *  7봉 vs 20봉에서 패턴이 26% 로 눌려 정작 비교 대상이 안 보인다. */
const MIN_PATTERN_WIDTH = 0.45;

export function CandleThumb({ bars, tail, height = 44, className = '' }: Props) {
  if (!bars.length) return null;
  const pad = Math.max(height * 0.08, 2);
  const tailCloses = tail ?? [];
  const lo = Math.min(...bars.map((b) => b[2]), ...tailCloses);
  const hi = Math.max(...bars.map((b) => b[1]), ...tailCloses);
  if (!(hi > lo)) return null;

  const total = bars.length + tailCloses.length;
  const bodyW = tailCloses.length
    ? VIEW_W * Math.max(MIN_PATTERN_WIDTH, bars.length / total)
    : VIEW_W;
  const slot = bodyW / bars.length;
  const candleW = Math.max(slot * BODY_RATIO, 1.2);
  const y = (v: number) => pad + ((hi - v) / (hi - lo)) * (height - 2 * pad);

  const lastClose = bars[bars.length - 1][3];
  const tailUp = tailCloses.length > 0 && tailCloses[tailCloses.length - 1] >= lastClose;
  const dx = tailCloses.length ? (VIEW_W - bodyW) / tailCloses.length : 0;
  const tailPoints = tailCloses.length
    ? [
        `${(bodyW - slot / 2).toFixed(1)},${y(lastClose).toFixed(1)}`,
        ...tailCloses.map((v, i) => `${(bodyW - slot / 2 + dx * (i + 1)).toFixed(1)},${y(v).toFixed(1)}`),
      ].join(' ')
    : '';

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`block w-full ${className}`.trim()}
      style={{ height, overflow: 'visible' }}
    >
      {bars.map((b, i) => {
        const [open, high, low, close] = b;
        const cx = slot * (i + 0.5);
        const color = close >= open ? 'var(--price-up)' : 'var(--price-down)';
        const top = Math.max(open, close);
        const bodyH = Math.max(y(Math.min(open, close)) - y(top), 0.9);
        return (
          <g key={i} fill={color} stroke={color}>
            <line
              x1={cx.toFixed(1)}
              y1={y(high).toFixed(1)}
              x2={cx.toFixed(1)}
              y2={y(low).toFixed(1)}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={(cx - candleW / 2).toFixed(1)}
              y={y(top).toFixed(1)}
              width={candleW.toFixed(1)}
              height={bodyH.toFixed(1)}
            />
          </g>
        );
      })}
      {tailCloses.length > 0 && (
        <>
          <line
            x1={bodyW.toFixed(1)}
            y1={0}
            x2={bodyW.toFixed(1)}
            y2={height}
            stroke="var(--border-strong)"
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={tailPoints}
            fill="none"
            stroke={tailUp ? 'var(--price-up)' : 'var(--price-down)'}
            strokeWidth={1.3}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
