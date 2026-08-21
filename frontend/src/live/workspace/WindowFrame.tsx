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
import { TitleBarSymbolRow } from './TitleBarSymbolRow';

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
  /** 이동 드래그 중인 창 여부 — 코어 프레임의 리프트(그림자) 표현으로 전달. */
  lifting?: boolean;
  /** 그룹→종목명. 없으면 "그룹 N" 로 표시(PR-A 스캐폴딩). */
  symbolLabel: string | null;
  symbolCode: string | null;
  /** 지수 종목 여부 — 타이틀바 종목 행에서 현재가/등락률/히트맵/수집점을 숨긴다. */
  isIndex?: boolean;
  paletteOpen: boolean;
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
      lifting={lifting}
      // /study 통일(2026-07-23): 안착 그림자·카드 배경 스텝 제거 → 창이 필드에 평평.
      // 리프트(shadow-modal)는 유지해 이동 피드백은 남는다.
      flat
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={onClose}
      header={
        <>
          <div ref={paletteAnchorRef} className="relative shrink-0">
            <button
              className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-sm bg-tint-selection font-data text-2xs font-semibold text-accent hover:brightness-125"
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
                    className={`h-[20px] w-[20px] rounded-sm font-data text-2xs font-semibold ${
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
          {/* 종목 고정 — 그룹 뱃지 바로 옆이다. 두 컨트롤이 같은 축(이 창이 어느 종목을
              따르는가)을 다루므로 붙여 두면 "그룹을 따를지 / 이 창에 붙들지" 가 한 자리에
              읽힌다. `title` 이 스코프를 **창**으로 못 박는다 — 그룹 뱃지 옆이라 그룹
              단위로 오해되기 쉬운 자리다(DESIGN 2026-08-07 #759 결정 1 의 반대 방향
              함정: 거기선 전역 값을 창 헤더에 뒀을 때, 여기선 창 값을 그룹 컨트롤 옆에
              둘 때). 종목이 없어 켤 수 없는 창은 disabled — 흐린 것이 기능이다. */}
          {onTogglePin && (
            <button
              type="button"
              data-testid="window-pin-toggle"
              aria-pressed={pinned}
              disabled={!canPin}
              className={`inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-sm ${
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
          )}
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
