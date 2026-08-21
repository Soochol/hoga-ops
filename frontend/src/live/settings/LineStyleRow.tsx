import {
  lineStyleDescription,
  useScopedChartPrefs,
  useChartPrefsStore,
  type ChartLineStyleKey,
  type ChartLineWidth,
  type LineStylePrefDef,
} from '../../state/chartPrefs';
import { resolvePriceDirectionColor } from '../../chart/priceDirectionTokens';
import MAStylePicker from '../indicators/MAStylePicker';
import { SettingsRow } from './SettingsRow';

/**
 * `CHART_LINE_STYLES` 한 엔트리의 색·두께 행. `NumericPrefRow` 의 자매 — 게이트 토글이
 * 꺼져 있으면 dim 되고(값은 보존), `IndicatorPrefRows` 가 `enabledBy` 를 보고 그 토글
 * 아래 들여쓰기로 렌더한다.
 *
 * **색 `''` 는 "고르지 않음"** 이라 화면엔 방향색으로 보여야 한다. 그래서 픽커에는
 * 해석된 색을 넘기고 저장은 사용자가 실제로 고른 값만 한다 — 픽커에 `''` 를 그대로
 * 넘기면 스와치가 빈 색으로 뜬다. 방향색을 `extraColors` 첫 줄에 실어 "기본색으로
 * 되돌리기" 를 한 번의 클릭으로 만들되, 그 클릭은 hex 를 굳히므로 이후로는 테마
 * 전환을 따라가지 않는다(설명 문구가 그 사실을 말한다).
 */
export default function LineStyleRow({ def }: { def: LineStylePrefDef }) {
  const prefs = useScopedChartPrefs();
  const setLineStyle = useChartPrefsStore((s) => s.setLineStyle);
  const key = def.key as ChartLineStyleKey;
  const gateOpen = prefs[def.enabledBy];
  const stored = prefs[`${key}Color` as keyof typeof prefs] as string;
  const width = prefs[`${key}Width` as keyof typeof prefs] as ChartLineWidth;
  const directionColor = resolvePriceDirectionColor(def.direction);

  return (
    <SettingsRow
      label={`${def.label} 스타일`}
      description={lineStyleDescription(def)}
      disabled={!gateOpen}
      testId={`settings-linestyle-${key}`}
    >
      <MAStylePicker
        color={stored || directionColor}
        lineWidth={width}
        onChange={(patch) => setLineStyle(key, patch)}
        label={def.label}
        extraColors={[directionColor]}
      />
    </SettingsRow>
  );
}
