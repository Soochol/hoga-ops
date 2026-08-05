// ============================================================================
// PROTOTYPE — throwaway. 변형 B: 신문형 스캔 보드.
//
// 구조: 카드 없음(히트맵 폴더 surface 예외 문법 차용) — 상단 1줄 지수 티커
// 스트립 + 4열 초고밀도 플랫 컬럼(상승/하락 · 거래대금 · 거래량급증 · 섹터·수급).
// 각 열은 heatHeaderBg 헤더 밴드 + border-l-2 스파인으로만 구분한다.
// 정보 위계: 전부 동급 — "스캔"이 primary affordance. 차트 없음(스파크라인만).
// ============================================================================
import { heatBg, heatHeaderBg } from '../../heatmap/heat';
import { priceDirClass } from '../../ui/priceDir';
import {
  MOCK_AS_OF, MOCK_INDICES, MOCK_INVESTOR_NET, MOCK_OPTION_SENTIMENT,
  MOCK_SECTORS, MOCK_TOP_GAINERS, MOCK_TOP_LOSERS, MOCK_TOP_VALUE, MOCK_VOLUME_SURGE,
  type MockRankRow,
} from './mockData';
import { PctText, Sparkline, fmtSigned } from './protoBits';

function TickerStrip() {
  return (
    <div className="flex items-center gap-xl overflow-x-auto whitespace-nowrap border-b border-border px-sm py-xs">
      {MOCK_INDICES.map((idx) => (
        <div key={idx.id} className="flex shrink-0 items-baseline gap-sm">
          <span className="text-xs font-semibold text-fg-dim">{idx.label}</span>
          <span className={`font-data text-md font-semibold tabular-nums ${priceDirClass(idx.change)}`}>
            {idx.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
          </span>
          <PctText pct={idx.changePct} className="text-sm" />
          {idx.advance !== null && (
            <span className="font-data text-2xs text-fg-dim tabular-nums">
              <span className="text-price-up">▲{idx.advance}</span>/<span className="text-price-down">▼{idx.decline}</span>
            </span>
          )}
        </div>
      ))}
      <span className="ml-auto shrink-0 font-data text-2xs text-fg-dim tabular-nums">
        P/C {MOCK_OPTION_SENTIMENT.pcVolumeRatio.toFixed(2)} · max pain{' '}
        {MOCK_OPTION_SENTIMENT.maxPain.toFixed(1)} · {MOCK_AS_OF} · 목업
      </span>
    </div>
  );
}

/** 열 헤더 밴드 — 히트맵 그룹 헤더 문법(평균 등락 비례 틴트). */
function ColumnHeader({ title, avgPct }: { title: string; avgPct: number | null }) {
  return (
    <div
      className="flex items-baseline justify-between px-sm py-2xs"
      style={{ background: heatHeaderBg(avgPct) }}
    >
      <span className="text-xs font-semibold uppercase text-fg">{title}</span>
      {avgPct !== null && <PctText pct={avgPct} className="text-xs" />}
    </div>
  );
}

function DenseRankRows({ rows }: { rows: MockRankRow[] }) {
  return (
    <ol className="flex flex-col">
      {rows.map((r) => (
        <li
          key={r.code}
          className="grid grid-cols-[1fr_4.8rem_4rem] items-center gap-xs border-b border-grid px-sm py-2xs last:border-b-0"
        >
          <span className="truncate text-sm text-fg">{r.name}</span>
          <span className="text-right font-data text-sm text-fg tabular-nums">
            {r.price.toLocaleString('ko-KR')}
          </span>
          <span
            className="rounded-sm text-right"
            style={{ background: heatBg(r.changePct, 0.3) }}
          >
            <PctText pct={r.changePct} className="block px-2xs text-sm" />
          </span>
        </li>
      ))}
    </ol>
  );
}

function avg(rows: MockRankRow[]): number {
  return rows.reduce((a, r) => a + r.changePct, 0) / rows.length;
}

export function VariantB() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TickerStrip />
      <div className="grid flex-1 grid-cols-4 gap-md px-sm py-sm">
        {/* 열 1 — 상승/하락 상위 */}
        <section className="border-l-2 border-border-strong">
          <ColumnHeader title="상승률 상위" avgPct={avg(MOCK_TOP_GAINERS)} />
          <DenseRankRows rows={MOCK_TOP_GAINERS} />
          <div className="mt-sm" />
          <ColumnHeader title="하락률 상위" avgPct={avg(MOCK_TOP_LOSERS)} />
          <DenseRankRows rows={MOCK_TOP_LOSERS} />
        </section>

        {/* 열 2 — 거래대금 */}
        <section className="border-l-2 border-border-strong">
          <ColumnHeader title="거래대금 상위" avgPct={null} />
          <ol className="flex flex-col">
            {MOCK_TOP_VALUE.map((r) => (
              <li
                key={r.code}
                className="grid grid-cols-[1fr_4.4rem_4rem] items-center gap-xs border-b border-grid px-sm py-2xs last:border-b-0"
              >
                <span className="truncate text-sm text-fg">{r.name}</span>
                <span className="text-right font-data text-sm text-fg-dim tabular-nums">
                  {r.valueEok.toLocaleString('ko-KR')}억
                </span>
                <PctText pct={r.changePct} className="text-right text-sm" />
              </li>
            ))}
          </ol>
          <div className="mt-sm" />
          <ColumnHeader title="거래량 급증" avgPct={avg(MOCK_VOLUME_SURGE)} />
          <DenseRankRows rows={MOCK_VOLUME_SURGE.slice(0, 6)} />
        </section>

        {/* 열 3 — 섹터 온도 */}
        <section className="border-l-2 border-border-strong">
          <ColumnHeader
            title="섹터 온도"
            avgPct={MOCK_SECTORS.reduce((a, s) => a + s.changePct, 0) / MOCK_SECTORS.length}
          />
          <ol className="flex flex-col">
            {MOCK_SECTORS.map((s) => (
              <li key={s.name} className="border-b border-grid px-sm py-2xs last:border-b-0">
                <div className="grid grid-cols-[1fr_auto_4rem] items-center gap-xs">
                  <span className="truncate text-sm text-fg">{s.name}</span>
                  <Sparkline points={s.spark} width={40} height={12} />
                  <PctText pct={s.changePct} className="text-right text-sm" />
                </div>
                <div className="truncate text-2xs text-fg-dim">{s.leaders.join(' · ')}</div>
              </li>
            ))}
          </ol>
        </section>

        {/* 열 4 — 투자자 수급 */}
        <section className="border-l-2 border-border-strong">
          <ColumnHeader title="투자자 수급 (억원)" avgPct={null} />
          {MOCK_INVESTOR_NET.map((m) => (
            <div key={m.market} className="border-b border-grid px-sm py-xs last:border-b-0">
              <div className="text-xs font-semibold text-fg-dim">
                {m.market === 'KOSPI' ? '코스피' : '코스닥'}
              </div>
              <table className="w-full">
                <tbody>
                  {([['개인', m.individual, m.individual5d], ['외국인', m.foreign, m.foreign5d], ['기관', m.institution, m.institution5d]] as const).map(
                    ([label, v, series]) => (
                      <tr key={label} className="border-b border-grid last:border-b-0">
                        <td className="py-2xs text-xs text-fg-dim">{label}</td>
                        <td className="py-2xs">
                          <Sparkline points={series as unknown as number[]} width={52} height={14} />
                        </td>
                        <td className={`py-2xs text-right font-data text-sm tabular-nums ${priceDirClass(v)}`}>
                          {fmtSigned(v)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ))}
          <p className="px-sm py-xs text-2xs text-fg-dim">
            5일 추세 스파크 + 당일 잠정. 순매수 = 외국인·기관 ka10051, 잠정
            단위·축 규칙은 잠정투자자 카드와 동일.
          </p>
        </section>
      </div>
    </div>
  );
}
