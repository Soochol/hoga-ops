import { useEffect } from 'react';
import { shouldIgnoreEvent } from '../util/keyboard';
import { useStudyLayoutStore } from '../state/studyLayout';

type UseStudyKeyboardOptions = {
  onSelectTabIndex?: (index: number) => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
};

/**
 * /study 키보드 단축키.
 *   1~4 — 탭 선택
 *   [ ] — 이전/다음 탭 순환 (/live 와 동일)
 *   d   — 상세 패널 접기/펴기 (레일 ↔ 확장; /live 와 동일)
 * 입력창·modifier 조합에선 무시(shouldIgnoreEvent + modifier bail).
 */
export function useStudyKeyboard({ onSelectTabIndex, onNextTab, onPrevTab }: UseStudyKeyboardOptions = {}): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreEvent(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 'd') {
        useStudyLayoutStore.getState().toggleDetailPanelCollapsed();
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
