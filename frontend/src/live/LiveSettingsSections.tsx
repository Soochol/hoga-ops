import { Fragment, useState } from 'react';
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
 * The live settings body — mirrors `IndicatorPanel`'s two-column layout (left
 * category nav `w-[200px]` + right detail pane). Categories come from the
 * `CHART_TOGGLES` registry (보조지표 / 총잔량 급증 / 차트) plus a 데이터소스 item;
 * the selected category's toggles + `enabledBy` numerics render on the right via
 * the same `ToggleRow`/`NumericPrefRow`/`SourcePreferenceRadio` as before. Adding
 * a toggle/pref stays a one-line registry edit.
 */
type NavId = ChartToggleCategory | 'data-source';

const CATEGORY_ORDER: ChartToggleCategory[] = ['indicators', 'surge', 'chart'];
const LABEL: Record<NavId, string> = {
  indicators: '보조지표',
  surge: '총잔량 급증',
  chart: '차트',
  'data-source': '데이터소스',
};

function CategoryDetail({ category }: { category: ChartToggleCategory }) {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);
  const toggles = CHART_TOGGLES.filter((t) => categoryOf(t) === category);
  return (
    <>
      {toggles.map((toggle, idx) => {
        const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === toggle.key);
        return (
          <Fragment key={toggle.key}>
            {idx > 0 && <div className="border-b border-border my-2" />}
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
    </>
  );
}

function DataSourceDetail() {
  return (
    <>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
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
    </>
  );
}

export default function LiveSettingsSections() {
  const navIds: NavId[] = [
    ...CATEGORY_ORDER.filter((c) => CHART_TOGGLES.some((t) => categoryOf(t) === c)),
    'data-source',
  ];
  const [selected, setSelected] = useState<NavId>(navIds[0]);

  return (
    <div className="flex">
      <nav className="w-[200px] py-2 border-r border-border" aria-label="설정 카테고리">
        {navIds.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`settings-nav-${id}`}
            aria-current={selected === id ? 'true' : undefined}
            onClick={() => setSelected(id)}
            className={`block w-full text-left pl-4 pr-2 py-2 text-sm text-fg cursor-pointer ${
              selected === id ? 'bg-bg-input' : 'hover:bg-bg-input'
            }`}
          >
            {LABEL[id]}
          </button>
        ))}
      </nav>
      <div className="flex-1 px-5 py-4" data-settings-detail={selected}>
        {selected === 'data-source' ? <DataSourceDetail /> : <CategoryDetail category={selected} />}
      </div>
    </div>
  );
}
