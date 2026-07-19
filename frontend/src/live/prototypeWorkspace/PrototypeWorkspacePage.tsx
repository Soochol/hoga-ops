/**
 * PROTOTYPE — throwaway. 지우기 전제의 코드. 프로덕션 아님.
 *
 * 질문: "차트+10호가 세트를 N개(여기선 3개) 놓은 워크스페이스는 어떤 모습이어야 하나"
 * (wayfinder 지도 #706 · 티켓 #707 레이아웃 패러다임 grilling → #714 프로토타입)
 *
 * /prototype-workspace 라우트에서 ?variant=A|B|C|D 로 전환:
 *   A — 균등 3열 · 호가 우측 세로 레일 (토스식 컬럼 도킹) [기각]
 *   B — 主副 포커스 · 큰 세트 1 + 작은 세트 2 (위계형) [기각]
 *   C — 2×2 그리드 · 호가 하단 가로 스트립 · 빈 슬롯 [기각]
 *   D — 스마트 자석 플로팅 (인터랙티브) [#707 채택 · #714 확장]
 *
 * 데이터는 전부 시드 더미.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  type UTCTimestamp,
  type IChartApi,
} from 'lightweight-charts';

// ── 더미 데이터 ──────────────────────────────────────────────────────────────

type SetSpec = {
  link: number; // 링크 그룹 번호 (동일 숫자 = 동일 종목)
  name: string;
  code: string;
  base: number; // 기준가
  tick: number;
  seed: number;
};

const SETS: SetSpec[] = [
  { link: 1, name: '삼성전자', code: '005930', base: 253500, tick: 500, seed: 11 },
  { link: 2, name: 'SK하이닉스', code: '000660', base: 1830000, tick: 1000, seed: 22 },
  { link: 3, name: '한화오션', code: '042660', base: 85900, tick: 100, seed: 33 },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function makeCandles(spec: SetSpec, n = 90): Candle[] {
  const rnd = mulberry32(spec.seed);
  const out: Candle[] = [];
  let close = spec.base * (0.9 + rnd() * 0.1);
  const day = 86400;
  const t0 = 1750000000 - n * day;
  for (let i = 0; i < n; i++) {
    const open = close;
    const drift = (rnd() - 0.48) * spec.base * 0.03;
    close = Math.max(spec.tick, open + drift);
    const high = Math.max(open, close) + rnd() * spec.base * 0.012;
    const low = Math.min(open, close) - rnd() * spec.base * 0.012;
    out.push({
      time: (t0 + i * day) as UTCTimestamp,
      open,
      high,
      low,
      close,
      volume: Math.round(1000 + rnd() * 9000),
    });
  }
  return out;
}

type BookLevel = { price: number; qty: number };
type Book = { asks: BookLevel[]; bids: BookLevel[]; last: number };

function makeBook(spec: SetSpec, last: number): Book {
  const rnd = mulberry32(spec.seed * 7 + 1);
  const snap = Math.round(last / spec.tick) * spec.tick;
  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (let i = 1; i <= 10; i++) {
    asks.push({ price: snap + i * spec.tick, qty: Math.round(200 + rnd() * 4800) });
    bids.push({ price: snap - (i - 1) * spec.tick, qty: Math.round(200 + rnd() * 4800) });
  }
  return { asks, bids, last };
}

const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

// ── 미니 차트 (lwc v5, 세트당 독립 인스턴스) ────────────────────────────────

function MiniChart({ spec }: { spec: SetSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const candles = useMemo(() => makeCandles(spec), [spec]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: v('--fg-dimmer'),
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: v('--grid') },
        horzLines: { color: v('--grid') },
      },
      rightPriceScale: { borderColor: v('--border') },
      timeScale: { borderColor: v('--border'), timeVisible: false },
      crosshair: { vertLine: { color: v('--accent') }, horzLine: { color: v('--accent') } },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: v('--price-up'),
      downColor: v('--price-down'),
      wickUpColor: v('--price-up'),
      wickDownColor: v('--price-down'),
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    candle.setData(candles);
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      color: v('--fg-dimmer'),
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? v('--tint-price-up') : v('--tint-price-down'),
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles]);

  return <div ref={ref} className="h-full w-full min-h-0 min-w-0" />;
}

// ── 10호가 (세로 레일 / 가로 스트립) ────────────────────────────────────────

function depthPct(qty: number, max: number) {
  return `${Math.max(6, Math.round((qty / max) * 100))}%`;
}

function OrderbookVertical({ book, dense }: { book: Book; dense?: boolean }) {
  const max = Math.max(...book.asks.map((l) => l.qty), ...book.bids.map((l) => l.qty));
  const row = dense ? 'h-[16px] text-[10px]' : 'h-[20px] text-[11px]';
  return (
    <div className="flex h-full min-h-0 flex-col font-mono [font-variant-numeric:tabular-nums]">
      <div className="flex-1 min-h-0 flex flex-col justify-end">
        {[...book.asks].reverse().map((l) => (
          <div key={l.price} className={`relative flex items-center justify-between px-1.5 ${row}`}>
            <span
              className="absolute inset-y-[2px] right-0 bg-tint-price-down"
              style={{ width: depthPct(l.qty, max) }}
            />
            <span className="relative z-10 text-price-down">{fmt(l.price)}</span>
            <span className="relative z-10 text-fg-dim">{fmt(l.qty)}</span>
          </div>
        ))}
      </div>
      <div
        className={`flex items-center justify-between border-y border-border bg-bg-subtle px-1.5 ${row}`}
      >
        <span className="text-fg">{fmt(book.last)}</span>
        <span className="text-[9px] uppercase tracking-wider text-accent">체결</span>
      </div>
      <div className="flex-1 min-h-0">
        {book.bids.map((l) => (
          <div key={l.price} className={`relative flex items-center justify-between px-1.5 ${row}`}>
            <span
              className="absolute inset-y-[2px] right-0 bg-tint-price-up"
              style={{ width: depthPct(l.qty, max) }}
            />
            <span className="relative z-10 text-price-up">{fmt(l.price)}</span>
            <span className="relative z-10 text-fg-dim">{fmt(l.qty)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderbookHorizontal({ book }: { book: Book }) {
  const max = Math.max(...book.asks.map((l) => l.qty), ...book.bids.map((l) => l.qty));
  const cell = (l: BookLevel, side: 'ask' | 'bid') => (
    <div key={`${side}-${l.price}`} className="relative min-w-0 flex-1 px-0.5 py-0.5 text-center">
      <span
        className={`absolute inset-x-[2px] bottom-0 ${side === 'ask' ? 'bg-tint-price-down' : 'bg-tint-price-up'}`}
        style={{ height: depthPct(l.qty, max) }}
      />
      <div
        className={`relative z-10 truncate text-[10px] ${side === 'ask' ? 'text-price-down' : 'text-price-up'}`}
      >
        {fmt(l.price)}
      </div>
      <div className="relative z-10 truncate text-[9px] text-fg-dim">{fmt(l.qty)}</div>
    </div>
  );
  return (
    <div className="flex h-[38px] shrink-0 items-stretch border-t border-border font-mono [font-variant-numeric:tabular-nums]">
      {[...book.asks].reverse().map((l) => cell(l, 'ask'))}
      <div className="w-px shrink-0 bg-border-strong" />
      {book.bids.map((l) => cell(l, 'bid'))}
    </div>
  );
}

// ── 세트 카드 공통 크롬 (A/B/C 정지화면용) ──────────────────────────────────

function LinkBadge({ n, onClick }: { n: number; onClick?: () => void }) {
  return (
    <button
      className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-sm bg-tint-selection font-mono text-[10px] font-semibold text-accent hover:brightness-125"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {n}
    </button>
  );
}

function SetHeader({ spec, price }: { spec: SetSpec; price: number }) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-border px-1.5">
      <span className="cursor-grab select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
      <LinkBadge n={spec.link} />
      <span className="truncate text-[12px] font-medium text-fg">{spec.name}</span>
      <span className="font-mono text-[10px] text-fg-dimmer">{spec.code}</span>
      <span className="ml-auto font-mono text-[11px] text-fg-dim [font-variant-numeric:tabular-nums]">
        {fmt(price)}
      </span>
      <button className="px-0.5 text-[11px] leading-none text-fg-dimmer hover:text-fg" title="지표 추가">
        +
      </button>
      <button className="px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg" title="세트 닫기">
        ×
      </button>
    </div>
  );
}

function SetCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-bg-card shadow-panel">
      {children}
    </div>
  );
}

// ── Variant A — 균등 3열 · 호가 우측 세로 레일 ──────────────────────────────

function VariantA() {
  return (
    <div className="grid h-full min-h-0 grid-cols-3 gap-1">
      {SETS.map((spec) => {
        const book = makeBook(spec, spec.base);
        return (
          <SetCard key={spec.code}>
            <SetHeader spec={spec} price={spec.base} />
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <MiniChart spec={spec} />
              </div>
              <div className="w-[150px] shrink-0 border-l border-border">
                <OrderbookVertical book={book} dense />
              </div>
            </div>
          </SetCard>
        );
      })}
    </div>
  );
}

// ── Variant B — 主副 포커스 · 1大 + 2小 ─────────────────────────────────────

function VariantB() {
  const [main, ...rest] = SETS;
  const mainBook = makeBook(main, main.base);
  return (
    <div className="grid h-full min-h-0 grid-cols-[2fr_1fr] gap-1">
      <SetCard>
        <SetHeader spec={main} price={main.base} />
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <MiniChart spec={main} />
          </div>
          <div className="w-[190px] shrink-0 border-l border-border">
            <OrderbookVertical book={mainBook} />
          </div>
        </div>
      </SetCard>
      <div className="grid min-h-0 grid-rows-2 gap-1">
        {rest.map((spec) => {
          const book = makeBook(spec, spec.base);
          return (
            <SetCard key={spec.code}>
              <SetHeader spec={spec} price={spec.base} />
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  <MiniChart spec={spec} />
                </div>
                <div className="w-[124px] shrink-0 border-l border-border">
                  <OrderbookVertical book={book} dense />
                </div>
              </div>
            </SetCard>
          );
        })}
      </div>
    </div>
  );
}

// ── Variant C — 2×2 그리드 · 호가 하단 가로 · 빈 슬롯 ───────────────────────

function VariantC() {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-1">
      {SETS.map((spec) => {
        const book = makeBook(spec, spec.base);
        return (
          <SetCard key={spec.code}>
            <SetHeader spec={spec} price={spec.base} />
            <div className="min-h-0 flex-1">
              <MiniChart spec={spec} />
            </div>
            <OrderbookHorizontal book={book} />
          </SetCard>
        );
      })}
      <button className="flex min-h-0 items-center justify-center rounded-lg border border-dashed border-border-strong text-[13px] text-fg-dimmer hover:border-accent hover:text-fg">
        + 세트 추가
      </button>
    </div>
  );
}

// ── Variant D — 스마트 자석 플로팅 (인터랙티브, #714 확장판) ────────────────
//
// #707 채택 규칙 + #714 잔여 범위 구현:
//   · 8방향 리사이즈 핸들(E/W/N/S + 4모서리), 전부 자석
//   · 순수 변(E/W/N/S) 드래그 시 붙은 이웃 동시 조절(스플리터 승격)
//   · 링크 뱃지 클릭 → 1~10 그룹 팔레트 (그룹=종목, #711 의미론)
//   · 창 추가(+차트/+호가/+거래원, 활성 그룹 상속)·닫기·12창 스트레스
//   · Alt=자석 해제 · 좌/우 벽 반분할 스냅존 · Tidy 일반화 · 포커스 z-order

type WinKind = 'chart' | 'book' | 'broker';
type Win = {
  id: string;
  kind: WinKind;
  group: number; // 링크 그룹 1~10 (그룹 = 종목)
  x: number;
  y: number;
  w: number;
  h: number;
};

const SNAP = 12;
const MIN_W = 160;
const MIN_H = 120;

// 그룹 1~10 → 더미 종목 (#711: 그룹이 종목의 SSOT)
const GROUP_SPECS: SetSpec[] = [
  ...SETS,
  { link: 4, name: 'NAVER', code: '035420', base: 189700, tick: 100, seed: 44 },
  { link: 5, name: '현대차', code: '005380', base: 421500, tick: 500, seed: 55 },
  { link: 6, name: 'KB금융', code: '105560', base: 132800, tick: 100, seed: 66 },
  { link: 7, name: 'POSCO홀딩스', code: '005490', base: 312000, tick: 500, seed: 77 },
  { link: 8, name: '카카오', code: '035720', base: 41250, tick: 50, seed: 88 },
  { link: 9, name: 'LG에너지솔루션', code: '373220', base: 338500, tick: 500, seed: 99 },
  { link: 10, name: '두산에너빌리티', code: '034020', base: 64300, tick: 100, seed: 110 },
];
const specForGroup = (g: number) => GROUP_SPECS[(g - 1 + GROUP_SPECS.length) % GROUP_SPECS.length];

const KIND_LABEL: Record<WinKind, string> = { chart: '차트', book: '10호가', broker: '거래원' };

function BrokerPanel({ spec }: { spec: SetSpec }) {
  const rows = useMemo(() => {
    const rnd = mulberry32(spec.seed * 13 + 5);
    const names = ['미래에셋', '한국투자', 'NH투자', '삼성', 'KB증권', '키움', '모건스탠리', 'JP모간'];
    return names.map((n) => ({ n, v: Math.round((rnd() - 0.5) * 40000) }));
  }, [spec]);
  return (
    <div className="h-full overflow-hidden p-1 font-mono text-[11px] [font-variant-numeric:tabular-nums]">
      {rows.map(({ n, v }) => (
        <div key={n} className="flex h-[20px] items-center justify-between px-1">
          <span className="text-fg-dim">{n}</span>
          <span className={v >= 0 ? 'text-price-up' : 'text-price-down'}>
            {v >= 0 ? '+' : ''}
            {v.toLocaleString('ko-KR')}
          </span>
        </div>
      ))}
    </div>
  );
}

type Cand = { val: number; guide: number };

function snapAxis(raw: number, cands: Cand[], alt: boolean): { val: number; guide: number | null } {
  if (alt) return { val: raw, guide: null };
  let best: Cand | null = null;
  for (const c of cands) {
    if (Math.abs(c.val - raw) <= SNAP && (!best || Math.abs(c.val - raw) < Math.abs(best.val - raw))) {
      best = c;
    }
  }
  return best ? { val: best.val, guide: best.guide } : { val: raw, guide: null };
}

type Mode = 'move' | 'e' | 'w' | 'n' | 's' | 'ne' | 'nw' | 'se' | 'sw';
type Follower = { id: string; x0: number; y0: number; w0: number; h0: number };
type DragState = {
  mode: Mode;
  id: string;
  px: number;
  py: number;
  orig: Win;
  // 순수 변 드래그에서만 채워짐 — 붙은 이웃(스플리터 승격 대상)
  followers: Follower[];
};

const HANDLES: { mode: Mode; cls: string }[] = [
  { mode: 'e', cls: 'absolute inset-y-[12px] right-0 w-[6px] cursor-ew-resize' },
  { mode: 'w', cls: 'absolute inset-y-[12px] left-0 w-[6px] cursor-ew-resize' },
  { mode: 's', cls: 'absolute inset-x-[12px] bottom-0 h-[6px] cursor-ns-resize' },
  { mode: 'n', cls: 'absolute inset-x-[12px] top-0 h-[6px] cursor-ns-resize' },
  { mode: 'se', cls: 'absolute bottom-0 right-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'nw', cls: 'absolute left-0 top-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'ne', cls: 'absolute right-0 top-0 h-[12px] w-[12px] cursor-nesw-resize' },
  { mode: 'sw', cls: 'absolute bottom-0 left-0 h-[12px] w-[12px] cursor-nesw-resize' },
];

const INITIAL_WINS: Win[] = [
  { id: 'c1', kind: 'chart', group: 1, x: 24, y: 16, w: 540, h: 350 },
  { id: 'c2', kind: 'chart', group: 2, x: 220, y: 140, w: 540, h: 350 },
  { id: 'b1', kind: 'book', group: 1, x: 800, y: 30, w: 200, h: 430 },
  { id: 'k1', kind: 'broker', group: 1, x: 850, y: 330, w: 240, h: 200 },
];

const STRESS_WINS: Omit<Win, 'x' | 'y'>[] = [
  { id: 's-c3', kind: 'chart', group: 3, w: 420, h: 300 },
  { id: 's-c4', kind: 'chart', group: 4, w: 420, h: 300 },
  { id: 's-c5', kind: 'chart', group: 5, w: 420, h: 300 },
  { id: 's-c6', kind: 'chart', group: 6, w: 420, h: 300 },
  { id: 's-b2', kind: 'book', group: 2, w: 190, h: 360 },
  { id: 's-b3', kind: 'book', group: 3, w: 190, h: 360 },
  { id: 's-k2', kind: 'broker', group: 2, w: 230, h: 190 },
  { id: 's-k4', kind: 'broker', group: 4, w: 230, h: 190 },
];

function VariantD() {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const idRef = useRef(0);
  const [wins, setWins] = useState<Win[]>(INITIAL_WINS);
  const [order, setOrder] = useState<string[]>(INITIAL_WINS.map((w) => w.id));
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const [zone, setZone] = useState<'left' | 'right' | null>(null);
  const [palette, setPalette] = useState<string | null>(null);

  const front = (id: string) => setOrder((o) => [...o.filter((i) => i !== id), id]);
  const focusedId = order[order.length - 1];
  // 활성 그룹 = 포커스 창의 그룹 (#711)
  const activeGroup = wins.find((w) => w.id === focusedId)?.group ?? 1;

  const beginDrag = (e: React.PointerEvent, id: string, mode: Mode) => {
    const win = wins.find((w) => w.id === id);
    if (!win) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 합성(비신뢰) 이벤트는 활성 포인터가 없어 캡처가 실패할 수 있음 — 컨테이너 onPointerMove로 지속
    }
    // 순수 변 드래그만 스플리터 승격: 해당 변에 붙은(±2px + 구간 겹침) 이웃 수집
    let followers: Follower[] = [];
    if (mode === 'e' || mode === 'w' || mode === 'n' || mode === 's') {
      followers = wins
        .filter((o) => {
          if (o.id === id) return false;
          const hOverlap = o.y < win.y + win.h && o.y + o.h > win.y;
          const vOverlap = o.x < win.x + win.w && o.x + o.w > win.x;
          if (mode === 'e') return Math.abs(o.x - (win.x + win.w)) <= 2 && hOverlap;
          if (mode === 'w') return Math.abs(o.x + o.w - win.x) <= 2 && hOverlap;
          if (mode === 's') return Math.abs(o.y - (win.y + win.h)) <= 2 && vOverlap;
          return Math.abs(o.y + o.h - win.y) <= 2 && vOverlap; // 'n'
        })
        .map((o) => ({ id: o.id, x0: o.x, y0: o.y, w0: o.w, h0: o.h }));
    }
    dragRef.current = { mode, id, px: e.clientX, py: e.clientY, orig: { ...win }, followers };
    front(id);
    setPalette(null);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const alt = e.altKey;
    const W = box.width;
    const H = box.height;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    const others = wins.filter((w) => w.id !== d.id);

    if (d.mode === 'move') {
      const { w, h } = d.orig;
      const cx: Cand[] = [
        { val: 0, guide: 0 },
        { val: W - w, guide: W },
      ];
      const cy: Cand[] = [
        { val: 0, guide: 0 },
        { val: H - h, guide: H },
      ];
      for (const o of others) {
        cx.push(
          { val: o.x + o.w, guide: o.x + o.w },
          { val: o.x - w, guide: o.x },
          { val: o.x, guide: o.x },
          { val: o.x + o.w - w, guide: o.x + o.w },
        );
        cy.push(
          { val: o.y + o.h, guide: o.y + o.h },
          { val: o.y - h, guide: o.y },
          { val: o.y, guide: o.y },
          { val: o.y + o.h - h, guide: o.y + o.h },
        );
      }
      const sx = snapAxis(Math.min(Math.max(d.orig.x + dx, 0), W - w), cx, alt);
      const sy = snapAxis(Math.min(Math.max(d.orig.y + dy, 0), H - h), cy, alt);
      setGuides({ v: sx.guide, h: sy.guide });
      const px = e.clientX - box.left;
      setZone(alt ? null : px < 28 ? 'left' : px > W - 28 ? 'right' : null);
      setWins((ws) => ws.map((w0) => (w0.id === d.id ? { ...w0, x: sx.val, y: sy.val } : w0)));
      return;
    }

    // 리사이즈: mode 문자에 포함된 변마다 해당 가장자리를 이동
    const hasE = d.mode.includes('e');
    const hasW = d.mode.includes('w');
    const hasN = d.mode.includes('n');
    const hasS = d.mode.includes('s');
    const pure = d.mode.length === 1;

    const vertCands: Cand[] = [
      { val: 0, guide: 0 },
      { val: W, guide: W },
    ];
    const horzCands: Cand[] = [
      { val: 0, guide: 0 },
      { val: H, guide: H },
    ];
    for (const o of others) {
      vertCands.push({ val: o.x, guide: o.x }, { val: o.x + o.w, guide: o.x + o.w });
      horzCands.push({ val: o.y, guide: o.y }, { val: o.y + o.h, guide: o.y + o.h });
    }

    let { x, y, w, h } = d.orig;
    let gv: number | null = null;
    let gh: number | null = null;
    let edgeV = 0; // 스플리터 승격에 쓰는 새 변 좌표
    let edgeH = 0;

    // 스플리터 승격 중에는 팔로워의 최소 크기에서도 함께 멈춤 (파고들어 겹침 방지)
    const fMin = (sel: (f: Follower) => number, pick: 'min' | 'max') =>
      d.followers.length === 0
        ? null
        : d.followers.map(sel).reduce((a, b) => (pick === 'min' ? Math.min(a, b) : Math.max(a, b)));

    if (hasE) {
      let hi = W;
      if (pure) {
        const cap = fMin((f) => f.x0 + f.w0 - MIN_W, 'min');
        if (cap !== null) hi = Math.min(hi, cap);
      }
      const raw = Math.max(d.orig.x + MIN_W, Math.min(d.orig.x + d.orig.w + dx, hi));
      const s = snapAxis(raw, vertCands, alt);
      w = s.val - x;
      gv = s.guide;
      edgeV = s.val;
    }
    if (hasW) {
      let lo = 0;
      if (pure) {
        const cap = fMin((f) => f.x0 + MIN_W, 'max');
        if (cap !== null) lo = Math.max(lo, cap);
      }
      const raw = Math.min(d.orig.x + d.orig.w - MIN_W, Math.max(d.orig.x + dx, lo));
      const s = snapAxis(raw, vertCands, alt);
      w = d.orig.x + d.orig.w - s.val;
      x = s.val;
      gv = s.guide;
      edgeV = s.val;
    }
    if (hasS) {
      let hi = H;
      if (pure) {
        const cap = fMin((f) => f.y0 + f.h0 - MIN_H, 'min');
        if (cap !== null) hi = Math.min(hi, cap);
      }
      const raw = Math.max(d.orig.y + MIN_H, Math.min(d.orig.y + d.orig.h + dy, hi));
      const s = snapAxis(raw, horzCands, alt);
      h = s.val - y;
      gh = s.guide;
      edgeH = s.val;
    }
    if (hasN) {
      let lo = 0;
      if (pure) {
        const cap = fMin((f) => f.y0 + MIN_H, 'max');
        if (cap !== null) lo = Math.max(lo, cap);
      }
      const raw = Math.min(d.orig.y + d.orig.h - MIN_H, Math.max(d.orig.y + dy, lo));
      const s = snapAxis(raw, horzCands, alt);
      h = d.orig.y + d.orig.h - s.val;
      y = s.val;
      gh = s.guide;
      edgeH = s.val;
    }
    setGuides({ v: gv, h: gh });

    setWins((ws) =>
      ws.map((w0) => {
        if (w0.id === d.id) return { ...w0, x, y, w, h };
        if (!pure) return w0;
        const f = d.followers.find((t) => t.id === w0.id);
        if (!f) return w0;
        // 스플리터 승격: 내 변을 따라 이웃의 맞닿은 변도 이동
        if (d.mode === 'e') {
          const nw = f.x0 + f.w0 - edgeV;
          return nw >= MIN_W ? { ...w0, x: edgeV, w: nw } : w0;
        }
        if (d.mode === 'w') {
          const nw = edgeV - f.x0;
          return nw >= MIN_W ? { ...w0, w: nw } : w0;
        }
        if (d.mode === 's') {
          const nh = f.y0 + f.h0 - edgeH;
          return nh >= MIN_H ? { ...w0, y: edgeH, h: nh } : w0;
        }
        // 'n'
        const nh = edgeH - f.y0;
        return nh >= MIN_H ? { ...w0, h: nh } : w0;
      }),
    );
  };

  const onUp = () => {
    const d = dragRef.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (d && box && d.mode === 'move' && zone) {
      const half = Math.round(box.width / 2);
      setWins((ws) =>
        ws.map((w0) =>
          w0.id === d.id
            ? { ...w0, x: zone === 'left' ? 0 : half, y: 0, w: half, h: Math.round(box.height) }
            : w0,
        ),
      );
    }
    dragRef.current = null;
    setGuides({ v: null, h: null });
    setZone(null);
  };

  // Tidy 일반화: 차트 창은 좌측 영역 그리드(열 최대 3), 데이터 창은 우측 열 스택
  const tidy = () => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const W = Math.round(box.width);
    const H = Math.round(box.height);
    const charts = wins.filter((w0) => w0.kind === 'chart');
    const datas = wins.filter((w0) => w0.kind !== 'chart');
    const chartW = datas.length ? Math.round(W * 0.72) : W;
    const dataW = W - chartW;
    const cols = Math.min(3, Math.max(1, charts.length));
    const rows = Math.max(1, Math.ceil(charts.length / cols));
    const cw = Math.round(chartW / cols);
    const ch = Math.round(H / rows);
    const dh = datas.length ? Math.round(H / datas.length) : H;
    const pos = new Map<string, Partial<Win>>();
    charts.forEach((w0, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      pos.set(w0.id, { x: c * cw, y: r * ch, w: cw, h: ch });
    });
    datas.forEach((w0, i) => {
      pos.set(w0.id, { x: chartW, y: i * dh, w: dataW, h: dh });
    });
    setWins((ws) => ws.map((w0) => ({ ...w0, ...pos.get(w0.id) })));
  };

  const addWin = (kind: WinKind) => {
    const n = ++idRef.current;
    const id = `n${n}`;
    const off = 30 + ((n * 24) % 180);
    const size = kind === 'chart' ? { w: 480, h: 320 } : kind === 'book' ? { w: 200, h: 400 } : { w: 230, h: 190 };
    // 새 창 = 활성 그룹 상속 (#711)
    setWins((ws) => [...ws, { id, kind, group: activeGroup, x: off, y: off, ...size }]);
    setOrder((o) => [...o, id]);
  };

  const closeWin = (id: string) => {
    setWins((ws) => ws.filter((w0) => w0.id !== id));
    setOrder((o) => o.filter((i) => i !== id));
  };

  const stress = () => {
    setWins((ws) => {
      const have = new Set(ws.map((w0) => w0.id));
      const add = STRESS_WINS.filter((s) => !have.has(s.id)).map((s, i) => ({
        ...s,
        x: 40 + ((i * 56) % 480),
        y: 30 + ((i * 44) % 320),
      }));
      setOrder((o) => [...o, ...add.map((a) => a.id)]);
      return [...ws, ...add];
    });
  };

  return (
    <div ref={boxRef} className="relative h-full min-h-0 overflow-hidden" onPointerMove={onMove} onPointerUp={onUp}>
      {/* 스냅존 미리보기 */}
      {zone && (
        <div
          className="pointer-events-none absolute inset-y-0 z-40 border border-accent bg-tint-selection"
          style={zone === 'left' ? { left: 0, width: '50%' } : { right: 0, width: '50%' }}
        />
      )}
      {/* 자석 가이드라인 */}
      {guides.v !== null && (
        <div className="pointer-events-none absolute inset-y-0 z-40 w-px bg-accent" style={{ left: guides.v }} />
      )}
      {guides.h !== null && (
        <div className="pointer-events-none absolute inset-x-0 z-40 h-px bg-accent" style={{ top: guides.h }} />
      )}
      {/* 툴바 */}
      <div className="absolute right-2 top-2 z-50 flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11px] text-fg-dim shadow-overlay">
        <span className="font-mono">{wins.length}창</span>
        <span>· 활성 그룹</span>
        <span className="font-mono text-accent">{activeGroup}</span>
        <span className="mx-1 h-[12px] w-px bg-border-strong" />
        <button className="rounded bg-bg-input px-1.5 py-0.5 hover:text-fg" onClick={() => addWin('chart')}>
          +차트
        </button>
        <button className="rounded bg-bg-input px-1.5 py-0.5 hover:text-fg" onClick={() => addWin('book')}>
          +호가
        </button>
        <button className="rounded bg-bg-input px-1.5 py-0.5 hover:text-fg" onClick={() => addWin('broker')}>
          +거래원
        </button>
        <button className="rounded bg-bg-input px-1.5 py-0.5 hover:text-fg" onClick={stress}>
          12창 스트레스
        </button>
        <button className="rounded bg-tint-selection px-2 py-0.5 font-medium text-accent hover:brightness-110" onClick={tidy}>
          정리
        </button>
      </div>
      {wins.map((w0) => {
        const z = order.indexOf(w0.id);
        const focused = w0.id === focusedId;
        const spec = specForGroup(w0.group);
        return (
          <div
            key={w0.id}
            data-win={w0.id}
            className={`absolute flex flex-col rounded-lg bg-bg-card ${focused ? 'shadow-modal' : 'shadow-panel'}`}
            style={{ left: w0.x, top: w0.y, width: w0.w, height: w0.h, zIndex: z }}
            onPointerDown={() => {
              front(w0.id);
              setPalette((p) => (p === w0.id ? p : null));
            }}
          >
            <div
              data-handle="move"
              className="flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 rounded-t-lg border-b border-border px-1.5 active:cursor-grabbing"
              onPointerDown={(e) => beginDrag(e, w0.id, 'move')}
            >
              <span className="select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
              <LinkBadge n={w0.group} onClick={() => setPalette((p) => (p === w0.id ? null : w0.id))} />
              <span className="truncate text-[12px] font-medium text-fg">
                {w0.kind === 'chart' ? spec.name : `${KIND_LABEL[w0.kind]} · ${spec.name}`}
              </span>
              <span className="font-mono text-[10px] text-fg-dimmer">{spec.code}</span>
              {w0.kind === 'chart' && (
                <span className="ml-auto font-mono text-[11px] text-fg-dim [font-variant-numeric:tabular-nums]">
                  {fmt(spec.base)}
                </span>
              )}
              <button
                className={`${w0.kind === 'chart' ? '' : 'ml-auto '}px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => closeWin(w0.id)}
              >
                ×
              </button>
            </div>
            {/* 링크 그룹 팔레트 (#711: 뱃지 클릭 → 1~10) */}
            {palette === w0.id && (
              <div
                className="absolute left-5 top-[26px] z-50 grid grid-cols-5 gap-0.5 rounded-md border border-border bg-bg-subtle p-1 shadow-overlay"
                onPointerDown={(e) => e.stopPropagation()}
              >
                {GROUP_SPECS.map((g) => (
                  <button
                    key={g.link}
                    title={g.name}
                    className={`h-[20px] w-[20px] rounded-sm font-mono text-[10px] font-semibold ${
                      g.link === w0.group
                        ? 'bg-accent text-accent-fg'
                        : 'bg-bg-input text-fg-dim hover:bg-tint-selection hover:text-accent'
                    }`}
                    onClick={() => {
                      setWins((ws) => ws.map((t) => (t.id === w0.id ? { ...t, group: g.link } : t)));
                      setPalette(null);
                    }}
                  >
                    {g.link}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg">
              {w0.kind === 'chart' && <MiniChart spec={spec} />}
              {w0.kind === 'book' && <OrderbookVertical book={makeBook(spec, spec.base)} dense={w0.h < 480} />}
              {w0.kind === 'broker' && <BrokerPanel spec={spec} />}
            </div>
            {HANDLES.map((hd) => (
              <div key={hd.mode} data-handle={hd.mode} className={hd.cls} onPointerDown={(e) => beginDrag(e, w0.id, hd.mode)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── 스위처 + 페이지 ─────────────────────────────────────────────────────────

const VARIANTS = [
  { key: 'A', label: '균등 3열 · 호가 우측', el: <VariantA /> },
  { key: 'B', label: '主副 포커스 · 1大 2小', el: <VariantB /> },
  { key: 'C', label: '2×2 그리드 · 호가 하단 · 빈 슬롯', el: <VariantC /> },
  { key: 'D', label: '스마트 자석 플로팅 · 풀 인터랙션', el: <VariantD /> },
];

function PrototypeSwitcher({ current, go }: { current: number; go: (d: number) => void }) {
  if (import.meta.env.PROD) return null;
  const v = VARIANTS[current];
  return (
    <div className="fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-strong bg-bg-subtle px-3 py-1.5 shadow-overlay">
      <button className="px-1 font-mono text-fg-dim hover:text-fg" onClick={() => go(-1)}>
        ‹
      </button>
      <span className="whitespace-nowrap font-mono text-[11px] text-fg">
        {v.key} — {v.label}
      </span>
      <button className="px-1 font-mono text-fg-dim hover:text-fg" onClick={() => go(1)}>
        ›
      </button>
    </div>
  );
}

export function PrototypeWorkspacePage() {
  const [params, setParams] = useSearchParams();
  const idx = Math.max(
    0,
    VARIANTS.findIndex((v) => v.key === (params.get('variant') ?? 'A')),
  );
  const go = (d: number) => {
    const next = VARIANTS[(idx + d + VARIANTS.length) % VARIANTS.length];
    setParams({ variant: next.key }, { replace: true });
  };
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
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
  return (
    <div className="h-full min-h-0 bg-bg p-1">
      {ready && VARIANTS[idx].el}
      <PrototypeSwitcher current={idx} go={go} />
    </div>
  );
}
