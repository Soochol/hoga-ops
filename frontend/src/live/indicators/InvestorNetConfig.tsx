import SignColorLegend from './SignColorLegend';

/**
 * 외국인 / 기관 순매수량의 상세 pane — 부호색 막대뿐이라 슬롯 설정이 없다.
 *
 * **`which` prop 이 사라진 이유**: 두 지표가 갈리던 유일한 자리가 제목과 설명이었고,
 * 그 둘은 이제 카테고리 표(`CATEGORIES`)가 헤더에서 말한다. 남은 내용은 범례와
 * 봉 제약뿐이라 방향에 무관하다 — prop 을 남겨 두면 아무 데도 안 쓰이는 스위치가
 * 되고, 읽는 사람은 그게 뭔가를 가른다고 믿는다.
 */
export default function InvestorNetConfig() {
  return (
    <div>
      <SignColorLegend up="순매수" down="순매도" />
      <p className="text-fg-dim text-xs mt-3">일봉(D)에서만 표시됩니다</p>
    </div>
  );
}
