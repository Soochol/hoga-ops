/** PROTOTYPE 스위처 — 시장 폭 카드 자리에 업종 수급 3변형을 끼운다.
 *
 *  질문: **시장 폭(개수/분산/쏠림/지수)을 빼고 업종별 투자자 수급을 넣는 게 나은가,
 *  넣는다면 어떤 형태인가.**
 *
 *  `?variant=` 없이 들어오면 A 가 뜬다. `?variant=breadth` 면 원래 시장 폭 카드를
 *  그려서 **직접 비교**할 수 있게 한다 — 교체 판단이라 "빼는 쪽" 도 화면에 있어야 한다.
 *
 *  데이터는 2026-08-07 장중 ka10051 실응답 픽스처다(`fixture.ts`). 실시간이 아닌 이유는
 *  이 질문이 레이아웃·정보 구조에 관한 것이고, 읽기 경로를 먼저 뚫으면 버려질 백엔드
 *  코드가 생기기 때문이다. 값·행 수·분포는 전부 실물이라 밀도 판단은 정확하다.
 */
import { BreadthCard } from '../BreadthCard';
import { PrototypeSwitcher, useVariant } from './PrototypeSwitcher';
import { VariantA } from './VariantA';
import { VariantB } from './VariantB';
import { VariantC } from './VariantC';

export function SectorFlowPrototype() {
  const variant = useVariant();
  return (
    <>
      {variant === 'A' && <VariantA />}
      {variant === 'B' && <VariantB />}
      {variant === 'C' && <VariantC />}
      {variant === 'BREADTH' && <BreadthCard />}
      <PrototypeSwitcher />
    </>
  );
}
