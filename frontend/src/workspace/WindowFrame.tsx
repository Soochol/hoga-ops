/**
 * WindowFrame(코어) — 워크스페이스 창 하나의 페이지 중립 크롬 (ADR-0119/0123).
 *
 * 이동 핸들(⠿)·8방향 리사이즈 핸들·z-order·포커스 틴트·닫기 버튼만 소유하고,
 * 헤더 내용(제목·뱃지·팔레트 등 페이지 도메인)은 `header` 노드로 주입받는다.
 * 포인터 로직은 `WorkspaceCanvas`(코어)가 소유하고, 이 컴포넌트는
 * `onHandleDown(mode)` 로 위임하는 프레젠테이션 껍데기다. /live 크롬(링크 그룹
 * 뱃지·팔레트)은 `live/workspace/WindowFrame.tsx` 가 이 코어 위에 얹는다.
 *
 * 간격(gap): 바깥 rect(히트박스·리사이즈 핸들)는 스냅 좌표 그대로 두고, 보이는
 * 카드만 사방 GAP/2 물러나 그려 인접 창과 GAP(px) 틈을 만든다(#811 후속). 좌표를
 * 손대지 않으므로 스냅 엔진·스플리터 승격·저장 스키마는 전부 불변이다. 마주 보는
 * 두 창의 리사이즈 핸들이 이 틈(이음매)에 겹쳐 얹혀 틈 자체가 스플리터 손잡이가 된다.
 */
import { memo } from 'react';
import type { ResizeMode } from './snapEngine';

/** 인접 창 사이 시각 간격(px). 카드는 바깥 rect 에서 이 값의 절반씩 물러난다. */
const GAP = 2;

/** 모서리(2변) 핸들 — 스플리터 승격 없음, 이음매 accent 바도 없음. */
const CORNER_HANDLES: { mode: ResizeMode; cls: string }[] = [
  { mode: 'se', cls: 'bottom-0 right-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'nw', cls: 'top-0 left-0 h-[12px] w-[12px] cursor-nwse-resize' },
  { mode: 'ne', cls: 'top-0 right-0 h-[12px] w-[12px] cursor-nesw-resize' },
  { mode: 'sw', cls: 'bottom-0 left-0 h-[12px] w-[12px] cursor-nesw-resize' },
];

/**
 * 변(edge) 핸들 — 8px 히트박스(간격을 넉넉히 덮어 이음매를 잡기 쉽게). `bar` 는
 * 호버 시 이음매에 나타나는 accent 선(토스식 분할선). 평상시 숨김(DESIGN: 스플리터
 * 라인은 호버/드래그에서만 --accent 로 노출).
 */
const EDGE_HANDLES: { mode: ResizeMode; cls: string; bar: string }[] = [
  { mode: 'e', cls: 'inset-y-[10px] right-0 w-[8px] cursor-ew-resize', bar: 'inset-y-[4px] right-0 w-[2px]' },
  { mode: 'w', cls: 'inset-y-[10px] left-0 w-[8px] cursor-ew-resize', bar: 'inset-y-[4px] left-0 w-[2px]' },
  { mode: 's', cls: 'inset-x-[10px] bottom-0 h-[8px] cursor-ns-resize', bar: 'inset-x-[4px] bottom-0 h-[2px]' },
  { mode: 'n', cls: 'inset-x-[10px] top-0 h-[8px] cursor-ns-resize', bar: 'inset-x-[4px] top-0 h-[2px]' },
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
  /** × 버튼 표시 여부(기본 true) — 닫을 수 없는 창(예: /study 단일 차트)은 숨긴다. */
  closable?: boolean;
  /** 이동 드래그 중인 창 — 그림자를 한 단계 띄워(shadow-modal) "들어올림"을 표현. */
  lifting?: boolean;
  onHandleDown: (e: React.PointerEvent, id: string, mode: 'move' | ResizeMode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  children: React.ReactNode;
}

function WindowFrameCoreImpl(props: WindowFrameCoreProps) {
  const { id, rect, zIndex, focused, header, closable = true, lifting = false, onHandleDown, onFocus, onClose, children } =
    props;

  return (
    <div
      data-win={id}
      className="absolute"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        padding: GAP / 2,
      }}
      onPointerDown={() => onFocus(id)}
    >
      {/* 보이는 카드 — 바깥 rect 에서 GAP/2 물러난 자리. 그림자·둥근 모서리·contain
          은 여기(콘텐츠 경계)에 둔다. 리사이즈 핸들은 바깥 rect 를 그대로 쓰므로
          형제로 카드 밖에 남긴다(카드 overflow-hidden 에 안 잘리도록). */}
      <div
        className={`flex h-full flex-col overflow-hidden rounded-lg bg-bg-card transition-shadow duration-150 ease-out ${
          lifting ? 'shadow-modal' : 'shadow-panel'
        }`}
        style={{ contain: 'layout paint' }}
      >
        <div
          data-handle="move"
          data-focused={focused ? '' : undefined}
          className={`flex h-[26px] shrink-0 cursor-grab items-center gap-1.5 border-b border-border px-1.5 active:cursor-grabbing ${
            focused ? 'bg-tint-selection' : ''
          }`}
          onPointerDown={(e) => onHandleDown(e, id, 'move')}
        >
          <span className="select-none text-[11px] leading-none text-fg-dimmer">⠿</span>
          {header}
          {closable && (
            <button
              className="ml-auto px-0.5 text-[12px] leading-none text-fg-dimmer hover:text-fg"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onClose(id)}
              title="창 닫기"
            >
              ×
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>

      {CORNER_HANDLES.map((hd) => (
        <div
          key={hd.mode}
          data-handle={hd.mode}
          className={`absolute z-10 ${hd.cls}`}
          onPointerDown={(e) => onHandleDown(e, id, hd.mode)}
        />
      ))}
      {EDGE_HANDLES.map((hd) => (
        <div
          key={hd.mode}
          data-handle={hd.mode}
          className={`group/handle absolute z-10 ${hd.cls}`}
          onPointerDown={(e) => onHandleDown(e, id, hd.mode)}
        >
          <div
            className={`absolute ${hd.bar} rounded-full bg-accent opacity-0 transition-opacity duration-150 group-hover/handle:opacity-80`}
          />
        </div>
      ))}
    </div>
  );
}

export const WindowFrameCore = memo(WindowFrameCoreImpl);
