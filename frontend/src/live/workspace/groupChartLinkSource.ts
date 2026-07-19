import { useSyncExternalStore } from 'react';
import type { RangeBundle } from '../../api/types';
import type { LiveTimeframe } from '../../state/livePage';
import type { GroupId } from '../../state/workspace';

/**
 * 그룹 차트 링크 발행 채널 (ADR-0119 PR-D, liveWindowStatusSource 패턴의 per-group 판).
 *
 * 매물대·프로그램 데이터 창은 번들(timeframe 종속)이 필요하고, 10호가·거래원의
 * 스팟 모드는 링크된 차트의 timeframe 이 필요하다. 각 그룹의 **대상 차트 창**
 * (z-최상위 차트, `groupTargetChartWindow`)이 자기 파이프라인 산출물 일부를 여기로
 * 발행하고, 같은 그룹 데이터 창들이 구독한다.
 *
 * 발행자는 그룹당 항상 하나 — 게이트(`groupTargetChartWindow`)가 바뀌면 새 창의
 * 발행이 교체하고, 게이트 이탈/언마운트 시 자기 발행만 걷는다(studySaveSource
 * clear 규율). 셸이 아니라 데이터 창 리프만 구독하므로 발행자 재렌더 루프가
 * 없다(#706 함정 — 발행 구독은 리프 격리).
 */

/** 매물대 카드가 소비하는 링크 차트 창의 지표 설정 조각(설정 소유권=차트 창, #712). */
export type GroupChartLinkVdistSettings = {
  rangeCount: number;
  color: string;
  maxColor: string;
  hoverCutoffEnabled: boolean;
};

export type GroupChartLink = {
  windowId: string;
  group: GroupId;
  /** 주식=6자리 코드, 지수 차트 창=null(데이터 창은 지수 게이트로 선차단). */
  code: string | null;
  timeframe: LiveTimeframe;
  /** 차트 파이프라인의 chartBundle ?? bundle (레거시 LiveSidebar 계약 미러). */
  bundle: RangeBundle | null;
  todayKst: string;
  vdist: GroupChartLinkVdistSettings;
};

const links = new Map<GroupId, GroupChartLink>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function publishGroupChartLink(next: GroupChartLink): void {
  links.set(next.group, next);
  emit();
}

/** 자기 발행일 때만 걷는다 — 게이트 교체 직후 이전 창의 cleanup 이 새 발행을
 *  지우지 않게(liveWindowStatusSource 와 동일 규율). */
export function clearGroupChartLink(group: GroupId, windowId: string): void {
  if (links.get(group)?.windowId !== windowId) return;
  links.delete(group);
  emit();
}

export function useGroupChartLink(group: GroupId | null): GroupChartLink | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (group === null ? null : links.get(group) ?? null),
    () => null,
  );
}

export function __resetGroupChartLinksForTests(): void {
  links.clear();
}
