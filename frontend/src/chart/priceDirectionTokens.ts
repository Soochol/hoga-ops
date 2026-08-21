import { resolveTokensThemed } from '../util/tokens';

/**
 * 시세 방향색 토큰 — DESIGN.md 성역(상승=빨강 / 하락=파랑, KRX 컨벤션). 캔버스는 CSS
 * 변수를 못 읽으므로 런타임에 해석하고, 폴백 hex 는 테스트·SSR 전용이다.
 *
 * **모듈 상수인 것이 계약이다**: `resolveTokensThemed` 가 spec 객체를 WeakMap 키로
 * 캐시하므로, 호출부에서 리터럴을 새로 만들면 테마마다 `getComputedStyle` 이 다시 돈다.
 *
 * 공유 대상: 캔버스 렌더(`HighLowLabelsPrimitive`)와 **설정 UI**(`LineStyleRow` 가
 * "색을 고르지 않은" 선의 현재 색을 스와치로 보여 줘야 한다). 두 곳이 각자 리터럴을
 * 들고 있으면 한쪽만 바뀌어도 화면과 설정이 다른 색을 말하게 된다.
 */
export const PRICE_DIRECTION_TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
} as const;

export type PriceDirection = keyof typeof PRICE_DIRECTION_TOKEN_SPEC;

/** 현재 테마에서 방향색 hex. `CHART_LINE_STYLES` 의 색 `''`(고르지 않음)이 푸는 값. */
export function resolvePriceDirectionColor(direction: PriceDirection): string {
  return resolveTokensThemed(PRICE_DIRECTION_TOKEN_SPEC)[direction];
}
