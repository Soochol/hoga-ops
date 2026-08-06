import type { CSSProperties } from 'react';
import { TIME_AXIS_PX } from './paneFolding';

/**
 * 호가 pane 이 빈 이유를 알리는 한 줄 — 문구 결정은 `hogaMissingNotice.ts` 가 한다.
 *
 * **자리가 인라인인 근거**(DESIGN.md「Error surfaces」): 이 상태의 원인은 사용자가
 * 방금 고른 **venue 선택기**이고 그건 지금 화면에 있다. 원인이 보이면 인라인, 안
 * 보이면 토스트 — 그 규칙대로 차트 안에 둔다. 토스트로 띄우면 시선이 원인에서
 * 떨어지고, 무엇보다 **상태가 지속되는데 토스트는 사라진다**(사용자가 그 venue·그
 * 날짜에 머무는 내내 참이다).
 *
 * `FoldedPaneNotice` 와 크롬·자리를 공유하되 **위로 쌓는다** — 둘은 동시에 뜰 수 있고
 * (창이 작고 + 기록도 없음) 겹치면 둘 다 못 읽는다. 그래서 `stacked` 로 한 칸 밀어
 * 올린다. 두 알림이 같은 모서리를 쓰는 것은 의도다: "이 차트가 지금 덜 보여주고
 * 있다" 는 같은 갈래의 말이라 한 곳에 모이는 편이 스캔하기 쉽다.
 */
const noticeStyle: CSSProperties = {
  position: 'absolute',
  left: 'var(--space-xs)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2xs)',
  background: 'var(--bg-card)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-data)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.4,
  color: 'var(--fg-dimmer)',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  overflow: 'hidden',
  pointerEvents: 'none',
  // lightweight-charts 내부 위젯(하단 시간축)이 자체 스택 컨텍스트를 만들어 그 위로
  // 올라온다 — FoldedPaneNotice·PaneLegendOverlay 가 같은 이유로 zIndex 4 를 쓴다.
  zIndex: 4,
};

export function HogaMissingNotice({
  text,
  timeAxisVisible = true,
  stacked = false,
  testId = 'hoga-missing-notice',
  ariaLabel,
}: {
  /** `deriveHogaMissingNotice` 결과. `null` 이면 렌더하지 않는다. */
  text: string | null;
  /** 시간축이 보이면 그 위로 띄운다 — 안 그러면 눈금 라벨을 덮는다. */
  timeAxisVisible?: boolean;
  /** 아래에 `FoldedPaneNotice` 가 떠 있으면 한 칸 밀어 올린다. */
  stacked?: boolean;
  /** 같은 크롬을 쓰는 다른 알림(소스 배지)이 자기 셀렉터를 갖도록. */
  testId?: string;
  /** 스크린리더 문구. 미지정이면 결손 안내용 기본 문장을 쓴다 — 크롬은 공유해도
   *  **말하는 내용은 알림마다 달라야** 한다(배지는 "왜 비었나" 가 아니다). */
  ariaLabel?: string;
}) {
  if (!text) return null;
  const base = timeAxisVisible ? `${TIME_AXIS_PX}px + var(--space-2xs)` : 'var(--space-xs)';
  // 한 칸 = 알림 한 줄 높이(text-xs × 1.4 + 2xs 패딩 상하) + 간격. `--space-xl` 이
  // 그 합과 맞고, 하드코딩 px 대신 토큰을 쓰는 것이 DESIGN.md 규율이다.
  const bottom = stacked ? `calc(${base} + var(--space-xl))` : `calc(${base})`;
  return (
    <div
      data-testid={testId}
      style={{ ...noticeStyle, bottom }}
      // 마우스를 올릴 수 없으니(pointerEvents:none) 스크린리더용으로만 남긴다.
      // 여기서만 "왜" 를 길게 말한다 — 시각 문구는 한 줄이어야 차트를 안 가린다.
      aria-label={ariaLabel ?? `${text}. 이 구간은 호가 지표를 만들 데이터가 없어 캔들만 표시됩니다.`}
    >
      {text}
    </div>
  );
}
