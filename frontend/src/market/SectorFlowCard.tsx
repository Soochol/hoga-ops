/** 업종 등락과 수급을 코드로 결합한다. 수급이 없는 지수는 순매수를 0으로 채우지 않는다. */
import { useState } from 'react';
import {
  useMarketBreadth,
  useMarketSectorFlow,
  useMarketSectors,
  type MarketName,
  type SectorFlowRow,
} from '../api/market';
import { CardHeader, DataStatus, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { useCardPref } from './marketCardBitsHelpers';
import { sectorCategory } from './sectorCategory';

type Actor = 'foreign' | 'institution' | 'individual';
/** 시장 라벨은 `api/market` 의 `MarketName` 하나로 모은다 — 같은 union 을 두 벌 두면
 *  백엔드 `MarketName` 과의 대조(ADR-0004)가 한쪽만 걸린다. */
type Market = MarketName;

const ACTORS: ReadonlyArray<readonly [Actor, string]> = [
  ['foreign', '외국인'],
  ['institution', '기관'],
  ['individual', '개인'],
];
const MARKETS: ReadonlyArray<readonly [Market, string]> = [
  ['KOSPI', '코스피'],
  ['KOSDAQ', '코스닥'],
];

/** 표시 행 수. 선택한 정렬 기준으로 정렬한 뒤 자른다. */
const ROWS = 12;

const PREF_KEY = 'market.sectorFlow.v1';

type SortKey = 'name' | 'change_pct' | Actor;
type Sort = { key: SortKey; direction: 'asc' | 'desc' } | null;
const COLUMNS: ReadonlyArray<readonly [SortKey, string]> = [
  ['name', '업종'], ['change_pct', '등락'], ...ACTORS,
];

export function SectorFlowCard() {
  const flow = useMarketSectorFlow();
  const breadth = useMarketBreadth();
  const quotes = useMarketSectors();
  const [sort, setSort] = useState<Sort>(null);
  const [category, setCategory] = useState<'all' | 'industry' | 'index' | 'unknown'>('all');
  const [showAll, setShowAll] = useState(false);
  const [market, setMarket] = useCardPref<Market>(PREF_KEY, 'market', 'KOSPI');

  const all = flow.data?.markets?.[market] ?? [];
  const quoteRows = quotes.data?.markets?.[market === 'KOSPI' ? '0' : '1']?.sectors ?? [];
  const whole = all.find((r) => r.name.startsWith('종합'));
  const byCode = new Map(all.filter(r => r !== whole).map(r => [r.code, r]));
  // Display names differ across vendors. Only codes can identify a shared row.
  for (const row of quoteRows) {
    const existing = byCode.get(row.code);
    if (existing) {
      byCode.set(row.code, { ...existing, change_pct: row.change_pct });
    } else if (row.code !== whole?.code) {
      byCode.set(row.code, { ...row, individual: null, foreign: null, institution: null });
    }
  }
  const source = [...new Set([...quoteRows.map(r => r.code), ...byCode.keys()])]
    .flatMap(code => byCode.has(code) ? [byCode.get(code)!] : []);
  const filtered = source.filter(r => category === 'all' || sectorCategory(r.code) === category);
  const ordered = sort == null ? filtered : [...filtered].sort((a, b) => {
    if (sort.key === 'name') {
      const compared = a.name.localeCompare(b.name, 'ko');
      return sort.direction === 'asc' ? compared : -compared;
    }
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return sort.direction === 'asc' ? av - bv : bv - av;
  });
  const sectors = ordered.slice(0, showAll ? undefined : ROWS);

  const cycleSort = (key: SortKey) => setSort(current => {
    const first = key === 'name' ? 'asc' : 'desc';
    if (current?.key !== key) return { key, direction: first };
    return current.direction === first ? { key, direction: first === 'asc' ? 'desc' : 'asc' } : null;
  });

  // 종합을 포함한 표시 행의 세 주체가 같은 농도 기준을 공유한다.
  const visibleRows = whole ? [whole, ...sectors] : sectors;
  const max = Math.max(...visibleRows.flatMap(r => ACTORS.map(([key]) => Math.abs(r[key] ?? 0))), 0) || 1;

  return (
    <MarketCard className="market-sector-card">
      <CardHeader
        title="업종 등락 · 수급"
        hint="당일 누적 · 억원"
        right={<ModeSwitch value={market} options={MARKETS} onChange={setMarket} label="시장" />}
      />

      <div className="market-sector-controls flex flex-wrap items-center justify-between gap-sm">
        <button type="button" className="text-xs text-accent" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>{showAll ? '12개씩 보기' : '전체 보기'}</button>
        <ModeSwitch value={category} onChange={setCategory} label="업종 지수 유형" options={[
          ['all', '전체'], ['industry', '업종'], ['index', '규모·대표지수'], ['unknown', '미분류'],
        ]} />
        <span className="text-2xs text-fg-dim">{sectors.length}/{filtered.length}개 · {sort == null ? '제공 순서' : `${COLUMNS.find(([key]) => key === sort.key)![1]} ${sort.direction === 'asc' ? '오름차순' : '내림차순'}`}</span>
      </div>
      {(flow.isError || quotes.isError) && <div className="market-sector-stamps text-2xs text-fg-dim">
        {flow.isError && <div><span>수급</span><DataStatus hasData={flow.data !== undefined} error /></div>}
        {quotes.isError && <div><span>등락</span><DataStatus hasData={quotes.data !== undefined} error /></div>}
      </div>}
      {all.length === 0 && quoteRows.length > 0 && <EmptyNote>{flow.isLoading ? '수급 표본을 읽는 중입니다.' : '오늘 수집된 수급 표본이 아직 없습니다.'}</EmptyNote>}
      {all.length === 0 && quoteRows.length === 0 ? (
        // 왜 비었는지 말한다 — 장 시작 전이면 표본이 아직 없는 게 정상이다.
        <EmptyNote>
          {flow.isLoading ? '수급 표본을 읽는 중입니다.' : '오늘 수집된 표본이 아직 없습니다.'}
        </EmptyNote>
      ) : (
        /* `text-sm` — 같은 성격의 데이터 행은 같은 크기다(2026-08-19 사용자 결정):
           업종 온도·순위표 행이 `text-sm` 이므로 이 표도 맞춘다. 원래 `2xs` 였던 것은
           1.125× 다이얼 시절(렌더 10.125px) 승인 후 다이얼 하향의 부수효과로 9px 가
           된 드리프트였다. 11.5px 에서도 5열 셀 넘침 0 실측. */
        <div className="market-sector-table" tabIndex={0} role="region" aria-label="업종 등락과 수급 목록">
          <table className="w-full border-collapse font-data text-sm tabular-nums">
            <thead>
              <tr className="text-fg-dim">
                {COLUMNS.map(([key, label]) => (
                  <th
                    key={key}
                    aria-sort={sort?.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`pb-1 font-normal ${key === 'name' ? 'text-left' : 'text-right'}`}
                  >
                    <button
                      type="button"
                      onClick={() => cycleSort(key)}
                      className={`inline-flex w-full items-center gap-xs whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${key === 'name' ? 'justify-start' : 'justify-end'} ${sort?.key === key ? 'text-fg' : 'text-fg-dim hover:text-fg'}`}
                    >
                      {label}
                      {sort?.key === key && <span aria-hidden="true" className="text-accent">{sort.direction === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {whole && <Row row={whole} max={max} emphasise />}
              {sectors.map((r) => (
                <Row key={r.code} row={r} max={max} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <BreadthLine breadth={breadth.data} />
    </MarketCard>
  );
}

function Row({
  row,
  max,
  emphasise,
}: {
  row: SectorFlowRow;
  max: number;
  emphasise?: boolean;
}) {
  return (
    <tr className={emphasise ? 'border-b border-border' : undefined}>
      <td className={`max-w-[7rem] truncate py-0.5 ${emphasise ? 'font-semibold text-fg' : 'text-fg'}`}>
        {row.name}
      </td>
      <td
        className="py-0.5 text-right"
        style={{ color: (row.change_pct ?? 0) >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}
      >
        {row.change_pct == null ? '—' : `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%`}
      </td>
      {ACTORS.map(([key]) => {
        const v = row[key];
        const alpha = v != null ? Math.abs(v) / max * 0.45 : 0;
        return (
          <td
            key={key}
            className="py-0.5 text-right text-fg"
            style={{
              background:
                alpha === 0
                  ? undefined
                  : `color-mix(in srgb, ${(v ?? 0) >= 0 ? 'var(--price-up)' : 'var(--price-down)'} ${alpha * 100}%, transparent)`,
            }}
          >
            {v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString('ko-KR')}`}
          </td>
        );
      })}
    </tr>
  );
}

/** 52주 신고·신저 한 줄 — 시장 폭 카드에서 살아남은 유일한 값이다.
 *
 *  등락종목수는 지수 카드 헤더가 이미 말하고(`▲370 · ▼501`) 상·하한은 `/sectors` 가
 *  주지만, 52주 신고·신저는 화면 어디에도 없어서 카드가 사라지면 통째로 없어진다.
 *  `truncated` 면 카운트가 **하한**이므로 `+` 를 붙인다(#1099).
 */
function BreadthLine({ breadth }: { breadth: ReturnType<typeof useMarketBreadth>['data'] }) {
  const cell = (market: string) => {
    const b = breadth?.markets?.[market];
    const fmt = (c: { count: number; truncated: boolean } | undefined) =>
      c == null ? '—' : `${c.count}${c.truncated ? '+' : ''}`;
    return `신고가 ${fmt(b?.new_high_52w)} / 신저가 ${fmt(b?.new_low_52w)}`;
  };
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-xs border-t border-border pt-xs font-data text-2xs tabular-nums text-fg-dim">
      <span>52주 신고·신저 종목 수</span>
      <span className="text-fg">
        코스피 {cell('KOSPI')} <span className="text-fg-dim">|</span> 코스닥 {cell('KOSDAQ')}
      </span>
    </div>
  );
}
