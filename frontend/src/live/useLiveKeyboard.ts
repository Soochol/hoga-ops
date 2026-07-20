import { useEffect } from 'react';
import { useRightRailStore } from '../state/rightRail';
import { shouldIgnoreEvent } from '../util/keyboard';

export type LiveTimeframeShortcutSlot = 'minute' | 'D' | 'W' | 'M';

const TIMEFRAME_SHORTCUT_KEYS: Record<string, LiveTimeframeShortcutSlot> = {
  Digit1: 'minute',
  Digit2: 'D',
  Digit3: 'W',
  Digit4: 'M',
};

/**
 * Keyboard shortcuts for the /live page (Addendum Task 9.y / Design B7).
 *
 *   j   — focus next watchlist code (handled via callback for caller wiring)
 *   k   — focus previous watchlist code
 *   w   — toggle watchlist panel
 *   n   — add a chart window to the active group (ADR-0119 PR-E)
 *   t   — Tidy(정리) — tile all windows (PR-E)
 *   [ ] — cycle window focus prev / next in the window list (PR-E)
 *   Shift+1~4 — focus chart window timeframe slot
 *
 * Shortcuts are suppressed when the user is typing in an input/textarea or
 * any element with `data-prevent-shortcuts`. This avoids interfering with
 * stock code search etc. 창 관리 키(n/t/[/])는 **평문**이라 드로잉 도구 단축키
 * (전부 Alt+key)와 충돌하지 않는다(위 altKey early-return). 파괴적 창 닫기는
 * 드로잉의 Delete/Backspace 리스너와 겹치므로 키보드에 싣지 않는다(창 헤더 × 로만).
 */
export interface UseLiveKeyboardOpts {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onSelectTimeframeShortcut?: (slot: LiveTimeframeShortcutSlot) => void;
  /** 활성 그룹에 차트 창 추가(n). 미지정이면 no-op(멀티창 밖). */
  onAddChartWindow?: () => void;
  /** 정리(t). 미지정이면 no-op. */
  onTidy?: () => void;
  /** 포커스 창 순환(] = next, [ = prev). 미지정이면 no-op. */
  onCycleFocus?: (dir: 1 | -1) => void;
}

export function useLiveKeyboard(opts: UseLiveKeyboardOpts = {}): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shouldIgnoreEvent(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey) {
        const slot = TIMEFRAME_SHORTCUT_KEYS[e.code];
        if (slot && opts.onSelectTimeframeShortcut) {
          opts.onSelectTimeframeShortcut(slot);
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case 'j':
          opts.onNextCode?.();
          e.preventDefault();
          break;
        case 'k':
          opts.onPrevCode?.();
          e.preventDefault();
          break;
        case 'w':
          useRightRailStore.getState().togglePanel('watchlist');
          e.preventDefault();
          break;
        case 'n':
          if (opts.onAddChartWindow) { opts.onAddChartWindow(); e.preventDefault(); }
          break;
        case 't':
          if (opts.onTidy) { opts.onTidy(); e.preventDefault(); }
          break;
        case ']':
          if (opts.onCycleFocus) { opts.onCycleFocus(1); e.preventDefault(); }
          break;
        case '[':
          if (opts.onCycleFocus) { opts.onCycleFocus(-1); e.preventDefault(); }
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    opts.onNextCode,
    opts.onPrevCode,
    opts.onSelectTimeframeShortcut,
    opts.onAddChartWindow,
    opts.onTidy,
    opts.onCycleFocus,
  ]);
}
