import { hogaplayPeriodLabel, type HogaplayChipGapFill, hogaplayGapFillSentence } from './HogaplaySourceChipHelpers';


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
