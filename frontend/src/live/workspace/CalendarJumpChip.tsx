import { AppIcon } from '../../ui/AppIcon';
import { noticeStyle } from '../../ui/noticeTone';
import { jumpDateLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import type { CalendarJumpState } from '../useCalendarJumpReceiver';

const messages: Record<CalendarJumpState['status'], string> = {
  'seeking-daily': '거래일 확인 중',
  'seeking-target': '불러오는 중',
  landed: '',
  'no-data': '봉 없음',
  failed: '조회 실패',
  'out-of-range': '기준일 범위 밖',
  cancelled: '이동 취소됨',
};

export function CalendarJumpChip({ state, onClear }: { state: CalendarJumpState; onClear: () => void }) {
  const message = messages[state.status];
  const text = `점프 ${jumpDateLabel(state.date, todayKstYyyymmdd())}${message ? ` · ${message}` : ''}`;
  return <div data-testid="live-calendar-jump-chip" role="status" aria-label={text}
    className="live-chart-state-chip flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-2xs"
    style={noticeStyle(state.status === 'failed' || state.status === 'out-of-range' ? 'warn' : 'neutral')}>
    <span className="truncate">{text}</span>
    <button type="button" aria-label="기간 점프 해제" onClick={onClear}
      className="live-chart-chip-dismiss shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
      style={{ color: 'var(--fg-muted)' }}><AppIcon name="close" /></button>
  </div>;
}
