/**
 * PROTOTYPE — throwaway. 지우기 전제의 코드. 프로덕션 아님.
 *
 * 질문: "차트+10호가 세트를 N개(여기선 3개) 놓은 워크스페이스는 어떤 모습이어야 하나"
 * (wayfinder 지도 #706 · 티켓 #707 레이아웃 패러다임 grilling 보조 자료)
 *
 * /prototype-workspace 라우트에서 ?variant=A|B|C 로 3개 변형 전환:
 *   A — 균등 3열 · 호가 우측 세로 레일 (토스식 컬럼 도킹)
 *   B — 主副 포커스 · 큰 세트 1 + 작은 세트 2 (위계형)
 *   C — 2×2 그리드 · 호가 하단 가로 스트립 · 빈 슬롯(+ 세트 추가)
 *
 * 데이터는 전부 시드 더미. 드래그/리사이즈는 비기능(모양 판단용).
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

// ── 세트 카드 공통 크롬 ─────────────────────────────────────────────────────

function LinkBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-sm bg-tint-selection font-mono text-[10px] font-semibold text-accent">
      {n}
    </span>
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

// ── Variant D — 스마트 자석 플로팅 (인터랙티브) ─────────────────────────────
//
// 영웅문식 자유 플로팅 + 현대화 6종 중 4종을 간이 구현:
//   · 드래그/리사이즈 자석(이웃 가장자리·정렬·화면 경계, 임계 12px) + accent 가이드
//   · Alt = 자석 해제
//   · 붙은 경계는 스플리터로 승격 — E/S 변 드래그 시 인접 창이 함께 조절
//   · 화면 좌/우 스냅존(반분할 미리보기) · 원클릭 Tidy 정렬 · 포커스 z-order

type WinKind = 'chart' | 'book' | 'broker';
type Win = {
  id: string;
  kind: WinKind;
  spec: SetSpec;
  x: number;
  y: number;
  w: number;
  h: number;
};

const SNAP = 12;
const MIN_W = 160;
const MIN_H = 120;

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

const WIN_TITLE: Record<WinKind, (s: SetSpec) => string> = {
  chart: (s) => s.name,
  book: () => '10호가',
  broker: () => '거래원',
};

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

type DragState = {
  mode: 'move' | 'e' | 's' | 'se';
  id: string;
  px: number;
  py: number;
  orig: Win;
  attachedE: { id: string; x0: number; w0: number }[];
  attachedS: { id: string; y0: number; h0: number }[];
};

function VariantD() {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [wins, setWins] = useState<Win[]>(() => [
    { id: 'c1', kind: 'chart', spec: SETS[0], x: 24, y: 16, w: 540, h: 350 },
    { id: 'c2', kind: 'chart', spec: SETS[1], x: 220, y: 140, w: 540, h: 350 },
    { id: 'b1', kind: 'book', spec: SETS[0], x: 800, y: 30, w: 200, h: 430 },
    { id: 'k1', kind: 'broker', spec: SETS[0], x: 850, y: 330, w: 240, h: 200 },
  ]);
  const [order, setOrder] = useState<string[]>(['c1', 'c2', 'b1', 'k1']);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const [zone, setZone] = useState<'left' | 'right' | null>(null);

  const front = (id: string) => setOrder((o) => [...o.filter((i) => i !== id), id]);

  const beginDrag = (e: React.PointerEvent, id: string, mode: DragState['mode']) => {
    const win = wins.find((w) => w.id === id);
    if (!win) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 합성(비신뢰) 이벤트는 활성 포인터가 없어 캡처가 실패할 수 있음 — 드래그는 컨테이너 onPointerMove로 지속
    }
    // 붙은 경계 탐지 — E/S 변 리사이즈를 스플리터로 승격
    const attachedE = wins
      .filter(
        (o) =>
          o.id !== id &&
          Math.abs(o.x - (win.x + win.w)) <= 2 &&
          o.y < win.y + win.h &&
          o.y + o.h > win.y,
      )
      .map((o) => ({ id: o.id, x0: o.x, w0: o.w }));
    const attachedS = wins
      .filter(
        (o) =>
          o.id !== id &&
          Math.abs(o.y - (win.y + win.h)) <= 2 &&
          o.x < win.x + win.w &&
          o.x + o.w > win.x,
      )
      .map((o) => ({ id: o.id, y0: o.y, h0: o.h }));
    dragRef.current = { mode, id, px: e.clientX, py: e.clientY, orig: { ...win }, attachedE, attachedS };
    front(id);
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
          { val: o.x + o.w, guide: o.x + o.w }, // 내 왼변 ↔ 상대 오른변 (인접)
          { val: o.x - w, guide: o.x }, // 내 오른변 ↔ 상대 왼변 (인접)
          { val: o.x, guide: o.x }, // 왼변 정렬
          { val: o.x + o.w - w, guide: o.x + o.w }, // 오른변 정렬
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
      // 화면 좌/우 스냅존 (반분할)
      const px = e.clientX - box.left;
      setZone(alt ? null : px < 28 ? 'left' : px > W - 28 ? 'right' : null);
      setWins((ws) => ws.map((w0) => (w0.id === d.id ? { ...w0, x: sx.val, y: sy.val } : w0)));
      return;
    }

    setWins((ws) => {
      let next = ws;
      const me = ws.find((w) => w.id === d.id);
      if (!me) return ws;
      if (d.mode === 'e' || d.mode === 'se') {
        const cands: Cand[] = [{ val: W, guide: W }];
        for (const o of others) {
          cands.push({ val: o.x, guide: o.x }, { val: o.x + o.w, guide: o.x + o.w });
        }
        const raw = Math.max(d.orig.x + MIN_W, Math.min(d.orig.x + d.orig.w + dx, W));
        const sr = snapAxis(raw, cands, alt);
        const newW = sr.val - d.orig.x;
        setGuides((g) => ({ ...g, v: sr.guide }));
        next = next.map((w0) => {
          if (w0.id === d.id) return { ...w0, w: newW };
          const a = d.attachedE.find((t) => t.id === w0.id);
          if (a && d.mode === 'e') {
            // 붙은 경계 = 스플리터: 이웃의 왼변을 함께 이동
            const nx = d.orig.x + newW;
            const nw = a.x0 + a.w0 - nx;
            if (nw >= MIN_W) return { ...w0, x: nx, w: nw };
          }
          return w0;
        });
      }
      if (d.mode === 's' || d.mode === 'se') {
        const cands: Cand[] = [{ val: H, guide: H }];
        for (const o of others) {
          cands.push({ val: o.y, guide: o.y }, { val: o.y + o.h, guide: o.y + o.h });
        }
        const raw = Math.max(d.orig.y + MIN_H, Math.min(d.orig.y + d.orig.h + dy, H));
        const sb = snapAxis(raw, cands, alt);
        const newH = sb.val - d.orig.y;
        setGuides((g) => ({ ...g, h: sb.guide }));
        next = next.map((w0) => {
          if (w0.id === d.id) return { ...w0, h: newH };
          const a = d.attachedS.find((t) => t.id === w0.id);
          if (a && d.mode === 's') {
            const ny = d.orig.y + newH;
            const nh = a.y0 + a.h0 - ny;
            if (nh >= MIN_H) return { ...w0, y: ny, h: nh };
          }
          return w0;
        });
      }
      return next;
    });
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

  const tidy = () => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const W = Math.round(box.width);
    const H = Math.round(box.height);
    const cw = Math.round(W * 0.36);
    const rw = W - cw * 2;
    setWins((ws) =>
      ws.map((w0) => {
        if (w0.id === 'c1') return { ...w0, x: 0, y: 0, w: cw, h: H };
        if (w0.id === 'c2') return { ...w0, x: cw, y: 0, w: cw, h: H };
        if (w0.id === 'b1') return { ...w0, x: cw * 2, y: 0, w: rw, h: Math.round(H * 0.62) };
        return { ...w0, x: cw * 2, y: Math.round(H * 0.62), w: rw, h: H - Math.round(H * 0.62) };
      }),
    );
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
      <div className="absolute right-2 top-2 z-50 flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11px] text-fg-dim shadow-overlay">
        <span>드래그·리사이즈=자석 · Alt=해제 · 붙은 경계=동시 조절 · 좌/우 벽=반분할</span>
        <button className="rounded bg-tint-selection px-2 py-0.5 font-medium text-accent hover:brightness-110" onClick={tidy}>
          정리
        </button>
      </div>
      {wins.map((w0) => {
        const z = order.indexOf(w0.id);
        const focused = z === order.length - 1;
        return (
          <div
            key={w0.id}
            data-win={w0.id}
            className={`absolute flex flex-col overflow-hidden rounded-lg bg-bg-card ${focused ? 'shadow-modal' : 'shadow-panel'}`}
            style={{ left: w0.x, top: w0.y, width: w0.w, height: w0.h, zIndex: z }}
            onPointerDown={() => front(w0.id)}
          >
            <div
              data-handle="move"
              className="flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 border-b border-border px-1.5 active:cursor-grabbing"
              onPointerDown={(e) => beginDrag(e, w0.id, 'move')}
            >
              <span className="select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
              <LinkBadge n={w0.spec.link} />
              <span className="truncate text-[12px] font-medium text-fg">{WIN_TITLE[w0.kind](w0.spec)}</span>
              <span className="font-mono text-[10px] text-fg-dimmer">{w0.spec.code}</span>
              <button className="ml-auto px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg">×</button>
            </div>
            <div className="min-h-0 flex-1">
              {w0.kind === 'chart' && <MiniChart spec={w0.spec} />}
              {w0.kind === 'book' && <OrderbookVertical book={makeBook(w0.spec, w0.spec.base)} />}
              {w0.kind === 'broker' && <BrokerPanel spec={w0.spec} />}
            </div>
            {/* 리사이즈 핸들: E / S / SE */}
            <div
              data-handle="e"
              className="absolute inset-y-0 right-0 w-[6px] cursor-ew-resize"
              onPointerDown={(e) => beginDrag(e, w0.id, 'e')}
            />
            <div
              data-handle="s"
              className="absolute inset-x-0 bottom-0 h-[6px] cursor-ns-resize"
              onPointerDown={(e) => beginDrag(e, w0.id, 's')}
            />
            <div
              data-handle="se"
              className="absolute bottom-0 right-0 h-[12px] w-[12px] cursor-nwse-resize"
              onPointerDown={(e) => beginDrag(e, w0.id, 'se')}
            />
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
  { key: 'D', label: '스마트 자석 플로팅 · 드래그 가능', el: <VariantD /> },
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
