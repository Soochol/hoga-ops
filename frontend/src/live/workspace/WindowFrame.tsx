/**
 * WindowFrame(/live) — 코어 프레임 위에 /live 도메인 크롬을 얹는다 (ADR-0119).
 *
 * 프레임 뼈대(⠿·8핸들·닫기·포커스 틴트)는 `workspace/WindowFrame` 코어가 소유하고,
 * 이 컴포넌트는 /live 전용 헤더 — 링크 그룹 뱃지·팔레트·종목 제목 — 만 구성해
 * 주입한다. prop 표면은 일반화 이전과 동일하다(소비자·테스트 무변경).
 */
import { memo } from 'react';
import type { ResizeMode } from '../../workspace/snapEngine';
import { WindowFrameCore, type WindowRectPx } from '../../workspace/WindowFrame';
import { GroupBadge } from '../../workspace/GroupBadge';
import type { GroupId, WindowKind } from '../../state/workspace';
// 창 제목은 창 추가 메뉴와 같은 문자열이어야 "고른 것 = 생긴 것" 이 맞는다
// (windowKindLabels 의 SSOT 취지). 여기에 사본을 두면 그 약속이 조용히 깨진다.
import { WINDOW_KIND_LABEL as KIND_LABEL } from './windowKindLabels';
import { TitleBarSymbolRow } from './TitleBarSymbolRow';

export type { WindowRectPx };

export interface WindowFrameProps {
  id: string;
  kind: WindowKind;
  group: GroupId;
  rect: WindowRectPx;
  zIndex: number;
  /** 최상단(포커스) 창 여부 — 헤더 밴드 틴트로만 표현한다. */
  focused: boolean;
  /** 이동 드래그 중인 창 여부 — 코어 프레임의 리프트(그림자) 표현으로 전달. */
  lifting?: boolean;
  /** 그룹→종목명. 없으면 "그룹 N" 로 표시(PR-A 스캐폴딩). */
  symbolLabel: string | null;
  symbolCode: string | null;
  /** 지수 종목 여부 — 타이틀바 종목 행에서 현재가/등락률/히트맵/수집점을 숨긴다. */
  isIndex?: boolean;
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
    lifting,
    symbolLabel,
    symbolCode,
    isIndex = false,
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
    <WindowFrameCore
      id={id}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      lifting={lifting}
      // /study 통일(2026-07-23): 안착 그림자·카드 배경 스텝 제거 → 창이 필드에 평평.
      // 리프트(shadow-modal)는 유지해 이동 피드백은 남는다.
      flat
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={onClose}
      header={
        <>
          {/* 뱃지·팔레트 마크업은 `/study` 와 공유한다(`workspace/GroupBadge`) —
              번호가 가리키는 것만 페이지가 정하고 제스처는 하나다. */}
          <GroupBadge
            group={group}
            open={paletteOpen}
            onToggle={() => onTogglePalette(id)}
            onPick={(g) => onPickGroup(id, g)}
          />
          {/* 차트 창은 종목 식별 행(종목명·현재가·등락률·히트맵·경고)을 타이틀바에
              그린다(#869 캔버스 레전드에서 이관). 데이터 창·종목 없는 창은 기존 제목. */}
          {kind === 'chart' && symbolCode ? (
            <TitleBarSymbolRow name={symbolLabel} code={symbolCode} isIndex={isIndex} windowId={id} />
          ) : (
            <>
              <span className="truncate text-sm font-medium text-fg">
                {kind === 'chart' ? title : `${KIND_LABEL[kind]} · ${title}`}
              </span>
              {symbolCode && <span className="font-data text-2xs text-fg-dim">{symbolCode}</span>}
            </>
          )}
        </>
      }
    >
      {children}
    </WindowFrameCore>
  );
}

export const WindowFrame = memo(WindowFrameImpl);
