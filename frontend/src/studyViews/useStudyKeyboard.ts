import { useEffect } from 'react';
import { shouldIgnoreEvent } from '../util/keyboard';
import { requestWorkspaceTidy } from '../workspace/workspaceCanvasControls';

type UseStudyKeyboardOptions = {
  onSelectTabIndex?: (index: number) => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
};

/**
 * /study 키보드 단축키.
 *   1~4 — 탭 선택
 *   [ ] — 이전/다음 탭 순환. /live 의 `[`/`]` 는 **창 포커스** 순환이지만 /study 는
 *         탭(저장뷰)이 정체성이라 의도적으로 다르다(ADR-0123). 창 포커스 순환 키는
 *         v1 미도입 — 클릭 포커스로 충분한지 도그푸딩 후 판단.
 *   t   — 창 정리(Tidy; /live 와 동일)
 * `d`(상세 패널 접기)는 창 전환으로 개념이 사라져 제거됐다.
 * 입력창·modifier 조합에선 무시(shouldIgnoreEvent + modifier bail).
 */
export function useStudyKeyboard({ onSelectTabIndex, onNextTab, onPrevTab }: UseStudyKeyboardOptions = {}): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreEvent(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 't') {
        requestWorkspaceTidy();
        event.preventDefault();
        return;
      }
      if (event.key === ']') {
        if (onNextTab) {
          onNextTab();
          event.preventDefault();
        }
        return;
      }
      if (event.key === '[') {
        if (onPrevTab) {
          onPrevTab();
          event.preventDefault();
        }
        return;
      }
      if (!/^[1-4]$/.test(event.key) || !onSelectTabIndex) return;
      onSelectTabIndex(Number(event.key) - 1);
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSelectTabIndex, onNextTab, onPrevTab]);
}
