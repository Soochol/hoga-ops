import { Fragment, useState } from 'react';
import {
  CHART_TOGGLES,
  DAY_BOUNDARY_COLOR_DEFAULT,
  categoryOf,
  useChartPrefsStore,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import { MINUTE_TIMEFRAMES, useLivePageStore, type MinuteTimeframe } from '../state/livePage';
import { useStudyViewOpenPrefsStore, type StudyViewOpenTimeframe } from '../state/studyViewOpenPrefs';
import MAStylePicker from './indicators/MAStylePicker';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import { SettingsRow } from './settings/SettingsRow';
import { DataSourceDetail } from './settings/DataSourceDetail';
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

export default function LiveSettingsSections({ variant = 'live' }: { variant?: 'live' | 'study' }) {
  const navIds: NavId[] = [
    ...CATEGORY_ORDER.filter((c) => CHART_TOGGLES.some((t) => categoryOf(t) === c)),
    // 'data-source'는 라이브 워크스페이스에선 메인 Settings(「데이터 소스」)로 이동했다.
    // 복기뷰(study)는 캔들 디스크-온리 등 전용 안내가 있어 이 모달에 유지한다.
    ...(variant === 'study' ? (['data-source'] as const) : []),
    'study-views',
    'alerts',
  ];
  const [selected, setSelected] = useState<NavId>(navIds[0]);

  return (
    <div className="grid min-h-0 grid-cols-[200px_minmax(0,1fr)]">
      {/* nav↔콘텐츠 분리는 border-r가 아니라 bg-subtle↔bg-card 톤 스텝이 담당(2026-07-15
          borderless 규칙). 선택은 좌측 accent 보더 대신 둥근 pill. */}
      <nav className="space-y-0.5 overflow-y-auto bg-bg-subtle p-2" aria-label="설정 카테고리">
        {navIds.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`settings-nav-${id}`}
            aria-current={selected === id ? 'true' : undefined}
            onClick={() => setSelected(id)}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selected === id
                ? 'bg-tint-selection font-medium text-fg'
                : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            {LABEL[id]}
          </button>
        ))}
      </nav>
      <div className="min-h-0 overflow-y-auto" data-settings-detail={selected}>
        <DataSection title={LABEL[selected]} contentClassName="space-y-3 p-4">
          {selected === 'data-source'
            ? <DataSourceDetail variant={variant} />
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
