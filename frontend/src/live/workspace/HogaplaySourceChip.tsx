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

/**
 * 키움 보충의 요약 — `useMinuteGapFill` 결과에서 **개수만** 뽑은 것.
 *
 * `SavedRangeGapFill` 과 모양이 같지만 별도 타입이다. 저쪽은 저장뷰 안내의 판정 입력이라
 * 필드가 그 판정에 묶여 있고, 이쪽은 툴팁 한 문장이라 필요한 것이 다르다(유예 수까지
 * 말한다 — 이 모드는 창이 자라서 유예가 실제로 생긴다).
 */
export interface HogaplayChipGapFill {
  /** 벤더로 실제 채운 거래일 수. */
  filledCount: number;
  /** 키움 보유(약 13개월) 밖이라 요청조차 하지 않은 거래일 수. */
  unfillableCount: number;
  /** 수정주가 척도가 달라 보충을 포기한 거래일 수. */
  rescaledCount: number;
  /** 총량 상한에 걸려 이번에 시도하지 않은 거래일 수. */
  deferredCount: number;
  /** 아직 보충 중인가. */
  pending: boolean;
}

/**
 * 툴팁 뒷문장 — 보충이 **한 일과 못 한 일**.
 *
 * 못 한 쪽을 사유별로 가르는 이유는 사용자가 할 수 있는 일이 다르기 때문이다:
 * 보유 밖(영영 없음) · 척도 불일치(의도적으로 안 채움) · 유예(더 좁게 보면 채워짐).
 * 한 문장으로 뭉치면 "왜" 가 사라진다 — `savedRangeNotice` 가 같은 이유로 갈라 둔다.
 */
export function hogaplayGapFillSentence(g: HogaplayChipGapFill | undefined): string {
  if (!g) return '';
  if (g.pending) return ' 비어 있는 거래일을 벤더에서 보충하는 중입니다.';
  const parts: string[] = [];
  if (g.filledCount > 0) parts.push(`빈 거래일 ${g.filledCount}일을 키움 분봉으로 보충했습니다`);
  if (g.unfillableCount > 0) parts.push(`${g.unfillableCount}일은 키움 보유 기간이 지나 채울 수 없습니다`);
  if (g.rescaledCount > 0) parts.push(`${g.rescaledCount}일은 수정주가 척도가 달라 보충하지 않았습니다`);
  if (g.deferredCount > 0) parts.push(`${g.deferredCount}일은 이번에 시도하지 않았습니다`);
  return parts.length > 0 ? ` ${parts.join('. ')}.` : '';
}

export function HogaplaySourceChip({
  range,
  gapFill,
  onClear,
}: {
  /** 실제로 그려진 캔들의 양 끝 거래일. 아직 없으면 `null`. */
  range: { fromDate: string; toDate: string } | null;
  /**
   * 키움 보충 요약. **툴팁에만** 실린다.
   *
   * 시각 라벨을 안 늘리는 이유는 헤더 폭 예산이다 — 접힘 임계(`chartHeaderCompact`)가
   * `/browse` 실측 상수라 칩의 자연 폭을 늘리면 그 표를 다시 재야 한다. 개수 몇 개짜리
   * 부가 정보에 그 비용을 치를 이유가 없고, `aria-label` 에도 들어가므로 스크린리더는
   * 읽는다.
   */
  gapFill?: HogaplayChipGapFill;
  onClear: () => void;
}) {
  const detail = range
    ? `hogaplay 저장 데이터 ${range.fromDate}~${range.toDate} 을(를) 표시 중입니다. 기간을 옮겨도 저장 데이터에서 읽습니다.${hogaplayGapFillSentence(gapFill)}`
    : `hogaplay 저장 데이터를 불러오는 중입니다.${hogaplayGapFillSentence(gapFill)}`;

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
