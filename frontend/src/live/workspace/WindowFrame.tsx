/**
 * WindowFrame(/live) — 코어 프레임 위에 /live 도메인 크롬을 얹는다 (ADR-0119).
 *
 * 프레임 뼈대(⠿·8핸들·닫기·포커스 틴트)는 `workspace/WindowFrame` 코어가 소유하고,
 * 이 컴포넌트는 /live 전용 헤더 — 링크 그룹 뱃지·팔레트·종목 제목 — 만 구성해
 * 주입한다. prop 표면은 일반화 이전과 동일하다(소비자·테스트 무변경).
 */
import { memo, useRef } from 'react';
import type { ResizeMode } from '../../workspace/snapEngine';
import { WindowFrameCore, type WindowRectPx } from '../../workspace/WindowFrame';
import { MIN_GROUP, MAX_GROUP, type GroupId, type WindowKind } from '../../state/workspace';
import { useDismissablePopover } from '../../util/useDismissablePopover';
// 창 제목은 창 추가 메뉴와 같은 문자열이어야 "고른 것 = 생긴 것" 이 맞는다
// (windowKindLabels 의 SSOT 취지). 여기에 사본을 두면 그 약속이 조용히 깨진다.
import { WINDOW_KIND_LABEL as KIND_LABEL } from './windowKindLabels';

const GROUP_IDS: GroupId[] = Array.from({ length: MAX_GROUP - MIN_GROUP + 1 }, (_, i) => i + MIN_GROUP);

export type { WindowRectPx };

export interface WindowFrameProps {
  id: string;
  kind: WindowKind;
  group: GroupId;
  rect: WindowRectPx;
  zIndex: number;
  /** 최상단(포커스) 창 여부 — 헤더 밴드 틴트로만 표현한다. */
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

  // 팔레트 트리거(뱃지)+본체를 한 앵커로 감싸 외부 클릭·Escape 로 닫는다(DESIGN
  // 팝오버 계약, hand-rolled useEffect 금지). 앵커 내부(뱃지·팔레트) 클릭은 무시돼
  // 그룹 선택·토글이 dismiss 와 경합하지 않는다.
  const paletteAnchorRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(paletteOpen, paletteAnchorRef, () => onTogglePalette(id));

  return (
    <WindowFrameCore
      id={id}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={onClose}
      header={
        <>
          <div ref={paletteAnchorRef} className="relative shrink-0">
            <button
              className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-sm bg-tint-selection font-data text-[10px] font-semibold text-accent hover:brightness-125"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onTogglePalette(id)}
              title="링크 그룹 변경"
            >
              {group}
            </button>
            {paletteOpen && (
              <div
                // w-max 필수: 앵커(16px 뱃지)가 containing block 이라 shrink-to-fit 이
                // 팔레트를 16px 로 눌러 grid-cols-5 의 minmax(0,1fr) 열이 0 폭으로
                // 붕괴하고 20px 버튼 5개가 겹친다(행마다 마지막 숫자만 보임).
                className="absolute left-0 top-[20px] z-50 grid w-max grid-cols-5 gap-0.5 rounded-md border border-border bg-bg-subtle p-1 shadow-overlay"
                onPointerDown={(e) => e.stopPropagation()}
              >
                {GROUP_IDS.map((g) => (
                  <button
                    key={g}
                    className={`h-[20px] w-[20px] rounded-sm font-data text-[10px] font-semibold ${
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
          </div>
          <span className="truncate text-[12px] font-medium text-fg">
            {kind === 'chart' ? title : `${KIND_LABEL[kind]} · ${title}`}
          </span>
          {symbolCode && <span className="font-data text-[10px] text-fg-dimmer">{symbolCode}</span>}
        </>
      }
    >
      {children}
    </WindowFrameCore>
  );
}

export const WindowFrame = memo(WindowFrameImpl);
