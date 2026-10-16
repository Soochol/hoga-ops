import { useState } from 'react';
import { ToastAction, ToastCard } from '../ui/toast/ToastCard';
import { useToastTimer } from '../ui/toast/useToastTimer';
import { useRightRailStore } from '../state/rightRail';
import { useStudyViewReveal } from './studyViewReveal';
import { useStudySaveNotice } from './StudyViewSaveToastHostHelpers';

export function StudyViewSaveToastHost() {
  const notice = useStudySaveNotice((s) => s.notice);
  const [shown, setShown] = useState(notice);
  if (notice != null && notice !== shown) setShown(notice);
  const dismiss = () => useStudySaveNotice.setState({ notice: null });
  const timer = useToastTimer({ visible: notice != null, resetKey: notice, durationMs: notice?.retryCapture ? null : 6000,
    onExpire: () => { if (useStudySaveNotice.getState().notice === notice) dismiss(); } });
  const payload = notice ?? shown;
  if (!payload) return null;
  return <ToastCard visible={notice !== null} onExited={() => setShown(null)}
    variant={payload.retryCapture ? 'warn' : 'neutral'}
    title={payload.retryCapture ? '저장은 완료했지만 수집 요청에 실패했습니다' : `${payload.label}에 저장했습니다`}
    role="status" ariaLabel="저장뷰 저장 안내" onDismiss={dismiss} progress={timer.progress} {...timer.interactionProps}
    actions={<>
      {payload.retryCapture && <ToastAction emphasis="accent" onClick={payload.retryCapture}>수집 다시 시도</ToastAction>}
      <ToastAction onClick={() => {
        useStudyViewReveal.setState({ target: { id: payload.id, groupId: payload.groupId } });
        useRightRailStore.getState().setActivePanel('savedViews');
        if (!payload.retryCapture) dismiss();
      }}>목록에서 보기</ToastAction>
    </>}>
    {payload.retryCapture ? <p>{payload.label}에 저장했습니다 · 빠진 기간 수집 요청에 실패했습니다</p> : null}
  </ToastCard>;
}
