import type { RangeSegment } from '../api/types';

/** 차트 번들에는 캔들 세그먼트가 있는데 10호가 캡처(/api/range mode=hoga 세그먼트)가 없는
 *  과거 거래일 목록. 이런 날짜는 최대벽·매물대·호가비·체결강도·거래원 등 캡처 기반 지표가
 *  조용히 빠져 "지표가 최신 날짜에만 나온다"로 오인되므로(2026-07-08 000810 실증) 상태바
 *  칩으로 공백을 드러낸다.
 *  - `hogaSegments == null`(mode=hoga 미로드/비활성)이면 아직 판정 불가 → 빈 배열.
 *  - 오늘은 제외 — 오늘 수집 상태는 CollectionDot 소관이고, 장 시작 전·SSE 유입 중에는
 *    공백이 정상 상태라 칩이 거짓 경고가 된다. */
export function hogaCoverageGapDates(
  chartSegments: readonly RangeSegment[] | null | undefined,
  hogaSegments: readonly RangeSegment[] | null | undefined,
  todayKst: string,
): string[] {
  if (!chartSegments || hogaSegments == null) return [];
  const covered = new Set(hogaSegments.map((s) => s.date));
  return chartSegments
    .map((s) => s.date)
    .filter((date) => date !== todayKst && !covered.has(date))
    .sort();
}

function formatMmDd(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

/** 칩 title(툴팁) 문구. 6일 이하는 날짜 나열, 초과는 범위로 압축. */
export function hogaCoverageGapTitle(dates: readonly string[]): string {
  if (dates.length === 0) return '';
  const span = dates.length <= 6
    ? dates.map(formatMmDd).join('·')
    : `${formatMmDd(dates[0])}–${formatMmDd(dates[dates.length - 1])} ${dates.length}일`;
  return `${span} 호가 캡처 없음 — 최대벽·매물대·호가비 등 10호가·체결 기반 지표 미표시, Capture 페이지에서 백필 가능`;
}
