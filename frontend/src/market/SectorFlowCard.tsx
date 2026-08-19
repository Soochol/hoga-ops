/** 업종 × 투자자 순매수 — 시장 폭 카드를 대체한다.
 *
 * 프로토타입 B 변형이 이겼다(2026-08-07, `prototype/market-sector-investor-flow-2026-08-07`).
 * 판정 근거는 **상계가 한 행에서 보인다**는 것이다: 개인 +937 은 그 자체로 정보가
 * 아니고 같은 행의 외국인 −1,118 과 붙어야 그림이 된다. 주체를 토글로 하나씩 보는
 * 안(A)은 쏠린 날 반대편이 시각적으로 죽었고(그날 순매수 최대 +281 vs 순매도 −2,601),
 * 산점도(C)는 큰 값 하나가 축을 잡아먹어 나머지가 0선에 뭉쳤다.
 *
 * ## 주체 토글은 "무엇을 보나" 가 아니라 "무엇으로 고르나" 다
 *
 * 세 열은 항상 보인다. 토글이 바꾸는 것은 **정렬·절단 기준**이다. B 의 유일한 약점이
 * 12행 절단의 기준이 자의적이라는 것이었고(3주체 절대값 합), 그 기준을 사용자가
 * 정하게 하면 약점이 사라진다. 선택된 열만 히트 배경을 칠해 어느 축으로 정렬됐는지
 * 화면이 말한다.
 *
 * ## 데이터
 *
 * `ka10051` 은 처음부터 업종 행을 다 주고 있었고 수집기가 60초마다 저장해 왔다 —
 * 종합 행만 소비했을 뿐이다(#1105). 그래서 이 카드는 **새 벤더 호출이 0** 이다.
 * 대신 폴링 전용이다(이 TR 에는 WS 타입이 없다 — 0J/0U 는 지수·등락종목수만 준다).
 */
import {
  useMarketBreadth,
  useMarketSectorFlow,
  type MarketName,
  type SectorFlowRow,
} from '../api/market';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch, useCardPref } from './marketCardBits';

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

/** 표시 행 수. 코스피 27 · 코스닥 31 업종을 다 그리면 카드가 페이지를 밀어낸다.
 *  절단 기준은 **선택된 주체의 순매수 절대값** 이라 사용자가 정한다. */
const ROWS = 12;

const PREF_KEY = 'market.sectorFlow.v1';

export function SectorFlowCard() {
  const flow = useMarketSectorFlow();
  const breadth = useMarketBreadth();
  const [market, setMarket] = useCardPref<Market>(PREF_KEY, 'market', 'KOSPI');
  const [actor, setActor] = useCardPref<Actor>(PREF_KEY, 'actor', 'foreign');

  const all = flow.data?.markets?.[market] ?? [];
  // 종합은 백엔드가 맨 앞에 둔다 — 기준선이라 정렬·절단에서 빼고 따로 고정한다.
  const whole = all.find((r) => r.name.startsWith('종합'));
  const sectors = all
    .filter((r) => !r.name.startsWith('종합'))
    .sort((a, b) => Math.abs(b[actor] ?? 0) - Math.abs(a[actor] ?? 0))
    .slice(0, ROWS);

  const max = Math.max(...sectors.map((r) => Math.abs(r[actor] ?? 0)), 1);

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="업종 수급"
        hint="당일 누적 · 억원"
        right={
          <div className="flex gap-xs">
            <ModeSwitch value={market} options={MARKETS} onChange={setMarket} label="시장" />
            <ModeSwitch value={actor} options={ACTORS} onChange={setActor} label="정렬 기준" />
          </div>
        }
      />

      {all.length === 0 ? (
        // 왜 비었는지 말한다 — 장 시작 전이면 표본이 아직 없는 게 정상이다.
        <EmptyNote>
          {flow.isLoading ? '수급 표본을 읽는 중입니다.' : '오늘 수집된 표본이 아직 없습니다.'}
        </EmptyNote>
      ) : (
        /* 데이터 표라 `text-xs` — `2xs` 는 크롬 마이크로라벨 용도다. 이 표는 1.125×
           다이얼 시절(렌더 10.125px)에 승인됐고, 2026-08-07 다이얼 하향으로 9px 가
           된 것은 부수효과였다. `text-xs`(10.5px)가 승인된 외형을 복원한다. */
        <table className="w-full border-collapse font-data text-xs tabular-nums">
          <thead>
            <tr className="text-fg-dim">
              <th className="pb-1 text-left font-normal">업종</th>
              <th className="pb-1 text-right font-normal">등락</th>
              {ACTORS.map(([key, label]) => (
                <th
                  key={key}
                  className={`pb-1 text-right font-normal ${key === actor ? 'text-fg' : ''}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {whole && <Row row={whole} actor={actor} max={max} emphasise />}
            {sectors.map((r) => (
              <Row key={r.code} row={r} actor={actor} max={max} />
            ))}
          </tbody>
        </table>
      )}

      <BreadthLine breadth={breadth.data} />
    </MarketCard>
  );
}

function Row({
  row,
  actor,
  max,
  emphasise,
}: {
  row: SectorFlowRow;
  actor: Actor;
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
        // 히트 배경은 **정렬 기준 열에만** 칠한다. 세 열을 다 칠하면 어느 축으로
        // 줄이 세워졌는지가 사라지고, 색이 셋이라 표가 시끄러워진다.
        const alpha = key === actor && v != null ? Math.min(Math.abs(v) / max, 1) * 0.45 : 0;
        return (
          <td
            key={key}
            className="py-0.5 text-right text-fg"
            style={{
              background:
                alpha < 0.02
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
    return `${fmt(b?.new_high_52w)} · ${fmt(b?.new_low_52w)}`;
  };
  return (
    <div className="flex items-baseline justify-between border-t border-border pt-xs font-data text-2xs tabular-nums text-fg-dim">
      <span>52주 신고 · 신저</span>
      <span className="text-fg">
        코스피 {cell('KOSPI')} <span className="text-fg-dim">|</span> 코스닥 {cell('KOSDAQ')}
      </span>
    </div>
  );
}
