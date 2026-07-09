import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import ToggleRow from '../settings/ToggleRow';
import MAStylePicker from './MAStylePicker';
import { useLivePageStore } from '../../state/livePage';

/** 총잔량 상세 — 매수/매도 호가 총잔량 라인 범례 + 현재값 수평선 + 급증 마커 설정.
 *  동작설정(급증 마커·문턱)은 chartPrefs에 저장(렌더 위치만 ⚙️→지표 모달 이동). */
export default function QuoteTotalsConfig() {
  const levelEnabled = useLivePageStore((s) => s.quoteTotalsLevelLineEnabled);
  const setLevelEnabled = useLivePageStore((s) => s.setQuoteTotalsLevelLineEnabled);
  const bidColor = useLivePageStore((s) => s.quoteTotalsBidLevelColor);
  const bidWidth = useLivePageStore((s) => s.quoteTotalsBidLevelWidth);
  const bidStyle = useLivePageStore((s) => s.quoteTotalsBidLevelStyle);
  const setBidStyle = useLivePageStore((s) => s.setQuoteTotalsBidLevelStyle);
  const askColor = useLivePageStore((s) => s.quoteTotalsAskLevelColor);
  const askWidth = useLivePageStore((s) => s.quoteTotalsAskLevelWidth);
  const askStyle = useLivePageStore((s) => s.quoteTotalsAskLevelStyle);
  const setAskStyle = useLivePageStore((s) => s.setQuoteTotalsAskLevelStyle);
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
      <ToggleRow
        label="현재값 수평선"
        description="현재 매수·매도 총잔량 값에 수평 기준선을 그립니다."
        checked={levelEnabled}
        onToggle={() => setLevelEnabled(!levelEnabled)}
        testId="settings-toggle-quoteTotalsLevelLineEnabled"
      />
      {levelEnabled && (
        <div className="space-y-2 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg">매수 수평선</span>
            <MAStylePicker
              color={bidColor}
              lineWidth={bidWidth}
              lineStyle={bidStyle}
              onChange={setBidStyle}
              onLineStyleChange={(lineStyle) => setBidStyle({ lineStyle })}
              label="매수 수평선"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg">매도 수평선</span>
            <MAStylePicker
              color={askColor}
              lineWidth={askWidth}
              lineStyle={askStyle}
              onChange={setAskStyle}
              onLineStyleChange={(lineStyle) => setAskStyle({ lineStyle })}
              label="매도 수평선"
            />
          </div>
        </div>
      )}
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['surgeMarkerEnabled', 'quoteTotalsIntraMax']} />
    </div>
  );
}
