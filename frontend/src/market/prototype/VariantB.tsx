/** B — 업종 × 주체 매트릭스 (히트 테이블).
 *
 *  전제: 수급의 뜻은 **누가 누구에게 넘겼나**에 있다. 개인 +1000 은 그 자체로 정보가
 *  아니고 "외국인이 -1000" 이어야 그림이 된다. 그래서 토글을 없애고 세 주체를 열로
 *  나란히 놓아 한 행에서 상계가 보이게 한다.
 *
 *  버리는 것: 세로가 길다. 업종 전체(코스피 27 + 코스닥 31)를 담으면 시장 폭 카드
 *  자리를 넘어선다 — 그래서 거래대금 상위로 자른다. 그 절단이 이 변형의 약점이다.
 */
import { useState } from 'react';
import { MarketCard, CardHeader, ModeSwitch } from '../marketCardBits';
import { SECTOR_FLOW_FIXTURE } from './fixture';

type Market = 'KOSPI' | 'KOSDAQ';
const MARKETS: ReadonlyArray<readonly [Market, string]> = [
  ['KOSPI', '코스피'],
  ['KOSDAQ', '코스닥'],
];

const COLS = [
  { key: 'individual', label: '개인' },
  { key: 'foreign', label: '외국인' },
  { key: 'institution', label: '기관' },
] as const;

/** 세로 예산. 시장 폭 카드가 쓰던 높이를 넘지 않게 자른다. */
const ROWS = 12;

export function VariantB() {
  const [market, setMarket] = useState<Market>('KOSPI');
  const all = SECTOR_FLOW_FIXTURE[market];
  const whole = all.find((r) => r.name.startsWith('종합'));
  const rows = all
    .filter((r) => !r.name.startsWith('종합'))
    // 절단 기준은 "얼마나 움직였나" — 세 주체 절대값 합.
    .map((r) => ({ ...r, mass: Math.abs(r.individual) + Math.abs(r.foreign) + Math.abs(r.institution) }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, ROWS);

  const max = Math.max(...rows.flatMap((r) => COLS.map((c) => Math.abs(r[c.key] as number))), 1);

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="업종 × 투자자"
        hint="당일 누적 · 억원 · 수급 상위"
        right={<ModeSwitch value={market} options={MARKETS} onChange={setMarket} label="시장" />}
      />

      <table className="w-full border-collapse font-data text-2xs tabular-nums">
        <thead>
          <tr className="text-fg-dim">
            <th className="pb-1 text-left font-normal">업종</th>
            <th className="pb-1 text-right font-normal">등락</th>
            {COLS.map((c) => (
              <th key={c.key} className="pb-1 text-right font-normal">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {whole && <Row row={whole} max={max} emphasise />}
          {rows.map((r) => (
            <Row key={r.code} row={r} max={max} />
          ))}
        </tbody>
      </table>
    </MarketCard>
  );
}

function Row({
  row,
  max,
  emphasise,
}: {
  row: { code: string; name: string; changePct: number; individual: number; foreign: number; institution: number };
  max: number;
  emphasise?: boolean;
}) {
  return (
    <tr className={emphasise ? 'border-b border-border text-fg' : 'text-fg'}>
      <td className={`max-w-[7rem] truncate py-0.5 ${emphasise ? 'font-semibold' : ''}`}>
        {row.name}
      </td>
      <td
        className="py-0.5 text-right"
        style={{ color: row.changePct >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}
      >
        {row.changePct >= 0 ? '+' : ''}
        {row.changePct.toFixed(2)}%
      </td>
      {COLS.map((c) => {
        const v = row[c.key] as number;
        const alpha = Math.min(Math.abs(v) / max, 1) * 0.5;
        return (
          <td
            key={c.key}
            className="py-0.5 text-right"
            style={{
              background:
                alpha < 0.02
                  ? undefined
                  : `color-mix(in srgb, ${v >= 0 ? 'var(--price-up)' : 'var(--price-down)'} ${alpha * 100}%, transparent)`,
            }}
          >
            {v >= 0 ? '+' : ''}
            {v.toLocaleString('ko-KR')}
          </td>
        );
      })}
    </tr>
  );
}
