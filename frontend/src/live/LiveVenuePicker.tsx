/**
 * LiveVenuePicker — /live 툴바의 거래소(KRX · NXT · 통합) 선택기.
 *
 * 상태는 원래부터 다 있었다(`useLiveVenueStore` 전역 + `live.venue.v1`). 없던 것은
 * **진입점**이다 — 유일한 변경 수단이 설정 모달 → 데이터 소스 → 거래소 라디오라
 * 클릭 4번 깊이에 묻혀 있었다. 설정 모달 쪽은 그대로 남는다: `DataSourceDetail` 은
 * /study(복기뷰) 설정도 렌더하는데 거기엔 이 툴바가 없어 유일 진입점이다.
 *
 * **트리거가 현재 값과 세션 창을 함께 이고 있는 것이 이 컴포넌트의 요점이다**
 * (`거래소 통합 08:00–20:00`). 거래소 전환의 실제 비용은 클릭이 아니라 **뷰
 * 리플로우**다 — KRX↔NXT 한 번에 x축이 09:00–15:30 에서 08:00–20:00 으로 갈아엎히고
 * NXT 호가 공백 경고까지 붙는다. 그래서 트리거는 지금 무엇을 보고 있는지 늘 알리고,
 * 팝오버는 선택지마다 그 창을 병기해 **고르기 전에** 결과를 알린다. 프로토타입
 * 4변형 비교(2026-08-07)에서 이 축이 승부를 갈랐다.
 *
 * 배치가 툴바인 근거는 #759 결정 1과 같다 — venue 는 창이 아니라 앱 전역이다
 * (관심종목·히트맵·타이틀바가 같은 값을 읽는다). 차트 창 헤더에 두면 "이 창의
 * 거래소" 로 읽히는데 실제론 앱 전체를 바꾼다.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LIVE_VENUE_HELP,
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  useLiveVenueStore,
} from '../state/liveVenue';
import { liveVenueSessionWindowLabel } from './liveVenuePolicy';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { clampToViewport } from '../util/clampToViewport';

/** 팝오버 폭 — 설명 문단이 3줄 안에 들어가는 값. 클램프 계산도 이 폭을 전제한다. */
const PANEL_WIDTH_PX = 300;
/** 트리거와 팝오버 사이 간격. */
const PANEL_GAP_PX = 6;

export function LiveVenuePicker() {
  const venue = useLiveVenueStore((s) => s.venue);
  const setVenue = useLiveVenueStore((s) => s.setVenue);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, anchorRef, close);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    setPos(clampToViewport(
      anchor.left,
      anchor.bottom + PANEL_GAP_PX,
      panel.width,
      panel.height,
      window.innerWidth,
      window.innerHeight,
    ));
  }, [open]);

  return (
    <div ref={anchorRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="live-venue-picker"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-bg-subtle px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
      >
        <span className="text-2xs uppercase text-fg-dimmer">거래소</span>
        <span className="font-data text-accent">{LIVE_VENUE_LABELS[venue]}</span>
        <span className="font-data text-2xs tabular-nums text-fg-dimmer">
          {liveVenueSessionWindowLabel(venue)}
        </span>
        <span aria-hidden className="text-2xs">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="거래소 선택"
          data-testid="live-venue-popover"
          // 포털이라 앵커 밖이다 — `useDismissablePopover` 의 anchor-contains 예외가
          // 안 걸려 패널 내부 mousedown 이 곧장 닫는다. 닫히면 그 버튼의 click 은
          // 영영 안 온다(언마운트). 전파를 끊어 헬퍼 계약을 그대로 쓴다.
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 rounded-lg border border-border bg-bg-card p-2 shadow-overlay"
          // 좌표 계산 전 첫 프레임은 화면 밖에 둔다 — 0,0 에 한 프레임 번쩍이는 걸 막는다.
          style={{ width: PANEL_WIDTH_PX, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        >
          {LIVE_VENUE_OPTIONS.map((opt) => {
            const selected = opt === venue;
            return (
              <button
                key={opt}
                type="button"
                aria-pressed={selected}
                data-testid={`live-venue-option-${opt}`}
                onClick={() => {
                  setVenue(opt);
                  close();
                }}
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-tint-selection text-accent'
                    : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
                }`}
              >
                <span>{LIVE_VENUE_LABELS[opt]}</span>
                <span className="font-data text-2xs tabular-nums text-fg-dimmer">
                  {liveVenueSessionWindowLabel(opt)}
                </span>
              </button>
            );
          })}
          <p className="mt-1.5 border-t border-border px-2 pt-1.5 text-2xs leading-relaxed text-fg-dim">
            {LIVE_VENUE_HELP}
          </p>
        </div>,
        document.body,
      )}
    </div>
  );
}
