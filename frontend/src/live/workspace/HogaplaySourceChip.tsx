/**
 * `/live` 차트 창의 **hogaplay 저장 데이터 칩** — 지금 디스크를 읽고 있다는 표시이자
 * 푸는 문(2026-08-22 사용자 결정: 해제는 칩의 ×).
 *
 * `SavedRangeChip` 과 시각 껍데기를 공유하지만 **별도 컴포넌트다.** 그쪽 도크스트링은
 * 자기를 "저장뷰 기간 칩" 으로 정의하고 「KRX 기준」 병기 규칙까지 그 의미에 묶어
 * 놓았다 — 두 번째 의미를 얹으면 둘 다 흐려진다. 여기엔 venue 고정이 **없다**(소스만
 * 바꿀 뿐 거래소 선택은 창의 것을 그대로 따른다).
 *
 * **날짜는 실제로 실려 온 캔들에서 뽑는다**(호출부). 켤 때의 구간을 박아 두면 좌측
 * 팬으로 넓어진 뒤 칩이 거짓말을 한다 — 이 모드의 정의가 "기간 이동을 따라간다" 라
 * 고정 표기와 원리적으로 양립하지 않는다. 아직 아무것도 안 왔으면 `null` 을 넘겨
 * 날짜 없이 「불러오는 중」 으로 뜬다(`undefined~undefined` 방지).
 */

/** `20260701` → `07-01` (연도 접음) / `26-07-01` (연도 2자리 유지). */
function shortDate(yyyymmdd: string, withYear: boolean): string {
  const md = `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return withYear ? `${yyyymmdd.slice(2, 4)}-${md}` : md;
}

/**
 * 칩 한 줄용 기간 표기. **해를 걸치면 연도를 접지 않는다** — 접으면
 * `2025-08-20~2026-07-09` 가 `08-20~07-09` 가 되어 끝이 시작보다 앞선 것처럼 읽힌다
 * (`SavedRangeChip` 이 실측으로 발견한 것과 같은 규칙·같은 이유).
 */
export function hogaplayPeriodLabel(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return shortDate(fromDate, false);
  const crossesYear = fromDate.slice(0, 4) !== toDate.slice(0, 4);
  return `${shortDate(fromDate, crossesYear)}~${shortDate(toDate, crossesYear)}`;
}

export function HogaplaySourceChip({
  range,
  onClear,
}: {
  /** 실제로 그려진 캔들의 양 끝 거래일. 아직 없으면 `null`. */
  range: { fromDate: string; toDate: string } | null;
  onClear: () => void;
}) {
  const detail = range
    ? `hogaplay 저장 데이터 ${range.fromDate}~${range.toDate} 을(를) 표시 중입니다. 기간을 옮겨도 저장 데이터에서 읽습니다.`
    : 'hogaplay 저장 데이터를 불러오는 중입니다.';

  return (
    <div
      data-testid="live-hogaplay-source-chip"
      title={detail}
      aria-label={detail}
      // 헤더 안에 산다 — 저장뷰 칩과 같은 흐름(오버레이 스택이 아니다).
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
      style={{ background: 'var(--tint-selection)', color: 'var(--fg-muted)' }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: 'var(--fg-muted)' }}
      />
      <span className="truncate">
        {range ? `hogaplay ${hogaplayPeriodLabel(range.fromDate, range.toDate)}` : 'hogaplay 불러오는 중'}
      </span>
      <button
        type="button"
        aria-label="hogaplay 저장 데이터 해제"
        onClick={onClear}
        className="shrink-0 rounded px-1 leading-none hover:bg-tint-hover"
        style={{ color: 'var(--fg-muted)' }}
      >
        ×
      </button>
    </div>
  );
}
