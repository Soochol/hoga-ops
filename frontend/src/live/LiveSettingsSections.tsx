import { Fragment, useState, type ReactNode } from 'react';
import {
  CHART_TOGGLES,
  DAY_BOUNDARY_COLOR_DEFAULT,
  categoryOf,
  useChartPrefsStore,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import { CANDLE_DATA_PREFERENCE_OPTIONS } from '../state/candleDataPreference';
import {
  LIVE_VENUE_LABELS,
  LIVE_VENUE_OPTIONS,
  useLiveVenueStore,
  type LiveVenueOption,
} from '../state/liveVenue';
import { useLiveSettings, usePatchLiveSettings, type LiveStoragePolicy } from '../api/liveSettings';
import { MINUTE_TIMEFRAMES, useLivePageStore, type MinuteTimeframe } from '../state/livePage';
import { useStudyViewOpenPrefsStore, type StudyViewOpenTimeframe } from '../state/studyViewOpenPrefs';
import MAStylePicker from './indicators/MAStylePicker';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import { SettingsRow, ToggleSwitch } from './settings/SettingsRow';
import CandleDataPreferenceRadio from './settings/CandleDataPreferenceRadio';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';
import { DataSection } from '../ui/DataSurface';
import SignalAlertSettingsSection from '../signalAlerts/SignalAlertSettingsSection';

/**
 * The live settings body — mirrors `IndicatorPanel`'s two-column layout (left
 * category nav `w-[200px]` + right detail pane). Categories come from the
 * `CHART_TOGGLES` registry (차트) plus a 데이터소스 item; 'indicator-modal'
 * toggles are excluded (they live in the 「지표」 modal instead). Adding
 * a toggle/pref stays a one-line registry edit.
 */
type NavId = ChartToggleCategory | 'data-source' | 'study-views' | 'alerts';

const CATEGORY_ORDER: ChartToggleCategory[] = ['chart'];
const LABEL: Record<NavId, string> = {
  chart: '차트',
  'indicator-modal': '지표', // never rendered — not in CATEGORY_ORDER; kept for Record<NavId> exhaustiveness
  'data-source': '데이터소스',
  'study-views': '저장뷰',
  alerts: '알림',
};

const STORAGE_POLICY_LABEL: Record<LiveStoragePolicy, string> = {
  ws_only: 'WS만 저장',
  ws_plus_rest: 'WS 우선 + 나머지 REST 저장',
  rest_only: 'REST만 저장',
};

const STORAGE_POLICY_OPTIONS: LiveStoragePolicy[] = ['ws_only', 'ws_plus_rest', 'rest_only'];

function RoleSourceGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="mb-1 text-sm font-medium text-fg">{title}</div>
      <div className="mb-2 text-xs text-fg-dimmer">{description}</div>
      {children}
    </section>
  );
}

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
          {key === 'viLimitPriceDotsEnabled' && <ViLimitPriceLineStyleRow />}
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
    <SettingsRow
      label="날짜 구분선 스타일"
      description="거래일 경계를 표시하는 세로 점선의 색상과 두께입니다."
    >
      <MAStylePicker
        color={color}
        lineWidth={lineWidth}
        onChange={setStyle}
        label="날짜 구분선"
        extraColors={[DAY_BOUNDARY_COLOR_DEFAULT]}
      />
    </SettingsRow>
  );
}

function ViLimitPriceLineStyleRow() {
  const color = useLivePageStore((s) => s.viLimitPriceLineColor);
  const lineWidth = useLivePageStore((s) => s.viLimitPriceLineWidth);
  const setStyle = useLivePageStore((s) => s.setViLimitPriceLineStyle);

  return (
    <SettingsRow
      label="VI/상하한가 선 스타일"
      description="VI 가격대와 상한가·하한가 가격선을 표시하는 색상과 두께입니다."
    >
      <MAStylePicker
        color={color}
        lineWidth={lineWidth}
        onChange={setStyle}
        label="VI/상하한가 선"
      />
    </SettingsRow>
  );
}

function DataSourceDetail() {
  const { data } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const storagePolicy = data?.storage_policy ?? 'ws_plus_rest';
  const restAllowed = data != null && storagePolicy !== 'ws_only';
  const programTradeEnabled = data?.program_trade_storage_enabled ?? false;

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
      <SettingsRow
        label="프로그램 순매수 저장"
        description="캡처 활성 관심그룹 종목의 프로그램 순매수 시계열을 저장합니다."
        className="mb-3"
        testId="program-trade-storage-row"
      >
        <ToggleSwitch
          label="프로그램 순매수 저장"
          checked={programTradeEnabled && restAllowed}
          disabled={!restAllowed}
          onClick={() => patch.mutate({
            storage_policy: storagePolicy,
            program_trade_storage_enabled: !(programTradeEnabled && restAllowed),
          })}
        />
      </SettingsRow>
      <RoleSourceGroup
        title="캔들 데이터 기준"
        description="분봉·일봉·주봉·월봉 캔들에 적용됩니다. 자동은 현재 안정적인 디스크 데이터를 먼저 사용합니다."
      >
        <div className="flex flex-col gap-2">
          {CANDLE_DATA_PREFERENCE_OPTIONS.map((opt) => (
            <CandleDataPreferenceRadio key={opt} value={opt} />
          ))}
        </div>
      </RoleSourceGroup>
      <RoleSourceGroup
        title="호가·체결 데이터 기준"
        description="호가창, 체결, 거래원, 호가비, 체결강도 같은 보조 데이터에 적용됩니다."
      >
        <div className="flex flex-col gap-2">
          {SOURCE_OPTIONS.map((opt) => (
            <SourcePreferenceRadio key={opt} value={opt} />
          ))}
        </div>
      </RoleSourceGroup>
      <RoleSourceGroup
        title="스크리너 일봉 데이터"
        description="스크리너 갱신으로 저장되는 KIS 일봉 parquet입니다. 조건검색과 섹터 랭킹의 기준 데이터로 사용됩니다."
      >
        <div className="text-sm text-fg-dim">
          갱신은 스크리너 화면의 데이터 갱신 버튼에서 실행합니다.
        </div>
      </RoleSourceGroup>
      <div className="text-xs text-fg-dimmer">
        차트 상단 칩은 실제 렌더링에 사용된 source를 표시합니다.
      </div>
    </>
  );
}

function minuteLabel(value: MinuteTimeframe): string {
  return `${value.slice(0, -1)}분`;
}

function studyViewOpenTimeframeLabel(value: StudyViewOpenTimeframe): string {
  return value === 'saved' ? '저장된 분봉' : minuteLabel(value);
}

function StudyViewsDetail() {
  const defaultTimeframe = useStudyViewOpenPrefsStore((s) => s.defaultTimeframe);
  const setDefaultTimeframe = useStudyViewOpenPrefsStore((s) => s.setDefaultTimeframe);

  return (
    <>
      <div className="mb-1 text-sm text-fg-dim">저장뷰 사이드 메뉴</div>
      <div className="mb-md text-xs text-fg-dimmer">
        오른쪽 저장뷰 패널에서 저장뷰를 열 때 적용할 기본 분봉입니다.
      </div>
      <div className="flex flex-wrap gap-2">
        {(['saved', ...MINUTE_TIMEFRAMES] as StudyViewOpenTimeframe[]).map((value) => {
          const checked = defaultTimeframe === value;
          return (
            <label
              key={value}
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
                name="study-view-open-timeframe"
                value={value}
                checked={checked}
                onChange={() => setDefaultTimeframe(value)}
              />
              <span>{studyViewOpenTimeframeLabel(value)}</span>
            </label>
          );
        })}
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
        onChange={() => patch.mutate({
          storage_policy: value,
          program_trade_storage_enabled: value === 'ws_only'
            ? false
            : (data?.program_trade_storage_enabled ?? false),
        })}
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
    'study-views',
    'alerts',
  ];
  const [selected, setSelected] = useState<NavId>(navIds[0]);

  return (
    <div className="grid min-h-0 grid-cols-[200px_minmax(0,1fr)]">
      <nav className="overflow-y-auto py-2 border-r border-border bg-bg-card" aria-label="설정 카테고리">
        {navIds.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`settings-nav-${id}`}
            aria-current={selected === id ? 'true' : undefined}
            onClick={() => setSelected(id)}
            className={`flex w-full items-center justify-between rounded-none border-l-2 px-4 py-2 text-left text-sm transition-colors ${
              selected === id
                ? 'border-accent bg-tint-selection text-fg'
                : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            {LABEL[id]}
          </button>
        ))}
      </nav>
      <div className="min-h-0 overflow-y-auto" data-settings-detail={selected}>
        <DataSection title={LABEL[selected]} contentClassName="space-y-3 p-4">
          {selected === 'data-source'
            ? <DataSourceDetail />
            : selected === 'study-views'
              ? <StudyViewsDetail />
              : selected === 'alerts'
                ? <SignalAlertSettingsSection />
                : <CategoryDetail category={selected} />}
        </DataSection>
      </div>
    </div>
  );
}
