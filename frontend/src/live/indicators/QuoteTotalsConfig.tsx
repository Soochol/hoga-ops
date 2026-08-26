import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import ToggleRow from '../settings/ToggleRow';
import MAStylePicker from './MAStylePicker';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 총잔량 상세 — 매수/매도 호가 총잔량 라인 범례 + 현재값 수평선 + 급증 마커 설정.
 *  동작설정(급증 마커·문턱)은 chartPrefs에 저장(렌더 위치만 ⚙️→지표 모달 이동). */
export default function QuoteTotalsConfig() {
  const levelEnabled = useWindowIndicator((s) => s.quoteTotalsLevelLineEnabled);
  const setLevelEnabled = useIndicatorActions().setQuoteTotalsLevelLineEnabled;
  const bidColor = useWindowIndicator((s) => s.quoteTotalsBidLevelColor);
  const bidWidth = useWindowIndicator((s) => s.quoteTotalsBidLevelWidth);
  const bidStyle = useWindowIndicator((s) => s.quoteTotalsBidLevelStyle);
  const setBidStyle = useIndicatorActions().setQuoteTotalsBidLevelStyle;
  const askColor = useWindowIndicator((s) => s.quoteTotalsAskLevelColor);
  const askWidth = useWindowIndicator((s) => s.quoteTotalsAskLevelWidth);
  const askStyle = useWindowIndicator((s) => s.quoteTotalsAskLevelStyle);
  const setAskStyle = useIndicatorActions().setQuoteTotalsAskLevelStyle;
  const dayMaxEnabled = useWindowIndicator((s) => s.quoteTotalsDayMaxLineEnabled);
  const setDayMaxEnabled = useIndicatorActions().setQuoteTotalsDayMaxLineEnabled;
  const dayMaxBidColor = useWindowIndicator((s) => s.quoteTotalsDayMaxBidColor);
  const dayMaxBidWidth = useWindowIndicator((s) => s.quoteTotalsDayMaxBidWidth);
  const dayMaxBidStyle = useWindowIndicator((s) => s.quoteTotalsDayMaxBidStyle);
  const setDayMaxBidStyle = useIndicatorActions().setQuoteTotalsDayMaxBidStyle;
  const dayMaxAskColor = useWindowIndicator((s) => s.quoteTotalsDayMaxAskColor);
  const dayMaxAskWidth = useWindowIndicator((s) => s.quoteTotalsDayMaxAskWidth);
  const dayMaxAskStyle = useWindowIndicator((s) => s.quoteTotalsDayMaxAskStyle);
  const setDayMaxAskStyle = useIndicatorActions().setQuoteTotalsDayMaxAskStyle;
  return (
    <div>
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
      <ToggleRow
        label="당일 최고 수평선"
        description="마지막 거래일에 매수·매도 총잔량이 최고였던 값에 수평 기준선을 그립니다. 장중에는 당일 기준이고, 장 마감 후·주말에는 직전 거래일 기준선이 날짜와 함께 남습니다. 마감 동시호가 구간은 제외합니다."
        checked={dayMaxEnabled}
        onToggle={() => setDayMaxEnabled(!dayMaxEnabled)}
        testId="settings-toggle-quoteTotalsDayMaxLineEnabled"
      />
      {dayMaxEnabled && (
        <div className="space-y-2 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg">매수 최고선</span>
            <MAStylePicker
              color={dayMaxBidColor}
              lineWidth={dayMaxBidWidth}
              lineStyle={dayMaxBidStyle}
              onChange={setDayMaxBidStyle}
              onLineStyleChange={(lineStyle) => setDayMaxBidStyle({ lineStyle })}
              label="매수 최고선"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg">매도 최고선</span>
            <MAStylePicker
              color={dayMaxAskColor}
              lineWidth={dayMaxAskWidth}
              lineStyle={dayMaxAskStyle}
              onChange={setDayMaxAskStyle}
              onLineStyleChange={(lineStyle) => setDayMaxAskStyle({ lineStyle })}
              label="매도 최고선"
            />
          </div>
        </div>
      )}      <div className="border-b border-border my-3" />
      {/* 호가단위 보정은 급증 마커의 하위 설정이라(enabledBy: surgeMarkerEnabled)
          바로 뒤에 온다. 행 순서는 이 배열이 아니라 CHART_TOGGLES 등록 순서를 따른다. */}
      <IndicatorPrefRows
        toggleKeys={['surgeMarkerEnabled', 'quoteTotalsTickNormalize', 'quoteTotalsIntraMax']}
      />
    </div>
  );
}
