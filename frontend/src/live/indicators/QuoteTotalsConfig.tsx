import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

/** 총잔량 상세 — 매수/매도 호가 총잔량 라인 범례 + 급증 마커 설정.
 *  동작설정(급증 마커·문턱)은 chartPrefs에 저장(렌더 위치만 ⚙️→지표 모달 이동). */
export default function QuoteTotalsConfig() {
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        총잔량 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        해당 분봉 시점의 매수·매도 호가 총잔량을 라인으로 표시합니다.
      </p>
      <SignColorLegend up="매수 총잔량" down="매도 총잔량" />
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['surgeMarkerEnabled', 'quoteTotalsIntraMax']} />
    </div>
  );
}
