import type {
  GammaExposure,
  IvSkew,
  OiDistribution,
  PutCallRatio,
} from '../api/optionSentiment';

/**
 * 옵션 심리 패널의 시각화 4종 (ADR-0135).
 *
 * 세 SVG 차트는 x축이 모두 행사가라 같은 스케일 함수를 공유한다 — 축이 어긋나면
 * "Max Pain 은 저기, GEX 플립은 여기" 같은 비교가 불가능해진다.
 *
 * 색은 DESIGN.md 의 가격방향 토큰을 쓴다: 콜 = `--price-up`(빨강), 풋 =
 * `--price-down`(파랑). KRX 관습(상승=빨강)과 방향 베팅이 일치해 직관적이다.
 * `--accent` 는 UI 상태 전용이므로 기준선(현재가·Max Pain·플립)에만 쓴다.
 */

const CHART_W = 720;
const PAD_L = 8;
const PAD_R = 8;

function makeScale(strikes: number[]) {
  const lo = Math.min(...strikes);
  const hi = Math.max(...strikes);
  const span = hi - lo || 1;
  return (k: number) => PAD_L + ((k - lo) / span) * (CHART_W - PAD_L - PAD_R);
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return n.toFixed(0);
}

/** 현재가·Max Pain 등 기준선. label 은 상단에 붙는다. */
function RefLine({
  x,
  height,
  label,
  dashed = false,
}: {
  x: number;
  height: number;
  label: string;
  dashed?: boolean;
}) {
  return (
    <g>
      <line
        x1={x}
        x2={x}
        y1={0}
        y2={height}
        stroke="var(--accent)"
        strokeWidth={1}
        strokeDasharray={dashed ? '3 3' : undefined}
      />
      <text x={x + 3} y={10} fontSize={10} fill="var(--accent)">
        {label}
      </text>
    </g>
  );
}

export function PutCallPanel({ pc }: { pc: PutCallRatio }) {
  const rows: Array<[string, number | null, string]> = [
    ['거래량 P/C', pc.volume_ratio, `콜 ${pc.call_volume.toLocaleString()} · 풋 ${pc.put_volume.toLocaleString()}`],
    ['미결제 P/C', pc.oi_ratio, `콜 ${pc.call_oi.toLocaleString()} · 풋 ${pc.put_oi.toLocaleString()}`],
  ];
  return (
    <div className="flex gap-lg">
      {rows.map(([label, value, sub]) => (
        <div key={label} className="flex-1">
          <div className="text-xs text-fg-dim">{label}</div>
          <div className="text-2xl tabular-nums text-fg">
            {value === null ? '—' : value.toFixed(3)}
          </div>
          <div className="text-xs text-fg-dimmer tabular-nums">{sub}</div>
        </div>
      ))}
    </div>
  );
}

export function OiDistributionChart({
  dist,
  underlying,
}: {
  dist: OiDistribution;
  underlying: number | null;
}) {
  const rows = dist.strikes.filter((s) => s.call_oi > 0 || s.put_oi > 0);
  if (rows.length === 0) return <div className="text-xs text-fg-dim">미결제 데이터 없음</div>;
  const x = makeScale(rows.map((r) => r.strike));
  const peak = Math.max(...rows.map((r) => Math.max(r.call_oi, r.put_oi)));
  const half = 70;
  const barW = Math.max(1, (CHART_W - PAD_L - PAD_R) / rows.length - 0.5);

  return (
    <svg viewBox={`0 0 ${CHART_W} ${half * 2 + 16}`} className="w-full" role="img" aria-label="행사가별 미결제약정 분포">
      {/* 위: 콜, 아래: 풋. 중앙선 기준 양방향 */}
      {rows.map((r) => {
        const cx = x(r.strike);
        const ch = (r.call_oi / peak) * half;
        const ph = (r.put_oi / peak) * half;
        return (
          <g key={r.strike}>
            <rect x={cx - barW / 2} y={half - ch} width={barW} height={ch} fill="var(--price-up)" opacity={0.75} />
            <rect x={cx - barW / 2} y={half} width={barW} height={ph} fill="var(--price-down)" opacity={0.75} />
          </g>
        );
      })}
      <line x1={0} x2={CHART_W} y1={half} y2={half} stroke="var(--grid)" strokeWidth={1} />
      {underlying !== null && <RefLine x={x(underlying)} height={half * 2} label={`현재 ${underlying.toFixed(2)}`} />}
      {dist.max_pain !== null && (
        <RefLine x={x(dist.max_pain)} height={half * 2} label={`Max Pain ${dist.max_pain}`} dashed />
      )}
    </svg>
  );
}

export function GexChart({
  gex,
  underlying,
}: {
  gex: GammaExposure;
  underlying: number | null;
}) {
  const rows = gex.points.filter((p) => p.gex !== 0);
  if (rows.length === 0) return <div className="text-xs text-fg-dim">감마 데이터 없음</div>;
  const x = makeScale(rows.map((r) => r.strike));
  const peak = Math.max(...rows.map((r) => Math.abs(r.gex))) || 1;
  const half = 60;
  const barW = Math.max(1, (CHART_W - PAD_L - PAD_R) / rows.length - 0.5);

  return (
    <svg viewBox={`0 0 ${CHART_W} ${half * 2 + 16}`} className="w-full" role="img" aria-label="행사가별 감마 익스포저">
      {rows.map((p) => {
        const h = (Math.abs(p.gex) / peak) * half;
        const up = p.gex > 0;
        return (
          <rect
            key={p.strike}
            x={x(p.strike) - barW / 2}
            y={up ? half - h : half}
            width={barW}
            height={h}
            fill={up ? 'var(--price-up)' : 'var(--price-down)'}
            opacity={0.75}
          />
        );
      })}
      <line x1={0} x2={CHART_W} y1={half} y2={half} stroke="var(--grid)" strokeWidth={1} />
      {underlying !== null && <RefLine x={x(underlying)} height={half * 2} label={`현재 ${underlying.toFixed(2)}`} />}
      {gex.flip_strike !== null && (
        <RefLine x={x(gex.flip_strike)} height={half * 2} label={`플립 ${gex.flip_strike}`} dashed />
      )}
    </svg>
  );
}

export function IvSkewChart({ skew, underlying }: { skew: IvSkew; underlying: number | null }) {
  const rows = skew.points;
  if (rows.length === 0) return <div className="text-xs text-fg-dim">IV 데이터 없음</div>;
  const x = makeScale(rows.map((r) => r.strike));
  const ivs = rows.flatMap((r) => [r.call_iv, r.put_iv]).filter((v): v is number => v !== null);
  const lo = Math.min(...ivs);
  const hi = Math.max(...ivs);
  const span = hi - lo || 1;
  const H = 130;
  const y = (iv: number) => H - 12 - ((iv - lo) / span) * (H - 24);

  const path = (pick: (r: (typeof rows)[number]) => number | null) => {
    const pts = rows
      .map((r) => ({ k: r.strike, v: pick(r) }))
      .filter((p): p is { k: number; v: number } => p.v !== null);
    if (pts.length === 0) return null;
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.k).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  };
  const callPath = path((r) => r.call_iv);
  const putPath = path((r) => r.put_iv);

  return (
    <svg viewBox={`0 0 ${CHART_W} ${H}`} className="w-full" role="img" aria-label="행사가별 내재변동성 스마일">
      {callPath && <path d={callPath} fill="none" stroke="var(--price-up)" strokeWidth={1.5} />}
      {putPath && <path d={putPath} fill="none" stroke="var(--price-down)" strokeWidth={1.5} />}
      {underlying !== null && <RefLine x={x(underlying)} height={H} label={`현재 ${underlying.toFixed(2)}`} />}
      <text x={PAD_L} y={H - 2} fontSize={10} fill="var(--fg-dimmer)">
        IV {lo.toFixed(1)}~{hi.toFixed(1)}%
      </text>
    </svg>
  );
}

/** GEX 총합·플립 등 숫자 요약. 차트 위에 붙는다. */
export function GexSummary({ gex }: { gex: GammaExposure }) {
  return (
    <div className="flex gap-lg">
      <div>
        <div className="text-xs text-fg-dim">총 GEX (1% 이동당)</div>
        <div className="text-lg tabular-nums text-fg">{fmtCompact(gex.total)}원</div>
      </div>
      <div>
        <div className="text-xs text-fg-dim">감마 플립</div>
        <div className="text-lg tabular-nums text-fg">{gex.flip_strike ?? '—'}</div>
      </div>
    </div>
  );
}

/**
 * OI 상위 기여 행사가. Max Pain·GEX 가 "무엇에 끌려간 값인지" 드러내는 용도다.
 *
 * 실측(2026-08-03)에서 델타가 사실상 0인 극외가에 OI 가 몰렸다 — 콜 1597.5(+58.5%
 * OTM, 델타 0.0002) OI 14,444, 풋 625.0(−38.0%) OI 14,402. 상위 4종목이 전체 OI 의
 * 21.5%였다. 원값만 크게 띄우면 미국 시장 기준 해설을 그대로 적용해 오독하게 된다.
 */
export function OiContributors({
  dist,
  underlying,
}: {
  dist: OiDistribution;
  underlying: number | null;
}) {
  const top = [...dist.strikes]
    .map((s) => ({ ...s, total: s.call_oi + s.put_oi }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const sum = dist.strikes.reduce((acc, s) => acc + s.call_oi + s.put_oi, 0);
  if (sum === 0) return null;

  return (
    <table className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-fg-dim">
          <th className="text-left font-normal">행사가</th>
          <th className="text-right font-normal">ATM 대비</th>
          <th className="text-right font-normal">콜 OI</th>
          <th className="text-right font-normal">풋 OI</th>
          <th className="text-right font-normal">비중</th>
        </tr>
      </thead>
      <tbody>
        {top.map((s) => (
          <tr key={s.strike} className="text-fg">
            <td className="text-left">{s.strike.toFixed(1)}</td>
            <td className="text-right text-fg-dim">
              {underlying ? `${(((s.strike - underlying) / underlying) * 100).toFixed(1)}%` : '—'}
            </td>
            <td className="text-right">{s.call_oi.toLocaleString()}</td>
            <td className="text-right">{s.put_oi.toLocaleString()}</td>
            <td className="text-right text-fg-dim">{((s.total / sum) * 100).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
