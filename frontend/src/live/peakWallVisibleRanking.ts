// 당일 최대벽 — 「보이는 영역」 랭킹(순수).
//
// 화면에 보이는 시간 범위와 겹치는 벽 세그먼트를 **잔량 내림차순**으로 상위 N개 고른다.
// 소비처가 둘이고 **같은 함수를 써야 한다**:
//   1. 선 강조 — `styleVisibleMaxAskPeakSegments`(보이는 영역 최대벽 색·두께)
//   2. 레전드 값 — `peakWallRankLegendCells`(PaneLegendOverlay 의 flag 행)
// 랭킹을 두 벌 두면 **동점(같은 잔량)에서 조용히 갈린다** — 선은 A 를 강조하는데
// 레전드 1위는 B 가 되는 식이다. 그래서 여기 한 곳에만 둔다.
//
// ⚠ 랭킹 대상은 **필터를 모두 통과한 뒤**의 세그먼트여야 한다(cutoff · MA · 일봉 MA ·
// 체결된 벽 개수). 레전드가 화면에 없는 벽을 이름 부르면 안 된다.

import type { IRange, Time } from 'lightweight-charts';
import type { AskPeakSegment } from '../chart/AskPeakSegmentsPrimitive';
import type { FlagLegendValueCell } from './indicators/flagLegendValueRegistry';
import { formatPriceQty } from './peakLegendValues';

type VisibleTimeRange = IRange<Time> | null;

/** 랭킹이 실제로 읽는 최소 형태 — 그날 구간(겹침 판정)과 잔량(정렬 키)뿐이다.
 *  `AskPeakSegment` 와 순위 화살표(`PeakWallRankArrow`)가 둘 다 이걸 만족하므로, 두
 *  표면이 **같은 랭커**를 쓰면서도 서로의 구조체를 알 필요가 없다. */
export type RankablePeakSegment = {
  time0: Time;
  time1: Time;
  qty: number;
};

/** 레전드가 보여 주는 벽 개수. 설정의 「보이는 영역 최대벽 표시 개수」(0~3)와 **무관하게**
 *  고정이다 — 그 설정은 선 강조 색만 관장하고, 0 으로 두면 레전드가 통째로 비어 버린다. */
export const PEAK_WALL_LEGEND_RANK_LIMIT = 3;

/** 세그먼트의 그날 구간 [time0, time1] 이 보이는 범위와 겹치는가.
 *  범위가 없으면(첫 프레임·teardown) **겹치지 않음**으로 본다 — 알 수 없는 상태에서
 *  전부 강조/표시하는 것보다 아무것도 안 하는 쪽이 정직하다. */
function segmentOverlapsVisibleRange(
  segment: RankablePeakSegment,
  visibleRange: VisibleTimeRange,
): boolean {
  if (!visibleRange) return false;
  const visibleFrom = visibleRange.from as unknown as number;
  const visibleTo = visibleRange.to as unknown as number;
  const from = Math.min(visibleFrom, visibleTo);
  const to = Math.max(visibleFrom, visibleTo);
  const s0 = segment.time0 as unknown as number;
  const s1 = segment.time1 as unknown as number;
  return Math.max(s0, from) <= Math.min(s1, to);
}

/** 보이는 범위와 겹치는 세그먼트를 잔량 내림차순으로 상위 `limit` 개. 반환은 **원 배열의
 *  인덱스**(순위 순) — 호출부가 스타일을 덮어쓰거나(강조) 값을 읽는(레전드) 데 모두 쓴다.
 *
 *  동점은 **먼저 나온 인덱스가 앞**이다(삽입 비교가 strict `>`). 이 규칙이 두 소비처의
 *  일치를 보장하므로 정렬을 `sort` 로 바꿀 때도 안정성을 유지할 것. */
export function rankVisiblePeakSegments<T extends RankablePeakSegment>(
  segments: readonly T[],
  visibleRange: VisibleTimeRange,
  limit: number,
): number[] {
  if (!visibleRange || limit <= 0 || segments.length === 0) return [];
  const best: { index: number; qty: number }[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segmentOverlapsVisibleRange(segment, visibleRange)) continue;
    const candidate = { index, qty: segment.qty };
    let insertAt = best.length;
    for (let i = 0; i < best.length; i += 1) {
      if (candidate.qty > best[i].qty) {
        insertAt = i;
        break;
      }
    }
    if (insertAt < limit) {
      best.splice(insertAt, 0, candidate);
      if (best.length > limit) best.length = limit;
    }
  }
  return best.map(({ index }) => index);
}

/** flag 레전드 값 셀 — 보이는 범위 상위 3개를 「순위 + 가격, 잔량」으로.
 *
 *  값 문자열은 도킹 라벨과 **같은 `formatPriceQty`** 다. 같은 벽이 화면 두 곳에서 다르게
 *  읽히는 것을 막는 유일한 방법이 함수 공유다(#839 가 그 사고였다).
 *  겹치는 벽이 3개 미만이면 있는 만큼만 — 빈 자리를 "—" 로 채우지 않는다. */
export function peakWallRankLegendCells(
  segments: readonly AskPeakSegment[],
  visibleRange: VisibleTimeRange,
  keyPrefix: string,
): FlagLegendValueCell[] {
  return rankVisiblePeakSegments(segments, visibleRange, PEAK_WALL_LEGEND_RANK_LIMIT).map(
    (index, rank) => ({
      key: `${keyPrefix}-${rank + 1}`,
      label: String(rank + 1),
      value: formatPriceQty(segments[index].price, segments[index].qty),
    }),
  );
}
