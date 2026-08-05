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

/** 시리즈 색 — 다계열 라인은 MA 팔레트가 승인된 색 공간(방향색 적/청과 분리).
 *  외국인=--ma-3(주황) · 기관=--ma-4(초록) · 지수 오버레이=--fg-dim. */
export const NET_TREND_COLORS = {
  foreign: 'var(--ma-3)',
  institution: 'var(--ma-4)',
  index: 'var(--fg-dim)',
} as const;

/** 기관·외국인 20일 누적 순매수 라인 + 지수 종가 오버레이(별도 정규화, 흐린 선).
 *  누적 2계열은 0 기준선 공유 — "이 달 들어 누가 사 모았나"를 한 눈에. */
export function NetTrendChart({
  foreignDaily,
  institutionDaily,
  indexClose,
  width = 300,
  height = 96,
}: {
  foreignDaily: number[];
  institutionDaily: number[];
  indexClose?: number[];
  width?: number;
  height?: number;
}) {
  const cum = (daily: number[]) => {
    let acc = 0;
    return daily.map((v) => (acc += v));
  };
  const f = cum(foreignDaily);
  const inst = cum(institutionDaily);
  const all = [...f, ...inst, 0];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const n = f.length;
  const px = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const py = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  let idxPath: string | null = null;
  if (indexClose && indexClose.length > 1) {
    const imin = Math.min(...indexClose);
    const ispan = Math.max(...indexClose) - imin || 1;
    const ipy = (v: number) => height - 3 - ((v - imin) / ispan) * (height - 6);
    const ipx = (i: number) => (i / (indexClose.length - 1)) * (width - 4) + 2;
    idxPath = indexClose
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${ipx(i).toFixed(1)},${ipy(v).toFixed(1)}`)
      .join(' ');
  }
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
      {idxPath && (
        <path d={idxPath} fill="none" stroke={NET_TREND_COLORS.index} strokeWidth="1" opacity="0.45" />
      )}
      <path d={path(inst)} fill="none" stroke={NET_TREND_COLORS.institution} strokeWidth="1.5" strokeLinejoin="round" />
      <path d={path(f)} fill="none" stroke={NET_TREND_COLORS.foreign} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** NetTrendChart 범례 — 색 견본 + 누적 합계. */
export function NetTrendLegend({
  foreignDaily,
  institutionDaily,
  showIndex = true,
}: {
  foreignDaily: number[];
  institutionDaily: number[];
  showIndex?: boolean;
}) {
  const sum = (s: number[]) => s.reduce((a, v) => a + v, 0);
  const fSum = sum(foreignDaily);
  const iSum = sum(institutionDaily);
  return (
    <div className="flex items-center gap-md font-data text-2xs tabular-nums">
      <span className="flex items-center gap-2xs">
        <span className="inline-block h-[2px] w-[10px]" style={{ background: NET_TREND_COLORS.foreign }} />
        <span className="text-fg-dim">외국인</span>
        <span className={priceDirClass(fSum)}>{fmtSigned(fSum)}</span>
      </span>
      <span className="flex items-center gap-2xs">
        <span className="inline-block h-[2px] w-[10px]" style={{ background: NET_TREND_COLORS.institution }} />
        <span className="text-fg-dim">기관</span>
        <span className={priceDirClass(iSum)}>{fmtSigned(iSum)}</span>
      </span>
      {showIndex && (
        <span className="flex items-center gap-2xs">
          <span className="inline-block h-[2px] w-[10px] opacity-45" style={{ background: NET_TREND_COLORS.index }} />
          <span className="text-fg-dim">지수</span>
        </span>
      )}
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
