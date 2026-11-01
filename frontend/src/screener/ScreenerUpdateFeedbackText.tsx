import type { ScreenerUpdateFeedback } from './useScreenerUpdateSync';

/** 저장된 결과도 원래 사건의 KST 날짜·시각을 표시한다. */
export function ScreenerUpdateFeedbackText({ feedback }: { feedback: ScreenerUpdateFeedback }) {
  return <>
    {feedback.source === 'update' && <>
      지난 갱신 <time dateTime={new Date(feedback.atMs).toISOString()}>
        {new Date(feedback.atMs).toLocaleString('sv-SE', {
          timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        })}
      </time>{' · '}
    </>}
    {feedback.message}
  </>;
}
