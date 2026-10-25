import { useWindowIndicatorTimeframe } from '../workspace/windowView';
import SignColorLegend from './SignColorLegend';
import LineVisibilityRow, { LineDisplayRow } from './LineVisibilityRow';
import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';

/** 체결강도 상세 — 매수/매도 체결량 범례 + 당일 누적선 설정. */
export default function FillStrengthConfig() {
  const seconds = useWindowIndicatorTimeframe()?.endsWith('s') ?? false;
  const cumulative = useScopedChartPrefs().fillStrengthCumulative;
  const { setToggle } = useChartPrefActions();
  return (
    <div>
      <SignColorLegend up="매수 체결" down="매도 체결" />
      <LineVisibilityRow lineKey="fillStrengthBuy" label="매수 체결" />
      <LineVisibilityRow lineKey="fillStrengthSell" label="매도 체결" />
      <div className="border-b border-border my-3" />
      {seconds ? <p className="text-xs text-fg-dim">표시 구간의 관측 매수·매도 체결량입니다. 방향 미확인·단일가 체결과 미수집 구간은 제외합니다.</p> : <LineDisplayRow label="당일 누적선" checked={cumulative} onToggle={() => setToggle('fillStrengthCumulative', !cumulative)}
        testId="settings-toggle-fillStrengthCumulative" />}
    </div>
  );
}
