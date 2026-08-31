// 당일 최대벽 — 「보이는 영역」 랭킹(순수).
//
// 화면에 보이는 시간 범위와 겹치는 벽 세그먼트를 **잔량 내림차순**으로 상위 N개 고른다.
// 소비처가 셋이고 **같은 함수를 써야 한다**:
//   1. 레전드 값 — `peakWallRankLegendCells`(PaneLegendOverlay 의 flag 행)
//   2. 순위 화살표 — `PeakWallRankArrowsPrimitive` 가 draw 시점에 고른다
//   3. 고저 극값 라벨 회피 — 그려지는 화살표만 피하려고 draw 시점에 같은 랭킹을 다시 한다
// 랭킹을 여러 벌 두면 **동점(같은 잔량)에서 조용히 갈린다** — 레전드 1위와 화살표 ① 이
// 다른 벽을 가리키는 식이다. 그래서 여기 한 곳에만 둔다.
//
// (넷째 소비처였던 「보이는 영역 최대벽」 색 강조는 2026-08-23 에 제거됐다 — 레전드와
// 화살표의 ①②③ 이 같은 정보를 순위까지 정확히 날라 색 채널이 중복이었다.)
//
// ⚠ 랭킹 대상은 **필터를 모두 통과한 뒤**의 세그먼트여야 한다(cutoff · MA · 일봉 MA ·
// 체결된 벽 개수). 레전드가 화면에 없는 벽을 이름 부르면 안 된다.

import type { IRange, Time } from 'lightweight-charts';
import type { PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import type { FlagLegendValueCell } from './indicators/flagLegendValueRegistry';
import { formatPriceQty } from './peakLegendValues';

type VisibleTimeRange = IRange<Time> | null;

/** 랭킹이 실제로 읽는 최소 형태 — 그날 구간(겹침 판정)과 잔량(정렬 키)뿐이다.
 *  `PeakWallSegment` 와 순위 화살표(`PeakWallRankArrow`)가 둘 다 이걸 만족하므로, 두
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

/**
 * 체결된 벽 + 전체 최대벽(터치 무관) 세그먼트를 **랭킹 입력 하나**로 병합한다.
 *
 * 왜 병합인가: 이 모듈의 랭킹은 레전드·순위 화살표·고저 라벨 회피가 **같이** 쓴다(머리말).
 * 전체 벽을 레전드에만 넣으면 레전드 1위와 화살표 ① 이 다른 벽을 가리키게 되므로,
 * 병합 집합을 만들어 세 소비처가 전부 이것을 받는다 — 계산은 usePeakWallRender 한 곳.
 *
 * 중복 규칙: 같은 (그날 time0, 가격) 벽이 두 패밀리에 다 있으면 **잔량 큰 쪽 하나**만
 * 남긴다(도킹 라벨의 (날, 가격) 병합과 같은 축). 동점은 체결된 벽이 이긴다 — traded 가
 * 앞에 오고 뒤 항목은 strict > 일 때만 교체하므로, 랭커의 「동점은 먼저 나온 인덱스」
 * 규칙과도 일관된다.
 *
 * 전체 벽이 비면(하위 토글 off·데이터 없음) **traded 배열 참조를 그대로** 돌려준다 —
 * 소비처 memo 가 참조로 안정된다.
 */
export function mergePeakWallRankSegments(
  traded: readonly PeakWallSegment[],
  ...subLines: ReadonlyArray<readonly PeakWallSegment[]>
): readonly PeakWallSegment[] {
  if (subLines.every((segments) => segments.length === 0)) return traded;
  const out: PeakWallSegment[] = [];
  const indexByKey = new Map<string, number>();
  for (const segment of [traded, ...subLines].flat()) {
    const key = `${segment.time0 as unknown as number}|${segment.price}`;
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, out.length);
      out.push(segment);
    } else if (segment.qty > out[existing].qty) {
      out[existing] = segment;
    }
  }
  return out;
}

/** flag 레전드 값 셀 — 보이는 범위 상위 3개를 「순위 + 가격, 잔량」으로.
 *
 *  값 문자열은 도킹 라벨과 **같은 `formatPriceQty`** 다. 같은 벽이 화면 두 곳에서 다르게
 *  읽히는 것을 막는 유일한 방법이 함수 공유다(#839 가 그 사고였다).
 *  겹치는 벽이 3개 미만이면 있는 만큼만 — 빈 자리를 "—" 로 채우지 않는다. */
export function peakWallRankLegendCells(
  segments: readonly PeakWallSegment[],
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
