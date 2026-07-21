/**
 * DrawingMenu — 그리기 도구 진입로 (지도 #758 / 티켓 #760·#761).
 *
 * 차트 왼쪽 44px 상시 레일(`LiveDrawingRail`)을 대체한다. 레일은 안 쓸 때도
 * 폭을 점유했고, 그 44px 은 차트가 늘 손해보는 고정비였다. 트리거 버튼 하나로
 * 접고 메뉴로 펼치면 평시 폭이 차트로 돌아온다.
 *
 * **트리거 = 상태 표시기 겸용**(#760 결정 4). 레일이 있을 땐 눌린 도구 버튼이
 * 활성 표시였는데, 레일을 없애면 그 표시가 사라진다 — 연필을 골라둔 걸 잊고
 * 차트를 클릭하면 의도 없는 선이 그려지고, Alt 단축키는 메뉴를 안 거치고도
 * 도구를 켜므로(`DrawingOverlay` 의 window keydown) "보이지 않는 모드" 가 된다.
 * 그래서 도구가 켜져 있으면 트리거가 그 도구의 글리프·이름으로 변신하고
 * 봉 버튼과 같은 활성 문법(tint-selection + accent)을 입는다.
 *
 * 해제 경로 3개: 메뉴 첫 항목 '선택' · Escape(`DrawingOverlay` 가 이미 처리) ·
 * 트리거 재클릭 후 '선택'. 도구는 한 번 고르면 바꿀 때까지 유지(sticky)한다.
 *
 * `code`/`timeframe` 은 조작할 드로잉 scope 를 정한다 — 레일과 같은 props 계약.
 * 셸을 마운트하는 쪽(/live 차트 창 · /study)이 이미 둘 다 들고 있고, 훅으로
 * 전역 활성 종목을 읽으면 /study 처럼 Provider 밖인 화면에서 엉뚱한 대상에
 * 걸린다(레일이 props 화된 것과 같은 이유).
 */
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import type { DrawingTool } from '../chart/drawing/types';
import { drawingScopeFor, useDrawingsStore } from '../state/drawings';
import type { LiveTimeframe } from '../state/livePage';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { COMPACT_PADDING_INLINE } from './workspace/chartHeaderCompact';

/** 메뉴 표시 순서 — '선택'(해제)이 먼저, 그 뒤로 실제 그리기 도구들. */
const MENU_TOOLS: readonly DrawingTool[] = ['select', ...DRAWABLE_TOOLS_ORDER];

type Props = {
  code: string | null;
  timeframe: LiveTimeframe;
  /** false 면 아이콘만 — 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
};

function itemClass(active: boolean): string {
  return [
    'flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] transition-colors',
    active
      ? 'bg-tint-selection text-accent'
      : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg',
  ].join(' ');
}

export function DrawingMenu({ code, timeframe, showLabel = true }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const scope = drawingScopeFor(code, timeframe);
  const activeTool = useDrawingsStore((state) => state.activeTool);
  const setActiveTool = useDrawingsStore((state) => state.setActiveTool);
  const magnet = useDrawingsStore((state) => state.defaults.magnet);
  const setDefaults = useDrawingsStore((state) => state.setDefaults);
  const clearAll = useDrawingsStore((state) => state.clearAll);

  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const drawing = activeTool !== 'select';
  const activeSpec = TOOLS[activeTool];

  const pickTool = (tool: DrawingTool) => {
    setActiveTool(tool);
    setOpen(false);
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="그리기 도구"
      data-testid="drawing-menu"
      onMouseDown={(event) => event.stopPropagation()}
      className="z-50 w-[184px] rounded-lg border border-border bg-bg-card py-1 shadow-overlay"
      style={{ position: 'fixed', left, top }}
    >
      {MENU_TOOLS.map((tool) => {
        const spec = TOOLS[tool];
        const active = activeTool === tool;
        return (
          <button
            key={tool}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => pickTool(tool)}
            className={itemClass(active)}
          >
            <span aria-hidden="true" className="w-4 text-center font-mono">{spec.glyph}</span>
            <span>{spec.label}</span>
            {spec.shortcut && (
              <span className="ml-auto font-mono text-[10px] text-fg-dimmer">
                ⌥{spec.shortcut.key.toUpperCase()}
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
        className={itemClass(false)}
        title="캔들에 스냅 (Ctrl로 일시 해제)"
      >
        <span aria-hidden="true" className="w-4 text-center">🧲</span>
        <span>자석</span>
        <span
          aria-hidden="true"
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
      {/* 파괴적이지만 확인 단계를 두지 않는다(#761) — `clearAll` 은 실행취소
          토스트와 Ctrl+Z 를 이미 갖고 있어 되돌리기가 한 동작이다. */}
      <button
        type="button"
        role="menuitem"
        data-testid="drawing-menu-clear"
        disabled={scope == null}
        onClick={() => {
          if (scope != null) clearAll(scope);
          setOpen(false);
        }}
        className={`${itemClass(false)} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span aria-hidden="true" className="w-4 text-center">✕</span>
        <span>모두 지우기</span>
      </button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid="drawing-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={drawing ? `그리기: ${activeSpec.label}` : '그리기'}
        title={drawing ? `그리기: ${activeSpec.label} — Esc로 해제` : '그리기'}
        onClick={() => {
          setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null);
          setOpen((prev) => !prev);
        }}
        className="inline-flex min-h-6 items-center gap-1 rounded-[7px] px-2 py-1 text-xs transition-colors hover:bg-bg-input-hover hover:text-fg"
        style={{
          // 테두리 없는 ghost — 비활성은 투명, 활성 도구가 있을 때만 강조
          // (봉 컨트롤과 같은 문법, 2026-07-15 결정).
          background: drawing ? 'var(--tint-selection)' : 'transparent',
          color: drawing ? 'var(--accent)' : 'var(--fg-dim)',
          // 아이콘만 남을 때 좌우 여백은 순수 낭비다 — 좁혀야 완전 접힘이
          // MIN_W(160px)에 들어간다(#762 후속 실측). 인라인이라 클래스 px-2 를 이긴다.
          paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE,
        }}
      >
        <span aria-hidden="true" className="font-mono">{drawing ? activeSpec.glyph : '✎'}</span>
        {showLabel && <span>{drawing ? activeSpec.label : '그리기'}</span>}
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export default DrawingMenu;
