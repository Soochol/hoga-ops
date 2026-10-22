/**
 * WindowFrame(/live) — 코어 프레임 위에 /live 도메인 크롬을 얹는다 (ADR-0119).
 *
 * 프레임 뼈대(⠿·8핸들·닫기·포커스 틴트)는 `workspace/WindowFrame` 코어가 소유하고,
 * 이 컴포넌트는 /live 전용 헤더 — 링크 그룹 뱃지·팔레트·종목 제목 — 만 구성해
 * 주입한다. prop 표면은 일반화 이전과 동일하다(소비자·테스트 무변경).
 */
import { memo, useState } from 'react';
import type { ResizeMode } from '../../workspace/snapEngine';
import { WindowFrameCore, type WindowRectPx } from '../../workspace/WindowFrame';
import { LiveGroupBadge } from './LiveGroupBadge';
import type { GroupId, WindowKind } from '../../state/workspace';
// 창 제목은 창 추가 메뉴와 같은 문자열이어야 "고른 것 = 생긴 것" 이 맞는다
// (windowKindLabels 의 SSOT 취지). 여기에 사본을 두면 그 약속이 조용히 깨진다.
import { WINDOW_KIND_LABEL as KIND_LABEL } from './windowKindLabels';
import { TitleBarSymbolRow } from './TitleBarSymbolRow';
import { WindowSettingsPopover } from './WindowSettingsPopover';
import { WindowHeaderActionsContext } from './WindowHeaderAction';
import { ChartWindowSettings } from './ChartWindowSettings';
import { TradeWindowSettings } from './TradeWindowSettings';
import { formatTradeMinAmount } from '../../state/tradeWindowSettings';

export type { WindowRectPx };

export interface WindowFrameProps {
  id: string;
  kind: WindowKind;
  group: GroupId;
  rect: WindowRectPx;
  zIndex: number;
  /** 최상단(포커스) 창 여부 — 헤더 틴트로 표현한다. 외곽선은 모든 창에서 같은 중성색이다. */
  focused: boolean;
  /** 이동 드래그 중인 창 여부 — 코어 프레임의 리프트(그림자) 표현으로 전달. */
  lifting?: boolean;
  /** 그룹→종목명. 없으면 "그룹 N" 로 표시(PR-A 스캐폴딩). */
  symbolLabel: string | null;
  symbolCode: string | null;
  /** Current master capability; null/missing is unknown, independent of the selected venue. */
  nxtEnabled?: boolean | null;
  /** 지수 종목 여부 — 타이틀바 종목 행에서 현재가/등락률/히트맵/수집점을 숨긴다. */
  isIndex?: boolean;
  paletteOpen: boolean;
  maximized?: boolean;
  alwaysOnTop?: boolean;
  onToggleAlwaysOnTop?: (id: string) => void;
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
  /** Market-wide windows supply their compact title/legend without a symbol group. */
  headerContent?: React.ReactNode;
  tradeMinAmountManwon?: number;
  onTradeMinAmountChange?: (amount: number) => void;
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
    nxtEnabled,
    isIndex = false,
    paletteOpen,
    maximized = false,
    alwaysOnTop = false,
    onToggleAlwaysOnTop,
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
    headerContent,
    tradeMinAmountManwon = 0,
    onTradeMinAmountChange,
  } = props;

  const marketWide = kind === 'market-indices';
  const showVenueSupport = (kind === 'book' || kind === 'order') && !!symbolCode && !isIndex;
  const title = marketWide ? KIND_LABEL[kind] : symbolLabel ?? `그룹 ${group}`;
  const [headerActions, setHeaderActions] = useState<HTMLSpanElement | null>(null);

  return (
    <WindowHeaderActionsContext.Provider value={headerActions}><WindowFrameCore
      id={id}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      lifting={lifting}
      // 카드 배경을 쓰고, 겹친 창의 경계는 외곽선과 짧은 그림자로 구분한다.
      outlined
      className={`live-window live-window-${kind}`}
      headerClassName="live-window-titlebar"
      gap={4}
      onHandleDown={maximized ? () => {} : onHandleDown}
      resizable={!maximized}
      onFocus={onFocus}
      onClose={onClose}
      closeTitle={null}
      closeLabel={marketWide ? `${title} 창 닫기` : `${title} ${KIND_LABEL[kind]} 창 닫기`}
      header={
        <>
          {/* 뱃지·팔레트 마크업은 `/study` 와 공유한다(`workspace/GroupBadge`) —
              번호가 가리키는 것만 페이지가 정하고 제스처는 하나다. */}
          {!marketWide && <LiveGroupBadge
            group={group}
            open={paletteOpen}
            onToggle={() => onTogglePalette(id)}
            onPick={(g) => onPickGroup(id, g)}
          />}
          {/* 차트 창은 종목 식별 행(종목명·현재가·등락률·히트맵·경고)을 타이틀바에
              그린다(#869 캔버스 레전드에서 이관). 데이터 창·종목 없는 창은 기존 제목. */}
          {marketWide ? headerContent ?? <span className="flex-1 text-xs">주요 지수</span> : kind === 'chart' && symbolCode ? (
            <TitleBarSymbolRow name={symbolLabel} code={symbolCode} isIndex={isIndex} windowId={id} />
          ) : (
            <>
              <span className={`live-data-title flex min-w-0 items-center gap-1 text-sm font-medium text-fg${showVenueSupport ? ' live-data-title-with-venues' : ''}`} tabIndex={0}>
                {kind !== 'chart' && <span className="live-data-title-kind shrink-0">{KIND_LABEL[kind]} ·</span>}
                {showVenueSupport ? <span className="live-data-title-identity">
                  <span className="live-symbol-name truncate">{title}</span>
                  <span className="live-symbol-venue-badge" data-supported={nxtEnabled === true ? '' : undefined}
                    aria-label={nxtEnabled === true ? 'NXT 거래 지원' : nxtEnabled === false ? 'NXT 거래 미지원' : 'NXT 지원 여부 미확인'}>
                    {nxtEnabled === true ? 'NXT 지원' : nxtEnabled === false ? 'NXT 미지원' : 'NXT 미확인'}
                  </span>
                </span> : <span className="live-symbol-name truncate">{title}</span>}
              </span>
            </>
          )}
          {/* 제목과 보조 정보가 먼저 줄어들고, 창 조작 버튼은 최소 창 폭까지 유지한다. */}
          {kind === 'trade' && tradeMinAmountManwon > 0 && <span className="live-window-title-meta rounded-sm bg-tint-selection px-1 text-xs text-accent font-data"
            aria-label={`체결금액 ${formatTradeMinAmount(tradeMinAmountManwon)} 이상 표시`}>{formatTradeMinAmount(tradeMinAmountManwon)} 이상</span>}
          <div className="live-window-direct-actions">
            <span ref={setHeaderActions} className="live-window-header-actions-slot" />
            {kind === 'chart' && <ChartWindowSettings windowId={id} />}
            {kind === 'trade' && onTradeMinAmountChange && <WindowSettingsPopover title="체결창 설정"
              render={close => <TradeWindowSettings minAmountManwon={tradeMinAmountManwon}
                onApply={amount => { onTradeMinAmountChange(amount); close(); }} />} />}
            {onToggleMaximize && (
              <button type="button" className="live-window-maximize inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-dim hover:bg-tint-selection hover:text-fg"
                aria-label={maximized ? '원래 크기로 복원' : '창 최대화'}
                onPointerDown={(e) => e.stopPropagation()} onClick={() => onToggleMaximize(id)}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {maximized ? <><path d="M8 8V4h12v12h-4" /><rect x="4" y="8" width="12" height="12" /></> : <rect x="4" y="4" width="16" height="16" />}
                </svg>
              </button>
            )}
            {onToggleAlwaysOnTop && (
              <button
                type="button"
                aria-label="항상 위"
                aria-pressed={alwaysOnTop}
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm ${alwaysOnTop
                  ? 'bg-tint-selection text-accent hover:brightness-125'
                  : 'text-fg-dim hover:bg-tint-selection hover:text-fg'}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onToggleAlwaysOnTop(id)}
              >
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16M12 18V8m-5 5 5-5 5 5" />
                  {alwaysOnTop && <path d="M4 21h16" />}
                </svg>
              </button>
            )}
            {!marketWide && onTogglePin && (
              <>
                <button
                  type="button"
                  data-testid="window-pin-toggle"
                  aria-label="종목 고정"
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
                >
                  <PinGlyph filled={pinned} />
                </button>
              </>
            )}
          </div>
        </>
      }
    >
      {children}
    </WindowFrameCore></WindowHeaderActionsContext.Provider>
  );
}

export const WindowFrame = memo(WindowFrameImpl);
