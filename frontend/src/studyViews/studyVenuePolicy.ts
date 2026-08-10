import type { LiveVenueOption } from '../state/liveVenue';

/**
 * **`/study` 는 항상 KRX 다** — 복기 표면 전체의 venue SSOT (2026-08-10 사용자 결정).
 *
 * ADR-0140 §7.2 가 부활시킨 `/study` 거래소 선택기를 되돌린다. 근거는 셋이다:
 *
 * 1. **복기 데이터의 실제 커버 범위가 KRX 다.** 상당량이 `hogaplay` 캡처인데
 *    hogaplay 는 KRX 전용이고 venue 축 자체가 없다(`SOURCE_HAS_VENUE`). NXT·통합을
 *    고르면 그 날짜들이 통째로 빈다 — 장애가 아니라 소스의 범위인데, 복기 화면에서는
 *    구별할 방법이 없어 고장으로 읽힌다.
 * 2. **같은 페이지가 두 시장을 동시에 보고 있었다.** 차트 경로만 공유 스토어를 따랐고
 *    10호가·거래원 카드(`studyWindowContents`)는 `'KRX'` 하드코딩으로 남아 있었다.
 *    NXT 를 고른 복기 화면은 차트는 NXT, 옆 카드는 KRX 였다.
 * 3. **거래소 선택은 탭 전역이다.** `/live` 에서 NXT 로 옮기면 열려 있던 복기 탭이
 *    "저절로" 다른 시장으로 바뀌었다 — 복기는 저장된 과거를 다시 보는 화면이라
 *    현재 시세 화면의 선택이 소급될 이유가 없다.
 *
 * ⚠ **고정하는 것은 입력이지 능력이 아니다.** venue 축 자체(`studyReferenceBundleModel`
 * 의 세션 경계 분기 #1245, 백엔드 `venue` 파라미터)는 그대로 둔다. 정책을 되돌리려면
 * 이 상수 하나를 스토어 읽기로 바꾸면 되고, 그때 그 축이 다시 살아난다.
 *
 * ⚠ **`/study` 안에서 `useLiveVenueStore` 를 읽지 말 것.** 한 곳이라도 스토어를 읽으면
 * 차트와 카드가 다시 갈린다 — 위 2번이 정확히 그렇게 생긴 사고다.
 * `studyVenuePolicy.test.ts` 가 스토어를 NXT·UN 으로 밀어 놓고 쿼리 키가 KRX 로
 * 남는지 검사한다.
 */
export const STUDY_VENUE = 'KRX' as const satisfies LiveVenueOption;
