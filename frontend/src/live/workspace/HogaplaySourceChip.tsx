import { hogaplayPeriodLabel } from './HogaplaySourceChipHelpers';


export function HogaplaySourceChip({
  range,
  onClear,
}: {
  /** 실제로 그려진 캔들의 양 끝 거래일. 아직 없으면 `null`. */
  range: { fromDate: string; toDate: string } | null;
  onClear: () => void;
}) {
  const detail = range
    ? `hogaplay 저장 데이터 ${range.fromDate}~${range.toDate} 을(를) 표시 중입니다. 디스크에 있는 분봉만 표시합니다. 정규장 뱃지 OFF에서는 보유 중인 저녁 분봉도 표시하고 미저장 구간은 빈 구간으로 남깁니다. 미저장 구간을 서버에서 자동으로 가져오지 않습니다.`
    : 'hogaplay 저장 데이터를 디스크에서 불러오는 중입니다. 미저장 구간은 자동으로 가져오지 않습니다.';

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
