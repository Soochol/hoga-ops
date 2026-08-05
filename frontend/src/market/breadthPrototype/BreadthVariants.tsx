/**
 * PROTOTYPE — throwaway. 「시장 폭」 카드 지표 시안 (main 병합 금지).
 *
 * 질문: "52주 신고/신저 + 급등/급락 말고 무엇을 세야 시장 폭이 보이나?"
 *
 * 실측 근거 (2026-08-05 마감 후, `/api/market/{sectors,breadth}`):
 *   코스피  상승 675 하락 197 보합 43 · 상한 0 하한 0 · 52주 49/20 · 급등 1 급락 0
 *   코스닥  상승 1346 하락 301 보합 78 · 상한 **11** 하한 0 · 52주 5/0 · 급등 0 급락 0
 * → 코스닥 상한가 11 건인 날에 급등이 0 이다. ka10019 는 **순간 급변 스캔**이라
 *   마감 후 조회하면 정직하게 비어 있다 — 이 카드가 쓸 지표가 아니다.
 *
 * A·B·C 가 쓰는 값은 **전부 이미 받아 오는 것**이다(ka20003 → /api/market/sectors 의
 * `index.{rising,falling,flat,upper,lower}` · `sectors[].change_pct`). 추가 콜 0.
 * 예외는 C 의 누적 등락선 하나 — 저장이 필요해서 **목업 배열**로 그린다(프로토타입
 * 규칙: 영속은 검증 대상이지 의존 대상이 아니다).
 */
import { useMarketBreadth, useMarketSectors } from '../../api/market';
import type { BreadthCount, MarketIndexRow, MarketSectorRow } from '../../api/market';
import { AdvanceDeclineBar, BreadthTile } from '../marketBits';
import { PanelCard } from '../../ui/PageShell';

const MARKET_LABELS: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };
const SECTORS_KEY: Record<string, string> = { KOSPI: '0', KOSDAQ: '1' };

/** 프로토 전용 카드 크롬 — 실카드(MarketCard)와 같은 모양. */
function Card({ children }: { children: React.ReactNode }) {
  return <PanelCard borderless flat className="flex flex-col gap-sm p-sm">{children}</PanelCard>;
}
function Head({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-sm gap-y-2xs border-b border-border pb-2xs">
      <h2 className="text-sm text-fg">
        {title} {hint && <span className="text-2xs text-fg-dim">{hint}</span>}
      </h2>
    </div>
  );
}

type Row = {
  label: string;
  idx: MarketIndexRow | null;
  sectors: MarketSectorRow[];
  b: {
    new_high_52w?: BreadthCount;
    new_low_52w?: BreadthCount;
    surge?: BreadthCount;
    plunge?: BreadthCount;
  };
};

/** 두 응답(breadth · sectors)을 시장 단위로 붙인다 — 키 체계가 다르다(KOSPI vs '0'). */
function useRows(): Row[] {
  const breadth = useMarketBreadth();
  const sectors = useMarketSectors();
  return Object.keys(MARKET_LABELS).map((k) => ({
    label: MARKET_LABELS[k],
    idx: sectors.data?.markets[SECTORS_KEY[k]]?.index ?? null,
    sectors: sectors.data?.markets[SECTORS_KEY[k]]?.sectors ?? [],
    b: breadth.data?.markets[k] ?? {},
  }));
}

/** 상승 비율 % — 분모는 상승+하락+보합. null 이 섞이면 계산하지 않는다. */
function advancePct(idx: MarketIndexRow | null): number | null {
  if (!idx || idx.rising == null || idx.falling == null) return null;
  const total = idx.rising + idx.falling + (idx.flat ?? 0);
  return total > 0 ? (idx.rising / total) * 100 : null;
}

function risingSectors(sectors: MarketSectorRow[]): [number, number] {
  const withPct = sectors.filter((s) => s.change_pct != null);
  return [withPct.filter((s) => (s.change_pct ?? 0) > 0).length, withPct.length];
}

// ── 현행 ──────────────────────────────────────────────────────────────────

export function BreadthCurrent() {
  const rows = useRows();
  return (
    <Card>
      <Head title="시장 폭" hint="종목수" />
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-2xs">
          <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
          <div className="grid grid-cols-4 gap-2xs">
            <BreadthTile label="52주 신고" count={r.b.new_high_52w?.count ?? null} truncated={r.b.new_high_52w?.truncated} dir="up" />
            <BreadthTile label="52주 신저" count={r.b.new_low_52w?.count ?? null} truncated={r.b.new_low_52w?.truncated} dir="down" />
            <BreadthTile label="급등" count={r.b.surge?.count ?? null} truncated={r.b.surge?.truncated} dir="up" />
            <BreadthTile label="급락" count={r.b.plunge?.count ?? null} truncated={r.b.plunge?.truncated} dir="down" />
          </div>
        </div>
      ))}
    </Card>
  );
}

// ── A · 폭 우선 ───────────────────────────────────────────────────────────

function MarketBlockA({ r }: { r: Row }) {
  const pct = advancePct(r.idx);
  const [up, total] = risingSectors(r.sectors);
  return (
    <div className="flex flex-col gap-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
        <span className="font-data text-2xs text-fg-dimmer tabular-nums">
          업종 {total > 0 ? `${up}/${total}` : '—'}
        </span>
      </div>
      {/* 큰 숫자 하나 = 이 카드의 답. 개수 두 개보다 먼저 읽힌다. */}
      <div className="flex items-end justify-between gap-sm">
        <div className="flex items-baseline gap-2xs">
          <span className={`font-data text-2xl font-semibold tabular-nums ${pct != null && pct >= 50 ? 'text-price-up' : 'text-price-down'}`}>
            {pct != null ? pct.toFixed(0) : '—'}
          </span>
          <span className="text-xs text-fg-dim">% 상승</span>
        </div>
        <span className="font-data text-2xs text-fg-dim tabular-nums">
          <span className="text-price-up">{r.idx?.rising ?? '—'}</span>
          {' · '}
          <span className="text-price-down">{r.idx?.falling ?? '—'}</span>
          {' · '}
          {r.idx?.flat ?? '—'}
        </span>
      </div>
      <AdvanceDeclineBar rising={r.idx?.rising ?? null} falling={r.idx?.falling ?? null} flat={r.idx?.flat ?? null} />
      <div className="grid grid-cols-4 gap-2xs">
        <BreadthTile label="상한가" count={r.idx?.upper ?? null} dir="up" />
        <BreadthTile label="하한가" count={r.idx?.lower ?? null} dir="down" />
        <BreadthTile label="52주 신고" count={r.b.new_high_52w?.count ?? null} truncated={r.b.new_high_52w?.truncated} dir="up" />
        <BreadthTile label="52주 신저" count={r.b.new_low_52w?.count ?? null} truncated={r.b.new_low_52w?.truncated} dir="down" />
      </div>
    </div>
  );
}

export function BreadthVariantA() {
  const rows = useRows();
  return (
    <Card>
      <Head title="시장 폭" hint="상승비율 · 종목수" />
      {rows.map((r) => (
        <MarketBlockA key={r.label} r={r} />
      ))}
    </Card>
  );
}

// ── B · 터미널 행 ─────────────────────────────────────────────────────────

const B_COLS = ['상승', '하락', '보합', '상승%', '상한', '하한', '52주↑', '52주↓', '업종'] as const;

export function BreadthVariantB() {
  const rows = useRows();
  return (
    <Card>
      <Head title="시장 폭" hint="전수" />
      <div className="grid grid-cols-[3.2rem_repeat(9,1fr)] gap-x-2xs">
        <span />
        {B_COLS.map((c) => (
          <span key={c} className="pb-2xs text-right text-2xs text-fg-dimmer">
            {c}
          </span>
        ))}
        {rows.map((r) => {
          const pct = advancePct(r.idx);
          const [up, total] = risingSectors(r.sectors);
          const cells: Array<[string | number, string]> = [
            [r.idx?.rising ?? '—', 'text-price-up'],
            [r.idx?.falling ?? '—', 'text-price-down'],
            [r.idx?.flat ?? '—', 'text-fg-dim'],
            [pct != null ? `${pct.toFixed(0)}%` : '—', pct != null && pct >= 50 ? 'text-price-up' : 'text-price-down'],
            [r.idx?.upper ?? '—', 'text-price-up'],
            [r.idx?.lower ?? '—', 'text-price-down'],
            [r.b.new_high_52w?.count ?? '—', 'text-price-up'],
            [r.b.new_low_52w?.count ?? '—', 'text-price-down'],
            [total > 0 ? `${up}/${total}` : '—', 'text-fg-dim'],
          ];
          return (
            <div key={r.label} className="col-span-10 grid grid-cols-subgrid border-b border-grid py-2xs last:border-b-0">
              <span className="text-xs text-fg-dim">{r.label}</span>
              {cells.map(([v, cls], i) => (
                <span key={B_COLS[i]} className={`text-right font-data text-xs tabular-nums ${cls}`}>
                  {v}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── C · A + 누적 등락선 ───────────────────────────────────────────────────

/** ⚠ 목업. 실제 AD Line 은 하루 한 점씩 (상승−하락) 을 누적해야 하고 수십 거래일이
 *  쌓여야 형태가 나온다. 여기서는 **모양만** 보기 위한 고정 배열이다. */
const AD_LINE_MOCK: Record<string, number[]> = {
  코스피: [0, 120, 60, -80, -40, 90, 210, 180, 90, 30, -60, -150, -90, 40, 160, 300, 420, 380, 300, 478],
  코스닥: [0, -40, -120, -60, 80, 40, -30, -180, -260, -200, -120, -40, 60, 180, 320, 520, 760, 900, 1000, 1045],
};

function AdLine({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 300;
  const h = 44;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[44px] w-full" preserveAspectRatio="none" aria-hidden>
      {/* 0선 — AD Line 은 절대값보다 방향과 지수와의 괴리가 정보다. */}
      {min < 0 && max > 0 && (
        <line x1="0" x2={w} y1={h - ((0 - min) / span) * h} y2={h - ((0 - min) / span) * h} stroke="var(--grid)" strokeWidth="1" />
      )}
      <path d={d} fill="none" stroke={last >= 0 ? 'var(--price-up)' : 'var(--price-down)'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BreadthVariantC() {
  const rows = useRows();
  return (
    <Card>
      <Head title="시장 폭" hint="상승비율 · 누적 등락선" />
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-xs">
          <MarketBlockA r={r} />
          <div className="flex flex-col gap-2xs">
            <span className="text-2xs text-fg-dimmer">
              누적 등락선 <span style={{ color: 'var(--warn)' }}>· 목업 (저장 미구현)</span>
            </span>
            <AdLine points={AD_LINE_MOCK[r.label] ?? []} />
          </div>
        </div>
      ))}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 「개수」 축 밖의 지표들 — D·E·F. 각 변형이 **다른 질문**에 답한다.
// ═══════════════════════════════════════════════════════════════════════════

/** 업종 등락률의 퍼짐 통계. 종합·규모별(대형/중형/소형) 행은 업종이 아니라 제외한다. */
const SIZE_ROWS = new Set(['대형주', '중형주', '소형주']);

function spread(sectors: MarketSectorRow[]): { pcts: number[]; min: number; max: number; sd: number } | null {
  const pcts = sectors.filter((s) => !SIZE_ROWS.has(s.name) && s.change_pct != null).map((s) => s.change_pct as number);
  if (pcts.length < 2) return null;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const sd = Math.sqrt(pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length);
  return { pcts, min: Math.min(...pcts), max: Math.max(...pcts), sd };
}

// ── D · 분산도 ────────────────────────────────────────────────────────────

/** 업종 등락률 분포 띠 — 점 하나가 업종 하나. 뭉치면 지수장, 퍼지면 종목장. */
function DistributionStrip({ pcts, min, max }: { pcts: number[]; min: number; max: number }) {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  const span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  return (
    <div className="relative h-[22px] w-full">
      <div className="absolute inset-x-0 top-[10px] h-px bg-grid" />
      {/* 0% 기준선 — 퍼짐이 상승 쪽인지 하락 쪽인지가 스프레드만큼 중요하다. */}
      <div className="absolute top-0 h-full w-px bg-border-strong" style={{ left: `${x(0)}%` }} />
      {pcts.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="absolute top-[6px] h-[9px] w-[2px] rounded-full opacity-70"
          style={{ left: `${x(v)}%`, background: v >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}
        />
      ))}
    </div>
  );
}

export function BreadthVariantD() {
  const rows = useRows();
  return (
    <Card>
      <Head title="업종 분산도" hint="지수장 ↔ 종목장" />
      {rows.map((r) => {
        const s = spread(r.sectors);
        return (
          <div key={r.label} className="flex flex-col gap-2xs">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
              <span className="font-data text-2xs text-fg-dimmer tabular-nums">업종 {s?.pcts.length ?? '—'}개</span>
            </div>
            {s ? (
              <>
                <div className="flex items-end justify-between gap-sm">
                  <div className="flex items-baseline gap-2xs">
                    <span className="font-data text-2xl font-semibold tabular-nums text-fg">
                      {(s.max - s.min).toFixed(1)}
                    </span>
                    <span className="text-xs text-fg-dim">%p 스프레드</span>
                  </div>
                  <span className="font-data text-2xs text-fg-dim tabular-nums">σ {s.sd.toFixed(2)}</span>
                </div>
                <DistributionStrip pcts={s.pcts} min={s.min} max={s.max} />
                <div className="flex justify-between font-data text-2xs tabular-nums">
                  <span className="text-price-down">{s.min.toFixed(2)}%</span>
                  <span className="text-price-up">+{s.max.toFixed(2)}%</span>
                </div>
              </>
            ) : (
              <span className="text-2xs text-fg-dimmer">업종 데이터 없음</span>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ── E · 쏠림·열기 ─────────────────────────────────────────────────────────

/**
 * ⚠ **실측 픽스처** (2026-08-05 마감 후 ka20003 직접 호출). 사용자 dev 백엔드에는
 * `trade_value_eok` / `listed_count` 가 아직 없어 실시간으로 못 받는다 — 백엔드
 * 변경은 이 워크트리에 이미 있고, 채택되면 훅 한 줄로 바뀐다.
 */
const SIZE_FIXTURE: Record<string, { total_jo: number; sizes: Array<[string, number]>; listed: number; traded: number }> = {
  코스피: { total_jo: 25.66, sizes: [['대형주', 21.36], ['중형주', 2.5], ['소형주', 1.21]], listed: 943, traded: 915 },
  코스닥: { total_jo: 6.38, sizes: [], listed: 1821, traded: 1725 },
};

const SIZE_COLORS = ['var(--ma-1)', 'var(--ma-3)', 'var(--ma-5)'];

export function BreadthVariantE() {
  const rows = useRows();
  return (
    <Card>
      <Head title="쏠림 · 열기" hint="거래대금 기준" />
      <p className="text-2xs" style={{ color: 'var(--warn)' }}>
        실측 픽스처 (2026-08-05 마감) — 백엔드 필드 미배포
      </p>
      {rows.map((r) => {
        const f = SIZE_FIXTURE[r.label];
        if (!f) return null;
        return (
          <div key={r.label} className="flex flex-col gap-2xs">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
              <span className="font-data text-2xs text-fg-dimmer tabular-nums">
                참여 {((f.traded / f.listed) * 100).toFixed(1)}% ({f.traded}/{f.listed})
              </span>
            </div>
            <div className="flex items-baseline gap-2xs">
              <span className="font-data text-2xl font-semibold tabular-nums text-fg">{f.total_jo.toFixed(2)}</span>
              <span className="text-xs text-fg-dim">조원 거래</span>
            </div>
            {f.sizes.length > 0 ? (
              <>
                {/* 100% 누적 막대 — "몇 종목이 올랐나" 와 완전히 다른 축이다. */}
                <div className="flex h-[8px] w-full overflow-hidden rounded-sm">
                  {f.sizes.map(([name, jo], i) => (
                    <span key={name} style={{ width: `${(jo / f.total_jo) * 100}%`, background: SIZE_COLORS[i] }} />
                  ))}
                  <span className="flex-1 bg-grid" />
                </div>
                <div className="flex flex-wrap gap-x-sm gap-y-2xs">
                  {f.sizes.map(([name, jo], i) => (
                    <span key={name} className="font-data text-2xs text-fg-dim tabular-nums">
                      <span className="mr-[3px] inline-block h-[6px] w-[6px] rounded-full align-middle" style={{ background: SIZE_COLORS[i] }} />
                      {name} {((jo / f.total_jo) * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <span className="text-2xs text-fg-dimmer">규모별 지수 없음 — 코스닥엔 대형/중형/소형주 지수가 없다</span>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ── F · 정규화 게이지 ─────────────────────────────────────────────────────

/** 0~100 게이지. 개수와 달리 **어제와 비교되는** 값이라 눈금이 고정이다. */
function Gauge({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs text-fg-dim">{label}</span>
        <span className={`font-data text-xs tabular-nums ${v == null ? 'text-fg-dimmer' : v >= 50 ? 'text-price-up' : 'text-price-down'}`}>
          {v == null ? '—' : v.toFixed(0)}
          {hint && <span className="pl-[3px] text-fg-dimmer">{hint}</span>}
        </span>
      </div>
      <div className="relative h-[6px] w-full rounded-sm bg-grid">
        {/* 50 = 중립. 게이지의 의미는 절대값이 아니라 중립선 대비 위치다. */}
        <span className="absolute top-[-2px] h-[10px] w-px bg-border-strong" style={{ left: '50%' }} />
        {v != null && (
          <span
            className="absolute inset-y-0 rounded-sm"
            style={{
              left: v >= 50 ? '50%' : `${v}%`,
              width: `${Math.abs(v - 50)}%`,
              background: v >= 50 ? 'var(--price-up)' : 'var(--price-down)',
            }}
          />
        )}
      </div>
    </div>
  );
}

export function BreadthVariantF() {
  const rows = useRows();
  const [kospi, kosdaq] = rows;
  const gap =
    kospi?.idx?.change_pct != null && kosdaq?.idx?.change_pct != null
      ? kospi.idx.change_pct - kosdaq.idx.change_pct
      : null;
  return (
    <Card>
      <Head title="시장 폭" hint="0~100 정규화" />
      {rows.map((r) => {
        const hi = r.b.new_high_52w?.count ?? null;
        const lo = r.b.new_low_52w?.count ?? null;
        const hlIndex = hi != null && lo != null && hi + lo > 0 ? (hi / (hi + lo)) * 100 : null;
        const adr = r.idx?.rising != null && r.idx.falling ? r.idx.rising / r.idx.falling : null;
        return (
          <div key={r.label} className="flex flex-col gap-2xs">
            <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
            <Gauge label="52주 신고-신저 지수" value={hlIndex} hint={hi != null && lo != null ? `${hi}/${hi + lo}` : undefined} />
            <Gauge label="상승 비율" value={advancePct(r.idx)} hint={r.idx?.rising != null ? `${r.idx.rising}종목` : undefined} />
            {/* ADR 은 배수라 0~100 이 아니다 — 2배를 50 에 놓는 로그 매핑으로 눈금을 맞춘다. */}
            <Gauge
              label="등락비율 (ADR)"
              value={adr == null ? null : Math.max(0, Math.min(100, 50 + (Math.log2(adr) / 2) * 50))}
              hint={adr == null ? undefined : `${adr.toFixed(2)}배`}
            />
          </div>
        );
      })}
      <div className="flex items-baseline justify-between border-t border-border pt-2xs">
        <span className="text-2xs text-fg-dim">시장 간 상대강도</span>
        <span className={`font-data text-xs tabular-nums ${gap == null ? 'text-fg-dimmer' : gap >= 0 ? 'text-price-up' : 'text-price-down'}`}>
          {gap == null ? '—' : `코스피 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%p`}
        </span>
      </div>
    </Card>
  );
}
