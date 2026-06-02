import SignColorLegend from './SignColorLegend';

type Props = {
  which: 'foreign' | 'institution';
};

// Detail pane for the 외국인 / 기관 순매수량 (investor net-buy) indicators.
// Sign-colored bars, no per-slot config — informational page like VolumeConfig.
// Foreign and institution differ only in label/copy, so they share this
// component (DRY) parameterized by `which`.
export default function InvestorNetConfig({ which }: Props) {
  const who = which === 'foreign' ? '외국인' : '기관';
  const label = `${who} 순매수량`;
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        {label} <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        일자별 {who}의 순매수 수량(매수 − 매도)을 막대로 표시합니다.
      </p>
      <SignColorLegend up="순매수" down="순매도" />
      <p className="text-fg-dimmer text-xs mt-3">일봉(D)에서만 표시됩니다.</p>
    </div>
  );
}
