import { Fragment } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  type ChartToggleKey,
} from '../../state/chartPrefs';
import ToggleRow from './ToggleRow';
import NumericPrefRow from './NumericPrefRow';

/**
 * 주어진 토글 키 목록을 `ToggleRow` + (enabledBy로 묶인) `NumericPrefRow`로
 * 렌더한다. 「설정」 모달(CategoryDetail)과 「지표」 모달의 호가 Config가 동일한
 * 행 디자인을 공유하도록 추출한 단일 소스. 키 순서가 아니라 CHART_TOGGLES
 * 등록 순서를 따른다(기존 CategoryDetail 동작 유지).
 */
export default function IndicatorPrefRows({
  toggleKeys,
}: {
  toggleKeys: readonly ChartToggleKey[];
}) {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);
  const keySet = new Set<string>(toggleKeys);
  const toggles = CHART_TOGGLES.filter((t) => keySet.has(t.key));
  return (
    <>
      {toggles.map((toggle, idx) => {
        const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => (
          'enabledBy' in p && p.enabledBy === toggle.key
        ));
        return (
          <Fragment key={toggle.key}>
            <ToggleRow
              label={toggle.label}
              description={toggle.description}
              checked={prefs[toggle.key]}
              onToggle={() => setToggle(toggle.key, !prefs[toggle.key])}
              testId={`settings-toggle-${toggle.key}`}
            />
            {gatedNumerics.length > 0 && (
              <div className="ml-4">
                {gatedNumerics.map((def) => (
                  <NumericPrefRow key={def.key} def={def} />
                ))}
              </div>
            )}
            {idx < toggles.length - 1 && <div className="my-1" />}
          </Fragment>
        );
      })}
    </>
  );
}
