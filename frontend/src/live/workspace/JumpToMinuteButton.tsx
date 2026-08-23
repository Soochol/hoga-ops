/**
 * 캘린더 봉 창 헤더의 **「분봉으로」** — 지금 보고 있는 날짜를 그룹의 분봉 창에서 연다.
 *
 * ── 목적지를 **라벨에** 쓴다 ─────────────────────────────────────────────
 * 착지 규칙은 「캘린더 뷰의 가장 오른쪽 칸」이다(2026-08-22 사용자 결정 + 주·월봉은 그
 * 칸의 끝, `bucketEndMs`). 규칙이 마우스와 무관해도 목적지 표시는 필요하다 — 화면만
 * 봐서는 그 날짜가 바로 안 읽힌다: 우측 여백을 보고 있으면 목적지가 **최신 캔들**로
 * 떨어지고, 캘린더 축은 눈금이 촘촘해 오른쪽 끝 봉의 날짜를 세기 어렵다.
 *
 * ⚠ **종전엔 이것이 호버 툴팁뿐이었다.** 그 설계의 근거는 "`readTargetMs` 는 차트
 * 좌표를 읽는 명령형 호출이라 렌더마다 부를 수 없다" 였는데, 대가가 셋이었다(2026-08-23
 * 실측): 터치·펜에는 호버가 없어 **볼 방법이 아예 없고**, 네이티브 툴팁은 ~1초 지연에
 * 스타일도 못 주며, 좁은 헤더에서는 버튼이 **20px 아이콘 하나**였다. 지금은 차트가
 * 뷰포트 변화에만 rAF 로 묶어 날짜를 밀어 주므로(`onJumpDestinationChange`) 비용
 * 없이 라벨에 쓴다 — SSE 틱은 이 경로를 태우지 않는다.
 *
 * ── 「갈 수 없다」는 여기서 말하지 않는다 ─────────────────────────────────
 * 이 버튼이 막는 것은 **보낼 곳이 없을 때**(그룹에 분봉 창 없음) 하나다. 그건
 * 워크스페이스 상태라 렌더 시점에 알 수 있다.
 *
 * 그때 툴팁은 **상태가 아니라 할 일**을 말한다. 종전 문구(「이 창번호에 분봉 창이
 * 없습니다」)는 사실이지만 막다른 길이었다 — 사용자가 실제로 해야 하는 일은 세
 * 단계이고, 그중 하나는 **화면만 봐서는 알 수 없다**: 「창 추가 → 차트」로 만든 새
 * 창은 `addWindow` 가 **포커스 차트 창의 봉을 물려받게** 하므로, 캘린더 창에서
 * 누르면 새 창도 캘린더 봉이다. 그래서 「만들면 된다」가 아니라 「만든 뒤 봉을
 * 바꾸라」고 적어야 맞다.
 *
 * 창번호는 안내하지 않아도 된다 — 새 창은 활성 그룹(포커스 창의 그룹)을 상속하므로
 * 이 창에서 누르면 같은 창번호에 생긴다(#711).
 *
 * ⚠ **`disabled` 인 채로 툴팁이 뜬다.** 대조군 실험(2026-08-23, 실제 마우스 hover):
 * enabled·disabled 두 버튼 모두 `mouseover` 가 발화했다 — Chrome 은 비활성 폼
 * 컨트롤에도 hover 계열 이벤트를 보내고 `title` 툴팁도 띄운다. 이 안내를 위해
 * `aria-disabled` 로 바꿀 필요가 없다는 뜻이다.
 *
 * 「그 날짜는 데이터가 없다」는 **소비 창이 말한다**(점프 칩). 하한이 모드에 따라
 * 갈리기 때문이다 — 벤더 모드는 250일 벽, 디스크(hogaplay) 모드는 캡처가 있는 만큼
 * (#1497). 그 값을 아는 것은 그 분봉 창뿐이고 이 캘린더 창은 항상 `null` 을 본다.
 * 여기서 하드코딩된 13개월로 막으면 **디스크 모드에서 갈 수 있는 곳을 못 간다고**
 * 말하게 된다 — `savedRangeNotice` 헤더가 경고한 그 실패다.
 */
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';
import { jumpBucketLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import type { CalendarTimeframe } from '../../state/livePage';

export function JumpToMinuteButton({
  timeframe,
  destinationDate,
  hasMinuteWindow,
  onRun,
  showLabel = true,
}: {
  /** 이 창의 봉 — 목적지를 **칸 단위로** 말하기 위해 필요하다(`jumpBucketLabel`). */
  timeframe: CalendarTimeframe;
  /** 목적지 칸의 **시작** KST 날짜(YYYYMMDD). 차트가 아직 없거나 캔들이 없으면 null. */
  destinationDate: string | null;
  /** 같은 창번호 그룹에 분봉 창이 하나라도 있는가. */
  hasMinuteWindow: boolean;
  /** 실제 발행 — `g` 단축키와 **같은 함수**다(판정이 갈리지 않게 창이 소유한다). */
  onRun: () => void;
  /** false 면 아이콘만 — 창 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
}) {
  const destination = destinationDate === null
    ? null
    : jumpBucketLabel(timeframe, destinationDate, todayKstYyyymmdd());

  const title = !hasMinuteWindow
    ? '이 창번호에 분봉 창이 없습니다. 「창 추가 → 차트」 로 창을 만든 뒤, 그 창의 봉 버튼에서 분봉을 고르세요.'
    : destination === null
      ? '분봉으로'
      : `분봉으로 — ${destination}`;

  const onClick = () => {
    if (!hasMinuteWindow) return;
    // 발행 시점의 목적지는 **차트가 다시 읽는다**(`runJump`) — 라벨은 rAF 로 묶인
    // 표시값이라 마지막 프레임만큼 낡을 수 있고, 실제로 보낼 값과 갈리면 안 된다.
    onRun();
  };

  return (
    <IconToolbarButton
      data-testid="live-jump-to-minute-button"
      onClick={onClick}
      disabled={!hasMinuteWindow}
      aria-label={
        destination === null || !hasMinuteWindow ? title : `분봉 창을 ${destination} 로 이동`
      }
      title={title}
      style={{ paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE }}
      icon={(
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="12" x2="18" y2="12" />
          <polyline points="13 7 18 12 13 17" />
        </svg>
      )}
    >
      {showLabel && (
        <span>
          분봉으로
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
