import { Fragment } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  categoryOf,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import ToggleRow from './settings/ToggleRow';
import NumericPrefRow from './settings/NumericPrefRow';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';

/**
 * The registry-driven body of the live settings surface: every `CHART_TOGGLES`
 * category as its own labelled section (with `enabledBy` numeric prefs indented
 * under their parent toggle), followed by the data-source picker. Shared by the
 * left settings panel; adding a toggle/pref stays a one-line registry edit.
 *
 * Unlike the retired modal (which rendered only the 'chart' category), this
 * renders ALL categories — 보조지표 / 총잔량 급증 / 차트.
 */
const CATEGORY_ORDER: ChartToggleCategory[] = ['indicators', 'surge', 'chart'];
const CATEGORY_LABEL: Record<ChartToggleCategory, string> = {
  indicators: '보조지표',
  surge: '총잔량 급증',
  chart: '차트',
};

export default function LiveSettingsSections() {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);

  return (
    <div className="px-5 py-4">
      {CATEGORY_ORDER.map((cat) => {
        const toggles = CHART_TOGGLES.filter((t) => categoryOf(t) === cat);
        if (toggles.length === 0) return null;
        return (
          <section key={cat} data-settings-category={cat} style={{ marginBottom: 'var(--space-md)' }}>
            <div
              style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}
            >
              {CATEGORY_LABEL[cat]}
            </div>
            {toggles.map((toggle) => {
              const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === toggle.key);
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
                </Fragment>
              );
            })}
          </section>
        );
      })}
      <div className="border-b border-border my-2" />
      <div style={{ marginTop: 'var(--space-md)' }}>
        <div
          style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}
        >
          기본 데이터 소스 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          {SOURCE_OPTIONS.map((opt) => (
            <SourcePreferenceRadio key={opt} value={opt} />
          ))}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dimmer)', marginTop: 'var(--space-xs)' }}>
          현재 source는 차트 상단 칩에 표시됩니다.
        </div>
      </div>
    </div>
  );
}
