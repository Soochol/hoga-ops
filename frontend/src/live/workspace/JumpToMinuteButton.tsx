import { AppIcon } from '../../ui/AppIcon';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';
import { jumpBucketLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import type { CalendarTimeframe } from '../../state/livePage';

export function JumpToMinuteButton({
  timeframe,
  destinationDate,
  hasJumpReceiver,
  onRun,
  showLabel = true,
}: {
  /** 이 창의 봉 — 목적지를 **칸 단위로** 말하기 위해 필요하다(`jumpBucketLabel`). */
  timeframe: CalendarTimeframe;
  /** 목적지 칸의 **시작** KST 날짜(YYYYMMDD). 차트가 아직 없거나 캔들이 없으면 null. */
  destinationDate: string | null;
  hasJumpReceiver: boolean;
  /** 실제 발행 — `g` 단축키와 **같은 함수**다(판정이 갈리지 않게 창이 소유한다). */
  onRun: () => void;
  /** false 면 아이콘만 — 창 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
}) {
  const destination = destinationDate === null
    ? null
    : jumpBucketLabel(timeframe, destinationDate, todayKstYyyymmdd());

  const action = timeframe === 'D' ? '분봉으로' : '기간 끝으로';
  const title = !hasJumpReceiver
    ? '이 창번호에 이동할 차트가 없습니다. 같은 종목의 다른 주기 차트나 분봉 창을 여세요.'
    : destination === null
      ? action
      : timeframe === 'D' ? `분봉으로 — ${destination}` : `${action} · ${destination}`;

  const onClick = () => {
    if (!hasJumpReceiver) return;
    // 발행 시점의 목적지는 **차트가 다시 읽는다**(`runJump`) — 라벨은 rAF 로 묶인
    // 표시값이라 마지막 프레임만큼 낡을 수 있고, 실제로 보낼 값과 갈리면 안 된다.
    onRun();
  };

  return (
    <IconToolbarButton
      data-testid="live-jump-to-minute-button"
      onClick={onClick}
      disabled={!hasJumpReceiver}
      aria-label={
        destination === null || !hasJumpReceiver ? title : timeframe === 'D' ? `분봉 창을 ${destination} 로 이동` : `연결 차트를 ${destination} 기간 끝으로 이동`
      }
      title={title}
      style={{ paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE }}
      icon={(
        <AppIcon name="arrowRight" />
      )}
    >
      {showLabel && (
        <span>
          {action}
          {/* 목적지는 **덜 강한 톤**으로 — 동사가 주인공이고 날짜는 그 대상이다.
              접힘(아이콘만)에서는 title 만 남는다(#762 폭 예산). */}
          {destination !== null && (
            <span style={{ color: 'var(--fg-muted)', marginInlineStart: 4 }}>{destination}</span>
          )}
        </span>
      )}
    </IconToolbarButton>
  );
}
