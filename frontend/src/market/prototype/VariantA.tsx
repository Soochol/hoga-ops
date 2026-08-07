/** A — 주체 토글 + 순매수 랭킹 (발산 막대).
 *
 *  전제: 사용자가 한 번에 궁금한 주체는 **하나**다("오늘 외국인 어디 샀나"). 그래서
 *  주체를 토글로 두고 그 한 축을 업종 랭킹으로 세운다. 30개를 다 보여주지 않고
 *  상·하위만 잘라 시장 폭 카드가 쓰던 세로 공간에 맞춘다.
 *
 *  버리는 것: 주체 간 비교(개인이 산 걸 누가 받았나)가 토글 전환 없이는 안 보인다.
 */
import { useState } from 'react';
import { MarketCard, CardHeader, ModeSwitch } from '../marketCardBits';
import { SECTOR_FLOW_FIXTURE } from './fixture';

type Actor = 'foreign' | 'institution' | 'individual';
type Market = 'KOSPI' | 'KOSDAQ';

const ACTORS: ReadonlyArray<readonly [Actor, string]> = [
  ['foreign', '외국인'],
  ['institution', '기관'],
  ['individual', '개인'],
];
const MARKETS: ReadonlyArray<readonly [Market, string]> = [
  ['KOSPI', '코스피'],
  ['KOSDAQ', '코스닥'],
];

/** 상·하위 몇 개씩 보일지. 세로 공간이 시장 폭 카드와 같아야 레이아웃이 안 흔들린다. */
const TOP_N = 6;

export function VariantA() {
  const [actor, setActor] = useState<Actor>('foreign');
  const [market, setMarket] = useState<Market>('KOSPI');

  const rows = SECTOR_FLOW_FIXTURE[market]
    .filter((r) => !r.name.startsWith('종합'))
    .map((r) => ({ name: r.name, v: r[actor] as number, chg: r.changePct }))
    .sort((a, b) => b.v - a.v);

  const top = rows.slice(0, TOP_N);
  const bottom = rows.slice(-TOP_N).reverse();
  const max = Math.max(...rows.map((r) => Math.abs(r.v)), 1);

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="업종 수급"
        hint="당일 누적 · 억원"
        right={
          <div className="flex gap-xs">
            <ModeSwitch value={market} options={MARKETS} onChange={setMarket} label="시장" />
            <ModeSwitch value={actor} options={ACTORS} onChange={setActor} label="투자자" />
          </div>
        }
      />

      <Section rows={top} max={max} label="순매수" />
      <Section rows={bottom} max={max} label="순매도" />
    </MarketCard>
  );
}

function Section({
  rows,
  max,
  label,
}: {
  rows: { name: string; v: number; chg: number }[];
  max: number;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs text-fg-dim">{label}</span>
      {rows.map((r) => {
        const pct = (Math.abs(r.v) / max) * 100;
        const up = r.v >= 0;
        return (
          <div key={r.name} className="flex items-center gap-xs">
            <span className="w-24 shrink-0 truncate text-2xs text-fg-dim">{r.name}</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-bg-elev">
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{
                  width: `${pct}%`,
                  background: up ? 'var(--price-up)' : 'var(--price-down)',
                  opacity: 0.75,
                }}
              />
            </div>
            <span
              className="w-14 shrink-0 text-right font-data text-2xs tabular-nums"
              style={{ color: up ? 'var(--price-up)' : 'var(--price-down)' }}
            >
              {up ? '+' : ''}
              {r.v.toLocaleString('ko-KR')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
