import { Fragment, useState } from 'react';
import {
  CHART_TOGGLES,
  categoryOf,
  useChartPrefsStore,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import MAStylePicker from './indicators/MAStylePicker';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';

/**
 * The live settings body — mirrors `IndicatorPanel`'s two-column layout (left
 * category nav `w-[200px]` + right detail pane). Categories come from the
 * `CHART_TOGGLES` registry (차트) plus a 데이터소스 item; 'indicator-modal'
 * toggles are excluded (they live in the 「지표」 modal instead). Adding
 * a toggle/pref stays a one-line registry edit.
 */
type NavId = ChartToggleCategory | 'data-source';

const CATEGORY_ORDER: ChartToggleCategory[] = ['chart'];
const LABEL: Record<NavId, string> = {
  chart: '차트',
  'indicator-modal': '지표', // never rendered — not in CATEGORY_ORDER; kept for Record<NavId> exhaustiveness
  'data-source': '데이터소스',
};

function CategoryDetail({ category }: { category: ChartToggleCategory }) {
  const keys = CHART_TOGGLES
    .filter((t) => categoryOf(t) === category)
    .map((t) => t.key);

  if (category !== 'chart') {
    return <IndicatorPrefRows toggleKeys={keys} />;
  }

  return (
    <>
      {keys.map((key, idx) => (
        <Fragment key={key}>
          {idx > 0 && <div className="border-b border-border my-2" />}
          <IndicatorPrefRows toggleKeys={[key]} />
          {key === 'dayBoundaryEnabled' && <DayBoundaryStyleRow />}
        </Fragment>
      ))}
    </>
  );
}

function DayBoundaryStyleRow() {
  const color = useChartPrefsStore((s) => s.dayBoundaryColor);
  const lineWidth = useChartPrefsStore((s) => s.dayBoundaryLineWidth);
  const setStyle = useChartPrefsStore((s) => s.setDayBoundaryStyle);

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">날짜 구분선 스타일</div>
        <div className="text-fg-dim text-xs mt-0.5">
          거래일 경계를 표시하는 세로 점선의 색상과 두께입니다.
        </div>
      </div>
      <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="날짜 구분선" />
    </div>
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
