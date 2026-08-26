import { useState, Fragment } from 'react';
import { useChartPrefActions } from '../../state/chartPrefs';
import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import MovingAverageConfig from './MovingAverageConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import InvestorNetConfig from './InvestorNetConfig';
import PeakWallsConfig from './PeakWallsConfig';
import TradeVolumePocConfig from './TradeVolumePocConfig';
import DepthHeatmapConfig from './DepthHeatmapConfig';
import WallSurgeConfig from './WallSurgeConfig';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import FillStrengthConfig from './FillStrengthConfig';
import ColorSwatchPicker from './ColorSwatchPicker';
import ProgramTradeConfig from './ProgramTradeConfig';
import BrokerLateEntryConfig from './BrokerLateEntryConfig';
import {
  pickPanePrefs,
  type PanePrefKey,
  type PanePrefsIndicatorSource,
} from './indicatorPaneProfiles';
import ToggleRow from '../settings/ToggleRow';
import { STOCK_CAPABILITIES, type LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';
import { ListRow } from '../../ui/DataSurface';
import { ModalShell } from '../../ui/ModalShell';
import {
  WORKSPACE_PANEL_WIDTH_CLASS,
  WORKSPACE_PANEL_HEIGHT_CLASS,
  WORKSPACE_PANEL_SHELL_CLASS,
} from '../workspacePanel';
import type { LiveTimeframe } from '../../state/livePage';

export type CategoryId =
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'peak-walls'
  | 'trade-volume-poc'
  | 'depth-heatmap'
  | 'wall-surge'
  | 'volume-distribution'
  | 'quote-totals'
  | 'ratio'
  | 'fill-strength'
  | 'broker-late-entry'
  | 'program-trade';

type GroupId = 'top' | 'hoga' | 'program' | 'broker';
const GROUP_LABEL: Record<GroupId, string> = {
  top: '상단 지표',
  hoga: '10호가 지표',
  program: '프로그램 지표',
  broker: '거래원 지표',
};

/** 차트의 어디에 그려지는가. 글리프가 암시하는 것을 헤더가 텍스트로 확정한다. */
type Placement = 'overlay' | 'pane';
const PLACEMENT_LABEL: Record<Placement, string> = {
  overlay: '캔들 오버레이',
  pane: '하단 패널',
};

// 드리프트 테스트(`IndicatorPanel.paneNames.test.ts`)가 pane 을 가진 항목의 라벨을
// `PANE_DISPLAY_NAME` 과 대조하므로 export 한다 — 같은 pane 을 설정 패널과 차트
// 레전드가 다르게 부르면 안 된다.
//
// `description` 은 각 Config 컴포넌트가 자기 `h3`+`p` 로 들고 있던 문장을 그대로
// 올린 것이다. 한 지표의 이름과 설명을 패널 헤더와 Config 가 각자 적고 있으면
// 언젠가 갈린다 — 미리보기 카드(아직 추가하지 않은 지표)는 Config 를 렌더하지
// 않으므로 설명이 Config 안에 있으면 **애초에 닿지도 못한다**.
export const CATEGORIES: ReadonlyArray<{
  id: CategoryId;
  label: string;
  group: GroupId;
  description: string;
  placement: Placement;
}> = [
  { id: 'moving-average',  label: '이동평균선',       group: 'top',  placement: 'overlay',
    description: '지난 n일 동안 주가 평균값을 이은 선' },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top',  placement: 'overlay',
    description: '일봉 종가 기준 이평선을 분봉 차트에 투영 · 분봉 차트에서만 표시됩니다' },
  { id: 'volume',          label: '거래량',           group: 'top',  placement: 'pane',
    description: '해당 봉 동안 체결된 거래량을 막대로 표시합니다.' },
  { id: 'quote-totals',    label: '총잔량',           group: 'hoga', placement: 'pane',
    description: '해당 분봉 시점의 매수·매도 호가 총잔량을 라인으로 표시합니다.' },
  { id: 'ratio',           label: '호가비',           group: 'hoga', placement: 'pane',
    description: '매수·매도 호가 총잔량의 불균형(우위)을 0 기준선 위아래로 표시합니다.' },
  { id: 'fill-strength',   label: '체결강도',         group: 'hoga', placement: 'pane',
    description: '해당 분봉 동안 체결된 매수·매도 물량을 막대로 표시합니다.' },
  { id: 'volume-distribution', label: '연속체결 매물대 분포', group: 'hoga', placement: 'overlay',
    description: '정규장 연속매매 체결만 집계한 가격대별 체결량 분포를 거래일 단위로 표시합니다. 가격 구간은 각 Stock-Date 캔들 저가-고가 범위를 기준으로 나눕니다.' },
  { id: 'trade-volume-poc', label: '당일 최대 매물대', group: 'hoga', placement: 'overlay',
    description: '정규장 연속매매 체결량을 연속체결 매물대 분포와 동일한 가격 구간에 누적하고, 거래량이 가장 큰 구간을 캔들 위 밴드로 표시합니다. 동시호가 제외.' },
  { id: 'peak-walls',      label: '당일 최대벽',     group: 'hoga', placement: 'overlay',
    description: '차트에 보이는 거래일마다, 그 날 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 그날 구간만큼 수평선을 그립니다. 매도·매수를 각각 설정합니다. 분봉 차트에서만 표시됩니다' },
  { id: 'depth-heatmap',   label: '호가 잔량 히트맵', group: 'hoga', placement: 'overlay',
    description: '각 분봉 시점의 10호가 매수·매도 잔량을 캔들 뒤 색상 강도로 표시합니다. 강도는 화면에 보이는 범위의 최대 잔량 기준으로 정규화됩니다. 분봉 차트에서만 표시됩니다' },
  { id: 'wall-surge',      label: '호가벽 급증',     group: 'hoga', placement: 'overlay',
    description: '한 호가 레벨에 물량이 순간적으로 몰린 지점을 캔들 차트의 그 가격 위치에 삼각형으로 표시합니다. 잔량이 많은 것이 아니라 짧은 시간에 갑자기 늘어난 것을 잡습니다. 분봉 차트에서만 표시됩니다' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker',  placement: 'pane',
    description: '일자별 외국인의 순매수 수량(매수 − 매도)을 막대로 표시합니다.' },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker',  placement: 'pane',
    description: '일자별 기관의 순매수 수량(매수 − 매도)을 막대로 표시합니다.' },
  { id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker', placement: 'overlay',
    description: '기준 시각 이후에 처음 등장한 거래원을 마커로 표시합니다. 시각대를 나눠 보려면 세트를 추가하세요.' },
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program', placement: 'pane',
    description: 'KIS REST 저장 데이터의 시간별 프로그램 누적 순매수 금액을 표시합니다.' },
];

// 모든 지표 설정이 현재 봉(분/일/주/월) 버킷에 저장되므로(#699), 카테고리별
// 스코프 칩 대신 헤더에 '현재: 분봉' 배지 하나로 스코프를 알린다(PR-C).
function timeframeLabel(tf: LiveTimeframe): string {
  if (tf === 'D') return '일봉';
  if (tf === 'W') return '주봉';
  if (tf === 'M') return '월봉';
  return '분봉';
}

const PANE_CATEGORY_TO_KEY: Partial<Record<CategoryId, PanePrefKey>> = {
  volume: 'volumeEnabled',
  'quote-totals': 'quoteTotalsEnabled',
  ratio: 'ratioEnabled',
  'fill-strength': 'fillStrengthEnabled',
  'program-trade': 'programTradeEnabled',
  'foreign-net': 'foreignNetEnabled',
  'institution-net': 'institutionNetEnabled',
};

/**
 * nav 행 하나 — "내 지표"(삭제)와 "추가 카탈로그"(추가)가 같은 형태를 쓴다.
 *
 * 어휘가 **추가/삭제 둘뿐**인 것이 이 패널의 계약이다. 종전의 체크박스(켜기/끄기)는
 * 레전드의 눈(숨김)과 뜻이 겹쳤다 — 같은 지표를 두 표면이 서로 다른 말로 조작하면
 * 사용자는 어느 쪽이 무엇을 하는지 매번 다시 배워야 한다. 지금은 **패널이 존재를,
 * 레전드가 가시성을** 맡는다.
 */
function IndicatorNavRow({ label, selected, onSelect, action }: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  action: { kind: 'add' | 'remove'; label: string; onClick: () => void };
}) {
  return (
    <ListRow
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        selected
          ? 'bg-tint-selection font-medium text-fg'
          : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`min-w-0 flex-1 cursor-pointer whitespace-nowrap text-left ${selected ? 'text-fg' : 'text-inherit'}`}
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        onClick={action.onClick}
        className="ml-3 cursor-pointer p-1.5 text-fg-dim transition-colors hover:text-fg"
      >
        {action.kind === 'add' ? '＋' : '✕'}
      </button>
    </ListRow>
  );
}

type Props = {
  onClose: () => void;
  capabilities?: LiveInstrumentCapabilities;
  timeframe: LiveTimeframe;
  /** 멀티창 대상 창 표시(#712) — "종목명" 등. 없으면 기존 단일 뷰 헤더. */
  targetLabel?: string;
  /** 이 워크스페이스가 **그리지 않는** 지표 — 목록에서 뺀다.
   *
   *  `capabilities` 와 다른 축이다: 저쪽은 "이 종목/시장에 그 데이터가 있는가"(ETF 는
   *  투자자 순매수가 없다 등)이고, 이쪽은 "이 화면이 그 지표를 렌더하는가" 다.
   *  토글만 있고 아무것도 안 그려지는 항목을 없애기 위한 것이라, 숨기는 쪽은
   *  **데이터 요청도 같이 꺼야 한다**(`/study` 는 `studyReferenceQueries` 에서 끈다). */
  hiddenCategories?: readonly CategoryId[];
};

const NO_HIDDEN_CATEGORIES: readonly CategoryId[] = [];

export default function IndicatorPanel({
  onClose,
  capabilities = STOCK_CAPABILITIES,
  timeframe,
  targetLabel,
  hiddenCategories = NO_HIDDEN_CATEGORIES,
}: Props) {
  // 창-스코프 절단(ADR-0119 C2c-2a): 읽기=대상 창의 resolve 된 설정, 쓰기=창 봉
  // 버킷. Provider 밖(/study·플립 전 /live)에서는 둘 다 전역 스토어로 폴백.
  const ind = useWindowIndicators();
  const actions = useIndicatorActions();
  // MA 계열의 마스터 토글은 슬롯의 `enabled` 로 접혔다(ADR) — 카테고리 체크박스는
  // "켜진 슬롯이 하나라도 있는가" 의 파생이고, 누르면 전 슬롯을 함께 켜고 끈다.
  const maEnabled = ind.movingAverages.some((m) => m.enabled);
  const setMaEnabled = actions.setAllMovingAveragesEnabled;
  const dailyMaEnabled = ind.dailyMovingAverages.some((m) => m.enabled);
  const setDailyMaEnabled = actions.setAllDailyMovingAveragesEnabled;
  const askPeakEnabled = ind.askPeakEnabled;
  const setAskPeakEnabled = actions.setAskPeakEnabled;
  const bidPeakEnabled = ind.bidPeakEnabled;
  const setBidPeakEnabled = actions.setBidPeakEnabled;
  const tradeVolumePocEnabled = ind.tradeVolumePocEnabled;
  const setTradeVolumePocEnabled = actions.setTradeVolumePocEnabled;
  const volumeDistributionEnabled = ind.volumeDistributionEnabled;
  const setVolumeDistributionEnabled = actions.setVolumeDistributionEnabled;
  const volumeDistributionHoverCutoffEnabled = ind.volumeDistributionHoverCutoffEnabled;
  const setVolumeDistributionHoverCutoffEnabled = actions.setVolumeDistributionHoverCutoffEnabled;
  const volumeDistributionRangeCount = ind.volumeDistributionRangeCount;
  const volumeDistributionColor = ind.volumeDistributionColor;
  const volumeDistributionMaxColor = ind.volumeDistributionMaxColor;
  const setVolumeDistributionRangeCount = actions.setVolumeDistributionRangeCount;
  const setVolumeDistributionStyle = actions.setVolumeDistributionStyle;
  const brokerLateEntryEnabled = ind.brokerLateEntries.some((e) => e.enabled);
  const setBrokerLateEntryEnabled = actions.setAllBrokerLateEntriesEnabled;
  const depthHeatmapEnabled = ind.depthHeatmapEnabled;
  const setDepthHeatmapEnabled = actions.setDepthHeatmapEnabled;
  const wallSurgeEnabled = ind.wallSurgeEnabled;
  const setWallSurgeEnabled = actions.setWallSurgeEnabled;
  const paneIndicators: PanePrefsIndicatorSource = {
    volumeEnabled: ind.volumeEnabled,
    quoteTotalsEnabled: ind.quoteTotalsEnabled,
    ratioEnabled: ind.ratioEnabled,
    fillStrengthEnabled: ind.fillStrengthEnabled,
    programTradeEnabled: ind.programTradeEnabled,
    foreignNetEnabled: ind.foreignNetEnabled,
    institutionNetEnabled: ind.institutionNetEnabled,
    peakWallPaneEnabled: ind.peakWallPaneEnabled,
  };
  const setPanePrefForTimeframe = actions.setPanePrefForTimeframe;

  const resetIndicators = actions.resetIndicators;
  // indicator-modal chartPrefs 도 이제 대상 창의 봉 버킷을 향한다 — #712 에서
  // "전역 유지"로 수용했던 비대칭은 결함이었다: 버킷은 봉별인데 어느 버킷을 볼지는
  // 포커스를 따라다니는 전역 슬롯이 정해, 창마다 엉뚱한 봉의 설정이 적용됐다.
  const { resetIndicatorModalBucket: resetChartPrefsBucket } = useChartPrefActions();

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');
  // 좌측 목록의 모드 — 내 지표(존재하는 것) / 카탈로그(추가할 수 있는 것).
  const [mode, setMode] = useState<'mine' | 'catalog'>('mine');
  // 파괴적 리셋은 인라인 2단계 확인(중첩 모달 회피). 클릭 → 확인 행 → 복원.
  const [confirmingReset, setConfirmingReset] = useState(false);

  // "현재 봉 초기화"(PR-C #699): 지표 버킷과 indicator-modal chartPrefs 버킷을
  // 현재 봉만 비운다. 차트 전반 flat(⚙️ 설정 항목)은 드로어 밖이라 건드리지 않는다.
  const handleReset = () => {
    resetIndicators();
    resetChartPrefsBucket();
    setConfirmingReset(false);
  };

  const categories = CATEGORIES.filter((c) => {
    if (hiddenCategories.includes(c.id)) return false;
    if (c.group === 'hoga' || c.group === 'program') return capabilities.hogaPanes;
    if ((c.id === 'foreign-net' || c.id === 'institution-net') && capabilities.investorNet === 'none') {
      return false;
    }
    return true;
  });
  // store 최상위 필드가 이미 현재 봉으로 resolve 된 투영(PR-A #699) — pick만 한다.
  const selectedPanePrefs = pickPanePrefs(paneIndicators);

  // Each category maps to a master on/off toggle. Investor bars have an
  // informational detail pane (legend + daily note) but no per-slot config,
  // so the left checkbox is the whole control for them.
  const checkedFor = (id: CategoryId): boolean => {
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) return selectedPanePrefs[paneKey];
    switch (id) {
      case 'moving-average': return maEnabled;
      case 'daily-moving-average': return dailyMaEnabled;
      // 병합 카테고리: 어느 한쪽이라도 켜져 있으면 checked. 마스터 토글은 둘을 함께 켠다.
      case 'peak-walls': return askPeakEnabled || bidPeakEnabled;
      case 'trade-volume-poc': return tradeVolumePocEnabled;
      case 'volume-distribution': return volumeDistributionEnabled;
      case 'depth-heatmap': return depthHeatmapEnabled;
      case 'wall-surge': return wallSurgeEnabled;
      case 'broker-late-entry': return brokerLateEntryEnabled;
      default: return false;
    }
  };
  /** 존재 토글 — 추가와 삭제가 **같은 슬롯의 반대 방향**이라 한 함수로 둔다.
   *  `null` 은 조작할 수 없는 카테고리(현재 없음 — 남겨 두는 것은 총계 방어). */
  const setPresenceFor = (id: CategoryId, present: boolean): (() => void) | null => {
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) return () => setPanePrefForTimeframe(timeframe, paneKey, present);
    switch (id) {
      case 'moving-average': return () => setMaEnabled(present);
      case 'daily-moving-average': return () => setDailyMaEnabled(present);
      // 병합 카테고리: 매도·매수를 함께 움직인다(레전드에서는 각각 별도 행이다).
      case 'peak-walls': return () => { setAskPeakEnabled(present); setBidPeakEnabled(present); };
      case 'trade-volume-poc': return () => setTradeVolumePocEnabled(present);
      case 'volume-distribution': return () => setVolumeDistributionEnabled(present);
      case 'depth-heatmap': return () => setDepthHeatmapEnabled(present);
      case 'wall-surge': return () => setWallSurgeEnabled(present);
      case 'broker-late-entry': return () => setBrokerLateEntryEnabled(present);
      default: return null;
    }
  };
  const removeFor = (id: CategoryId) => setPresenceFor(id, false);

  /** 카탈로그에서 추가 — 켜고, 그 지표의 상세로 이동하고, 목록으로 돌아간다.
   *  세 동작이 한 클릭인 이유: 추가의 목적은 "생겼다" 를 보는 것이고, 카탈로그에
   *  남아 있으면 방금 추가한 것이 어디 갔는지 확인하러 한 번 더 눌러야 한다. */
  const addFor = (id: CategoryId) => {
    setPresenceFor(id, true)?.();
    setSelected(id);
    setMode('mine');
  };

  // "내 지표" = 지금 존재하는 것, 카탈로그 = 나머지. 두 목록의 합집합이 `categories`
  // 라, 어느 쪽에도 안 나타나는 지표는 원리적으로 없다.
  const active = categories.filter((c) => checkedFor(c.id));
  const catalog = categories.filter((c) => !checkedFor(c.id));

  // 선택이 삭제되면(내 지표에서 사라지면) 남은 첫 항목으로 넘긴다 — 빈 상세를
  // 남겨 두면 "방금 지운 지표의 설정" 을 계속 보게 된다.
  // 카탈로그에서는 아직 없는 지표도 미리 볼 수 있으므로 전체에서 찾는다. "내 지표"
  // 모드에서는 선택이 삭제됐을 때 남은 첫 항목으로 넘긴다 — 빈 상세를 남겨 두면
  // "방금 지운 지표의 설정" 을 계속 보게 된다.
  const selectedCategory = mode === 'catalog'
    ? categories.find((category) => category.id === selected) ?? categories[0]
    : active.find((category) => category.id === selected) ?? active[0] ?? categories[0];
  const currentTimeframeLabel = timeframeLabel(timeframe);

  return (
    // 중앙 모달(2026-08-21 사용자 결정 — 그전에는 우측 드로어). 마스터-디테일
    // (240 nav + 디테일)과 760px 폭은 드로어 시절 그대로 승계하고, 높이만 중앙 카드가
    // 스스로 정한다(상수 docstring 에 근거). 설정 패널과 폭·높이·nav 를 공유한다.
    <ModalShell
      ariaLabel="지표"
      width={WORKSPACE_PANEL_WIDTH_CLASS}
      height={WORKSPACE_PANEL_HEIGHT_CLASS}
      onClose={onClose}
    >
      <div
        data-testid="indicator-panel-shell"
        className={WORKSPACE_PANEL_SHELL_CLASS}
      >
        {/* nav↔콘텐츠 분리는 border-r가 아니라 bg-subtle↔bg-card 톤 스텝이 담당(2026-07-15
            borderless 규칙). 선택은 좌측 accent 보더 대신 둥근 pill. 리셋 푸터는
            스크롤과 무관하게 하단 고정 — nav는 flex-1로 스크롤. */}
      <div className="flex min-h-0 flex-col bg-bg-subtle">
        {mode === 'mine' ? (
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="내 지표">
            {active.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-dim">
                추가한 지표가 없습니다.
              </p>
            ) : (
              active.map((c) => (
                <IndicatorNavRow
                  key={c.id}
                  label={c.label}
                  selected={selected === c.id}
                  onSelect={() => setSelected(c.id)}
                  action={{
                    kind: 'remove',
                    label: `${c.label} 삭제`,
                    onClick: () => removeFor(c.id)?.(),
                  }}
                />
              ))
            )}
          </nav>
        ) : (
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="지표 추가">
            {catalog.length === 0 ? (
              <p className="px-3 py-4 text-sm text-fg-dim">
                추가할 수 있는 지표를 전부 쓰고 있습니다.
              </p>
            ) : (
              catalog.map((c, i) => (
                <Fragment key={c.id}>
                  {(i === 0 || catalog[i - 1].group !== c.group) && (
                    <div className={`px-3 pb-1 text-xs font-semibold uppercase text-fg-dim${i !== 0 ? ' pt-3' : ''}`}>
                      {GROUP_LABEL[c.group]}
                    </div>
                  )}
                  {/* 라벨은 **미리보기**, ＋ 만 추가다. 라벨 클릭이 곧 추가면 "뭘 하는
                      지표인지 보고 나서 결정" 이 불가능해진다 — 일단 켜서 그려 보고
                      마음에 안 들면 지우는 흐름이 되는데, 그건 차트를 어지럽힌다. */}
                  <IndicatorNavRow
                    label={c.label}
                    selected={selected === c.id}
                    onSelect={() => setSelected(c.id)}
                    action={{
                      kind: 'add',
                      label: `${c.label} 추가`,
                      onClick: () => addFor(c.id),
                    }}
                  />
                </Fragment>
              ))
            )}
          </nav>
        )}
        {/* 모드 전환 — "추가" 는 카탈로그를 열고, 카탈로그에서는 목록으로 돌아간다.
            둘을 한 화면에 섞지 않는 이유: 켜고 끌 때마다 행이 두 섹션 사이를 오가면
            방금 조준한 항목이 커서 밑에서 움직인다. */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => setMode(mode === 'mine' ? 'catalog' : 'mine')}
            data-testid="indicator-panel-mode-toggle"
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
          >
            {mode === 'mine' ? '＋ 지표 추가' : '← 내 지표'}
          </button>
        </div>
        {/* 현재 봉 초기화 — 현재 보는 봉의 지표 설정만 되돌린다(#699). 파괴적이라
            인라인 2단계 확인. */}
        <div className="border-t border-border p-2">
          {confirmingReset ? (
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-fg-dim">{currentTimeframeLabel} 초기화?</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="rounded px-2 py-1 text-xs text-fg-dim hover:text-fg"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded px-2 py-1 text-xs font-medium"
                  style={{ background: 'var(--error)', color: 'var(--fg)' }}
                >
                  초기화
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingReset(true)}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
            >
              현재 봉 초기화
            </button>
          )}
        </div>
      </div>
        <div className="flex min-h-0 flex-col">
          {/* 헤더는 그룹명이 아니라 '지금 편집 중인 지표'를 보여준다(그룹은 eyebrow).
              마스터 토글을 우측에 상주시켜 스크롤과 무관하게 켜짐/꺼짐을 읽고 바꾼다. */}
          <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0">
              {/* eyebrow 는 그룹 + **어디에 그려지는가**. 후자가 없으면 "추가하면 캔들
                  위에 겹치나, 아래 pane 을 새로 먹나" 를 켜 보고 알게 된다. 두 조각
                  모두 `--fg-dim` — 소형 텍스트에 `--fg-dimmer` 는 대비 미달이라
                  쓰지 않는다(DESIGN.md 텍스트 대비 규칙). */}
              <div className="text-xs font-medium uppercase text-fg-dim">
                {GROUP_LABEL[selectedCategory.group]} · {PLACEMENT_LABEL[selectedCategory.placement]}
              </div>
              <h2 className="truncate text-lg font-semibold text-fg">{selectedCategory.label}</h2>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/* 모든 지표 설정은 현재 보는 봉 버킷에 저장된다(#699). 읽기전용 배지
                  하나로 스코프를 알린다 — 봉 전환 시 timeframe prop 으로 자동 갱신. */}
              <span
                title={targetLabel
                  ? '이 드로어는 포커스된 차트 창의 지표 설정을 편집합니다. 지표 설정은 창×봉마다 따로 저장됩니다'
                  : '지표 설정은 현재 보는 봉(분·일·주·월)마다 따로 저장됩니다'}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-dim"
                data-testid="indicator-panel-scope-badge"
              >
                {targetLabel ? `${targetLabel} · ${currentTimeframeLabel}` : `현재: ${currentTimeframeLabel}`}
              </span>
              {/* 종전에 여기 있던 표시/숨김 스위치는 사라졌다 — 가시성은 레전드 눈이
                  전담하고 이 패널은 존재(추가·삭제)만 다룬다. 한 지표를 두 표면이 서로
                  다른 말로 조작하던 상태를 끝낸 것이 이 PR 의 요점이다. */}
              <button
                type="button"
                aria-label="닫기"
                onClick={onClose}
                className="-mr-1 px-1 text-lg leading-none text-fg-dim transition-colors hover:text-fg"
              >
                ✕
              </button>
            </div>
          </header>
          <section
            aria-label={selectedCategory.label}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5"
          >
              {/* 설명은 카테고리 표가 소유한다 — Config 안에 두면 아직 추가하지
                  않은 지표(Config 를 렌더하지 않는다)에서는 읽을 수가 없다. */}
              <p className="text-xs text-fg-dim">{selectedCategory.description}</p>
              {selected === 'moving-average' && <MovingAverageConfig />}
              {selected === 'daily-moving-average' && <DailyMovingAverageConfig />}
              {selected === 'volume' && <VolumeConfig />}
              {(selected === 'foreign-net' || selected === 'institution-net') && <InvestorNetConfig />}
              {selected === 'broker-late-entry' && <BrokerLateEntryConfig />}
              {selected === 'peak-walls' && <PeakWallsConfig />}
              {selected === 'trade-volume-poc' && <TradeVolumePocConfig />}
              {selected === 'depth-heatmap' && <DepthHeatmapConfig />}
              {selected === 'wall-surge' && <WallSurgeConfig />}
              {selected === 'volume-distribution' && (
                <div>
                  <div className="mb-3">
                    <label className="flex items-center justify-between gap-3 text-sm text-fg">
                      <span>구간 수</span>
                      <input
                        type="number"
                        min={5}
                        max={30}
                        step={1}
                        aria-label="연속체결 매물대 분포 구간 수"
                        className="w-[84px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
                        value={volumeDistributionRangeCount}
                        onChange={(event) => setVolumeDistributionRangeCount(Number(event.currentTarget.value))}
                      />
                    </label>
                  </div>
                  <div className="mb-3">
                    <ToggleRow
                      label="호버 시점 누적"
                      description="캔들 hover 시점까지의 연속체결만 누적해 매물대 bar를 표시합니다."
                      checked={volumeDistributionHoverCutoffEnabled}
                      onToggle={() => setVolumeDistributionHoverCutoffEnabled(!volumeDistributionHoverCutoffEnabled)}
                      testId="settings-toggle-volumeDistributionHoverCutoff"
                    />
                  </div>
                  <div className="mb-3">
                    <div className="mb-1.5 text-xs text-fg-dim">색상</div>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-20 text-sm text-fg">기본 구간</span>
                        <ColorSwatchPicker
                          label="연속체결 매물대 분포 색상"
                          color={volumeDistributionColor}
                          onChange={(color) => setVolumeDistributionStyle({ color })}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-20 text-sm text-fg">최대 구간</span>
                        <ColorSwatchPicker
                          label="연속체결 매물대 분포 최대 구간 색상"
                          color={volumeDistributionMaxColor}
                          onChange={(maxColor) => setVolumeDistributionStyle({ maxColor })}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="text-xs leading-5 text-fg-dim">
                    <div>대상: 연속매매 체결만 집계, 동시호가 제외</div>
                    <div>단위: 거래일별 가격대 분포</div>
                    <div>강조: 거래일 내 최대 체결량 구간</div>
                  </div>
                </div>
              )}
              {selected === 'quote-totals' && <QuoteTotalsConfig />}
              {selected === 'ratio' && <RatioConfig />}
              {selected === 'fill-strength' && <FillStrengthConfig />}
              {selected === 'program-trade' && <ProgramTradeConfig />}
          </section>
        </div>
      </div>
    </ModalShell>
  );
}
