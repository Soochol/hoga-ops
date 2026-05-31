import SignColorLegend from './SignColorLegend';

// Detail pane for the 거래량 (volume) indicator. Volume bars are sign-colored
// and have no per-slot configuration (unlike MovingAverageConfig), so this is
// an informational page; the on/off control is the category checkbox.
export default function VolumeConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        거래량 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        해당 봉 동안 체결된 거래량을 막대로 표시합니다.
      </p>
      <SignColorLegend up="상승봉" down="하락봉" />
    </div>
  );
}
