import { useEffect } from 'react';
import { shouldIgnoreEvent } from '../util/keyboard';

type UseStudyKeyboardOptions = {
  onSelectTabIndex?: (index: number) => void;
};

export function useStudyKeyboard({ onSelectTabIndex }: UseStudyKeyboardOptions = {}): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreEvent(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!/^[1-4]$/.test(event.key) || !onSelectTabIndex) return;
      onSelectTabIndex(Number(event.key) - 1);
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSelectTabIndex]);
}
