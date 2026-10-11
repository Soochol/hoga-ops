import SignColorLegend from './SignColorLegend';

export default function TradeValueConfig() {
  return (
    <div>
      <SignColorLegend up="상승봉" down="하락봉" />
      <p className="mt-3 text-xs text-fg-dim">일봉·주봉·월봉의 거래대금을 억·조 단위로 표시합니다.</p>
    </div>
  );
}
