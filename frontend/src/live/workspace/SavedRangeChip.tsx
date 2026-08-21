/**
 * `/live` 차트 창의 **저장뷰 기간 칩** — 지금 무엇이 걸려 있는지, 그리고 푸는 문.
 *
 * 이 칩이 해제의 **유일한 명시적 표면**이다. `/live` 에는 "지금으로 돌아가기" 컨트롤이
 * 따로 없으므로(`scrollToRealTime` 소비자 0) × 가 라이브 복귀를 겸한다 — 슬롯이
 * 지워지면 차트 `viewKey` 에서 `sv=` 가 빠져 재생성되고, 복원 뷰포트가 없으니 분봉
 * 기본 초기 뷰(=라이브 엣지)로 돌아간다(`ChartWindow` 의 `viewIdentity` 주석).
 *
 * **「KRX 기준」을 항상 병기한다.** 저장뷰 창은 전역 거래소 선택과 무관하게 KRX 로
 * 고정되므로(`SAVED_RANGE_VENUE`), 병기하지 않으면 사용자가 NXT 를 골라 둔 채로
 * KRX 차트를 보면서 그 사실을 알 길이 없다 — ADR-0144 §2 가 "한 화면이 두 시장을
 * 보고 있었다" 로 기록한 사고의 예방이다.
 */
import type { SavedRangeNotice } from '../savedRangeNotice';

/** `20260701` → `07-01` (연도 접음) / `26-07-01` (연도 2자리 유지). */
function shortDate(yyyymmdd: string, withYear: boolean): string {
  const md = `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return withYear ? `${yyyymmdd.slice(2, 4)}-${md}` : md;
}

/**
 * 칩 한 줄용 기간 표기. **해를 걸치면 연도를 접지 않는다.**
 *
 * 접으면 `2024-08-20~2025-07-09` 가 `08-20~07-09` 가 되어 **끝이 시작보다 앞선 것처럼
 * 읽힌다**(2026-08-21 실측으로 발견). 저장뷰는 해를 넘겨 쌓이므로 드문 경우가 아니다 —
 * 목록 쪽 `formatStudyViewMeta` 가 같은 이유로 같은 규칙을 쓴다.
 */
function periodLabel(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return shortDate(fromDate, false);
  const crossesYear = fromDate.slice(0, 4) !== toDate.slice(0, 4);
  return `${shortDate(fromDate, crossesYear)}~${shortDate(toDate, crossesYear)}`;
}

export function SavedRangeChip({
  label,
  fromDate,
  toDate,
  notice,
  onClear,
}: {
  label: string;
  fromDate: string;
  toDate: string;
  notice: SavedRangeNotice | null;
  onClear: () => void;
}) {
  const period = periodLabel(fromDate, toDate);
  // 안내가 있으면 칩 전체가 경고 톤이 된다 — 문구를 옆에 덧붙이면 한 줄이 두 배가
  // 되고, 이 칩은 차트 위에 떠 있어 넓힐 수 없다. 상세는 title/aria 에 있다.
  const tone = notice ? 'var(--warn)' : 'var(--fg-muted)';
  const detail = notice
    ? `${notice.text}. ${notice.detail}`
    : `${label} 저장뷰 기간 ${fromDate}~${toDate} 을(를) 표시 중입니다. 이 창은 KRX 기준으로 고정됩니다.`;

  return (
    <div
      data-testid="live-saved-range-chip"
      title={detail}
      aria-label={detail}
      // 헤더 안에 산다 — 차트 위에 뜨는 `/study` 판과 달리 `shadow-panel` 도
      // `pointer-events-auto` 도 필요 없다(오버레이 스택이 아니라 일반 흐름이다).
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
      style={{ background: 'var(--tint-selection)', color: tone }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="truncate">
        {notice ? notice.text : `저장뷰 ${period}`}
      </span>
      <span className="shrink-0" style={{ color: 'var(--fg-subtle)' }}>KRX</span>
      <button
        type="button"
        aria-label="저장뷰 기간 표시 해제"
        onClick={onClear}
        className="shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
        style={{ color: 'var(--fg-muted)' }}
      >
        ×
      </button>
    </div>
  );
}
