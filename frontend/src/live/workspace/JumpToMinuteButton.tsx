/**
 * 캘린더 봉 창 헤더의 **「분봉으로」** — 지금 보고 있는 날짜를 그룹의 분봉 창에서 연다.
 *
 * ── 목적지를 **누르기 전에** 보여준다 ────────────────────────────────────
 * 착지 규칙이 「마지막으로 호버한 봉 → 없으면 뷰 우측 끝」이라 **마우스 위치에 따라
 * 목적지가 달라진다**. 그게 안 보이면 사용자는 규칙을 추측해야 하고, 추측이 틀리면
 * 엉뚱한 날로 간 뒤에야 안다. 호버(·포커스) 시점에 차트에 물어 라벨에 그대로 띄우면
 * 규칙을 설명할 필요 자체가 없어진다.
 *
 * 렌더마다 묻지 않는 이유: `readTargetMs` 는 차트 좌표를 읽는 명령형 호출이고, 이
 * 버튼은 SSE 틱마다 재렌더되는 헤더 안에 산다. 사용자는 어차피 호버한 뒤 누른다.
 *
 * ── 비활성은 **두 가지**이고 사유가 다르다 ───────────────────────────────
 * ① 그룹에 분봉 창이 없다 — 보낼 곳이 없다. 워크스페이스 상태라 렌더 시점에 안다.
 * ② 목적지가 분봉 보유 한계(13개월) 밖이다 — 벤더가 못 준다. 목적지를 알아야 하므로
 *    호버 뒤에 판정된다.
 *
 * 둘 다 **사유를 말한다**. 회색으로 죽어 있기만 하면 사용자는 기능이 고장난 줄 안다 —
 * "되는 데까지 보여주고 **안 되는 것만 말한다**" 가 이 리포의 정책이다
 * (`savedRangeNotice` 헤더).
 */
import { useCallback, useState } from 'react';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';
import { jumpDateLabel } from '../../chart/timeframeJump';
import { todayKstYyyymmdd } from '../liveDateTime';
import { jumpDestinationOf, type JumpDestination } from '../minuteJumpDestination';

export function JumpToMinuteButton({
  readTargetMs,
  hasMinuteWindow,
  onRun,
  showLabel = true,
}: {
  /** 이 창의 목적지를 읽는다(실시각 ms). 차트가 없거나 캔들이 없으면 null. */
  readTargetMs: () => number | null;
  /** 같은 창번호 그룹에 분봉 창이 하나라도 있는가. */
  hasMinuteWindow: boolean;
  /** 실제 발행 — `g` 단축키와 **같은 함수**다(판정이 갈리지 않게 창이 소유한다). */
  onRun: () => void;
  /** false 면 아이콘만 — 창 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
}) {
  const [preview, setPreview] = useState<JumpDestination | null>(null);

  const refresh = useCallback(() => {
    setPreview(jumpDestinationOf(readTargetMs()));
  }, [readTargetMs]);

  const blocked = !hasMinuteWindow || preview?.outOfRetention === true;
  const today = todayKstYyyymmdd();
  const destination = preview === null ? null : jumpDateLabel(preview.date, today);

  const title = !hasMinuteWindow
    ? '이 창번호에 분봉 창이 없습니다'
    : preview?.outOfRetention
      ? `분봉 보유 기간(13개월) 밖입니다 — ${destination}`
      : destination === null
        ? '분봉으로'
        : `분봉으로 — ${destination}`;

  const onClick = () => {
    if (!hasMinuteWindow) return;
    // 호버 없이 도달하는 경로(키보드 활성화)가 있으므로 **여기서 다시 읽는다** —
    // 호버 시점 값은 그 사이 사용자가 차트를 팬했으면 낡았다. 라벨이 사유를
    // 말하도록 갱신만 하고, 보낼지 말지는 `onRun` 이 같은 판정으로 정한다.
    setPreview(jumpDestinationOf(readTargetMs()));
    onRun();
  };

  return (
    <IconToolbarButton
      data-testid="live-jump-to-minute-button"
      onClick={onClick}
      onPointerEnter={refresh}
      onFocus={refresh}
      disabled={!hasMinuteWindow}
      aria-label={
        destination === null || blocked ? title : `분봉 창을 ${destination} 로 이동`
      }
      title={title}
      // 목적지가 못 가는 곳이면 눌러도 아무 일이 없다는 것을 **미리** 보인다.
      // `disabled` 를 쓰지 않는 이유: 그러면 title 툴팁이 안 뜨는 브라우저가 있어
      // 사유가 사라진다. ①(분봉 창 없음)은 사유가 정적이라 진짜 disabled 다.
      style={{
        paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE,
        opacity: preview?.outOfRetention ? 0.5 : undefined,
      }}
      icon={(
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="12" x2="18" y2="12" />
          <polyline points="13 7 18 12 13 17" />
        </svg>
      )}
    >
      {showLabel && <span>분봉으로</span>}
    </IconToolbarButton>
  );
}
