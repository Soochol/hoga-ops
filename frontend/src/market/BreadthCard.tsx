/**
 * 「시장 폭」 — 네 개의 축을 토글로 겹쳐 놓은 카드.
 *
 * **왜 토글인가**: 네 모드는 서로를 대체하지 않는다. 같은 날 "675종목 상승"(개수),
 * "업종 스프레드 10.4%p"(분산), "대형주가 거래대금의 83%"(쏠림)는 전부 참이고 서로
 * 다른 사실이다. 카드 폭이 좁아 넷을 동시에 못 그리므로 겹치되, 어느 축을 보고 있는지
 * 토글이 항상 말한다. 이 페이지의 기존 관용구와 같다(투자자 수급·프로그램의 당일/일별).
 *
 * **급등/급락은 뺐다.** ka10019 는 순간 급변 스캔이라 마감 후 조회하면 거의 0 이다 —
 * 2026-08-05 실측에서 코스닥 상한가가 11건인 날에 급등이 0 이었고, 같은 화면 상승률
 * 상위에는 +30.00% 가 세 줄 떠 있었다. 자리를 상한가/하한가에 넘겼다(ka20003 `upl`/`lst`,
 * 추가 콜 0).
 *
 * 지표 시안 7종 중 4종 채택 — `prototype/market-breadth-indicators-2026-08-05` 보존.
 */
import { useState } from 'react';
import { useMarketBreadth, useMarketSectors } from '../api/market';
import type { BreadthCount, MarketIndexRow, MarketSectorRow } from '../api/market';
import { AdvanceDeclineBar, BreadthTile } from './marketBits';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import {
  adrToGauge,
  advanceDeclineRatio,
  advancePct,
  eokToJo,
  highLowIndex,
  risingSectorCount,
  sectorSpread,
  sizeShares,
} from './breadthMath';

const MARKET_LABELS: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };
/** 두 라우트의 시장 키 체계가 다르다 — breadth 는 `KOSPI`, sectors 는 `'0'`. */
const SECTORS_KEY: Record<string, string> = { KOSPI: '0', KOSDAQ: '1' };

const MODES = [
  ['count', '개수'],
  ['spread', '분산'],
  ['flow', '쏠림'],
  ['index', '지수'],
] as const;
type Mode = (typeof MODES)[number][0];

const MODE_HINT: Record<Mode, string> = {
  count: '종목수',
  spread: '지수장 ↔ 종목장',
  flow: '거래대금',
  index: '0~100 정규화',
};

interface Row {
  key: string;
  label: string;
  idx: MarketIndexRow | null;
  sectors: MarketSectorRow[];
  b: {
    new_high_52w?: BreadthCount;
    new_low_52w?: BreadthCount;
  };
}

// ── 모드별 본문 ───────────────────────────────────────────────────────────

function CountBody({ r }: { r: Row }) {
  const pct = advancePct(r.idx);
  return (
    <>
      <div className="flex items-end justify-between gap-sm">
        <div className="flex items-baseline gap-2xs">
          <span
            className={`font-data text-2xl font-semibold tabular-nums ${pct == null ? 'text-fg-dim' : pct >= 50 ? 'text-price-up' : 'text-price-down'}`}
          >
            {pct != null ? pct.toFixed(0) : '—'}
          </span>
          <span className="text-xs text-fg-dim">% 상승</span>
        </div>
        {/* 비율만 남기면 표본 크기를 잃는다 — 원본 개수를 작게 붙여 둔다. */}
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
    </>
  );
}

/** 업종 등락률 분포 — 점 하나가 업종 하나. 30개짜리는 요약하지 말고 그냥 다 그린다:
 *  같은 표준편차가 균등한 퍼짐일 수도, 이상치 하나일 수도 있다. */
function DistributionStrip({ pcts, min, max }: { pcts: readonly number[]; min: number; max: number }) {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  const span = hi - lo || 1;
  const x = (v: number) => ((v - lo) / span) * 100;
  return (
    <div className="relative h-[22px] w-full">
      <div className="absolute inset-x-0 top-[10px] h-px bg-grid" />
      {/* 0% 기준선 — 퍼짐이 어느 쪽으로 기울었는지가 폭만큼 중요하다. */}
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

function SpreadBody({ r }: { r: Row }) {
  const s = sectorSpread(r.sectors);
  if (!s) return <span className="text-2xs text-fg-dimmer">업종 등락률이 아직 없습니다.</span>;
  return (
    <>
      <div className="flex items-end justify-between gap-sm">
        <div className="flex items-baseline gap-2xs">
          <span className="font-data text-2xl font-semibold tabular-nums text-fg">{s.range.toFixed(1)}</span>
          <span className="text-xs text-fg-dim">%p 스프레드</span>
        </div>
        <span className="font-data text-2xs text-fg-dim tabular-nums">σ {s.sd.toFixed(2)}</span>
      </div>
      <DistributionStrip pcts={s.pcts} min={s.min} max={s.max} />
      <div className="flex justify-between font-data text-2xs tabular-nums">
        <span className="text-price-down">{s.min.toFixed(2)}%</span>
        <span className="text-price-up">
          {s.max >= 0 ? '+' : ''}
          {s.max.toFixed(2)}%
        </span>
      </div>
    </>
  );
}

const SIZE_COLORS = ['var(--ma-1)', 'var(--ma-3)', 'var(--ma-5)'];

function FlowBody({ r }: { r: Row }) {
  const jo = eokToJo(r.idx?.trade_value_eok);
  const shares = sizeShares(r.sectors, r.idx?.trade_value_eok);
  return (
    <>
      <div className="flex items-baseline gap-2xs">
        <span className="font-data text-2xl font-semibold tabular-nums text-fg">{jo != null ? jo.toFixed(2) : '—'}</span>
        <span className="text-xs text-fg-dim">조원 거래</span>
      </div>
      {shares.length > 0 ? (
        <>
          {/* 100% 누적 막대. 남는 몫(규모별 지수 밖 종목)은 빈칸으로 남긴다 — 세 조각을
              늘려 100%를 채우면 없는 거래대금을 지어내는 셈이다. */}
          <div className="flex h-[8px] w-full overflow-hidden rounded-sm bg-grid">
            {shares.map((s, i) => (
              <span key={s.name} style={{ width: `${s.share}%`, background: SIZE_COLORS[i] }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-sm gap-y-2xs">
            {shares.map((s, i) => (
              <span key={s.name} className="font-data text-2xs text-fg-dim tabular-nums">
                <span
                  className="mr-[3px] inline-block h-[6px] w-[6px] rounded-full align-middle"
                  style={{ background: SIZE_COLORS[i] }}
                />
                {s.name} {s.share.toFixed(0)}%
              </span>
            ))}
          </div>
        </>
      ) : (
        // 빈 이유를 적는다 — 벤더 공백이 아니라 코스닥엔 규모별 지수가 없는 것이다.
        <span className="text-2xs text-fg-dimmer">규모별 지수가 없는 시장입니다.</span>
      )}
    </>
  );
}

/** 0~100 게이지. 중립 50 눈금이 고정이라 **어제와 비교되는** 값이다. */
function Gauge({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs text-fg-dim">{label}</span>
        <span
          className={`font-data text-xs tabular-nums ${v == null ? 'text-fg-dimmer' : v >= 50 ? 'text-price-up' : 'text-price-down'}`}
        >
          {v == null ? '—' : v.toFixed(0)}
          {hint && <span className="pl-[3px] text-fg-dimmer">{hint}</span>}
        </span>
      </div>
      <div className="relative h-[6px] w-full rounded-sm bg-grid">
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

function IndexBody({ r }: { r: Row }) {
  const hi = r.b.new_high_52w?.count ?? null;
  const lo = r.b.new_low_52w?.count ?? null;
  const adr = advanceDeclineRatio(r.idx);
  return (
    <>
      {/* 원본 개수를 hint 로 남긴다 — 분모가 작으면 정규화가 과장한다(신고 5·신저 0 → 100). */}
      <Gauge
        label="52주 신고-신저"
        value={highLowIndex(hi, lo)}
        hint={hi != null && lo != null ? `${hi}/${hi + lo}` : undefined}
      />
      <Gauge label="상승 비율" value={advancePct(r.idx)} hint={r.idx?.rising != null ? `${r.idx.rising}종목` : undefined} />
      <Gauge label="등락비율 (ADR)" value={adrToGauge(adr)} hint={adr == null ? undefined : `${adr.toFixed(2)}배`} />
    </>
  );
}

const BODY_BY_MODE: Record<Mode, (p: { r: Row }) => React.ReactElement> = {
  count: CountBody,
  spread: SpreadBody,
  flow: FlowBody,
  index: IndexBody,
};

// ── 카드 ──────────────────────────────────────────────────────────────────

export function BreadthCard() {
  const [mode, setMode] = useState<Mode>('count');
  const breadth = useMarketBreadth();
  const sectors = useMarketSectors();

  const rows: Row[] = Object.keys(MARKET_LABELS).map((k) => ({
    key: k,
    label: MARKET_LABELS[k],
    idx: sectors.data?.markets[SECTORS_KEY[k]]?.index ?? null,
    sectors: sectors.data?.markets[SECTORS_KEY[k]]?.sectors ?? [],
    b: breadth.data?.markets[k] ?? {},
  }));
  const ready = rows.some((r) => r.idx != null || r.b.new_high_52w != null);
  const Body = BODY_BY_MODE[mode];

  return (
    <MarketCard className="flex flex-col gap-sm p-sm">
      <CardHeader
        title="시장 폭"
        hint={MODE_HINT[mode]}
        right={<ModeSwitch label="시장 폭 축" value={mode} onChange={setMode} options={MODES} />}
      />
      {!ready ? (
        <EmptyNote>시장 폭 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        rows.map((r) => {
          const [up, total] = risingSectorCount(r.sectors);
          return (
            <div key={r.key} className="flex flex-col gap-2xs">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-fg-dim">{r.label}</span>
                <span className="font-data text-2xs text-fg-dimmer tabular-nums">
                  업종 {total > 0 ? `${up}/${total}` : '—'}
                </span>
              </div>
              <Body r={r} />
            </div>
          );
        })
      )}
    </MarketCard>
  );
}
