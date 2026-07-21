/**
 * PROTOTYPE — THROWAWAY. main 에 머지하지 말 것.
 *
 * 질문: 브라우저 줌인(= 유효 뷰포트 축소) 시 /live 류 워크스페이스가 어떻게
 * 접혀야 "전문가 웹"처럼 느껴지는가?
 *
 * 계획: dev 전용 라우트 /prototype/zoom-responsive 에서 ?variant= 로 전환되는
 * 3개 변형. App 셸(실제 TopNav·RightRail·하단 바)은 그대로 두고 <main> 영역만
 * 각 변형이 다른 반응 전략으로 렌더링한다. 데이터는 전부 결정적 더미.
 *
 *   A — 우선순위 접기: 컨테이너 폭 티어별로 체결 → 사이드 → 호가 순서로 접힘
 *   B — 고정 바닥: 1360px 아래로는 레이아웃 불변 + 가로 스크롤 (TradingView식)
 *   C — 유동 스택: 폭에 따라 패널이 아래 행으로 재배치 (일반 반응형 웹식)
 *
 * 판정법: Ctrl +/- 로 줌을 80%~150% 오가며 (또는 창 폭을 줄이며) 변형을 ←/→ 로
 * 전환해 비교한다. 하단 필의 상태 표시가 현재 유효 폭과 접힘 상태를 보여준다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

// ───────────────────────── 더미 데이터 (결정적) ─────────────────────────

type Candle = { o: number; h: number; l: number; c: number; v: number };

function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function makeCandles(n: number): Candle[] {
  const rng = seededRng(42);
  const out: Candle[] = [];
  let price = 71900;
  for (let i = 0; i < n; i++) {
    const drift = (rng() - 0.48) * 400;
    const o = price;
    const c = Math.round((price + drift) / 100) * 100;
    const h = Math.max(o, c) + Math.round(rng() * 300);
    const l = Math.min(o, c) - Math.round(rng() * 300);
    out.push({ o, h, l, c, v: Math.round(rng() * 90000) + 5000 });
    price = c;
  }
  return out;
}

const CANDLES = makeCandles(64);
const LAST = CANDLES[CANDLES.length - 1].c;
const PREV_CLOSE = 71400;

const ASKS = Array.from({ length: 10 }, (_, i) => ({
  price: LAST + (10 - i) * 100,
  qty: [48210, 30155, 22894, 61023, 18740, 25510, 90112, 14208, 33871, 27455][i],
}));
const BIDS = Array.from({ length: 10 }, (_, i) => ({
  price: LAST - (i + 1) * 100,
  qty: [55120, 41890, 19733, 72455, 28104, 16920, 84501, 22317, 38064, 45990][i],
}));
const MAX_QTY = Math.max(...ASKS.map((r) => r.qty), ...BIDS.map((r) => r.qty));

const TICKS = Array.from({ length: 24 }, (_, i) => {
  const rng = seededRng(7 + i);
  const side = rng() > 0.45 ? 1 : -1;
  return {
    time: `13:${String(58 - Math.floor(i / 3)).padStart(2, '0')}:${String(59 - ((i * 7) % 60)).padStart(2, '0')}`,
    price: LAST + side * (Math.floor(rng() * 3) * 100),
    qty: Math.round(rng() * 4200) + 12,
    side,
  };
});

const BROKERS = [
  { name: '미래에셋', net: 182430 },
  { name: 'JP모간', net: 95112 },
  { name: '키움증권', net: -41230 },
  { name: 'NH투자', net: -87455 },
  { name: '모건스탠리', net: 132800 },
];

const PROGRAM_NET = 214_500;
const PROGRAM_SPARK = [12, 30, 24, 48, 40, 66, 58, 84, 76, 100, 92, 118];

// ───────────────────────── 공용 훅 ─────────────────────────

/** 프로토타입 컨테이너의 실측 폭. 줌·창 리사이즈·우측 드로어 개폐 모두에 반응한다. */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

// ───────────────────────── 공용 더미 패널 (변형 간 공유하는 "내용물") ─────────────────────────

function Pane({
  title,
  children,
  className = '',
  headerRight,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  headerRight?: ReactNode;
}) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-bg-card shadow-panel ${className}`}>
      <header className="flex h-[26px] shrink-0 items-center justify-between border-b border-border px-2 text-[10.5px] font-semibold uppercase text-fg-dimmer">
        <span>{title}</span>
        {headerRight}
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

function PriceStrip() {
  const diff = LAST - PREV_CLOSE;
  const pct = ((diff / PREV_CLOSE) * 100).toFixed(2);
  const dir = diff >= 0 ? 'text-price-up' : 'text-price-down';
  return (
    <div className="flex shrink-0 items-baseline gap-3 px-3 py-1.5">
      <span className="text-md font-semibold">삼성전자</span>
      <span className="text-xs text-fg-dimmer">005930 · KOSPI</span>
      <span className={`font-data text-xl tabular-nums ${dir}`}>{LAST.toLocaleString('ko-KR')}</span>
      <span className={`font-data text-sm tabular-nums ${dir}`}>
        {diff >= 0 ? '+' : ''}
        {diff.toLocaleString('ko-KR')} ({pct}%)
      </span>
    </div>
  );
}

function ChartPanel() {
  const min = Math.min(...CANDLES.map((c) => c.l));
  const max = Math.max(...CANDLES.map((c) => c.h));
  const H = 260;
  const y = (p: number) => ((max - p) / (max - min)) * (H - 20) + 6;
  const w = 640 / CANDLES.length;
  return (
    <div className="relative h-full w-full">
      <div className="absolute left-2 top-1.5 z-10 rounded px-1 font-data text-[10px] tabular-nums text-fg-dim" style={{ background: 'var(--bg-legend)' }}>
        1분 · 시 {CANDLES[0].o.toLocaleString('ko-KR')} 종 {LAST.toLocaleString('ko-KR')}
      </div>
      <svg viewBox={`0 0 640 ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2="640" y1={H * g} y2={H * g} stroke="var(--grid)" strokeWidth="1" />
        ))}
        {CANDLES.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? 'var(--price-up)' : 'var(--price-down)';
          const x = i * w + w / 2;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" />
              <rect
                x={i * w + w * 0.18}
                width={w * 0.64}
                y={y(Math.max(c.o, c.c))}
                height={Math.max(1.5, Math.abs(y(c.o) - y(c.c)))}
                fill={color}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BookRows({ compact }: { compact?: boolean }) {
  const asks = compact ? ASKS.slice(5) : ASKS;
  const bids = compact ? BIDS.slice(0, 5) : BIDS;
  return (
    <div className="font-data text-sm tabular-nums">
      {asks.map((r) => (
        <div key={r.price} className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 leading-6">
          <div className="relative h-4 min-w-0">
            <div
              className="absolute inset-y-0 right-0 rounded-sm"
              style={{ width: `${(r.qty / MAX_QTY) * 100}%`, background: 'color-mix(in srgb, var(--price-down) 28%, transparent)' }}
            />
            <span className="absolute inset-y-0 right-1 leading-4 text-fg-dim">{r.qty.toLocaleString('ko-KR')}</span>
          </div>
          <span className="w-[7ch] text-center text-price-down">{r.price.toLocaleString('ko-KR')}</span>
          <span />
        </div>
      ))}
      <div className="my-0.5 border-t border-border-strong" />
      {bids.map((r) => (
        <div key={r.price} className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 leading-6">
          <span />
          <span className="w-[7ch] text-center text-price-up">{r.price.toLocaleString('ko-KR')}</span>
          <div className="relative h-4 min-w-0">
            <div
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${(r.qty / MAX_QTY) * 100}%`, background: 'color-mix(in srgb, var(--price-up) 28%, transparent)' }}
            />
            <span className="absolute inset-y-0 left-1 leading-4 text-fg-dim">{r.qty.toLocaleString('ko-KR')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TickRows({ limit = 24 }: { limit?: number }) {
  return (
    <div className="font-data text-sm tabular-nums">
      {TICKS.slice(0, limit).map((t, i) => (
        <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-2 px-2 leading-6">
          <span className="text-fg-dimmer">{t.time}</span>
          <span className={`text-right ${t.side > 0 ? 'text-price-up' : 'text-price-down'}`}>
            {t.price.toLocaleString('ko-KR')}
          </span>
          <span className="w-[6ch] text-right text-fg-dim">{t.qty.toLocaleString('ko-KR')}</span>
        </div>
      ))}
    </div>
  );
}

function BrokerRows() {
  return (
    <div className="font-data text-sm tabular-nums">
      {BROKERS.map((b) => (
        <div key={b.name} className="grid grid-cols-[1fr_auto] gap-2 px-2 leading-6">
          <span className="truncate font-ui text-fg-dim">{b.name}</span>
          <span className={b.net >= 0 ? 'text-price-up' : 'text-price-down'}>
            {b.net >= 0 ? '+' : ''}
            {b.net.toLocaleString('ko-KR')}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProgramCard() {
  const max = Math.max(...PROGRAM_SPARK);
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5">
      <div>
        <div className="text-[10.5px] uppercase text-fg-dimmer">프로그램 순매수</div>
        <div className="font-data text-base tabular-nums text-price-up">+{PROGRAM_NET.toLocaleString('ko-KR')}</div>
      </div>
      <svg viewBox="0 0 120 32" className="h-8 w-[120px] shrink-0">
        <polyline
          fill="none"
          stroke="var(--price-up)"
          strokeWidth="1.5"
          points={PROGRAM_SPARK.map((v, i) => `${(i / (PROGRAM_SPARK.length - 1)) * 118 + 1},${30 - (v / max) * 28}`).join(' ')}
        />
      </svg>
    </div>
  );
}

// ───────────────────────── 변형 A — 우선순위 접기 ─────────────────────────
// 서열: 차트 > 호가 > 체결 > 사이드 카드. 폭 티어가 내려갈 때마다 서열 밖 패널부터 접는다.

const TIER_A = (w: number) => (w >= 1360 ? 0 : w >= 1140 ? 1 : w >= 940 ? 2 : 3);
const TIER_A_LABEL = ['전체 표시', '체결 접힘', '체결+사이드 접힘', '호가 압축(5단)'];

function VariantA({ width }: { width: number }) {
  const tier = TIER_A(width);
  const [sideOpen, setSideOpen] = useState(false);
  const showTicks = tier === 0;
  const showSideCol = tier <= 1;
  const compactBook = tier === 3;

  const cols = [
    showSideCol ? '248px' : '36px',
    'minmax(0, 1fr)',
    compactBook ? '248px' : '312px',
    ...(showTicks ? ['248px'] : []),
  ].join(' ');

  return (
    <div className="relative grid h-full min-h-0 gap-1 p-1" style={{ gridTemplateColumns: cols }}>
      {showSideCol ? (
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-1">
          <Pane title="거래원">
            <BrokerRows />
          </Pane>
          <Pane title="프로그램">
            <ProgramCard />
          </Pane>
        </div>
      ) : (
        // 접힌 아이콘 스트립 — 클릭 시 오버레이 드로어
        <div className="flex min-h-0 flex-col items-center gap-1 rounded-lg bg-bg-card py-2 shadow-panel">
          <button
            onClick={() => setSideOpen((v) => !v)}
            className={`h-6 w-6 rounded-sm font-data text-[10px] font-semibold ${sideOpen ? 'bg-tint-selection text-accent' : 'text-fg-dimmer hover:text-fg'}`}
            title="사이드 카드 열기"
          >
            ≡
          </button>
          <span className="text-[9px] text-fg-dimmer [writing-mode:vertical-rl]">거래원 · 프로그램</span>
        </div>
      )}

      {!showSideCol && sideOpen && (
        <div className="absolute left-10 top-1 z-20 grid w-[248px] gap-1 rounded-lg border border-border bg-bg-subtle p-1 shadow-panel">
          <Pane title="거래원" className="max-h-[180px]">
            <BrokerRows />
          </Pane>
          <Pane title="프로그램">
            <ProgramCard />
          </Pane>
        </div>
      )}

      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1">
        <div className="rounded-lg bg-bg-card shadow-panel">
          <PriceStrip />
        </div>
        <Pane title="차트">
          <ChartPanel />
        </Pane>
      </div>

      <Pane
        title={compactBook ? '10호가 (5단 압축)' : '10호가'}
        headerRight={
          !showTicks ? <span className="rounded-sm bg-tint-selection px-1 font-data text-[9px] text-accent">체결 접힘</span> : undefined
        }
      >
        <BookRows compact={compactBook} />
      </Pane>

      {showTicks && (
        <Pane title="체결">
          <TickRows />
        </Pane>
      )}
    </div>
  );
}

// ───────────────────────── 변형 B — 고정 바닥 + 가로 스크롤 ─────────────────────────
// 레이아웃은 어떤 줌에서도 불변. 유효 폭 < 1360 이면 페이지가 가로 스크롤을 얻는다.

const FLOOR_B = 1360;

function VariantB() {
  return (
    <div className="h-full min-h-0 overflow-x-auto overflow-y-hidden">
      <div className="grid h-full gap-1 p-1" style={{ minWidth: FLOOR_B, gridTemplateColumns: '248px minmax(0,1fr) 312px 248px' }}>
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-1">
          <Pane title="거래원">
            <BrokerRows />
          </Pane>
          <Pane title="프로그램">
            <ProgramCard />
          </Pane>
        </div>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1">
          <div className="rounded-lg bg-bg-card shadow-panel">
            <PriceStrip />
          </div>
          <Pane title="차트">
            <ChartPanel />
          </Pane>
        </div>
        <Pane title="10호가">
          <BookRows />
        </Pane>
        <Pane title="체결">
          <TickRows />
        </Pane>
      </div>
    </div>
  );
}

// ───────────────────────── 변형 C — 유동 스택 재배치 ─────────────────────────
// 접지 않는다. 폭이 줄면 패널이 아래 행으로 흘러내리고 페이지는 세로 스크롤을 얻는다.

const TIER_C = (w: number) => (w >= 1200 ? 0 : w >= 800 ? 1 : 2);
const TIER_C_LABEL = ['2행 와이드', '차트 전폭 + 2열', '1열 스택'];

function VariantC({ width }: { width: number }) {
  const tier = TIER_C(width);
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="grid gap-1 p-1">
        <div className="rounded-lg bg-bg-card shadow-panel">
          <PriceStrip />
        </div>
        {tier === 0 ? (
          <>
            <div className="grid gap-1" style={{ gridTemplateColumns: 'minmax(0,1fr) 312px' }}>
              <Pane title="차트" className="h-[340px]">
                <ChartPanel />
              </Pane>
              <Pane title="10호가" className="h-[340px]">
                <BookRows />
              </Pane>
            </div>
            <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
              <Pane title="체결" className="h-[200px]">
                <TickRows />
              </Pane>
              <Pane title="거래원" className="h-[200px]">
                <BrokerRows />
              </Pane>
              <Pane title="프로그램" className="h-[200px]">
                <ProgramCard />
              </Pane>
            </div>
          </>
        ) : tier === 1 ? (
          <>
            <Pane title="차트" className="h-[300px]">
              <ChartPanel />
            </Pane>
            <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
              <Pane title="10호가" className="h-[300px]">
                <BookRows />
              </Pane>
              <Pane title="체결" className="h-[300px]">
                <TickRows />
              </Pane>
            </div>
            <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
              <Pane title="거래원" className="h-[170px]">
                <BrokerRows />
              </Pane>
              <Pane title="프로그램">
                <ProgramCard />
              </Pane>
            </div>
          </>
        ) : (
          <>
            <Pane title="차트" className="h-[240px]">
              <ChartPanel />
            </Pane>
            <Pane title="10호가" className="h-[300px]">
              <BookRows />
            </Pane>
            <Pane title="체결" className="h-[220px]">
              <TickRows limit={10} />
            </Pane>
            <Pane title="거래원" className="h-[170px]">
              <BrokerRows />
            </Pane>
            <Pane title="프로그램">
              <ProgramCard />
            </Pane>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 변형 D — 토스식 하이브리드 ─────────────────────────
// 토스증권 주문 페이지 실측(2026-07-21)의 이식: 코어(차트·호가·체결)는 유동 압축까지만
// 허용하고 절대 접지 않는다. 접는 건 주변부(사이드 카드→아이콘 스트립)뿐. 그래도
// 모자라면 html min-width 식 바닥 + 가로 스크롤로 도망간다 (토스 바닥 = 1024px).
//
// 바닥 실측 근거 (합계 = 900px):
//   아이콘 스트립 36 + 차트 최소 380(봉 몸통 가독) + 호가 최소 260(7ch 가격 + 잔량바)
//   + 체결 최소 200(3열) + gap 12 + 패딩 12 ≈ 900
const FLOOR_D = 900;
const SIDE_COLLAPSE_D = 1140; // 이 아래에서 사이드 카드 → 아이콘 스트립 (토스의 관심 레일과 동형)

const TIER_D = (w: number) =>
  w >= SIDE_COLLAPSE_D ? 0 : w >= FLOOR_D ? 1 : 2;
const TIER_D_LABEL = ['전체 표시 — 유동 압축', '사이드 접힘 — 코어 유동 압축', '바닥 미달 — 가로 스크롤'];

function VariantD({ width }: { width: number }) {
  const tier = TIER_D(width);
  const [sideOpen, setSideOpen] = useState(false);
  const showSideCol = tier === 0;

  // 코어 3열은 minmax 로 유동 압축: 폭이 줄면 각 열이 자기 최소까지 눌리다가,
  // 합계가 바닥에 닿으면 (min-width) 더는 안 눌리고 가로 스크롤로 전환된다.
  const cols = [
    showSideCol ? '248px' : '36px',
    'minmax(380px, 1fr)', // 차트
    'minmax(260px, 312px)', // 호가
    'minmax(200px, 248px)', // 체결
  ].join(' ');

  return (
    <div className="h-full min-h-0 overflow-x-auto overflow-y-hidden">
      <div
        className="relative grid h-full min-h-0 gap-1 p-1"
        style={{ gridTemplateColumns: cols, minWidth: FLOOR_D }}
      >
        {showSideCol ? (
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-1">
            <Pane title="거래원">
              <BrokerRows />
            </Pane>
            <Pane title="프로그램">
              <ProgramCard />
            </Pane>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col items-center gap-1 rounded-lg bg-bg-card py-2 shadow-panel">
            <button
              onClick={() => setSideOpen((v) => !v)}
              className={`h-6 w-6 rounded-sm font-data text-[10px] font-semibold ${sideOpen ? 'bg-tint-selection text-accent' : 'text-fg-dimmer hover:text-fg'}`}
              title="사이드 카드 열기"
            >
              ≡
            </button>
            <span className="text-[9px] text-fg-dimmer [writing-mode:vertical-rl]">거래원 · 프로그램</span>
          </div>
        )}

        {!showSideCol && sideOpen && (
          <div className="absolute left-10 top-1 z-20 grid w-[248px] gap-1 rounded-lg border border-border bg-bg-subtle p-1 shadow-panel">
            <Pane title="거래원" className="max-h-[180px]">
              <BrokerRows />
            </Pane>
            <Pane title="프로그램">
              <ProgramCard />
            </Pane>
          </div>
        )}

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-1">
          <div className="rounded-lg bg-bg-card shadow-panel">
            <PriceStrip />
          </div>
          <Pane title="차트">
            <ChartPanel />
          </Pane>
        </div>

        <Pane title="10호가">
          <BookRows />
        </Pane>

        <Pane title="체결">
          <TickRows />
        </Pane>
      </div>
    </div>
  );
}

// ───────────────────────── 스위처 + 상태 HUD ─────────────────────────

const VARIANTS = [
  { key: 'A', name: '우선순위 접기' },
  { key: 'B', name: '고정 바닥 + 가로 스크롤' },
  { key: 'C', name: '유동 스택 재배치' },
  { key: 'D', name: '토스식 하이브리드' },
] as const;

function stateLabel(variant: string, width: number): string {
  if (variant === 'A') return TIER_A_LABEL[TIER_A(width)];
  if (variant === 'B') return width >= FLOOR_B ? '바닥 이상 — 스크롤 없음' : `바닥 미달 — 가로 스크롤 (${FLOOR_B - width}px 부족)`;
  if (variant === 'D') {
    const label = TIER_D_LABEL[TIER_D(width)];
    return TIER_D(width) === 2 ? `${label} (${FLOOR_D - width}px 부족)` : label;
  }
  return TIER_C_LABEL[TIER_C(width)];
}

function PrototypeSwitcher({ current, width }: { current: (typeof VARIANTS)[number]; width: number }) {
  const [, setSearchParams] = useSearchParams();
  const idx = VARIANTS.findIndex((v) => v.key === current.key);
  const go = (dir: 1 | -1) => {
    const next = VARIANTS[(idx + dir + VARIANTS.length) % VARIANTS.length];
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('variant', next.key);
      return p;
    }, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-accent bg-bg-subtle px-4 py-1.5 shadow-panel">
      <button onClick={() => go(-1)} className="text-fg-dim hover:text-fg" aria-label="이전 변형">
        ←
      </button>
      <div className="text-center">
        <div className="text-sm font-semibold text-fg">
          {current.key} — {current.name}
        </div>
        <div className="font-data text-[10px] tabular-nums text-fg-dimmer">
          유효폭 {width}px · dpr {typeof devicePixelRatio === 'number' ? devicePixelRatio.toFixed(2) : '?'} · {stateLabel(current.key, width)}
        </div>
      </div>
      <button onClick={() => go(1)} className="text-fg-dim hover:text-fg" aria-label="다음 변형">
        →
      </button>
    </div>
  );
}

// ───────────────────────── 루트 ─────────────────────────

export default function ZoomResponsivePrototype() {
  const [searchParams] = useSearchParams();
  const key = searchParams.get('variant') ?? 'A';
  const current = VARIANTS.find((v) => v.key === key) ?? VARIANTS[0];
  const { ref, width } = useContainerWidth();
  // dpr 표시를 줌 변경에 반응시키기 위한 리렌더 트리거 (resize 는 줌 시에도 발화)
  const [, force] = useState(0);
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    // data-theme 래퍼: 라우트가 auto 매핑에서 ledger 로 떨어져도 이 서브트리는
    // /live 와 동일한 Obsidian 토큰으로 렌더링된다 (프로덕션 테마 로직 무접촉).
    <div ref={ref} data-theme="obsidian" className="h-full min-h-0 bg-bg font-ui text-fg">
      {width > 0 && (
        <>
          {current.key === 'A' && <VariantA width={width} />}
          {current.key === 'B' && <VariantB />}
          {current.key === 'C' && <VariantC width={width} />}
          {current.key === 'D' && <VariantD width={width} />}
        </>
      )}
      <PrototypeSwitcher current={current} width={width} />
    </div>
  );
}
