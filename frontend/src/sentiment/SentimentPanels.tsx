import { useCallback, useState } from 'react';

import type {
  GammaExposure,
  IvSkew,
  OiDistribution,
  PutCallRatio,
  PutCallSeriesPoint,
} from '../api/optionSentiment';
import {
  AXIS_H,
  CHART_W,
  PAD_L,
  PAD_R,
  nearestStrike,
  strikeAt,
  ticksFor,
  xOf,
  type StrikeDomain,
} from './strikeScale';

/**
 * 옵션 심리 패널의 시각화 4종 (ADR-0135).
 *
 * 세 SVG 차트는 x축이 모두 행사가라 **페이지가 내려주는 공유 도메인**으로 그린다
 * (`strikeScale.ts` — 각자 자기 데이터로 스케일을 만들면 축이 어긋나 교차 판독이
 * 불가능해진다). 도메인 밖 행은 그리지 않되, 기준선(Max Pain·플립)이 밖에 있으면
 * 가장자리 화살표로 존재를 알린다 — 조용히 사라지면 "기준선이 없다" 로 오독된다.
 *
 * 색은 DESIGN.md 의 가격방향 토큰: 콜 = `--price-up`(빨강), 풋 = `--price-down`
 * (파랑). KRX 관습(상승=빨강)과 방향 베팅이 일치해 직관적이다. `--accent` 는 UI
 * 상태 전용이므로 기준선·호버 가이드라인에만 쓴다.
 */

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return n.toFixed(0);
}

/** x축 눈금 밴드. 모든 차트가 같은 도메인을 쓰므로 라벨이 세로로 정렬된다. */
function StrikeAxis({ domain, y }: { domain: StrikeDomain; y: number }) {
  return (
    <g>
      <line x1={PAD_L} x2={CHART_W - PAD_R} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} />
      {ticksFor(domain).map((t) => (
        <g key={t}>
          <line
            x1={xOf(domain, t)}
            x2={xOf(domain, t)}
            y1={y}
            y2={y + 3}
            stroke="var(--fg-dimmer)"
            strokeWidth={1}
          />
          <text
            x={xOf(domain, t)}
            y={y + 13}
            fontSize={10}
            fill="var(--fg-dimmer)"
            textAnchor="middle"
          >
            {t.toLocaleString()}
          </text>
        </g>
      ))}
    </g>
  );
}

/**
 * 기준선(현재가·Max Pain·플립). 도메인 밖이면 선 대신 가장자리 화살표 라벨 —
 * ATM 줌에서 플립(예: 687.5)이 화면 밖일 때 존재 자체를 감추지 않기 위해서다.
 */
function RefLine({
  strike,
  domain,
  height,
  label,
  dashed = false,
}: {
  strike: number;
  domain: StrikeDomain;
  height: number;
  label: string;
  dashed?: boolean;
}) {
  if (strike < domain.lo) {
    return (
      <text x={PAD_L} y={10} fontSize={10} fill="var(--accent)">
        {`◀ ${label}`}
      </text>
    );
  }
  if (strike > domain.hi) {
    return (
      <text x={CHART_W - PAD_R} y={10} fontSize={10} fill="var(--accent)" textAnchor="end">
        {`${label} ▶`}
      </text>
    );
  }
  const x = xOf(domain, strike);
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

/**
 * 행사가 호버 훅. 마우스 x → 도메인 역변환 → 가장 가까운 행사가로 스냅.
 * jsdom 은 getBoundingClientRect 가 0 폭이라 가드로 조용히 무시된다 — 호버 스냅
 * 자체는 strikeScale 의 순수 함수 테스트가 커버한다.
 */
function useStrikeHover(sortedStrikes: number[], domain: StrikeDomain) {
  const [hover, setHover] = useState<number | null>(null);
  const onMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const px = ((e.clientX - rect.left) / rect.width) * CHART_W;
      setHover(nearestStrike(sortedStrikes, strikeAt(domain, px)));
    },
    [sortedStrikes, domain],
  );
  const onMouseLeave = useCallback(() => setHover(null), []);
  return { hover, onMouseMove, onMouseLeave };
}

/** 호버 툴팁 카드. 부모가 `relative` 여야 한다. */
function HoverTip({
  domain,
  strike,
  rows,
}: {
  domain: StrikeDomain;
  strike: number;
  rows: Array<[string, string]>;
}) {
  const pct = (xOf(domain, strike) / CHART_W) * 100;
  // 가장자리에서 카드가 잘리지 않게 클램프
  const left = Math.min(92, Math.max(8, pct));
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded border border-border bg-bg-card px-sm py-xs text-xs tabular-nums"
      style={{ left: `${left}%`, boxShadow: 'var(--shadow)' }}
    >
      <div className="text-fg">{strike.toLocaleString()}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-md text-fg-dim">
          <span>{k}</span>
          <span className="text-fg">{v}</span>
        </div>
      ))}
    </div>
  );
}

function HoverGuide({ domain, strike, height }: { domain: StrikeDomain; strike: number; height: number }) {
  const x = xOf(domain, strike);
  return <line x1={x} x2={x} y1={0} y2={height} stroke="var(--accent)" strokeWidth={1} opacity={0.35} />;
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
          <div className="text-xs text-fg-dim tabular-nums">{sub}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * P/C 비율 당일 추이. 스냅샷 숫자는 "지금 얼마"만 말한다 — "지금 풋이 쌓이는
 * 중인가" 는 이 곡선의 기울기가 말한다. 1.0 기준선 = 콜/풋 균형.
 *
 * 색을 쓰지 않는 이유: 비율은 콜도 풋도 아니라서 빨강/파랑 어느 쪽을 칠해도
 * 이웃 차트의 콜/풋 인코딩과 충돌한다. 두 계열은 실선(거래량)/점선(미결제)으로
 * 가른다.
 */
export function PutCallSeriesChart({ points }: { points: PutCallSeriesPoint[] }) {
  const H = 110;
  if (points.length < 2) {
    return (
      <div className="text-xs text-fg-dim">
        추이 축적 중 — 전수 수집(5분)마다 한 점씩 쌓입니다. 서버를 재시작하면 그
        시점부터 다시 쌓입니다
      </div>
    );
  }
  const t0 = points[0].t_ms;
  const t1 = points[points.length - 1].t_ms;
  const tSpan = t1 - t0 || 1;
  const x = (t: number) => PAD_L + ((t - t0) / tSpan) * (CHART_W - PAD_L - PAD_R);
  const vals = points
    .flatMap((p) => [p.volume_ratio, p.oi_ratio])
    .filter((v): v is number => v !== null);
  // 1.0(균형)을 항상 도메인에 포함 — 기준선이 화면 밖으로 나가면 절대 수준을 잃는다.
  const lo = Math.min(1, ...vals);
  const hi = Math.max(1, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => H - 10 - ((v - lo) / span) * (H - 26);

  const path = (pick: (p: PutCallSeriesPoint) => number | null) => {
    const pts = points
      .map((p) => ({ t: p.t_ms, v: pick(p) }))
      .filter((q): q is { t: number; v: number } => q.v !== null);
    if (pts.length === 0) return null;
    return pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${x(q.t).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
  };
  const volPath = path((p) => p.volume_ratio);
  const oiPath = path((p) => p.oi_ratio);
  const fmtT = (ms: number) =>
    new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });

  return (
    <svg viewBox={`0 0 ${CHART_W} ${H + AXIS_H}`} className="w-full" role="img" aria-label="P/C 비율 당일 추이">
      <line
        x1={PAD_L}
        x2={CHART_W - PAD_R}
        y1={y(1)}
        y2={y(1)}
        stroke="var(--grid)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <text x={CHART_W - PAD_R} y={y(1) - 3} fontSize={10} fill="var(--fg-dimmer)" textAnchor="end">
        1.0 균형
      </text>
      {volPath && <path d={volPath} fill="none" stroke="var(--fg)" strokeWidth={1.5} />}
      {oiPath && (
        <path d={oiPath} fill="none" stroke="var(--fg-dim)" strokeWidth={1.5} strokeDasharray="4 3" />
      )}
      <g fontSize={10} fill="var(--fg-dim)">
        <line x1={PAD_L} x2={PAD_L + 14} y1={5} y2={5} stroke="var(--fg)" strokeWidth={1.5} />
        <text x={PAD_L + 18} y={8}>거래량</text>
        <line x1={PAD_L + 58} x2={PAD_L + 72} y1={5} y2={5} stroke="var(--fg-dim)" strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={PAD_L + 76} y={8}>미결제</text>
      </g>
      <g fontSize={10} fill="var(--fg-dimmer)">
        <text x={PAD_L} y={H + 13}>{fmtT(t0)}</text>
        <text x={CHART_W - PAD_R} y={H + 13} textAnchor="end">{fmtT(t1)}</text>
      </g>
    </svg>
  );
}

export function OiDistributionChart({
  dist,
  underlying,
  domain,
}: {
  dist: OiDistribution;
  underlying: number | null;
  domain: StrikeDomain;
}) {
  const rows = dist.strikes.filter(
    (s) => (s.call_oi > 0 || s.put_oi > 0) && s.strike >= domain.lo && s.strike <= domain.hi,
  );
  const { hover, onMouseMove, onMouseLeave } = useStrikeHover(
    rows.map((r) => r.strike),
    domain,
  );
  if (rows.length === 0) return <div className="text-xs text-fg-dim">이 구간에 미결제 데이터 없음</div>;
  const peak = Math.max(...rows.map((r) => Math.max(r.call_oi, r.put_oi)));
  const half = 70;
  const H = half * 2;
  const barW = Math.max(1, (CHART_W - PAD_L - PAD_R) / rows.length - 0.5);
  const hovered = hover === null ? null : rows.find((r) => r.strike === hover);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${H + AXIS_H}`}
        className="w-full"
        role="img"
        aria-label="행사가별 미결제약정 분포"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {rows.map((r) => {
          const cx = xOf(domain, r.strike);
          const ch = (r.call_oi / peak) * half;
          const ph = (r.put_oi / peak) * half;
          return (
            <g key={r.strike}>
              <rect x={cx - barW / 2} y={half - ch} width={barW} height={ch} fill="var(--price-up)" opacity={0.75} />
              <rect x={cx - barW / 2} y={half} width={barW} height={ph} fill="var(--price-down)" opacity={0.75} />
            </g>
          );
        })}
        <line x1={PAD_L} x2={CHART_W - PAD_R} y1={half} y2={half} stroke="var(--grid)" strokeWidth={1} />
        {hover !== null && <HoverGuide domain={domain} strike={hover} height={H} />}
        {underlying !== null && (
          <RefLine strike={underlying} domain={domain} height={H} label={`현재 ${underlying.toFixed(2)}`} />
        )}
        {dist.max_pain !== null && (
          <RefLine strike={dist.max_pain} domain={domain} height={H} label={`Max Pain ${dist.max_pain}`} dashed />
        )}
        {/* 미니 범례 — caveat 문구가 하단으로 내려가도 색 의미가 즉시 보이게 */}
        <g fontSize={10}>
          <rect x={PAD_L} y={2} width={8} height={3} fill="var(--price-up)" />
          <text x={PAD_L + 11} y={7} fill="var(--fg-dim)">콜</text>
          <rect x={PAD_L + 30} y={2} width={8} height={3} fill="var(--price-down)" />
          <text x={PAD_L + 41} y={7} fill="var(--fg-dim)">풋</text>
        </g>
        <StrikeAxis domain={domain} y={H + 2} />
      </svg>
      {hovered && (
        <HoverTip
          domain={domain}
          strike={hovered.strike}
          rows={[
            ['콜 OI', hovered.call_oi.toLocaleString()],
            ['풋 OI', hovered.put_oi.toLocaleString()],
          ]}
        />
      )}
    </div>
  );
}

export function GexChart({
  gex,
  underlying,
  domain,
}: {
  gex: GammaExposure;
  underlying: number | null;
  domain: StrikeDomain;
}) {
  const rows = gex.points.filter((p) => p.gex !== 0 && p.strike >= domain.lo && p.strike <= domain.hi);
  const { hover, onMouseMove, onMouseLeave } = useStrikeHover(
    rows.map((r) => r.strike),
    domain,
  );
  if (rows.length === 0) return <div className="text-xs text-fg-dim">이 구간에 감마 데이터 없음</div>;
  const peak = Math.max(...rows.map((r) => Math.abs(r.gex))) || 1;
  const half = 60;
  const H = half * 2;
  const barW = Math.max(1, (CHART_W - PAD_L - PAD_R) / rows.length - 0.5);
  const hovered = hover === null ? null : rows.find((r) => r.strike === hover);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${H + AXIS_H}`}
        className="w-full"
        role="img"
        aria-label="행사가별 감마 익스포저"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {rows.map((p) => {
          const h = (Math.abs(p.gex) / peak) * half;
          const up = p.gex > 0;
          return (
            <rect
              key={p.strike}
              x={xOf(domain, p.strike) - barW / 2}
              y={up ? half - h : half}
              width={barW}
              height={h}
              // 단색 — 부호는 0선 위/아래 위치가 이미 말한다. 빨강/파랑을 재사용하면
              // 이웃 카드의 콜/풋 인코딩과 충돌하고, 양수(=움직임 억제)에 빨강이
              // 붙어 직관과 반대로 읽힌다.
              fill="var(--fg-dim)"
              opacity={0.7}
            />
          );
        })}
        <line x1={PAD_L} x2={CHART_W - PAD_R} y1={half} y2={half} stroke="var(--grid)" strokeWidth={1} />
        {hover !== null && <HoverGuide domain={domain} strike={hover} height={H} />}
        {underlying !== null && (
          <RefLine strike={underlying} domain={domain} height={H} label={`현재 ${underlying.toFixed(2)}`} />
        )}
        {gex.flip_strike !== null && (
          <RefLine strike={gex.flip_strike} domain={domain} height={H} label={`플립 ${gex.flip_strike}`} dashed />
        )}
        <StrikeAxis domain={domain} y={H + 2} />
      </svg>
      {hovered && (
        <HoverTip
          domain={domain}
          strike={hovered.strike}
          rows={[['GEX', `${fmtCompact(hovered.gex)}원`]]}
        />
      )}
    </div>
  );
}

export function IvSkewChart({
  skew,
  underlying,
  domain,
}: {
  skew: IvSkew;
  underlying: number | null;
  domain: StrikeDomain;
}) {
  const rows = skew.points.filter((p) => p.strike >= domain.lo && p.strike <= domain.hi);
  const { hover, onMouseMove, onMouseLeave } = useStrikeHover(
    rows.map((r) => r.strike),
    domain,
  );
  if (rows.length === 0) return <div className="text-xs text-fg-dim">이 구간에 IV 데이터 없음</div>;
  const ivs = rows.flatMap((r) => [r.call_iv, r.put_iv]).filter((v): v is number => v !== null);
  const lo = Math.min(...ivs);
  const hi = Math.max(...ivs);
  const span = hi - lo || 1;
  const H = 130;
  const y = (iv: number) => H - 8 - ((iv - lo) / span) * (H - 24);

  const path = (pick: (r: (typeof rows)[number]) => number | null) => {
    const pts = rows
      .map((r) => ({ k: r.strike, v: pick(r) }))
      .filter((p): p is { k: number; v: number } => p.v !== null);
    if (pts.length === 0) return null;
    return pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(domain, p.k).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ');
  };
  const callPath = path((r) => r.call_iv);
  const putPath = path((r) => r.put_iv);
  const hovered = hover === null ? null : rows.find((r) => r.strike === hover);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${H + AXIS_H}`}
        className="w-full"
        role="img"
        aria-label="행사가별 내재변동성 스마일"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {/* 선은 흐리게 — 저유동성 구간의 톱니(실측: OI 한 자릿수 행사가의 실제
            IV 산포)가 화면을 지배하지 않게 한다. 신뢰도는 점의 투명도가 말한다. */}
        {callPath && <path d={callPath} fill="none" stroke="var(--price-up)" strokeWidth={1} opacity={0.3} />}
        {putPath && <path d={putPath} fill="none" stroke="var(--price-down)" strokeWidth={1} opacity={0.3} />}
        {rows.map((r) => {
          // OI 로그 스케일 투명도: OI 5 → ~0.34, 100 → ~0.6, 10,000 → 1.0.
          // 지표에서 지우는 대신 화면에서 감쇠한다 — 지우면 Max Pain·GEX 가 보는
          // 데이터와 달라진다.
          const alpha = Math.min(1, 0.2 + 0.8 * (Math.log10(1 + r.oi) / 4));
          const cx = xOf(domain, r.strike);
          return (
            <g key={r.strike} opacity={alpha}>
              {r.call_iv !== null && <circle cx={cx} cy={y(r.call_iv)} r={1.8} fill="var(--price-up)" />}
              {r.put_iv !== null && <circle cx={cx} cy={y(r.put_iv)} r={1.8} fill="var(--price-down)" />}
            </g>
          );
        })}
        {hover !== null && <HoverGuide domain={domain} strike={hover} height={H} />}
        {underlying !== null && (
          <RefLine strike={underlying} domain={domain} height={H} label={`현재 ${underlying.toFixed(2)}`} />
        )}
        {/* 미니 범례 — 색 의미를 문장 밖에서도 알 수 있게 */}
        <g fontSize={10}>
          <rect x={PAD_L} y={2} width={8} height={3} fill="var(--price-up)" />
          <text x={PAD_L + 11} y={7} fill="var(--fg-dim)">콜</text>
          <rect x={PAD_L + 30} y={2} width={8} height={3} fill="var(--price-down)" />
          <text x={PAD_L + 41} y={7} fill="var(--fg-dim)">풋</text>
        </g>
        <text x={PAD_L} y={H - 2} fontSize={10} fill="var(--fg-dimmer)">
          IV {lo.toFixed(1)}~{hi.toFixed(1)}%
        </text>
        <StrikeAxis domain={domain} y={H + 2} />
      </svg>
      {hovered && (
        <HoverTip
          domain={domain}
          strike={hovered.strike}
          rows={[
            ['콜 IV', hovered.call_iv === null ? '—' : `${hovered.call_iv.toFixed(2)}%`],
            ['풋 IV', hovered.put_iv === null ? '—' : `${hovered.put_iv.toFixed(2)}%`],
          ]}
        />
      )}
    </div>
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
 * ATM 줌과 무관하게 **전 행사가 기준**이다 — 줌으로 잘린 극외가를 여기서 본다.
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
