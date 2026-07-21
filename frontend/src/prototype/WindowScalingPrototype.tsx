/**
 * PROTOTYPE — THROWAWAY. main 에 머지하지 말 것.
 *
 * 질문: 줌인으로 캔버스가 줄 때 /live 창들을 어떤 좌표 모델로 다뤄야 하는가?
 * (사용자 제안: "배치는 유지하되 비율만 반응형")
 *
 * 계획: dev 전용 라우트 /prototype/window-scaling 에서 ?variant= 로 전환되는 4개
 * 좌표 모델. 캔버스 크기를 슬라이더/줌 프리셋으로 직접 줄여가며 비교한다.
 * 창 내용은 결정적 더미이고, 판정에 필요한 수치(캔버스 px, 창별 px, 캔버스 밖
 * 개수, 가독 하한 미달 개수)를 항상 화면에 띄운다.
 *
 *   A — 절대 px (현재 프로덕션): 캔버스가 줄어도 창은 그대로 → 밖으로 나가 사라짐
 *   B — 완전 비례: rect 를 캔버스 비율로 저장 → 절대 안 사라지지만 하한이 없어 뭉개짐
 *   C — 비례 + 바닥 (권장): 바닥까지는 비례, 그 아래는 캔버스 동결 + 스크롤
 *   D — 비례 + 최소크기 보장: 가독 하한에서 크기를 멈추고 위치를 밀어넣음 → 겹침 허용
 *
 * 판정 포인트: "사라지지 않는다"만으로는 부족하다 — B 에서 10호가 가격열이 언제
 * 읽을 수 없게 되는지, C 의 스크롤과 D 의 겹침 중 무엇이 덜 나쁜지를 본다.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';

// ───────────────────────── 기준 배치 (실측 기본 워크스페이스의 비율) ─────────────────────────

type Frac = { x: number; y: number; w: number; h: number };
type Kind = 'chart' | 'book' | 'broker';

const REF = { w: 1546, h: 700 }; // 1600×900 뷰포트에서 실측한 캔버스 크기

const LAYOUT: { id: string; kind: Kind; title: string; frac: Frac; min: { w: number; h: number } }[] = [
  // min = 가독 하한 실측 근거: 차트는 봉 몸통이 뭉개지지 않는 폭, 10호가는 가격 7자리
  // + 잔량 바가 한 줄에 들어가는 폭, 거래원은 이름+값 2열.
  { id: 'chart', kind: 'chart', title: '차트 · 그룹 1', frac: { x: 0.01, y: 0.02, w: 0.47, h: 0.96 }, min: { w: 380, h: 260 } },
  { id: 'book', kind: 'book', title: '10호가 · 그룹 1', frac: { x: 0.49, y: 0.02, w: 0.44, h: 0.6 }, min: { w: 260, h: 240 } },
  { id: 'broker', kind: 'broker', title: '거래원 · 그룹 1', frac: { x: 0.49, y: 0.64, w: 0.44, h: 0.34 }, min: { w: 240, h: 120 } },
];

/** 셸 바닥(1026px) − 레일(54px). 세로 바닥은 가로와 대칭으로 잡은 제안값. */
const FLOOR = { w: 972, h: 560 };

const ZOOM_PRESETS = [100, 110, 125, 150, 175];

// ───────────────────────── 창 내용 (좁아지면 실제로 읽기 어려워져야 한다) ─────────────────────────

const CANDLES = Array.from({ length: 48 }, (_, i) => {
  const seed = Math.sin(i * 12.9898) * 43758.5453;
  const r = seed - Math.floor(seed);
  const base = 71000 + Math.round(Math.sin(i / 5) * 1800);
  const o = base;
  const c = base + Math.round((r - 0.5) * 700);
  return { o, c, h: Math.max(o, c) + Math.round(r * 260), l: Math.min(o, c) - Math.round(r * 260) };
});

const BOOK = Array.from({ length: 10 }, (_, i) => ({
  price: 73600 - i * 100,
  qty: [48210, 30155, 22894, 61023, 18740, 25510, 90112, 14208, 33871, 27455][i],
  ask: i < 5,
}));
const MAX_QTY = Math.max(...BOOK.map((r) => r.qty));

const BROKERS = [
  { name: '미래에셋', net: 182430 },
  { name: 'JP모간', net: 95112 },
  { name: '키움증권', net: -41230 },
  { name: 'NH투자', net: -87455 },
];

function ChartBody() {
  const min = Math.min(...CANDLES.map((c) => c.l));
  const max = Math.max(...CANDLES.map((c) => c.h));
  const H = 200;
  const y = (p: number) => ((max - p) / (max - min)) * (H - 16) + 8;
  const w = 480 / CANDLES.length;
  return (
    <svg viewBox={`0 0 480 ${H}`} preserveAspectRatio="none" className="h-full w-full">
      {CANDLES.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? 'var(--price-up)' : 'var(--price-down)';
        const x = i * w + w / 2;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" />
            <rect
              x={i * w + w * 0.2}
              width={w * 0.6}
              y={y(Math.max(c.o, c.c))}
              height={Math.max(1, Math.abs(y(c.o) - y(c.c)))}
              fill={color}
            />
          </g>
        );
      })}
    </svg>
  );
}

function BookBody() {
  return (
    <div className="font-data text-sm tabular-nums">
      {BOOK.map((r) => (
        <div key={r.price} className="grid grid-cols-[1fr_auto] items-center gap-1.5 whitespace-nowrap px-1.5 leading-6">
          <div className="relative h-3.5 min-w-0">
            <div
              className="absolute inset-y-0 right-0 rounded-sm"
              style={{
                width: `${(r.qty / MAX_QTY) * 100}%`,
                background: `color-mix(in srgb, var(${r.ask ? '--price-down' : '--price-up'}) 26%, transparent)`,
              }}
            />
            <span className="absolute inset-y-0 right-1 leading-[14px] text-fg-dim">{r.qty.toLocaleString('ko-KR')}</span>
          </div>
          <span className={r.ask ? 'text-price-down' : 'text-price-up'}>{r.price.toLocaleString('ko-KR')}</span>
        </div>
      ))}
    </div>
  );
}

function BrokerBody() {
  return (
    <div className="font-data text-sm tabular-nums">
      {BROKERS.map((b) => (
        <div key={b.name} className="grid grid-cols-[1fr_auto] gap-2 whitespace-nowrap px-1.5 leading-6">
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

function WindowFrame({
  title,
  kind,
  rect,
  illegible,
  offCanvas,
}: {
  title: string;
  kind: Kind;
  rect: { x: number; y: number; w: number; h: number };
  illegible: boolean;
  offCanvas: boolean;
}) {
  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-lg bg-bg-card shadow-panel"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        // 판정 보조: 가독 하한 미달은 경고 테두리, 캔버스 밖은 에러 테두리.
        outline: offCanvas
          ? '1px solid var(--error)'
          : illegible
            ? '1px solid var(--warn)'
            : '1px solid transparent',
        outlineOffset: '-1px',
        transition: 'left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out',
      }}
    >
      <header className="flex h-[22px] shrink-0 items-center gap-1 border-b border-border px-1.5 text-[10.5px] font-semibold uppercase text-fg-dimmer">
        <span className="truncate">{title}</span>
        <span className="ml-auto shrink-0 font-data text-[9px] normal-case text-fg-dimmer">
          {Math.round(rect.w)}×{Math.round(rect.h)}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {kind === 'chart' ? <ChartBody /> : kind === 'book' ? <BookBody /> : <BrokerBody />}
      </div>
    </div>
  );
}

// ───────────────────────── 좌표 모델 4종 ─────────────────────────

type Placed = { id: string; kind: Kind; title: string; rect: { x: number; y: number; w: number; h: number }; illegible: boolean; offCanvas: boolean };

function place(variant: string, canvas: { w: number; h: number }): { placed: Placed[]; surface: { w: number; h: number }; scrolls: boolean } {
  // C 는 바닥 아래에서 캔버스를 동결한다 — 그 아래로는 창이 아니라 스크롤이 움직인다.
  const surface =
    variant === 'C' ? { w: Math.max(canvas.w, FLOOR.w), h: Math.max(canvas.h, FLOOR.h) } : canvas;

  const placed = LAYOUT.map((win) => {
    let rect: { x: number; y: number; w: number; h: number };

    if (variant === 'A') {
      // 절대 px — 기준 캔버스에서 굳은 값. 캔버스가 줄어도 그대로.
      rect = {
        x: win.frac.x * REF.w,
        y: win.frac.y * REF.h,
        w: win.frac.w * REF.w,
        h: win.frac.h * REF.h,
      };
    } else if (variant === 'D') {
      // 비례하되 가독 하한에서 멈추고, 밖으로 나가면 안쪽으로 밀어넣는다(겹침 허용).
      const w = Math.max(win.min.w, win.frac.w * surface.w);
      const h = Math.max(win.min.h, win.frac.h * surface.h);
      rect = {
        x: Math.max(0, Math.min(win.frac.x * surface.w, surface.w - w)),
        y: Math.max(0, Math.min(win.frac.y * surface.h, surface.h - h)),
        w,
        h,
      };
    } else {
      // B·C — 순수 비례. 차이는 surface(바닥 적용 여부)뿐.
      rect = {
        x: win.frac.x * surface.w,
        y: win.frac.y * surface.h,
        w: win.frac.w * surface.w,
        h: win.frac.h * surface.h,
      };
    }

    return {
      id: win.id,
      kind: win.kind,
      title: win.title,
      rect,
      illegible: rect.w < win.min.w || rect.h < win.min.h,
      offCanvas: rect.x + rect.w > canvas.w + 1 || rect.y + rect.h > canvas.h + 1,
    };
  });

  return { placed, surface, scrolls: surface.w > canvas.w || surface.h > canvas.h };
}

// ───────────────────────── 화면 ─────────────────────────

const VARIANTS = [
  { key: 'A', name: '절대 px (현재)' },
  { key: 'B', name: '완전 비례' },
  { key: 'C', name: '비례 + 바닥 (권장)' },
  { key: 'D', name: '비례 + 최소크기 보장' },
] as const;

const NOTES: Record<string, string> = {
  A: '창은 원래 크기를 지키지만 캔버스 밖으로 나가 도달 불가가 된다. 지금 프로덕션 동작.',
  B: '절대 안 사라진다. 대신 하한이 없어 좁히면 10호가 가격열부터 읽을 수 없게 된다.',
  C: '바닥까지 비례, 그 아래는 캔버스를 동결하고 스크롤로 넘긴다. 창은 항상 읽을 수 있다.',
  D: '가독 하한에서 크기를 멈추고 안쪽으로 밀어넣는다. 스크롤은 없지만 창이 서로 겹친다.',
};

export default function WindowScalingPrototype() {
  const [searchParams, setSearchParams] = useSearchParams();
  const key = searchParams.get('variant') ?? 'C';
  const current = VARIANTS.find((v) => v.key === key) ?? VARIANTS[2];

  const [zoom, setZoom] = useState(100);
  // 줌 z% = 유효 캔버스가 1/z 로 줄어드는 것과 같다(브라우저 줌 = CSS px 확대).
  const canvas = { w: Math.round(REF.w / (zoom / 100)), h: Math.round(REF.h / (zoom / 100)) };
  const { placed, surface, scrolls } = place(current.key, canvas);

  const offCount = placed.filter((p) => p.offCanvas).length;
  const illegibleCount = placed.filter((p) => p.illegible).length;

  const go = (dir: 1 | -1) => {
    const idx = VARIANTS.findIndex((v) => v.key === current.key);
    const next = VARIANTS[(idx + dir + VARIANTS.length) % VARIANTS.length];
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('variant', next.key);
      return p;
    }, { replace: true });
  };

  return (
    <div data-theme="obsidian" className="flex h-full min-h-0 flex-col bg-bg font-ui text-fg">
      {/* 컨트롤 — 줌 프리셋으로 유효 캔버스를 직접 줄인다(실제 Ctrl+ 줌도 같이 먹는다) */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase text-fg-dimmer">브라우저 줌</span>
        <div className="flex gap-1">
          {ZOOM_PRESETS.map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={`rounded-sm px-2 py-0.5 font-data text-xs ${
                zoom === z ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:text-fg'
              }`}
            >
              {z}%
            </button>
          ))}
        </div>
        <input
          type="range"
          min={100}
          max={200}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-40 accent-[var(--accent)]"
          aria-label="줌 배율"
        />
        <span className="font-data text-xs tabular-nums text-fg-dim">
          유효 캔버스 {canvas.w}×{canvas.h}
        </span>
        <span className="ml-auto font-data text-xs tabular-nums">
          <span className={offCount > 0 ? 'text-error' : 'text-fg-dimmer'}>화면 밖 {offCount}</span>
          {' · '}
          <span className={illegibleCount > 0 ? 'text-warn' : 'text-fg-dimmer'}>가독 미달 {illegibleCount}</span>
          {' · '}
          <span className={scrolls ? 'text-accent' : 'text-fg-dimmer'}>{scrolls ? '스크롤 발생' : '스크롤 없음'}</span>
        </span>
      </div>

      {/* 뷰포트(= 유효 캔버스). 이 박스가 사용자가 실제로 보는 영역이다. */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div
          className="relative shrink-0 overflow-auto rounded-md border border-dashed border-border-strong bg-bg-subtle"
          style={{ width: canvas.w, height: canvas.h }}
        >
          {/* surface = 창이 배치되는 좌표계. C 에서만 캔버스보다 커질 수 있다(=스크롤). */}
          <div className="relative" style={{ width: surface.w, height: surface.h }}>
            {placed.map((p) => (
              <WindowFrame key={p.id} title={p.title} kind={p.kind} rect={p.rect} illegible={p.illegible} offCanvas={p.offCanvas} />
            ))}
          </div>
        </div>
      </div>

      {/* 스위처 */}
      <div className="flex shrink-0 items-center gap-3 border-t border-accent bg-bg-subtle px-3 py-2">
        <button onClick={() => go(-1)} className="text-fg-dim hover:text-fg" aria-label="이전 변형">
          ←
        </button>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {current.key} — {current.name}
          </div>
          <div className="truncate text-xs text-fg-dim">{NOTES[current.key]}</div>
        </div>
        <button onClick={() => go(1)} className="ml-auto text-fg-dim hover:text-fg" aria-label="다음 변형">
          →
        </button>
      </div>
    </div>
  );
}
