import { Fragment, useState } from 'react';
import {
  CHART_TOGGLES,
  DAY_BOUNDARY_COLOR_DEFAULT,
  categoryOf,
  useChartPrefsStore,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import {
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  useLiveVenueStore,
  type LiveVenueOption,
} from '../state/liveVenue';
import { useLiveSettings, usePatchLiveSettings, type LiveStoragePolicy } from '../api/liveSettings';
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

const STORAGE_POLICY_LABEL: Record<LiveStoragePolicy, string> = {
  ws_only: 'WS만 저장',
  ws_plus_rest: 'WS 우선 + 나머지 REST 저장',
  rest_only: 'REST만 저장',
};

const STORAGE_POLICY_OPTIONS: LiveStoragePolicy[] = ['ws_only', 'ws_plus_rest', 'rest_only'];

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
      <MAStylePicker
        color={color}
        lineWidth={lineWidth}
        onChange={setStyle}
        label="날짜 구분선"
        extraColors={[DAY_BOUNDARY_COLOR_DEFAULT]}
      />
    </div>
  );
}

function DataSourceDetail() {
  return (
    <>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        KIS 캔들 거래소
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)' }}>
        {LIVE_VENUE_OPTIONS.map((opt) => (
          <LiveVenueRadio key={opt} value={opt} />
        ))}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        데이터 저장 방식
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)' }}>
        {STORAGE_POLICY_OPTIONS.map((opt) => (
          <StoragePolicyRadio key={opt} value={opt} />
        ))}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        데이터 표현 기준 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
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

function StoragePolicyRadio({ value }: { value: LiveStoragePolicy }) {
  const { data } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const checked = (data?.storage_policy ?? 'ws_plus_rest') === value;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="live-storage-policy"
        value={value}
        checked={checked}
        onChange={() => patch.mutate(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
        {STORAGE_POLICY_LABEL[value]}
      </span>
    </label>
  );
}

function LiveVenueRadio({ value }: { value: LiveVenueOption }) {
  const venue = useLiveVenueStore((s) => s.venue);
  const setVenue = useLiveVenueStore((s) => s.setVenue);
  const checked = venue === value;
  return (
    <label
      className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
      style={{
        borderColor: checked ? 'var(--accent)' : 'var(--border)',
        background: checked ? 'var(--bg-input)' : 'transparent',
        color: checked ? 'var(--fg)' : 'var(--fg-dim)',
        outlineColor: 'var(--accent)',
      }}
    >
      <input
        type="radio"
        name="live-kis-venue"
        value={value}
        checked={checked}
        onChange={() => setVenue(value)}
        data-testid={`live-venue-${value}`}
      />
      <span>{LIVE_VENUE_LABELS[value]}</span>
    </label>
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
