/**
 * WindowFrame — 워크스페이스 창 하나의 크롬 (ADR-0119).
 *
 * 헤더(⠿ 이동 핸들 · 링크 뱃지 · ×), 8방향 리사이즈 핸들, z-order, 포커스 그림자,
 * 링크 그룹 팔레트를 렌더한다. 포인터 로직은 `WorkspaceCanvas` 가 소유하고, 이
 * 컴포넌트는 `onHandleDown(mode)` 로 위임하는 프레젠테이션 껍데기다.
 */
import { memo } from 'react';
import type { ResizeMode } from './snapEngine';
import { MIN_GROUP, MAX_GROUP, type GroupId, type WindowKind } from '../../state/workspace';

const KIND_LABEL: Record<WindowKind, string> = {
  chart: '차트',
  book: '10호가',
  broker: '거래원',
  vdist: '매물대',
  program: '프로그램',
  investor: '잠정투자자',
};

const HANDLES: { mode: ResizeMode; cls: string }[] = [
  { mode: 'e', cls: 'inset-y-[12px] right-0 w-[6px] cursor-ew-resize' },
  { mode: 'w', cls: 'inset-y-[12px] left-0 w-[6px] cursor-ew-resize' },
  { mode: 's', cls: 'inset-x-[12px] bottom-0 h-[6px] cursor-ns-resize' },
  { mode: 'n', cls: 'inset-x-[12px] top-0 h-[6px] cursor-ns-resize' },
  { mode: 'se', cls: 'bottom-0 right-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'nw', cls: 'top-0 left-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'ne', cls: 'top-0 right-0 h-[12px] w-[12px] cursor-nesw-resize' },
  { mode: 'sw', cls: 'bottom-0 left-0 h-[12px] w-[12px] cursor-nesw-resize' },
];

const GROUP_IDS: GroupId[] = Array.from({ length: MAX_GROUP - MIN_GROUP + 1 }, (_, i) => i + MIN_GROUP);

export interface WindowRectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowFrameProps {
  id: string;
  kind: WindowKind;
  group: GroupId;
  rect: WindowRectPx;
  zIndex: number;
  focused: boolean;
  /** 그룹→종목명. 없으면 "그룹 N" 로 표시(PR-A 스캐폴딩). */
  symbolLabel: string | null;
  symbolCode: string | null;
  paletteOpen: boolean;
  onHandleDown: (e: React.PointerEvent, id: string, mode: 'move' | ResizeMode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
  children: React.ReactNode;
}

function WindowFrameImpl(props: WindowFrameProps) {
  const {
    id,
    kind,
    group,
    rect,
    zIndex,
    focused,
    symbolLabel,
    symbolCode,
    paletteOpen,
    onHandleDown,
    onFocus,
    onClose,
    onTogglePalette,
    onPickGroup,
    children,
  } = props;

  const title = symbolLabel ?? `그룹 ${group}`;

  return (
    <div
      data-win={id}
      className={`absolute flex flex-col rounded-lg bg-bg-card ${
        focused ? 'shadow-modal' : 'shadow-panel'
      }`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        contain: 'layout paint',
      }}
      onPointerDown={() => onFocus(id)}
    >
      <div
        data-handle="move"
        className="flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 rounded-t-lg border-b border-border px-1.5 active:cursor-grabbing"
        onPointerDown={(e) => onHandleDown(e, id, 'move')}
      >
        <span className="select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
        <button
          className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-sm bg-tint-selection font-mono text-[10px] font-semibold text-accent hover:brightness-125"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onTogglePalette(id)}
          title="링크 그룹 변경"
        >
          {group}
        </button>
        <span className="truncate text-[12px] font-medium text-fg">
          {kind === 'chart' ? title : `${KIND_LABEL[kind]} · ${title}`}
        </span>
        {symbolCode && <span className="font-mono text-[10px] text-fg-dimmer">{symbolCode}</span>}
        <button
          className="ml-auto px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose(id)}
          title="창 닫기"
        >
          ×
        </button>
      </div>

      {paletteOpen && (
        <div
          className="absolute left-5 top-[26px] z-50 grid grid-cols-5 gap-0.5 rounded-md border border-border bg-bg-subtle p-1 shadow-overlay"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {GROUP_IDS.map((g) => (
            <button
              key={g}
              className={`h-[20px] w-[20px] rounded-sm font-mono text-[10px] font-semibold ${
                g === group
                  ? 'bg-accent text-accent-fg'
                  : 'bg-bg-input text-fg-dim hover:bg-tint-selection hover:text-accent'
              }`}
              onClick={() => onPickGroup(id, g)}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg">{children}</div>

      {HANDLES.map((hd) => (
        <div
          key={hd.mode}
          data-handle={hd.mode}
          className={`absolute ${hd.cls}`}
          onPointerDown={(e) => onHandleDown(e, id, hd.mode)}
        />
      ))}
    </div>
  );
}

export const WindowFrame = memo(WindowFrameImpl);
