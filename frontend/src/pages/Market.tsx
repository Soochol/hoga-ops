// ============================================================================
// PROTOTYPE(throwaway) — "시장 종합" 신규 페이지 UI 변형 3종.
//
// "세 변형을 /market 단일 라우트에서 ?variant= 로 전환한다" — 스크리너
// 프로토타입(#1079)과 같은 평가 방식. 변형이 확정되면 승자만 정식 구현으로
// 다시 쓰고 market/prototype/ 디렉터리는 통째로 prototype/ 브랜치에 보존한다.
// 전 변형 목업 데이터(market/prototype/mockData.ts 상단에 실 API 매핑표).
// ============================================================================
import { PageContainer } from '../layout/PageContainer';
import { PrototypeSwitcher, usePrototypeVariant } from '../market/prototype/PrototypeSwitcher';
import { VariantA } from '../market/prototype/VariantA';
import { VariantB } from '../market/prototype/VariantB';
import { VariantC } from '../market/prototype/VariantC';

export default function Market() {
  const variant = usePrototypeVariant();
  return (
    <PageContainer>
      {variant === 'a' && <VariantA />}
      {variant === 'b' && <VariantB />}
      {variant === 'c' && <VariantC />}
      <PrototypeSwitcher />
    </PageContainer>
  );
}
