import { Fragment, useState } from 'react';
import {
  CHART_TOGGLES,
  DAY_BOUNDARY_COLOR_DEFAULT,
  TRADE_HIGHLIGHT_COLOR_DEFAULT,
  categoryOf,
  gatedByOf,
  useChartPrefsStore,
  type ChartToggleCategory,
} from '../state/chartPrefs';
import MAStylePicker from './indicators/MAStylePicker';
import ColorSwatchPicker from './indicators/ColorSwatchPicker';
import IndicatorPrefRows from './settings/IndicatorPrefRows';
import { SettingsRow } from './settings/SettingsRow';
import { DataSourceDetail } from './settings/DataSourceDetail';
import {
  GeneralSection,
  RoadmapSection,
  SymbolMasterSection,
  ThemeSection,
} from './settings/AppInfoSections';
import SignalAlertSettingsSection from '../signalAlerts/SignalAlertSettingsSection';
import { WORKSPACE_DRAWER_SHELL_CLASS } from './workspaceDrawer';

/**
 * 앱의 **유일한** 설정 본체 — 좌측 카테고리 nav 240px + 우측 상세(지표 드로어와 동일
 * 폭이라 툴바에서 보조지표↔설정을 오가도 nav가 흔들리지 않는다). 차트 카테고리는
 * `CHART_TOGGLES` 레지스트리에서 오고('indicator-modal' 은 제외 — 그건 「지표」
 * 모달 소관), 나머지는 아래 고정 항목이다. 토글/pref 추가는 여전히 레지스트리 한 줄.
 *
 * 원래 설정 표면이 **둘**이었다 — 여기(차트 드로어)와 `pages/Settings` 의 앱 설정
 * 모달. 둘은 셸 마크업·testId 규칙·행 컴포넌트를 이미 공유하면서 nav 목록과 셸 상수만
 * 갈라져 있었고, 같은 값에 대해 서로 다른 이야기를 하는 지점까지 생겼다(자세한 사연은
 * `DataSourceDetail` 헤더). 이제 진입점(TopNav ⚙ · `/live`·`/study` 툴바 ⚙ · 캔들
 * 빈 상태 · `/settings` 라우트)이 전부 이 컴포넌트를 연다.
 *
 * `variant` 는 **체결창 nav 하나**만 가른다(아래). 데이터소스가 쓰던 분기는 삭제됐다 —
 * 값이 전역인데 화면마다 숨기면 어느 문으로 들어왔는지에 답이 달라지기 때문이다.
 */
type NavId =
  | ChartToggleCategory
  | 'data-source'
  | 'alerts'
  | 'theme'
  | 'symbols'
  | 'general'
  | 'roadmap';

const CATEGORY_ORDER: ChartToggleCategory[] = ['chart', 'trade-window'];
const LABEL: Record<NavId, string> = {
  chart: '차트',
  'indicator-modal': '지표', // never rendered — not in CATEGORY_ORDER; kept for Record<NavId> exhaustiveness
  'trade-window': '체결창',
  'data-source': '데이터소스',
  alerts: '알림',
  theme: '테마',
  symbols: 'Symbol Master',
  general: '앱 정보',
  roadmap: '로드맵',
};

/** nav id → 상세 패널. 차트 토글 카테고리는 레지스트리 주도라 `default` 로 떨어진다
 *  (리터럴 케이스를 모두 처리했으므로 TS 가 `ChartToggleCategory` 로 좁혀 준다). */
function SectionDetail({ id }: { id: NavId }) {
  switch (id) {
    case 'data-source':
      return <DataSourceDetail />;
    case 'alerts':
      return <SignalAlertSettingsSection />;
    case 'theme':
      return <ThemeSection />;
    case 'symbols':
      return <SymbolMasterSection />;
    case 'general':
      return <GeneralSection />;
    case 'roadmap':
      return <RoadmapSection />;
    default:
      return <CategoryDetail category={id} />;
  }
}

function CategoryDetail({ category }: { category: ChartToggleCategory }) {
  // `enabledBy` 로 부모를 가진 토글은 뺀다 — `IndicatorPrefRows` 가 부모 행 아래
  // 들여쓰기로 그리므로, 여기 남겨 두면 같은 행이 두 번 나온다.
  const keys = CHART_TOGGLES
    .filter((t) => categoryOf(t) === category && gatedByOf(t) === undefined)
    .map((t) => t.key);

  if (category === 'indicator-modal') {
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
          {key === 'tradeHighlightEnabled' && <TradeHighlightColorRow />}
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
      description="거래일 경계를 표시하는 세로 점선의 색상과 두께입니다"
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

function TradeHighlightColorRow() {
  const color = useChartPrefsStore((s) => s.tradeHighlightColor);
  const enabled = useChartPrefsStore((s) => s.tradeHighlightEnabled);
  const setColor = useChartPrefsStore((s) => s.setTradeHighlightColor);

  // 기준 금액(NumericPrefRow)과 같은 enabledBy 게이트 시맨틱 — 토글 OFF 면 dim.
  return (
    <div className={`ml-4 ${enabled ? '' : 'pointer-events-none opacity-40'}`}>
      <SettingsRow
        label="강조 배경색"
        description="대량 체결의 체결량 칸에 칠할 배경색입니다"
      >
        <ColorSwatchPicker
          label="대량 체결 강조 배경색"
          color={color}
          onChange={setColor}
          extraColors={[TRADE_HIGHLIGHT_COLOR_DEFAULT]}
        />
      </SettingsRow>
    </div>
  );
}

function ViLimitPriceLineStyleRow() {
  // 자기 토글(viLimitPriceDotsEnabled)과 같은 전역 스토어 — 원래는 스타일만
  // 지표 버킷(창×봉)에 있어 한 기능이 두 저장소로 쪼개져 있었다(#759 구현 중
  // 발견). 이 행이 전역이 되면서 설정 모달에 창 소유 필드가 하나도 남지 않는다.
  const color = useChartPrefsStore((s) => s.viLimitPriceLineColor);
  const lineWidth = useChartPrefsStore((s) => s.viLimitPriceLineWidth);
  const setStyle = useChartPrefsStore((s) => s.setViLimitPriceLineStyle);

  return (
    <SettingsRow
      label="VI/상하한가 선 스타일"
      description="VI 가격대와 상한가·하한가 가격선을 표시하는 색상과 두께입니다"
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

// 여기 있던 「저장뷰」 섹션(저장뷰를 열 때 적용할 기본 분봉)은 #1326 에서 제거됐다.
// 차트 창이 봉의 유일한 소유자가 되면서 그 설정이 정할 것이 없어졌다 — 저장뷰는
// 종목과 구간만 정한다. 근거와 버려진 trade-off 는 그 PR 에 있다.

export default function SettingsSections({ variant = 'live', onClose }: { variant?: 'live' | 'study'; onClose?: () => void }) {
  const navIds: NavId[] = [
    // 체결창은 /live 워크스페이스 전용 데이터 창 — 복기뷰(study) 설정에는 숨긴다.
    // **컨텍스트로 갈리는 유일한 항목**이다. 데이터소스가 쓰던 분기는 사라졌다:
    // 한때 `/live` 에서만 빼고 메인 Settings 로 보냈는데, 그 결과 `/study` 에서
    // TopNav ⚙ 와 툴바 ⚙ 가 같은 값에 대해 서로 다른 화면을 보여줬다.
    ...CATEGORY_ORDER.filter((c) => (variant === 'live' || c !== 'trade-window')
      && CHART_TOGGLES.some((t) => categoryOf(t) === c)),
    'alerts',
    'data-source',
    'theme',
    'symbols',
    'general',
    'roadmap',
  ];
  const [selected, setSelected] = useState<NavId>(navIds[0]);

  // 지표 드로어와 동일한 크롬(ADR-0116, 우측 드로어): 전폭 헤더 바·푸터 없이 nav+콘텐츠가
  // 드로어를 edge-to-edge로 채우고, 섹션 제목과 닫기 X는 콘텐츠 헤더가 담당.
  // nav↔콘텐츠 분리는 bg-subtle↔bg-card 톤 스텝. rounded-lg는 ModalShell 반경에 맞춰 클립.
  return (
    <div
      data-testid="settings-shell"
      className={WORKSPACE_DRAWER_SHELL_CLASS}
    >
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
      <div className="flex min-h-0 flex-col" data-settings-detail={selected}>
        <header className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-lg font-semibold text-fg">{LABEL[selected]}</h2>
          {onClose && (
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              className="-mr-1 px-1 text-lg leading-none text-fg-dim transition-colors hover:text-fg"
            >
              ✕
            </button>
          )}
        </header>
        <section aria-label={LABEL[selected]} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
          <SectionDetail id={selected} />
        </section>
      </div>
    </div>
  );
}
