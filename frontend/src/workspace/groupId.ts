/**
 * 링크 그룹 번호 — 창이 **무엇을 보는가**를 가리키는 간접층.
 *
 * 창 프레임 좌상단의 숫자 뱃지가 이것이다. 창은 자기 콘텐츠(종목·저장뷰)를 직접
 * 들지 않고 번호만 들며, 번호→대상 매핑이 SSOT 다. 그래서 같은 번호를 단 창들은
 * 대상이 **함께** 바뀌고, 창을 닫아도 대상은 남는다.
 *
 * 번호→**무엇**: `/live` 에서 번호 → 종목이다(`state/workspace.ts` 의 `groupSymbols`,
 * #711). 한때 `/study` 가 번호 → 저장뷰를 얹었으나(ADR-0155) 그 페이지와 함께
 * 사라졌다(ADR-0157).
 *
 * 이 모듈이 스토어 밖의 leaf 로 남은 이유는 이제 **역사**다: 두 스토어가 범위와
 * 판별자만 공유해야 했고, `state/workspace.ts` 에 두면 `/study` 를 여는 것만으로
 * `/live` 스토어가 하이드레이션되며 `live.workspace.v1` 에 시드를 쓰는 사고가 났다.
 * 그 위험은 사라졌지만 **옮기지 않는다** — 순수 상수·판별자 leaf 라 지금 자리가
 * 그르지 않고, 옮기면 import 를 전부 흔들 뿐이다.
 */

export const MIN_GROUP = 1;
export const MAX_GROUP = 10;

/** 링크 그룹 번호. 1..10 의 정수 — 좁은 타입이 아니라 런타임 판별자로 지킨다. */
export type GroupId = number;

/** 팔레트가 그리는 전체 번호 목록(오름차순). */
export const GROUP_IDS: readonly GroupId[] = Array.from(
  { length: MAX_GROUP - MIN_GROUP + 1 },
  (_, i) => i + MIN_GROUP,
);

/** 저장값·외부 입력에서 온 raw 를 그룹 번호로 판별한다. `GroupId` 가 `number` 라
 *  타입은 아무것도 막지 못하므로, 영속 경계에서는 **반드시** 이걸 통과시킨다. */
export function isGroupId(value: unknown): value is GroupId {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_GROUP
    && value <= MAX_GROUP
  );
}
