/**
 * 「hogaplay 저장 데이터」 토글 — 차트 창 헤더 액션 행 맨 왼쪽(관심 하트 왼쪽).
 *
 * 누르면 이 창의 캔들이 벤더 REST(키움 `ka10080`)가 아니라 **캡처 디스크**
 * (`/api/range mode=candles` → hogaplay parquet)에서 온다. 저장뷰를 여는 것과 같은
 * 소스 전환이지만 **구간을 얼지 않는다** — 좌측 팬으로 기간을 넓히면 디스크 요청도
 * 같이 넓어진다(2026-08-22 사용자 요구). 상세는 `useLiveBundle` 의
 * `hogaplaySourceEnabled` 도크스트링의 3열 표.
 *
 * **라벨을 달지 않는다(아이콘 전용).** 이웃 하트와 같은 이유가 둘 다 성립한다:
 *  ① 동사가 아니라 **상태**(디스크로 보는 중/아닌 중)이고, 그 상태는 채움 + 헤더의
 *     기간 칩이 이미 나른다 — 「hogaplay」 라벨은 켜졌는지를 말해 주지 않는다.
 *  ② 헤더 폭 예산이 그것을 감당하지 못한다. 라벨을 달면 full 요구폭이 ~50px 늘어
 *     1단계 접힘 임계가 그만큼 올라가고, 그 구간에서 이웃 네 라벨이 **전부 같이**
 *     접힌다(하트 도입 때 실측으로 기각한 것과 같은 실패 모드).
 *
 * `compact` 는 라벨 접힘이 아니라 **패딩만** 따라간다 — 라벨이 애초에 없다(하트 동일).
 *
 * 비활성 조건이 **셋**이고 각각 이유가 다르다. 숨기지 않고 `disabled` 로 두는 것은
 * 하트·수집과 같은 규칙이다(행 레이아웃이 창마다 흔들리지 않는다):
 *  - 종목 없음/지수 창 — 디스크에 그 종목의 캡처가 애초에 없다.
 *  - 캘린더 봉(D/W/M) — 그 봉의 디스크 소스는 스크리너 일봉이지 hogaplay 가 아니다.
 *  - 저장뷰 얼림 중 — 이미 디스크이고, 구간 축에서 더 구체적인 요청이 걸려 있다.
 */
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';

/** 왜 비활성인가 — 툴팁 문구의 단일 출처. `null` 이면 활성. */
export type HogaplaySourceDisabledReason = 'no-code' | 'calendar-timeframe' | 'saved-range';

const DISABLED_TITLE: Record<HogaplaySourceDisabledReason, string> = {
  'no-code': 'hogaplay 저장 데이터 — 지수는 지원하지 않습니다',
  'calendar-timeframe': 'hogaplay 저장 데이터 — 분봉에서만 지원합니다',
  'saved-range': 'hogaplay 저장 데이터 — 저장뷰 기간을 보는 중입니다(이미 저장 데이터)',
};

export function HogaplaySourceButton({
  enabled,
  disabledReason,
  onToggle,
  compact = false,
}: {
  /** 지금 이 창이 디스크를 읽는가. 채움 아이콘 + `aria-pressed` 가 나른다. */
  enabled: boolean;
  /** 비활성 사유. `null` 이면 활성. */
  disabledReason: HogaplaySourceDisabledReason | null;
  onToggle: (next: boolean) => void;
  /** 헤더 1단계 접힘. 이웃 버튼이 아이콘만 남을 때 패딩을 같이 좁힌다. */
  compact?: boolean;
}) {
  const title = disabledReason
    ? DISABLED_TITLE[disabledReason]
    : enabled
      ? 'hogaplay 저장 데이터로 보는 중 — 눌러서 실시간으로'
      : 'hogaplay 저장 데이터로 보기';

  return (
    <IconToolbarButton
      data-testid="live-hogaplay-source-button"
      disabled={disabledReason !== null}
      aria-label="hogaplay 저장 데이터로 보기"
      aria-pressed={enabled}
      title={title}
      onClick={() => {
        if (disabledReason !== null) return;
        onToggle(!enabled);
      }}
      style={compact ? { paddingInline: COMPACT_PADDING_INLINE } : undefined}
      icon={<DiskStackIcon filled={enabled} className={`h-3 w-3${enabled ? ' text-fg' : ''}`} />}
    />
  );
}

/**
 * 디스크 스택 글리프 — "저장된 것을 읽는다".
 *
 * 색은 **아이콘에** 건다(하트와 같은 이유): 버튼 클래스 `text-fg-dim` 을 뒤 클래스로
 * 덮으려 하면 Tailwind 유틸 충돌이 문자열 순서가 아니라 CSS 순서로 갈려 조용히
 * 죽는다. 자식이 자기 color 를 가지면 상속을 확실히 이기고, 꺼져 있을 때는 클래스가
 * 없어 부모의 `hover:text-fg` 를 그대로 상속받는다.
 *
 * 채움은 **맨 위 타원만** 칠한다 — 원통 전체를 칠하면 12px 에서 아래 두 줄이 뭉개져
 * 하트처럼 실루엣으로 읽히지 않는다(꺼짐/켜짐이 둘 다 "덩어리" 가 된다).
 */
function DiskStackIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" fill={filled ? 'currentColor' : 'none'} />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}
