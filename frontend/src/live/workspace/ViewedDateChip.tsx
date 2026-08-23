/**
 * 분봉 창 헤더의 **날짜 칩** — 이 창이 지금 어느 날을 보고 있는지, 그리고 돌아갈 문.
 *
 * `SavedRangeChip`·`MinuteJumpChip` 과 **같은 자리·같은 모양**이다. 헤더에 사는 이유도
 * 같다 — 차트 위 오버레이로 두면 `PaneLegendOverlay` 와 겹치는데, 켠 지표 수만큼 줄이
 * 늘어나므로 좌표를 피해 가는 방식으로는 구조적으로 못 막는다(2026-08-21 실측).
 *
 * ── 점프 칩과 **동시에 뜬다** ────────────────────────────────────────────
 * 둘은 다른 것을 말한다: 점프 칩은 **명령**(어디로 보냈는가), 이 칩은 **화면 상태**
 * (지금 무엇이 보이는가)다. 착지한 뒤 사용자가 팬하면 정당하게 갈라지므로, 값이 같을
 * 때 숨기는 최적화는 하지 않는다 — 폭 몇 px 을 얻고 「왜 사라졌지」를 파는 거래다.
 *
 * 시간축이 이미 날짜를 찍는 **캘린더 봉 창에는 뜨지 않는다**(호출부 게이트).
 */
import { jumpDateLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';

export function ViewedDateChip({
  date,
  onReturn,
}: {
  /** 화면 오른쪽 끝 봉의 KST 날짜(YYYYMMDD). */
  date: string;
  /** × — 라이브 엣지로 돌아간다(`MinuteJumpChip` 의 × 와 같은 계약). */
  onReturn: () => void;
}) {
  const detail = `이 창은 ${date} 를 보고 있습니다. × 를 누르면 최근 시각으로 돌아갑니다.`;
  return (
    <div
      data-testid="live-viewed-date-chip"
      title={detail}
      aria-label={detail}
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
      style={{ background: 'var(--tint-selection)', color: 'var(--fg-muted)' }}
    >
      <span className="truncate">과거 {jumpDateLabel(date, todayKstYyyymmdd())}</span>
      <button
        type="button"
        aria-label="최근 시각으로 돌아가기"
        onClick={onReturn}
        className="shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
        style={{ color: 'var(--fg-muted)' }}
      >
        ×
      </button>
    </div>
  );
}
