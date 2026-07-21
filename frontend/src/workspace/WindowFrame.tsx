/**
 * WindowFrame(코어) — 워크스페이스 창 하나의 페이지 중립 크롬 (ADR-0119/0123).
 *
 * 이동 핸들(⠿)·8방향 리사이즈 핸들·z-order·포커스 틴트·닫기 버튼만 소유하고,
 * 헤더 내용(제목·뱃지·팔레트 등 페이지 도메인)은 `header` 노드로 주입받는다.
 * 포인터 로직은 `WorkspaceCanvas`(코어)가 소유하고, 이 컴포넌트는
 * `onHandleDown(mode)` 로 위임하는 프레젠테이션 껍데기다. /live 크롬(링크 그룹
 * 뱃지·팔레트)은 `live/workspace/WindowFrame.tsx` 가 이 코어 위에 얹는다.
 */
import { memo } from 'react';
import type { ResizeMode } from './snapEngine';

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

export interface WindowRectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowFrameCoreProps {
  id: string;
  rect: WindowRectPx;
  zIndex: number;
  /** 최상단(포커스) 창 여부 — 헤더 밴드 틴트로만 표현한다. */
  focused: boolean;
  /** 헤더 내용(⠿ 오른쪽, × 왼쪽) — 제목·뱃지 등 페이지가 구성한다. */
  header: React.ReactNode;
  onHandleDown: (e: React.PointerEvent, id: string, mode: 'move' | ResizeMode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  children: React.ReactNode;
}

function WindowFrameCoreImpl(props: WindowFrameCoreProps) {
  const { id, rect, zIndex, focused, header, onHandleDown, onFocus, onClose, children } = props;

  return (
    <div
      data-win={id}
      className="absolute flex flex-col rounded-lg bg-bg-card shadow-panel"
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
        data-focused={focused ? '' : undefined}
        className={`flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 rounded-t-lg border-b border-border px-1.5 active:cursor-grabbing ${
          focused ? 'bg-tint-selection' : ''
        }`}
        onPointerDown={(e) => onHandleDown(e, id, 'move')}
      >
        <span className="select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
        {header}
        <button
          className="ml-auto px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose(id)}
          title="창 닫기"
        >
          ×
        </button>
      </div>

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

export const WindowFrameCore = memo(WindowFrameCoreImpl);
