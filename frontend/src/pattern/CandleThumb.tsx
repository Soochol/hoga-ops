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
  /** 이평 프리셋이 켜졌을 때만 — 기간별 원가격 이평값. `maPeriods` 와 **같은 순서**다.
   *  이 선이 없으면 왜 매치됐는지 화면에 아무 근거도 없다(캔들만 보이니까). */
  ma?: number[][] | null;
  /** 위 `ma` 의 기간들. 색을 정하는 데 쓴다 — 차트의 지표 색과 맞춘다. */
  maPeriods?: number[];
  height?: number;
  className?: string;
};

const VIEW_W = 240;
/** 캔들 몸통이 슬롯을 다 채우면 봉 사이가 붙어 개수를 못 센다. */
const BODY_RATIO = 0.6;
/** 이후 구간이 아무리 길어도 **패턴 봉**이 이만큼은 차지한다 — 비례 배분하면
 *  7봉 vs 20봉에서 패턴이 26% 로 눌려 정작 비교 대상이 안 보인다. */
const MIN_PATTERN_WIDTH = 0.45;

/** 기간 → 선 색. `/live` 차트의 이동평균선 공장값과 **같은 값**이다 — 매일 보는 선과
 *  색이 달라지면 이 썸네일의 두 선이 화면의 어느 선인지 설명 없이는 읽히지 않는다.
 *  모르는 기간은 중립색으로 떨어뜨린다(색을 발명하지 않는다). */
const MA_COLOR: Record<number, string> = {
  5: '#EC4899',
  20: '#F97316',
  60: '#22C55E',
  120: '#F8FAFC',
};

export function CandleThumb({
  bars,
  tail,
  ma,
  maPeriods = [],
  height = 44,
  className = '',
}: Props) {
  if (!bars.length) return null;
  const pad = Math.max(height * 0.08, 2);
  const tailCloses = tail ?? [];
  const maLines = (ma ?? []).filter((line) => line.length === bars.length);
  const maValues = maLines.flat();
  // ★ 이평선이 캔들 범위 밖으로 나가면 잘린다 — 스케일에 **함께** 넣어야 「종가가
  //   20일선 아래」 같은 관계가 보인다. 그게 이 선을 그리는 이유다.
  const lo = Math.min(...bars.map((b) => b[2]), ...tailCloses, ...maValues);
  const hi = Math.max(...bars.map((b) => b[1]), ...tailCloses, ...maValues);
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
      {/* 캔들 **뒤에** 그린다 — 봉이 선에 가리면 몸통·꼬리를 못 읽는다. */}
      {maLines.map((line, k) => (
        <polyline
          key={maPeriods[k] ?? k}
          points={line.map((v, i) => `${(slot * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={MA_COLOR[maPeriods[k]] ?? 'var(--fg-dim)'}
          strokeWidth={1.1}
          strokeLinejoin="round"
          strokeOpacity={0.85}
          vectorEffect="non-scaling-stroke"
        />
      ))}
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
