import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

// Detail pane for the 거래량 (volume) indicator. Volume bars are sign-colored
// and have no per-slot configuration (unlike MovingAverageConfig), so this is
// an informational page; the on/off control is the category checkbox.
export default function VolumeConfig() {
  return (
    <div>
      <SignColorLegend up="상승봉" down="하락봉" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['volumeFillStrengthCumulative']} />
    </div>
  );
}
