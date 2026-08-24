import type { LiveTimeframe } from '../state/livePage';
import type { BoundPaneSpec } from '../chart/paneSpecs';
import type { PaneId } from '../chart/drawing/types';
import type { PaneStretchMap } from '../chart/paneOrder';
import { paneSpecsForTimeframe, type PaneToggles } from './paneSpecsForTimeframe';

/**
 * pane 병합 그룹의 **스펙 해석** — `paneGroups`(레이아웃 원본, `chart/paneGroups.ts`)
 * 를 현재 봉·토글로 게이트해 "실제로 마운트할 pane 그룹 목록"으로 바꾼다.
 *
 * 멤버십은 여전히 `paneSpecsForTimeframe` 의 게이트가 소유한다 — 여기는 그 게이트
 * 결과를 그룹 모양으로 **분할**할 뿐이다. 게이트로 빠진 멤버는 그룹에서 사라지고,
 * 전원 빠진 그룹은 목록에서 사라진다(pane 자체가 안 생긴다).
 *
 * 반환 identity 는 **2층 캐시**로 안정화한다:
 *  - 그룹 배열: 자기 구성(멤버 이름 시퀀스)으로 캐시 — 다른 그룹이 바뀌어도 이
 *    그룹의 identity 는 유지된다. `RangeSeriesPane` 이 이 배열을 `groupPaneIds`
 *    dep 으로 받으므로, 이 안정성이 "무관한 그룹 편집이 전 pane 을 재생성"을 막는다.
 *  - 파티션(바깥 배열): 전체 구성으로 캐시 — `usePaneFolding`/stretch effect 의
 *    memo 가 봉 틱마다 churn 하지 않는다(flat 판의 `paneCache` 와 같은 규율).
 */
export type PaneSpecGroup = readonly BoundPaneSpec[];

const groupCache = new Map<string, PaneSpecGroup>();
const partitionCache = new Map<string, readonly PaneSpecGroup[]>();

export function paneGroupSpecsForTimeframe(
  tf: LiveTimeframe,
  toggles: PaneToggles,
  paneGroups: readonly (readonly PaneId[])[],
): readonly PaneSpecGroup[] {
  // 게이트 통과 집합(순서는 여기서 안 쓴다 — 그룹 순서·그룹 내 순서가 레이아웃이다).
  const flatOrder = paneGroups.flat() as PaneId[];
  const kept = paneSpecsForTimeframe(tf, toggles, flatOrder);
  const specByName = new Map(kept.map((s) => [s.name, s]));
  const groups: PaneSpecGroup[] = [];
  for (const group of paneGroups) {
    const members = group
      .map((id) => specByName.get(id))
      .filter((s): s is BoundPaneSpec => s !== undefined);
    if (members.length === 0) continue;
    const key = members.map((s) => s.name).join(',');
    let cached = groupCache.get(key);
    if (!cached) {
      cached = Object.freeze(members) as PaneSpecGroup;
      groupCache.set(key, cached);
    }
    groups.push(cached);
  }
  const partitionKey = groups.map((g) => g.map((s) => s.name).join(',')).join('|');
  const cachedPartition = partitionCache.get(partitionKey);
  if (cachedPartition) return cachedPartition;
  const frozen = Object.freeze(groups) as readonly PaneSpecGroup[];
  partitionCache.set(partitionKey, frozen);
  return frozen;
}

/** 그룹의 멤버 PaneId 배열 — 그룹 배열이 구성 키로 캐시되므로 이 배열의 identity 도
 *  구성이 같은 한 안정적이다(`RangeSeriesPane` 의 effect dep 으로 안전). */
const idsCache = new WeakMap<PaneSpecGroup, readonly PaneId[]>();
export function paneGroupIds(group: PaneSpecGroup): readonly PaneId[] {
  let ids = idsCache.get(group);
  if (!ids) {
    ids = Object.freeze(group.map((s) => s.name)) as readonly PaneId[];
    idsCache.set(group, ids);
  }
  return ids;
}

/**
 * 그룹의 유효 stretch = 멤버 유효 stretch(저장값 ?? 스펙 기본값)의 **최대값**.
 *
 * 트레이드오프(v1): 그룹 단위 저장 필드를 새로 만들지 않아 스키마가 안 늘지만,
 * separator 드래그로 그룹을 리사이즈하면 그 값이 **멤버 전원에게** 기록된다
 * (LiveChartRoot 의 드래그 캡처) — 나중에 분리하면 두 pane 이 같은 크기로 시작한다.
 * 문제가 되면 그룹 키 저장으로 승격한다(제안서 §4).
 */
export function paneGroupStretch(group: PaneSpecGroup, paneStretch: PaneStretchMap): number {
  let max = 0;
  for (const spec of group) {
    max = Math.max(max, paneStretch[spec.name] ?? spec.stretch);
  }
  return max;
}
