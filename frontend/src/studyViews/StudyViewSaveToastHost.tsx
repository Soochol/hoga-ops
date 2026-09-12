import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ToastCard } from '../ui/toast/ToastCard';
import { useRightRailStore } from '../state/rightRail';
import { useStudyViewReveal } from './studyViewReveal';

type Notice = { id: string; groupId: string; label: string; retryCapture?: () => void };
export const useStudySaveNotice = create<{ notice: Notice | null }>(() => ({ notice: null }));
const AUTO_DISMISS_MS = 6000;

export function StudyViewSaveToastHost() {
  const notice = useStudySaveNotice((s) => s.notice);
  const [shown, setShown] = useState(notice);
  useEffect(() => {
    if (!notice) return;
    setShown(notice);
    if (notice.retryCapture) return;
    const timer = setTimeout(() => {
      if (useStudySaveNotice.getState().notice === notice) {
        useStudySaveNotice.setState({ notice: null });
      }
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const payload = notice ?? shown;
  if (!payload) return null;
  return <ToastCard key={payload.id} visible={notice !== null}
    onExited={() => setShown(null)}
    progress={notice && !notice.retryCapture ? { durationMs: AUTO_DISMISS_MS, paused: false } : null} role="status" ariaLabel="저장뷰 저장 안내" action={{ label: '목록에서 보기', onClick: () => {
    useStudyViewReveal.setState({ target: { id: payload.id, groupId: payload.groupId } });
    useRightRailStore.getState().setActivePanel('savedViews');
    if (!payload.retryCapture) useStudySaveNotice.setState({ notice: null });
  } }}>
    <p className="text-sm text-fg">{payload.label}에 저장했습니다</p>
    {payload.retryCapture && <p className="text-xs text-error">빠진 기간 수집 요청에 실패했습니다 <button className="text-accent" onClick={payload.retryCapture}>수집 다시 시도</button></p>}
    <button className="mt-1 text-xs text-fg-dim" onClick={() => useStudySaveNotice.setState({ notice: null })}>닫기</button>
  </ToastCard>;
}
