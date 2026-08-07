/** PROTOTYPE 스위처 — 「투자자 수급」 카드 자리에 파생 7종 3변형을 끼운다.
 *
 *  질문: **선물·콜·풋·미니선물·미니콜·미니풋·주식선물의 투자자 수급을 이 페이지에
 *  어떤 형태로 얹을 것인가. 그리고 축은 억원인가 계약수인가.**
 *
 *  `/market?variant=A|B|C|CURRENT` — CURRENT 는 현행 주식 수급 카드 그대로다.
 *  추가 판단이라 **안 넣은 쪽도 사이클에 있어야** 한다: 새 카드만 보면 늘 좋아 보이고,
 *  실제로 갈리는 건 옆 카드들과 같이 놓았을 때의 밀도다.
 *
 *  데이터는 **합성 픽스처**다(`fixture.ts` 상단에 근거). 원천 TR 이 실계좌 앱키
 *  전용이고 워크트리에서 부르면 prod 토큰이 죽어서(#1088) 실측을 못 한다. 상품 간
 *  대금 100배 격차·제로섬·60초 표본·15:45 마감 같은 **판단이 걸리는 축은 실물**이라
 *  레이아웃 결정에는 충분하다. 값 자체를 읽지는 말 것.
 */
import { PrototypeSwitcher, useVariant } from './PrototypeSwitcher';
import { VariantA } from './VariantA';
import { VariantB } from './VariantB';
import { VariantC } from './VariantC';

/** 현행 카드는 `MarketPage` 가 소유하므로 prop 으로 받는다 — import 하면 순환이다. */
export function DerivFlowPrototype({ current }: { current: React.ReactNode }) {
  const variant = useVariant();
  return (
    <>
      {variant === 'A' && <VariantA />}
      {variant === 'B' && <VariantB />}
      {variant === 'C' && <VariantC />}
      {variant === 'CURRENT' && current}
      <PrototypeSwitcher />
    </>
  );
}
