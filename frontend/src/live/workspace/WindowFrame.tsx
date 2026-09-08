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
  maximized?: boolean;
  onToggleMaximize?: (id: string) => void;
  /** 종목 고정 상태 — 켜져 있으면 이 창은 링크 그룹을 따르지 않고 자기 종목을 든다. */
  pinned?: boolean;
  /** 핀을 켤 수 있는가(= 고정할 종목이 있는가). 이미 켜져 있으면 항상 true(끄기). */
  canPin?: boolean;
  onHandleDown: (e: React.PointerEvent, id: string, mode: 'move' | ResizeMode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
  onTogglePin?: (id: string) => void;
  children: React.ReactNode;
}

/**
 * 압정 글리프 — 리포 관례대로 손으로 그린다(`windowKindIcons` 와 같은 규격:
 * 24 viewBox · `currentColor` 스트로크 · round cap). 고정 상태에서는 머리를 채워
 * 색뿐 아니라 **형태로도** 켜짐을 말한다(색만으로 상태를 말하지 않는다 — DESIGN).
 */
function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3.5v6L7 14h10l-3-4.5v-6" fill={filled ? 'currentColor' : 'none'} />
      <path d="M8.5 3.5h7M12 14v6.5" />
    </svg>
  );
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
    maximized = false,
    onToggleMaximize,
    pinned = false,
    canPin = true,
    onHandleDown,
    onFocus,
    onClose,
    onTogglePalette,
    onPickGroup,
    onTogglePin,
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
      onHandleDown={maximized ? () => {} : onHandleDown}
      resizable={!maximized}
      onFocus={onFocus}
      onClose={onClose}
      closeLabel={`${title} ${KIND_LABEL[kind]} 창 닫기`}
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
              <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-fg" title={`${KIND_LABEL[kind]} · ${title}${symbolCode ? ` (${symbolCode})` : ''}`} tabIndex={0}>
                {kind !== 'chart' && <span className="shrink-0">{KIND_LABEL[kind]} ·</span>}
                <span className="truncate">{title}</span>
              </span>
            </>
          )}
          {/* 창 수준 액션은 오른쪽 끝에 모은다. flex-1 한 곳이 여유를 흡수해
              최대화·고정·닫기 사이에 auto 마진이 나눠 들어가지 않게 한다. */}
          {onToggleMaximize && <span aria-hidden className="flex-1" />}
          {onToggleMaximize && (
            <button type="button" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-dim hover:bg-tint-selection hover:text-fg"
              aria-label={maximized ? '원래 크기로 복원' : '창 최대화'} title={maximized ? '원래 크기로 복원 (Esc)' : '창 최대화'}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => onToggleMaximize(id)}>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {maximized ? <><path d="M8 8V4h12v12h-4" /><rect x="4" y="8" width="12" height="12" /></> : <rect x="4" y="4" width="16" height="16" />}
              </svg>
            </button>
          )}
          {onTogglePin && (
            <>
              <span aria-hidden data-testid="window-header-spacer" className={onToggleMaximize ? "hidden" : "flex-1"} />
              <button
                type="button"
                data-testid="window-pin-toggle"
                aria-pressed={pinned}
                disabled={!canPin}
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm ${
                  pinned
                    ? 'bg-tint-selection text-accent hover:brightness-125'
                    : canPin
                      ? 'text-fg-dim hover:bg-tint-selection hover:text-accent'
                      : 'cursor-not-allowed text-fg-dimmer'
                }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onTogglePin(id)}
                title={
                  pinned
                    ? '이 창 종목 고정 해제 — 다시 링크 그룹을 따릅니다'
                    : canPin
                      ? '이 창 종목 고정 — 목록 클릭으로 안 바뀌고, 이 창에 직접 드롭할 때만 바뀝니다'
                      : '고정할 종목이 없습니다'
                }
              >
                <PinGlyph filled={pinned} />
              </button>
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
