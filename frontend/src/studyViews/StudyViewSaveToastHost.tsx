import { create } from 'zustand';
import { ToastCard } from '../ui/toast/ToastCard';
import { useRightRailStore } from '../state/rightRail';
import { useStudyViewReveal } from './studyViewReveal';

type Notice = { id: string; groupId: string; label: string; retryCapture?: () => void };
export const useStudySaveNotice = create<{ notice: Notice | null }>(() => ({ notice: null }));
export function StudyViewSaveToastHost() {
  const notice = useStudySaveNotice((s) => s.notice);
  if (!notice) return null;
  return <ToastCard visible role="status" ariaLabel="저장뷰 저장 안내" action={{ label: '목록에서 보기', onClick: () => {
    useStudyViewReveal.setState({ target: { id: notice.id, groupId: notice.groupId } });
    useRightRailStore.getState().setActivePanel('savedViews');
    if (!notice.retryCapture) useStudySaveNotice.setState({ notice: null });
  } }}>
    <p className="text-sm text-fg">{notice.label}에 저장했습니다</p>
    {notice.retryCapture && <p className="text-xs text-error">빠진 기간 수집 요청에 실패했습니다 <button className="text-accent" onClick={notice.retryCapture}>수집 다시 시도</button></p>}
    <button className="mt-1 text-xs text-fg-dim" onClick={() => useStudySaveNotice.setState({ notice: null })}>닫기</button>
  </ToastCard>;
}
