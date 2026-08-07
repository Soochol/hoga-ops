/** C — 등락률 × 외국인 순매수 산점도.
 *
 *  전제: 표는 "얼마"를 답하지만 사용자가 찾는 것은 **불일치**다 — 외국인이 사는데
 *  아직 안 오른 업종, 오르는데 외국인이 파는 업종. 그건 정렬된 리스트에서는 두 표를
 *  머릿속에서 조인해야 보이고, 산점도에서는 사분면 위치로 즉시 보인다.
 *
 *  버리는 것: 정확한 금액을 읽기 어렵다(호버가 필요하고, 겹친 점은 못 읽는다).
 *  "얼마나" 를 알아야 하는 사용자는 A/B 로 가야 한다.
 */
import { useState } from 'react';
import { MarketCard, CardHeader, ModeSwitch } from '../marketCardBits';
import { SECTOR_FLOW_FIXTURE } from './fixture';

type Market = 'KOSPI' | 'KOSDAQ';
const MARKETS: ReadonlyArray<readonly [Market, string]> = [
  ['KOSPI', '코스피'],
  ['KOSDAQ', '코스닥'],
];

const W = 320;
const H = 190;
const PAD = 22;

export function VariantC() {
  const [market, setMarket] = useState<Market>('KOSPI');
  const [hover, setHover] = useState<string | null>(null);

  const rows = SECTOR_FLOW_FIXTURE[market].filter((r) => !r.name.startsWith('종합'));
  const maxChg = Math.max(...rows.map((r) => Math.abs(r.changePct)), 0.5);
  const maxFlow = Math.max(...rows.map((r) => Math.abs(r.foreign)), 1);
  const maxQty = Math.max(...rows.map((r) => r.tradeQty), 1);

  const x = (chg: number) => PAD + ((chg / maxChg + 1) / 2) * (W - PAD * 2);
  const y = (flow: number) => H - PAD - ((flow / maxFlow + 1) / 2) * (H - PAD * 2);
  const r = (qty: number) => 2.5 + Math.sqrt(qty / maxQty) * 6;

  const active = rows.find((s) => s.code === hover);

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="업종 수급 지도"
        hint="x 등락률 · y 외국인 순매수(억) · 크기 거래량"
        right={<ModeSwitch value={market} options={MARKETS} onChange={setMarket} label="시장" />}
      />

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="업종 수급 산점도">
        {/* 사분면 — 의미를 글자로 박아 둔다. 좌표만으로는 아무도 안 읽는다. */}
        <line x1={x(0)} y1={PAD} x2={x(0)} y2={H - PAD} stroke="var(--border)" />
        <line x1={PAD} y1={y(0)} x2={W - PAD} y2={y(0)} stroke="var(--border)" />
        <text x={W - PAD} y={PAD + 8} textAnchor="end" className="fill-fg-dimmer" fontSize="8">
          외국인 매수 · 상승
        </text>
        <text x={PAD} y={PAD + 8} className="fill-fg-dimmer" fontSize="8">
          외국인 매수 · 하락
        </text>
        <text x={PAD} y={H - PAD - 3} className="fill-fg-dimmer" fontSize="8">
          외국인 매도 · 하락
        </text>
        <text x={W - PAD} y={H - PAD - 3} textAnchor="end" className="fill-fg-dimmer" fontSize="8">
          외국인 매도 · 상승
        </text>

        {rows.map((s) => (
          <circle
            key={s.code}
            cx={x(s.changePct)}
            cy={y(s.foreign)}
            r={r(s.tradeQty)}
            fill={s.foreign >= 0 ? 'var(--price-up)' : 'var(--price-down)'}
            opacity={hover && hover !== s.code ? 0.18 : 0.55}
            onMouseEnter={() => setHover(s.code)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {/* 호버 없이도 한 줄은 늘 채운다 — 빈 줄이 생기면 카드 높이가 흔들린다. */}
      <div className="flex items-baseline justify-between font-data text-2xs tabular-nums">
        {active ? (
          <>
            <span className="text-fg">{active.name}</span>
            <span style={{ color: active.changePct >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}>
              {active.changePct >= 0 ? '+' : ''}
              {active.changePct.toFixed(2)}% · 외국인 {active.foreign >= 0 ? '+' : ''}
              {active.foreign.toLocaleString('ko-KR')}
            </span>
          </>
        ) : (
          <span className="text-fg-dim">점 위에 올리면 업종을 봅니다</span>
        )}
      </div>
    </MarketCard>
  );
}
