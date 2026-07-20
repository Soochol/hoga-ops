/**
 * PROTOTYPE ONLY — main 머지 금지. 폐기 전제 코드 (wayfinder #762).
 *
 * "차트 창 헤더 3변형, `/live` 에서 `?variant=` 로 전환" — #759·#760·#761 로
 * 확정된 구성(봉 컨트롤 + ✏그리기 드롭다운 + +보조지표, 액션 2버튼)을 실제
 * 차트 옆에 붙여 활성 문법·메뉴 스타일·좁은 창 접힘을 눈으로 판정한다.
 *
 * 세 변형은 "헤더 행"이라는 전제 자체를 다르게 잡는다:
 *   A 참조이미지  — 전용 헤더 행, 좌 봉 / 우 액션
 *   B 초압축      — 봉을 단일 드롭다운으로 접고 액션은 아이콘만, 행 높이 최소
 *   C 무헤더      — 헤더 행 제거, 차트 위 플로팅 알약
 *
 * 메뉴·활성 문법은 세 변형이 공유한다(그게 판정 대상이라 변수로 두면 안 됨).
 */
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../../chart/drawing/tools';
import type { DrawingTool } from '../../chart/drawing/types';
import { useDrawingsStore, drawingScopeFor } from '../../state/drawings';
import {
  CALENDAR_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type LiveTimeframe,
  type MinuteTimeframe,
} from '../../state/livePage';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';
import { TimeframeControl } from '../TimeframeControl';

export const HEADER_VARIANTS = ['A', 'B', 'C'] as const;
export const HEADER_VARIANT_LABELS: Record<string, string> = {
  A: '참조이미지 (전용 행)',
  B: '초압축 (아이콘만)',
  C: '무헤더 (플로팅)',
};

/* ── 보조지표 열기 요청 채널 ────────────────────────────────────────────
   #759 확정 계약(셸 소유 + windowId 실어보내기)의 프로토타입 구현.
   workspaceCanvasControls 와 같은 모듈 레지스트리 idiom. */
let indicatorOpener: ((windowId: string) => void) | null = null;
export function registerPrototypeIndicatorOpen(fn: (windowId: string) => void): () => void {
  indicatorOpener = fn;
  return () => {
    if (indicatorOpener === fn) indicatorOpener = null;
  };
}
function requestIndicatorOpen(windowId: string): void {
  indicatorOpener?.(windowId);
}

const CALENDAR_LABELS: Record<CalendarTimeframe, string> = { D: '일', W: '주', M: '월' };
const minuteLabel = (tf: MinuteTimeframe) => `${tf.slice(0, -1)}분`;
const tfLabel = (tf: LiveTimeframe) =>
  isMinuteTimeframe(tf) ? minuteLabel(tf) : CALENDAR_LABELS[tf as CalendarTimeframe];

/* ── 그리기 드롭다운 (세 변형 공유) ───────────────────────────────────── */

type MenuProps = {
  code: string | null;
  timeframe: LiveTimeframe;
  /** 트리거 모양만 변형별로 다르다 — 'full' 라벨+글리프 · 'icon' 글리프만 */
  trigger: 'full' | 'icon';
};

function DrawingMenu({ code, timeframe, trigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const scope = drawingScopeFor(code, timeframe);
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const setActiveTool = useDrawingsStore((s) => s.setActiveTool);
  const magnet = useDrawingsStore((s) => s.defaults.magnet);
  const setDefaults = useDrawingsStore((s) => s.setDefaults);
  const clearAll = useDrawingsStore((s) => s.clearAll);

  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: posRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchor?.left ?? 0,
    anchor ? anchor.bottom + 4 : 0,
  );

  // 활성 문법(#760 결정 4): 도구가 켜져 있으면 트리거가 상태 표시기로 변신.
  const drawing = activeTool !== 'select';
  const spec = TOOLS[activeTool];

  const pick = (tool: DrawingTool) => {
    setActiveTool(tool);
    setOpen(false);
  };

  const menu = open && anchor ? (
    <div
      ref={posRef}
      role="menu"
      aria-label="그리기 도구"
      data-testid="proto-drawing-menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="z-50 w-[184px] rounded-lg border border-border bg-bg-card py-1 shadow-overlay"
      style={{ position: 'fixed', left, top }}
    >
      {(['select', ...DRAWABLE_TOOLS_ORDER] as DrawingTool[]).map((tool) => {
        const t = TOOLS[tool];
        const on = activeTool === tool;
        return (
          <button
            key={tool}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            onClick={() => pick(tool)}
            className={`flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] transition-colors ${
              on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            <span aria-hidden="true" className="w-4 text-center font-mono text-[13px]">{t.glyph}</span>
            <span>{t.label}</span>
            {t.shortcut && (
              <span className="ml-auto font-mono text-[10px] text-fg-dimmer">
                ⌥{t.shortcut.key.toUpperCase()}
              </span>
            )}
          </button>
        );
      })}

      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={magnet}
        onClick={() => setDefaults({ magnet: !magnet })}
        className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
      >
        <span aria-hidden="true" className="w-4 text-center">🧲</span>
        <span>자석</span>
        {/* 참조 이미지 문법 — 우측 스위치 */}
        <span
          className={`ml-auto flex h-[15px] w-[26px] items-center rounded-full px-[2px] transition-colors ${
            magnet ? 'bg-accent' : 'bg-border-strong'
          }`}
        >
          <span
            className={`h-[11px] w-[11px] rounded-full bg-white transition-transform ${
              magnet ? 'translate-x-[11px]' : ''
            }`}
          />
        </span>
      </button>

      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          if (scope != null) clearAll(scope);
          setOpen(false);
        }}
        className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
      >
        <span aria-hidden="true" className="w-4 text-center">✕</span>
        <span>모두 지우기</span>
      </button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        data-testid="proto-drawing-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={drawing ? `그리기: ${spec.label} (Esc 해제)` : '그리기'}
        onClick={() => {
          setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
          setOpen((o) => !o);
        }}
        className="inline-flex min-h-6 items-center gap-1 rounded-[7px] px-2 py-1 text-xs transition-colors hover:bg-bg-input-hover hover:text-fg"
        style={{
          background: drawing ? 'var(--tint-selection)' : 'transparent',
          color: drawing ? 'var(--accent)' : 'var(--fg-dim)',
        }}
      >
        <span aria-hidden="true" className="font-mono">{drawing ? spec.glyph : '✏'}</span>
        {trigger === 'full' && <span>{drawing ? spec.label : '그리기'}</span>}
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

/* ── 보조지표 버튼 (세 변형 공유) ─────────────────────────────────────── */

function IndicatorButton({ windowId, trigger }: { windowId: string; trigger: 'full' | 'icon' }) {
  return (
    <button
      type="button"
      data-testid="proto-indicator-button"
      title="보조지표"
      onClick={() => requestIndicatorOpen(windowId)}
      className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-[7px] px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
    >
      <span aria-hidden="true" className="font-mono">＋</span>
      {trigger === 'full' && <span>보조지표</span>}
    </button>
  );
}

/* ── 변형 B 전용: 봉 통합 드롭다운 ────────────────────────────────────── */

function CompactTimeframe({
  timeframe,
  onChange,
}: {
  timeframe: LiveTimeframe;
  onChange: (tf: LiveTimeframe) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: posRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchor?.left ?? 0,
    anchor ? anchor.bottom + 4 : 0,
  );

  const all: LiveTimeframe[] = [...MINUTE_TIMEFRAMES, ...CALENDAR_TIMEFRAMES];
  const menu = open && anchor ? (
    <div
      ref={posRef}
      role="menu"
      className="z-50 w-[92px] rounded-lg border border-border bg-bg-card py-1 shadow-overlay"
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left, top }}
    >
      {all.map((tf) => {
        const on = tf === timeframe;
        return (
          <button
            key={tf}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            onClick={() => { onChange(tf); setOpen(false); }}
            className={`w-full px-3 py-1.5 text-left font-mono text-xs ${
              on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            {tfLabel(tf)}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
          setOpen((o) => !o);
        }}
        className="inline-flex min-h-5 items-center gap-1 rounded-[6px] px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-bg-input-hover"
        style={{ background: 'var(--tint-selection)', color: 'var(--accent)' }}
      >
        <span>{tfLabel(timeframe)}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

/* ── 변형들 ──────────────────────────────────────────────────────────── */

export type HeaderProps = {
  windowId: string;
  code: string | null;
  timeframe: LiveTimeframe;
  rememberedMinute: MinuteTimeframe;
  onTimeframeChange: (tf: LiveTimeframe) => void;
};

/** A — 참조 이미지: 전용 헤더 행, 좌 봉 / 우 액션. */
function VariantA(p: HeaderProps) {
  return (
    <div
      data-testid="proto-header-A"
      className="flex shrink-0 items-center gap-1 overflow-hidden border-b border-border bg-bg-card/60 px-1 py-0.5"
    >
      <TimeframeControl
        timeframe={p.timeframe}
        rememberedMinute={p.rememberedMinute}
        onChange={p.onTimeframeChange}
      />
      <div className="ml-auto flex items-center gap-0.5">
        <DrawingMenu code={p.code} timeframe={p.timeframe} trigger="full" />
        <IndicatorButton windowId={p.windowId} trigger="full" />
      </div>
    </div>
  );
}

/** B — 초압축: 봉 단일 드롭다운 + 아이콘 액션, 행 높이 최소. */
function VariantB(p: HeaderProps) {
  return (
    <div
      data-testid="proto-header-B"
      className="flex h-[22px] shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-bg-card/60 px-1"
    >
      <CompactTimeframe timeframe={p.timeframe} onChange={p.onTimeframeChange} />
      <div className="ml-auto flex items-center gap-0.5">
        <DrawingMenu code={p.code} timeframe={p.timeframe} trigger="icon" />
        <IndicatorButton windowId={p.windowId} trigger="icon" />
      </div>
    </div>
  );
}

/** C — 무헤더: 헤더 행 없음. 컨트롤이 차트 위에 플로팅(호버 시 또렷해짐). */
function VariantC(p: HeaderProps) {
  return (
    <div
      data-testid="proto-header-C"
      className="pointer-events-none absolute left-1.5 top-1.5 z-20 flex items-center gap-1 rounded-lg border border-border/60 bg-bg-card/70 px-1 py-0.5 opacity-70 shadow-subtle backdrop-blur transition-opacity hover:opacity-100"
      style={{ pointerEvents: 'auto' }}
    >
      <TimeframeControl
        timeframe={p.timeframe}
        rememberedMinute={p.rememberedMinute}
        onChange={p.onTimeframeChange}
      />
      <span className="mx-0.5 h-[14px] w-px bg-border-strong" />
      <DrawingMenu code={p.code} timeframe={p.timeframe} trigger="icon" />
      <IndicatorButton windowId={p.windowId} trigger="icon" />
    </div>
  );
}

export function PrototypeChartWindowHeader({ variant, ...p }: HeaderProps & { variant: string }) {
  if (variant === 'B') return <VariantB {...p} />;
  if (variant === 'C') return <VariantC {...p} />;
  return <VariantA {...p} />;
}

/** C는 헤더 행을 차지하지 않는다 — 차트 영역이 relative 여야 플로팅이 앉는다. */
export const variantIsFloating = (variant: string) => variant === 'C';
