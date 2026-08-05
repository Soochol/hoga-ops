/** 시장 종합 페이지의 그리기 조각 (#1102).
 *
 * 프로토타입(`market/prototype/protoBits.tsx`)에서 살아남은 것들이다 — 목업 타입을
 * 실 와이어 타입으로 갈고, 값이 `null` 일 수 있다는 사실(부분 실패·미수집)을
 * 시그니처에 반영했다.
 *
 * **계열 색은 MA 팔레트를 쓴다.** 방향색(`--price-up`/`--price-down`)은 등락 전용이라
 * 다계열 라인에 쓰면 "외국인이 빨간 건 순매수라서인가 상승이라서인가" 가 모호해진다.
 */
import { priceDirClass } from '../ui/priceDir';
import { fmtPct, fmtSigned } from './marketFormat';

export function PctText({ pct, className = '' }: { pct: number | null; className?: string }) {
  if (pct === null) return <span className={`font-data text-fg-dim ${className}`}>—</span>;
  return (
    <span className={`font-data tabular-nums ${priceDirClass(pct)} ${className}`}>{fmtPct(pct)}</span>
  );
}

/** 상승/보합/하락 비율 막대. 값이 없으면 렌더하지 않는다 — **지수 상품은 부재가 정상**이다(#1100). */
export function AdvanceDeclineBar({
  rising,
  falling,
  flat,
  height = 4,
}: {
  rising: number | null;
  falling: number | null;
  flat: number | null;
  height?: number;
}) {
  if (rising === null || falling === null) return null;
  const f = flat ?? 0;
  const total = rising + falling + f || 1;
  return (
    <div className="flex w-full overflow-hidden rounded-sm" style={{ height }} aria-hidden="true">
      <div style={{ width: `${(rising / total) * 100}%`, background: 'var(--price-up)' }} />
      <div style={{ width: `${(f / total) * 100}%`, background: 'var(--border-strong)' }} />
      <div style={{ width: `${(falling / total) * 100}%`, background: 'var(--price-down)' }} />
    </div>
  );
}

type Series = { color: string; values: (number | null)[] };

function finite(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

/** 다계열 누적 라인 — delta 배열을 누적해 그린다. 0 기준선 공유. */
export function CumLinesChart({
  series,
  width = 300,
  height = 96,
}: {
  series: Series[];
  width?: number;
  height?: number;
}) {
  const cums = series.map(({ values }) => {
    let acc = 0;
    return values.map((v) => (acc += v ?? 0));
  });
  const all = [...cums.flat(), 0];
  if (all.length < 2) return null;
  const min = Math.min(...all);
  const span = Math.max(...all) - min || 1;
  const n = cums[0]?.length ?? 0;
  if (n < 2) return null;
  const px = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const py = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <line x1="2" x2={width - 2} y1={py(0)} y2={py(0)} stroke="var(--border-strong)" strokeDasharray="2 3" />
      {cums.map((s, i) => (
        <path key={i} d={path(s)} fill="none" stroke={series[i].color} strokeWidth="1.5" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** 일별 막대(강도) + 누적 라인(방향) 콤보. 같은 계열은 같은 색, 막대는 반투명. */
export function ComboNetChart({
  a,
  b,
  height = 96,
}: {
  a: Series;
  b: Series;
  height?: number;
}) {
  const n = a.values.length;
  if (n < 1) return null;
  const width = 300;
  const maxAbs = Math.max(...finite(a.values).map(Math.abs), ...finite(b.values).map(Math.abs), 1);
  const mid = height / 2;
  const slot = width / n;
  const bw = Math.max((slot - 2) / 2, 1.5);
  const cum = (values: (number | null)[]) => {
    let acc = 0;
    return values.map((v) => (acc += v ?? 0));
  };
  const aCum = cum(a.values);
  const bCum = cum(b.values);
  const all = [...aCum, ...bCum, 0];
  const cMin = Math.min(...all);
  const cSpan = Math.max(...all) - cMin || 1;
  const px = (i: number) => i * slot + slot / 2;
  const py = (v: number) => height - 3 - ((v - cMin) / cSpan) * (height - 6);
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const bar = (v: number | null, x: number, color: string, key: string) => {
    if (v === null) return null;
    const bh = (Math.abs(v) / maxAbs) * (mid - 3);
    return (
      <rect
        key={key}
        x={x}
        y={v >= 0 ? mid - bh : mid}
        width={bw}
        height={Math.max(bh, 0.75)}
        fill={color}
        opacity="0.45"
      />
    );
  };
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--border-strong)" />
      {a.values.map((v, i) => bar(v, i * slot + 1, a.color, `a${i}`))}
      {b.values.map((v, i) => bar(v, i * slot + 1 + bw + 0.5, b.color, `b${i}`))}
      <path d={path(aCum)} fill="none" stroke={a.color} strokeWidth="1.5" strokeLinejoin="round" />
      <path d={path(bCum)} fill="none" stroke={b.color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 값 없이 색 견본 + 라벨만. 합계는 호출부가 계산해 넘긴다. */
export function LegendItem({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value?: number | null;
}) {
  return (
    <span className="flex items-center gap-2xs">
      <span className="inline-block h-[2px] w-[10px]" style={{ background: color }} />
      <span className="text-fg-dim">{label}</span>
      {value !== undefined && (
        <span className={value === null ? 'text-fg-dim' : priceDirClass(value)}>{fmtSigned(value)}</span>
      )}
    </span>
  );
}

/** 초소형 라인 스파크라인 — 당일 장중 흐름.
 *
 * **색 = 마지막 값 vs `baseline`(당일 시가).** 히트맵 `CandleGlyph` 와 같은 규칙이다
 * (DESIGN.md "Price-direction candle glyph": 색은 **종가 vs 시가** strict). 카드의 큰
 * 숫자는 *전일 대비* 라 시간창이 달라 **선과 숫자의 색이 갈릴 수 있는데, 그것이 의도**다
 * — 갭 상승 후 밀린 날은 "전일보단 위, 오늘은 아래" 가 사실이고 두 색이 그걸 말한다.
 * `baseline` 이 없으면 첫 점을 쓴다.
 *
 * 값이 2개 미만이면 그리지 않는다(한 점짜리 선은 거짓 정보다). */
export function Sparkline({
  points,
  baseline,
  width = 110,
  height = 40,
}: {
  points: number[];
  baseline?: number;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const px = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const py = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`)
    .join(' ');
  const dir = points[points.length - 1] - (baseline ?? points[0]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={dir >= 0 ? 'var(--price-up)' : 'var(--price-down)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 시장 폭 타일 — `truncated` 면 카운트가 **하한**이므로 `+` 를 붙인다(#1099). */
export function BreadthTile({
  label,
  count,
  truncated,
  dir,
}: {
  label: string;
  count: number | null;
  truncated?: boolean;
  dir: 'up' | 'down';
}) {
  return (
    <div
      className="flex flex-col items-center rounded-sm px-2xs py-2xs"
      style={{ background: 'var(--bg-subtle)' }}
      title={truncated ? '집계 상한에 도달해 실제 종목수는 이보다 많습니다' : undefined}
    >
      <span
        className={`font-data text-md font-semibold tabular-nums ${dir === 'up' ? 'text-price-up' : 'text-price-down'}`}
      >
        {count === null ? '—' : `${count.toLocaleString('ko-KR')}${truncated ? '+' : ''}`}
      </span>
      <span className="text-2xs text-fg-dim">{label}</span>
    </div>
  );
}
