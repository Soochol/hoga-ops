import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { RailDrawer, RailDrawerHeader, RailDrawerBody, RailDrawerSection } from '../../ui/RailShell';
import { SegmentedControl } from '../../ui/PageShell';
import { priceDirClass } from '../../ui/priceDir';
import { PrototypeSwitcher } from '../../ui/PrototypeSwitcher';

/**
 * PROTOTYPE — throwaway. 키움 순위 드로어 시안 3종.
 *
 * 아무 라우트에나 `?proto=ranking&variant=A|B|C` 를 붙이면 우측 드로어 슬롯에 뜬다.
 * 데이터는 전부 목업(폴링 없음), 행 클릭은 로컬 하이라이트만.
 *
 *  A — 세그먼트 리스트: 세그먼트 4탭 + 시장필터 + 리치 행 (그릴링 확정 스펙안)
 *  B — 4섹션 개요: 4개 순위를 동시에 톱5씩 스택, 섹션 클릭으로 확장
 *  C — 밀도 테이블: 드롭다운 선택 + 컬럼 헤더 테이블 (터미널 밀도)
 *
 * 머지 전 제거 대상 — App.tsx 의 proto 분기와 ui/PrototypeSwitcher.tsx 도 함께.
 */

type RankKind = 'change' | 'surge' | 'volume' | 'value';
type Market = 'all' | 'kospi' | 'kosdaq';
type Direction = 'up' | 'down';

const KINDS: RankKind[] = ['change', 'surge', 'volume', 'value'];
const KIND_LABEL: Record<RankKind, string> = {
  change: '등락률',
  surge: '량급증',
  volume: '거래량',
  value: '대금',
};
const KIND_FULL: Record<RankKind, string> = {
  change: '전일대비등락률 상위',
  surge: '거래량 급증',
  volume: '당일거래량 상위',
  value: '거래대금 상위',
};
// 기준값(급증률·거래량·거래대금) 열은 사용자 피드백으로 제거 — 순서가 곧 기준값이고,
// 열을 빼면 종목명 트렁케이션이 해소된다. metric 필드는 데이터에 남겨둔다(복원 대비).
interface Row {
  code: string;
  name: string;
  price: number;
  pct: number;
  metric: string | null;
}

const mk = (code: string, name: string, price: number, pct: number, metric: string | null = null): Row => ({
  code, name, price, pct, metric,
});

// ── 목데이터 (실감나는 값, 결정적) ─────────────────────────────────────────
const ROWS_CHANGE_UP: Row[] = [
  mk('294870', 'HDC현대산업개발', 24350, 29.97),
  mk('095340', 'ISC', 89400, 24.51),
  mk('403870', 'HPSP', 41250, 18.92),
  mk('058610', '에스피지', 31900, 15.4),
  mk('247540', '에코프로비엠', 512000, 12.86),
  mk('112040', '위메이드', 48750, 11.02),
  mk('039030', '이오테크닉스', 194500, 9.71),
  mk('277810', '레인보우로보틱스', 152300, 8.64),
  mk('086520', '에코프로', 631000, 7.9),
  mk('348370', '엔켐', 187600, 7.12),
  mk('196170', '알테오젠', 312500, 6.48),
  mk('005930', '삼성전자', 71200, 5.79),
  mk('042700', '한미반도체', 128400, 5.21),
  mk('373220', 'LG에너지솔루션', 412000, 4.83),
  mk('012450', '한화에어로스페이스', 289500, 4.4),
];
const ROWS_CHANGE_DOWN: Row[] = [
  mk('137310', '에스디바이오센서', 11840, -18.32),
  mk('214150', '클래시스', 38900, -14.71),
  mk('091990', '셀트리온헬스케어', 67200, -11.94),
  mk('028300', 'HLB', 89100, -9.86),
  mk('141080', '레고켐바이오', 54300, -8.42),
  mk('035760', 'CJ ENM', 71800, -7.15),
  mk('263750', '펄어비스', 30450, -6.53),
  mk('293490', '카카오게임즈', 20150, -5.87),
  mk('068270', '셀트리온', 178400, -5.12),
  mk('035720', '카카오', 41850, -4.66),
  mk('036570', '엔씨소프트', 187300, -4.21),
  mk('251270', '넷마블', 52400, -3.85),
];
const ROWS_SURGE: Row[] = [
  mk('058610', '에스피지', 31900, 15.4, '+1,842%'),
  mk('294870', 'HDC현대산업개발', 24350, 29.97, '+1,214%'),
  mk('095340', 'ISC', 89400, 24.51, '+986%'),
  mk('403870', 'HPSP', 41250, 18.92, '+740%'),
  mk('112040', '위메이드', 48750, 11.02, '+612%'),
  mk('348370', '엔켐', 187600, 7.12, '+498%'),
  mk('039030', '이오테크닉스', 194500, 9.71, '+371%'),
  mk('277810', '레인보우로보틱스', 152300, 8.64, '+334%'),
  mk('137310', '에스디바이오센서', 11840, -18.32, '+290%'),
  mk('086520', '에코프로', 631000, 7.9, '+241%'),
  mk('196170', '알테오젠', 312500, 6.48, '+198%'),
  mk('042700', '한미반도체', 128400, 5.21, '+165%'),
];
const ROWS_VOLUME: Row[] = [
  mk('137310', '에스디바이오센서', 11840, -18.32, '9,842만'),
  mk('294870', 'HDC현대산업개발', 24350, 29.97, '7,120만'),
  mk('005930', '삼성전자', 71200, 5.79, '4,381만'),
  mk('112040', '위메이드', 48750, 11.02, '2,964만'),
  mk('058610', '에스피지', 31900, 15.4, '2,411만'),
  mk('028300', 'HLB', 89100, -9.86, '1,872만'),
  mk('095340', 'ISC', 89400, 24.51, '1,540만'),
  mk('035720', '카카오', 41850, -4.66, '1,296만'),
  mk('348370', '엔켐', 187600, 7.12, '981만'),
  mk('086520', '에코프로', 631000, 7.9, '854만'),
  mk('403870', 'HPSP', 41250, 18.92, '742만'),
  mk('247540', '에코프로비엠', 512000, 12.86, '618만'),
];
const ROWS_VALUE: Row[] = [
  mk('005930', '삼성전자', 71200, 5.79, '3조 1,192억'),
  mk('086520', '에코프로', 631000, 7.9, '2조 5,388억'),
  mk('247540', '에코프로비엠', 512000, 12.86, '1조 8,904억'),
  mk('196170', '알테오젠', 312500, 6.48, '1조 2,150억'),
  mk('373220', 'LG에너지솔루션', 412000, 4.83, '9,841억'),
  mk('294870', 'HDC현대산업개발', 24350, 29.97, '8,420억'),
  mk('042700', '한미반도체', 128400, 5.21, '7,133억'),
  mk('039030', '이오테크닉스', 194500, 9.71, '5,912억'),
  mk('012450', '한화에어로스페이스', 289500, 4.4, '5,204억'),
  mk('068270', '셀트리온', 178400, -5.12, '4,871억'),
  mk('028300', 'HLB', 89100, -9.86, '4,310억'),
  mk('095340', 'ISC', 89400, 24.51, '3,984억'),
];

function rowsFor(kind: RankKind, direction: Direction): Row[] {
  if (kind === 'change') return direction === 'up' ? ROWS_CHANGE_UP : ROWS_CHANGE_DOWN;
  if (kind === 'surge') return ROWS_SURGE;
  if (kind === 'volume') return ROWS_VOLUME;
  return ROWS_VALUE;
}

const fmtPrice = (v: number) => v.toLocaleString('ko-KR');
const fmtPct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

// ── 공유 컨텍스트 (시안 전환해도 탭/필터 유지 — 비교 편의) ─────────────────
interface Ctx {
  kind: RankKind;
  setKind: (k: RankKind) => void;
  market: Market;
  setMarket: (m: Market) => void;
  direction: Direction;
  setDirection: (d: Direction) => void;
  activeCode: string | null;
  setActiveCode: (c: string) => void;
}

function UpdatedAt() {
  return <span className="font-data tabular-nums text-xs text-fg-dimmer">10:42:35</span>;
}

function MarketSelect({ market, setMarket }: Pick<Ctx, 'market' | 'setMarket'>) {
  return (
    <select
      aria-label="시장"
      value={market}
      onChange={(e) => setMarket(e.target.value as Market)}
      className="rounded-md border border-border bg-bg-input px-1.5 py-[3px] text-xs text-fg"
    >
      <option value="all">전체</option>
      <option value="kospi">코스피</option>
      <option value="kosdaq">코스닥</option>
    </select>
  );
}

function DirectionToggle({ direction, setDirection }: Pick<Ctx, 'direction' | 'setDirection'>) {
  return (
    <SegmentedControl aria-label="정렬 방향" className="self-start">
      {(['up', 'down'] as const).map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={direction === d}
          onClick={() => setDirection(d)}
          className={`px-2 py-[3px] text-xs ${direction === d ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
        >
          {d === 'up' ? '↑상승' : '↓하락'}
        </button>
      ))}
    </SegmentedControl>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 시안 A — 세그먼트 리스트 (그릴링 확정 스펙안)
// ════════════════════════════════════════════════════════════════════════
function VariantA(p: Ctx) {
  const rows = rowsFor(p.kind, p.direction);
  return (
    <RailDrawer id="right-rail-ranking-proto-panel" ariaLabel="순위 (시안 A)">
      <RailDrawerHeader title="순위" actions={<UpdatedAt />} />
      <RailDrawerSection className="flex flex-col gap-sm">
        <SegmentedControl aria-label="순위 종류" className="self-start">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={p.kind === k}
              onClick={() => p.setKind(k)}
              className={`px-2 py-[3px] text-xs ${p.kind === k ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </SegmentedControl>
        <div className="flex items-center gap-sm">
          <MarketSelect market={p.market} setMarket={p.setMarket} />
          {p.kind === 'change' && <DirectionToggle direction={p.direction} setDirection={p.setDirection} />}
          <span className="ml-auto text-xs text-fg-dimmer">10초 갱신 · 키움</span>
        </div>
      </RailDrawerSection>
      <RailDrawerBody>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r, i) => {
            const active = p.activeCode === r.code;
            return (
              <li
                key={r.code}
                role="button"
                tabIndex={0}
                onClick={() => p.setActiveCode(r.code)}
                className="flex cursor-pointer items-center gap-2 border-b py-sm pl-md pr-md hover:bg-bg-input-hover"
                style={{
                  background: active ? 'var(--tint-selection)' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                <span className="w-5 flex-none text-right font-data tabular-nums text-xs text-fg-dimmer">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-xs leading-tight text-fg">{r.name}</span>
                <span className="w-[4.25rem] flex-none text-right font-data tabular-nums text-sm leading-tight text-fg">
                  {fmtPrice(r.price)}
                </span>
                <span className={`w-[3.25rem] flex-none text-right font-data tabular-nums text-xs leading-tight ${priceDirClass(r.pct)}`}>
                  {fmtPct(r.pct)}
                </span>
              </li>
            );
          })}
        </ul>
      </RailDrawerBody>
    </RailDrawer>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 시안 B — 4섹션 개요 (동시 노출 톱5, 섹션 클릭 확장)
// ════════════════════════════════════════════════════════════════════════
function VariantB(p: Ctx & { expanded: RankKind | null; setExpanded: (k: RankKind | null) => void }) {
  return (
    <RailDrawer id="right-rail-ranking-proto-panel" ariaLabel="순위 (시안 B)">
      <RailDrawerHeader
        title="순위"
        actions={
          <span className="flex items-center gap-sm">
            <MarketSelect market={p.market} setMarket={p.setMarket} />
            <UpdatedAt />
          </span>
        }
      />
      <RailDrawerBody>
        {KINDS.map((k) => {
          const open = p.expanded === k;
          const rows = rowsFor(k, p.direction).slice(0, open ? 15 : 5);
          return (
            <section key={k}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => p.setExpanded(open ? null : k)}
                className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-bg-subtle px-md py-1.5 text-left text-xs text-fg hover:bg-bg-input-hover"
              >
                <span aria-hidden className="text-fg-dimmer">{open ? '▾' : '▸'}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{KIND_FULL[k]}</span>
                {k === 'change' && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.setDirection(p.direction === 'up' ? 'down' : 'up');
                    }}
                    className="rounded px-1.5 py-[1px] text-xs text-fg-dim hover:bg-bg-input-hover"
                  >
                    {p.direction === 'up' ? '↑상승' : '↓하락'}
                  </span>
                )}
                <span className="text-xs font-normal text-fg-dimmer">{open ? '접기' : '더보기'}</span>
              </button>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {rows.map((r, i) => {
                  const active = p.activeCode === r.code;
                  return (
                    <li
                      key={r.code}
                      role="button"
                      tabIndex={0}
                      onClick={() => p.setActiveCode(r.code)}
                      className="flex cursor-pointer items-center gap-2 border-b py-[5px] pl-md pr-md hover:bg-bg-input-hover"
                      style={{
                        background: active ? 'var(--tint-selection)' : 'transparent',
                        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                      }}
                    >
                      <span className="w-4 flex-none text-right font-data tabular-nums text-xs text-fg-dimmer">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-xs leading-tight text-fg">{r.name}</span>
                      <span className={`w-[3.4rem] flex-none text-right font-data tabular-nums text-xs leading-tight ${priceDirClass(r.pct)}`}>
                        {fmtPct(r.pct)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        <div className="px-md py-sm text-xs text-fg-dimmer">10초 갱신 · 키움</div>
      </RailDrawerBody>
    </RailDrawer>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 시안 C — 밀도 테이블 (드롭다운 + 컬럼 헤더, 터미널 밀도)
// ════════════════════════════════════════════════════════════════════════
function VariantC(p: Ctx) {
  const rows = rowsFor(p.kind, p.direction);
  return (
    <RailDrawer id="right-rail-ranking-proto-panel" ariaLabel="순위 (시안 C)">
      <RailDrawerHeader
        title="순위"
        actions={
          <select
            aria-label="순위 종류"
            value={p.kind}
            onChange={(e) => p.setKind(e.target.value as RankKind)}
            className="rounded-md border border-border bg-bg-input px-1.5 py-[3px] text-xs text-fg"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{KIND_FULL[k]}</option>
            ))}
          </select>
        }
      />
      <div className="flex items-center gap-1 border-b border-border px-md py-1.5">
        {(['all', 'kospi', 'kosdaq'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={p.market === m}
            onClick={() => p.setMarket(m)}
            className={`rounded px-1.5 py-[2px] text-xs ${p.market === m ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
          >
            {m === 'all' ? '전체' : m === 'kospi' ? '코스피' : '코스닥'}
          </button>
        ))}
        {p.kind === 'change' && (
          <button
            type="button"
            onClick={() => p.setDirection(p.direction === 'up' ? 'down' : 'up')}
            className="ml-1 rounded px-1.5 py-[2px] text-xs text-fg-dim hover:bg-bg-input-hover"
          >
            {p.direction === 'up' ? '↑상승' : '↓하락'}
          </button>
        )}
        <span className="ml-auto"><UpdatedAt /></span>
      </div>
      <RailDrawerBody>
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg-subtle">
            <tr className="border-b border-border text-[10px] uppercase text-fg-dimmer">
              <th className="w-6 py-1 pl-md pr-1 text-right font-normal">#</th>
              <th className="px-1 py-1 text-left font-normal">종목</th>
              <th className="w-[4.4rem] px-1 py-1 text-right font-normal">현재가</th>
              <th className="w-[3.9rem] py-1 pl-1 pr-md text-right font-normal">등락</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const active = p.activeCode === r.code;
              return (
                <tr
                  key={r.code}
                  onClick={() => p.setActiveCode(r.code)}
                  className="cursor-pointer border-b border-grid hover:bg-bg-input-hover"
                  style={{ background: active ? 'var(--tint-selection)' : 'transparent' }}
                >
                  <td className="py-[3px] pl-md pr-1 text-right font-data tabular-nums text-xs text-fg-dimmer">{i + 1}</td>
                  <td className="max-w-0 truncate px-1 py-[3px] text-xs text-fg">{r.name}</td>
                  <td className="px-1 py-[3px] text-right font-data tabular-nums text-xs text-fg">{fmtPrice(r.price)}</td>
                  <td className={`py-[3px] pl-1 pr-md text-right font-data tabular-nums text-xs ${priceDirClass(r.pct)}`}>
                    {fmtPct(r.pct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </RailDrawerBody>
    </RailDrawer>
  );
}

// ════════════════════════════════════════════════════════════════════════
export default function RankingDrawerPrototype() {
  const [params] = useSearchParams();
  const variant = params.get('variant')?.toUpperCase() ?? 'A';
  const [kind, setKind] = useState<RankKind>('change');
  const [market, setMarket] = useState<Market>('all');
  const [direction, setDirection] = useState<Direction>('up');
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<RankKind | null>(null);
  const ctx: Ctx = { kind, setKind, market, setMarket, direction, setDirection, activeCode, setActiveCode };
  return (
    <>
      {variant === 'B' ? (
        <VariantB {...ctx} expanded={expanded} setExpanded={setExpanded} />
      ) : variant === 'C' ? (
        <VariantC {...ctx} />
      ) : (
        <VariantA {...ctx} />
      )}
      <PrototypeSwitcher
        variants={['A', 'B', 'C']}
        names={{ A: '세그먼트 리스트', B: '4섹션 개요', C: '밀도 테이블' }}
      />
    </>
  );
}
