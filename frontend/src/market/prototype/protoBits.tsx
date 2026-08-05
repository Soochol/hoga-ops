// ============================================================================
// PROTOTYPE — throwaway. 변형 공용 소형 조각(스파크라인·포맷터)만 둔다.
// 레이아웃은 절대 공유하지 않는다 — 변형마다 구조가 달라야 프로토타입이다.
// ============================================================================
import { priceDirClass } from '../../ui/priceDir';

export function fmtPct(pct: number): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function fmtSigned(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${Math.round(n).toLocaleString('ko-KR')}`;
}

/** 등락률 텍스트 조각 — 색·부호 2중 표기(색약 보조), QuoteChange 컨벤션. */
export function PctText({ pct, className = '' }: { pct: number; className?: string }) {
  return (
    <span className={`font-data tabular-nums ${priceDirClass(pct)} ${className}`}>{fmtPct(pct)}</span>
  );
}

/** 초소형 라인 스파크라인 — 방향색, 0 기준선 없음(값 자체가 정규화됨). */
export function Sparkline({
  points,
  width = 96,
  height = 28,
  strokeVar,
}: {
  points: number[];
  width?: number;
  height?: number;
  /** 미지정 시 시작→끝 방향으로 price-up/down 자동 */
  strokeVar?: string;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const px = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const py = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const dir = points[points.length - 1] - points[0];
  const stroke = strokeVar ?? (dir >= 0 ? 'var(--price-up)' : 'var(--price-down)');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 상승/보합/하락 종목수 비율 막대 — advance/decline 이 null 이면 렌더 안 함. */
export function AdvanceDeclineBar({
  advance,
  decline,
  flat,
  height = 4,
}: {
  advance: number | null;
  decline: number | null;
  flat: number | null;
  height?: number;
}) {
  if (advance === null || decline === null) return null;
  const f = flat ?? 0;
  const total = advance + decline + f || 1;
  return (
    <div className="flex w-full overflow-hidden rounded-sm" style={{ height }} aria-hidden="true">
      <div style={{ width: `${(advance / total) * 100}%`, background: 'var(--price-up)' }} />
      <div style={{ width: `${(f / total) * 100}%`, background: 'var(--border-strong)' }} />
      <div style={{ width: `${(decline / total) * 100}%`, background: 'var(--price-down)' }} />
    </div>
  );
}

/** 부호 있는 수평 순매수 막대 (0 중앙 기준) — 투자자 수급용. */
export function NetBar({ value, max }: { value: number; max: number }) {
  const ratio = Math.min(Math.abs(value) / (max || 1), 1);
  const half = ratio * 50;
  return (
    <div className="relative h-[10px] w-full" aria-hidden="true">
      <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: 'var(--border-strong)' }} />
      <div
        className="absolute inset-y-[2px] rounded-sm"
        style={
          value >= 0
            ? { left: '50%', width: `${half}%`, background: 'var(--price-up)' }
            : { right: '50%', width: `${half}%`, background: 'var(--price-down)' }
        }
      />
    </div>
  );
}
