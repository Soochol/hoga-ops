/**
 * 캘린더 봉 창 헤더의 **「분봉으로」** — 지금 보고 있는 날짜를 그룹의 분봉 창에서 연다.
 *
 * ── 목적지를 **누르기 전에** 보여준다 ────────────────────────────────────
 * 착지 규칙은 「일봉 뷰의 가장 오른쪽 캔들」 하나다(2026-08-22 사용자 결정). 규칙이
 * 마우스와 무관해졌어도 이 미리보기는 남긴다 — 화면만 봐서는 그 날짜가 바로 안 읽히는
 * 경우가 있다: 우측 여백을 보고 있으면 목적지가 **최신 캔들**로 떨어지고, 캘린더 축은
 * 눈금이 촘촘해 오른쪽 끝 봉의 날짜를 세기 어렵다.
 *
 * 렌더마다 묻지 않는 이유: `readTargetMs` 는 차트 좌표를 읽는 명령형 호출이고, 이
 * 버튼은 SSE 틱마다 재렌더되는 헤더 안에 산다. 사용자는 어차피 호버한 뒤 누른다.
 *
 * ── 「갈 수 없다」는 여기서 말하지 않는다 ─────────────────────────────────
 * 이 버튼이 막는 것은 **보낼 곳이 없을 때**(그룹에 분봉 창 없음) 하나다. 그건
 * 워크스페이스 상태라 렌더 시점에 알 수 있다.
 *
 * 「그 날짜는 데이터가 없다」는 **소비 창이 말한다**(점프 칩). 하한이 모드에 따라
 * 갈리기 때문이다 — 벤더 모드는 250일 벽, 디스크(hogaplay) 모드는 캡처가 있는 만큼
 * (#1497). 그 값을 아는 것은 그 분봉 창뿐이고 이 캘린더 창은 항상 `null` 을 본다.
 * 여기서 하드코딩된 13개월로 막으면 **디스크 모드에서 갈 수 있는 곳을 못 간다고**
 * 말하게 된다 — `savedRangeNotice` 헤더가 경고한 그 실패다.
 */
import { useCallback, useState } from 'react';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';
import { jumpDateLabel } from '../../chart/timeframeJump';
import { realMsToYyyymmdd, todayKstYyyymmdd } from '../liveDateTime';

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
  /** 목적지 YYYYMMDD. 아직 안 물어봤거나 캔들이 없으면 null. */
  const [preview, setPreview] = useState<string | null>(null);

  const readDate = useCallback(() => {
    const toMs = readTargetMs();
    return toMs === null || !Number.isFinite(toMs) ? null : realMsToYyyymmdd(toMs);
  }, [readTargetMs]);
  const refresh = useCallback(() => setPreview(readDate()), [readDate]);

  const today = todayKstYyyymmdd();
  const destination = preview === null ? null : jumpDateLabel(preview, today);

  const title = !hasMinuteWindow
    ? '이 창번호에 분봉 창이 없습니다'
    : destination === null
      ? '분봉으로'
      : `분봉으로 — ${destination}`;

  const onClick = () => {
    if (!hasMinuteWindow) return;
    // 호버 없이 도달하는 경로(키보드 활성화)가 있으므로 **여기서 다시 읽는다** —
    // 호버 시점 값은 그 사이 사용자가 차트를 팬했으면 낡았다.
    setPreview(readDate());
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
      {showLabel && <span>분봉으로</span>}
    </IconToolbarButton>
  );
}
