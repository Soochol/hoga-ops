import { useState, useEffect, useRef, useCallback, Fragment, type ReactNode } from 'react';
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
import { dotColorsFor } from './indicatorDotColors';
import { INDICATOR_GLYPH } from './indicatorGlyphs';
import IndicatorPreviewCard from './IndicatorPreviewCard';
import IndicatorPanelMenu from './IndicatorPanelMenu';
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

/** 미추가 행에 넘기는 고정 빈 배열 — 매 렌더 새 리터럴을 만들지 않는다. */
const EMPTY_DOT_COLORS: readonly string[] = [];

/** 검색어와 겹치는 구간을 표시한다. 강조는 tint 배경 + 굵기 — 색 규율 안에 있다
 *  (액센트 잉크를 쓰면 UI 상태색이 데이터 라벨로 새어 나간다). */
function HighlightedLabel({ label, query }: { label: string; query: string }) {
  const at = query === '' ? -1 : label.indexOf(query);
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-sm bg-tint-selection font-semibold text-fg">
        {label.slice(at, at + query.length)}
      </mark>
      {label.slice(at + query.length)}
    </>
  );
}

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
    description: '차트에 보이는 거래일마다, 그 날 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격을 표시합니다. 계열 셋(체결된 벽·미도달 벽·전체 최대벽)을 각각 수평선·화살표·라벨·레전드로 그리고, 강도 계단을 별도 pane 에 낼 수 있습니다. 매도·매수를 각각 설정합니다. 분봉 차트에서만 표시됩니다' },
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
 * nav 행 하나 — 목록이 하나뿐이므로 **한 형태가 두 상태를 진다**.
 *
 * 어휘가 **추가/삭제 둘뿐**인 것이 이 패널의 계약이다. 종전의 체크박스(켜기/끄기)는
 * 레전드의 눈(숨김)과 뜻이 겹쳤다 — 같은 지표를 두 표면이 서로 다른 말로 조작하면
 * 사용자는 어느 쪽이 무엇을 하는지 매번 다시 배워야 한다. 지금은 **패널이 존재를,
 * 레전드가 가시성을** 맡는다.
 *
 * 두 축이 독립이라는 것이 요점이다: `added` 는 "차트에 있는가"(잉크 농도 + ＋/✕),
 * `selected` 는 "지금 보고 있는가"(tint 배경). 아직 추가하지 않은 지표를 골라
 * 미리 보는 중이면 tint 는 켜지고 잉크는 흐린 채다. 선택은 배경 tint 만으로 말한다 —
 * 좌측 accent 바는 리스트 행 규약에서 금지다(DESIGN.md).
 */
function IndicatorNavRow({
  label, glyph, added, selected, kbdFocused, query, dotColors, kbdIndex, onSelect, action,
}: {
  label: string;
  /** 무엇을 그리는 지표이고 어디에 그려지는가 — `indicatorGlyphs`. */
  glyph: ReactNode;
  added: boolean;
  selected: boolean;
  /** ↑↓ 로 짚은 행 — 선택(tint)과 **다른 축**이다. 포커스는 검색창에 남아 있고
   *  이 링이 "Enter 를 누르면 여기" 를 말한다. */
  kbdFocused: boolean;
  query: string;
  /** 차트에 그려지는 색들 — 비어 있으면 점을 찍지 않는다(`indicatorDotColors`). */
  dotColors: readonly string[];
  kbdIndex: number;
  onSelect: () => void;
  action: { kind: 'add' | 'remove'; label: string; onClick: () => void };
}) {
  return (
    <ListRow
      data-kbd-index={kbdIndex}
      className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
        selected ? 'bg-tint-selection' : 'hover:bg-bg-input-hover'
      } ${added ? 'font-medium text-fg' : 'text-fg-dim hover:text-fg'} ${
        kbdFocused ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 whitespace-nowrap text-left text-inherit"
      >
        {/* 글리프는 잉크를 행과 공유한다 — 미추가 행에서 함께 흐려져야 "아직 없다"
            가 한 덩어리로 읽힌다. `aria-hidden` 이라 접근성 이름은 라벨 그대로다. */}
        <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
        <span className="min-w-0 truncate">
          <HighlightedLabel label={label} query={query} />
        </span>
      </button>
      {dotColors.length > 0 && (
        // 장식이 아니라 데이터라 `aria-hidden` 이다 — 색은 스크린리더가 읽을 수 없고,
        // 이 행이 무엇인지는 라벨이 이미 말한다. 밝은 사용자 색이 밝은 배경에
        // 잠기지 않도록 상시 헤어라인을 두른다(테마 무관하게 옅은 검정 → 다크에서도
        // 흰 점의 윤곽이 남는다).
        <span aria-hidden="true" className="ml-2 flex shrink-0 items-center gap-[3px]">
          {dotColors.map((color, i) => (
            <i
              key={i}
              className="size-1.5 rounded-full ring-1 ring-inset ring-black/15"
              style={{ background: color }}
            />
          ))}
        </span>
      )}
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        onClick={action.onClick}
        // 고정 크기 정사각 — 행 높이를 이 버튼의 패딩이 정하게 두면 목록이 조용히
        // 길어진다(실측 45px/행 → 목록 827px). 밀도는 이 패널의 성격이다.
        className="ml-2 flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
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
};

export default function IndicatorPanel({
  onClose,
  capabilities = STOCK_CAPABILITIES,
  timeframe,
  targetLabel,
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

  // 우측 상세가 어느 카테고리를 보여주는가. 행의 라벨을 누르면 여기가 바뀐다 —
  // 추가 여부와 무관하다(아직 없는 지표도 골라서 미리 볼 수 있다).
  const [selected, setSelected] = useState<CategoryId>('moving-average');
  // 좌측 목록의 모드 — 내 지표(존재하는 것) / 카탈로그(추가할 수 있는 것).
  //
  // 2026-08-26 에 한 번 단일 리스트로 합쳤다가 **사용자 결정으로 되돌렸다**. 합친
  // 판의 이점(15종이 한 화면, 행이 안 움직임)보다 「지금 쓰는 것」과 「추가할 수 있는
  // 것」이 **섞이지 않는 것**이 중요하다는 판단이다 — 매일 여는 목록은 대개 전자만
  // 보려고 여는 것이고, 후자는 가끔 찾으러 들어가는 곳이다.
  const [mode, setMode] = useState<'mine' | 'catalog'>('mine');
  // 검색어와 ↑↓ 커서. 창을 바꾸면 패널이 재마운트되므로(`key={windowId}`) 둘 다
  // 초기화된다 — 이전 창에서 치던 검색어가 따라오지 않는 것이 맞다.
  const [query, setQuery] = useState('');
  // -1 = 커서 없음(마우스만 썼다). 검색어를 치면 첫 결과로 내려앉는다.
  const [kbdIndex, setKbdIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  // 헤더 ⋯ 메뉴. **열림 상태를 패널이 쥔다** — Escape 를 가로채려면 지금 메뉴가
  // 떠 있는지를 알아야 하기 때문이다(아래 `handleEscape`).
  const [menuOpen, setMenuOpen] = useState(false);

  // "현재 봉 초기화"(PR-C #699): 지표 버킷과 indicator-modal chartPrefs 버킷을
  // 현재 봉만 비운다. 차트 전반 flat(⚙️ 설정 항목)은 패널 밖이라 건드리지 않는다.
  const handleReset = () => {
    resetIndicators();
    resetChartPrefsBucket();
  };

  /** Escape 사다리의 두 번째 칸 — 메뉴가 떠 있으면 **메뉴만** 닫는다.
   *
   *  `ModalShell` 의 Escape 리스너는 `document`, 팝오버의 것은 `window` 라 document
   *  쪽이 먼저 발화한다. 즉 메뉴를 열어 둔 채 Escape 를 누르면 패널이 통째로 닫히고
   *  메뉴는 그 뒤에 사라진다 — 사용자가 취소하려던 것은 메뉴 하나였는데.
   *  (첫 칸은 검색어 지우기이고, 그건 입력이 전파를 끊어서 여기까지 오지 않는다.) */
  const handleEscape = useCallback(() => {
    if (menuOpen) { setMenuOpen(false); return; }
    onClose();
  }, [menuOpen, onClose]);

  const categories = CATEGORIES.filter((c) => {
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
  //
  // 검색은 `categories` **다음** 단계다 — capability 게이트를 통과한 것만 검색된다.
  // 순서를 바꾸면 이 종목에 없는 지표가 검색으로 되살아난다. 그리고 검색은 **지금
  // 보고 있는 모드 안에서만** 거른다: 「내 지표」에서 친 검색어가 아직 추가하지 않은
  // 지표를 끌어오면 두 목록을 가른 의미가 없어진다.
  const trimmedQuery = query.trim();
  const matches = (label: string) => trimmedQuery === '' || label.includes(trimmedQuery);
  const active = categories.filter((c) => checkedFor(c.id) && matches(c.label));
  const catalog = categories.filter((c) => !checkedFor(c.id) && matches(c.label));
  /** ↑↓ 가 짚는 대상 — 지금 모드의 보이는 행들. */
  const visible = mode === 'mine' ? active : catalog;

  // ↑↓ 가 짚는 대상은 **보이는 행의 평탄한 순서**다. 검색으로 목록이 줄면 커서도
  // 범위 안으로 당겨야 하므로, 렌더마다 클램프하지 않고 검색어 변경에서 0으로 되돌린다.
  const kbdTarget = kbdIndex >= 0 ? visible[kbdIndex] : undefined;
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // **한글 조합 중의 Enter 는 글자 확정이지 명령이 아니다.** 이 가드가 없으면
    // "매물" 을 치는 도중 확정 Enter 가 선택으로 새어 나간다.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setKbdIndex((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setKbdIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // **선택까지만.** 추가는 ＋ 나 미리보기 CTA 로만 — 보기 전에 차트가 바뀌면
      // 안 된다는 어휘 규약(라벨=미리보기)이 키보드에도 그대로 적용된다.
      if (kbdTarget) setSelected(kbdTarget.id);
    } else if (event.key === 'Escape' && query !== '') {
      // 검색어가 있으면 Escape 는 **검색만** 지운다. 전파를 끊지 않으면 ModalShell 의
      // document 리스너가 이어받아 패널까지 닫힌다.
      event.stopPropagation();
      setQuery('');
      setKbdIndex(-1);
    }
  };

  useEffect(() => {
    if (kbdIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-kbd-index="${kbdIndex}"]`);
    // jsdom 에는 scrollIntoView 가 없다 — 있으면 쓴다.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [kbdIndex]);

  // 카탈로그에서는 아직 없는 지표도 미리 볼 수 있으므로 전체에서 찾는다. "내 지표"
  // 모드에서는 선택이 삭제됐을 때 남은 첫 항목으로 넘긴다 — 그 모드의 목록에서 방금
  // 지운 행이 사라지므로, 선택을 그대로 두면 목록에 없는 것의 설정을 보게 된다.
  const selectedCategory = mode === 'catalog'
    ? categories.find((category) => category.id === selected) ?? categories[0]
    : categories.find((category) => category.id === selected && checkedFor(category.id))
      ?? categories.find((category) => checkedFor(category.id))
      ?? categories[0];
  // 상세 본문은 `selected` 가 아니라 **폴백까지 거친 결과**를 따른다 — capability 로
  // 걸러진 지표가 선택돼 있으면 헤더는 폴백을 그리는데 본문만 아무것도 안 그리는
  // 어긋남이 생긴다.
  const selectedId = selectedCategory.id;
  const selectedAdded = checkedFor(selectedId);
  const currentTimeframeLabel = timeframeLabel(timeframe);

  return (
    // 중앙 모달(2026-08-21 사용자 결정 — 그전에는 우측 드로어). 마스터-디테일
    // (240 nav + 디테일)과 760px 폭은 드로어 시절 그대로 승계하고, 높이만 중앙 카드가
    // 스스로 정한다(상수 docstring 에 근거). 설정 패널과 폭·높이·nav 를 공유한다.
    <ModalShell
      ariaLabel="지표"
      width={WORKSPACE_PANEL_WIDTH_CLASS}
      height={WORKSPACE_PANEL_HEIGHT_CLASS}
      onClose={handleEscape}
    >
      <div
        data-testid="indicator-panel-shell"
        className={WORKSPACE_PANEL_SHELL_CLASS}
      >
        {/* nav↔콘텐츠 분리는 border-r가 아니라 bg-subtle↔bg-card 톤 스텝이 담당(2026-07-15
            borderless 규칙). 선택은 좌측 accent 보더 대신 둥근 pill. 리셋 푸터는
            스크롤과 무관하게 하단 고정 — nav는 flex-1로 스크롤. */}
      <div className="flex min-h-0 flex-col bg-bg-subtle">
        {/* 검색은 **nav 안**이다 — 밖에 래퍼를 하나 더 두면 "nav 의 부모가 톤 면,
            그 부모가 2열 그리드" 라는 레이아웃 앵커(가드가 재고 있다)가 한 겹
            어긋난다. */}
        <nav
          className="flex min-h-0 flex-1 flex-col"
          aria-label={mode === 'mine' ? '내 지표' : '지표 추가'}
        >
          <div className="p-2 pb-1">
            <div className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-bg-input px-2 focus-within:border-accent">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-fg-dim">
                <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={query}
                aria-label="지표 검색"
                placeholder="지표 검색"
                data-testid="indicator-panel-search"
                onChange={(event) => { setQuery(event.currentTarget.value); setKbdIndex(0); }}
                onKeyDown={onSearchKeyDown}
                // 전역 `:focus-visible` 액센트 링은 맨 `outline-none` 으로는 안 꺼진다
                // (특이도) — variant 를 써야 한다. 테두리는 래퍼가 focus-within 으로 진다.
                className="w-full bg-transparent text-sm text-fg placeholder:text-fg-dimmer focus-visible:outline-none"
              />
            </div>
          </div>
          {/* 「내 지표」는 **평리스트**, 카탈로그는 **그룹 헤더가 있는 목록**이다.
              비대칭이 아니라 각 목록이 답하는 질문이 달라서다 — 전자는 "내가 지금 뭘
              쓰나"(대개 몇 개라 셀 수 있다), 후자는 "뭐가 더 있나"(계열로 훑는다). */}
          <div ref={listRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {visible.length === 0 && (
              <p className="px-3 py-4 text-sm text-fg-dim">
                {trimmedQuery !== ''
                  ? '일치하는 지표 없음'
                  : mode === 'mine'
                    ? '추가한 지표가 없습니다.'
                    : '추가할 수 있는 지표를 전부 쓰고 있습니다.'}
              </p>
            )}
            {visible.map((c, i) => {
              const added = checkedFor(c.id);
              // 그룹 헤더는 카탈로그에만. 같은 그룹이 이어지는 동안은 한 번만 낸다.
              const groupHead = mode === 'catalog'
                && (i === 0 || visible[i - 1].group !== c.group);
              return (
                <Fragment key={c.id}>
                  {groupHead && (
                    <div className={`px-3 pb-1 text-xs font-semibold uppercase text-fg-dim${i !== 0 ? ' pt-3' : ''}`}>
                      {GROUP_LABEL[c.group]}
                    </div>
                  )}
                  {/* 라벨은 **미리보기**, ＋ 만 추가다. 라벨 클릭이 곧 추가면 "뭘 하는
                      지표인지 보고 나서 결정" 이 불가능해진다 — 일단 켜서 그려 보고
                      마음에 안 들면 지우는 흐름이 되는데, 그건 차트를 어지럽힌다. */}
                  <IndicatorNavRow
                    label={c.label}
                    glyph={INDICATOR_GLYPH[c.id]}
                    added={added}
                    selected={selected === c.id}
                    kbdFocused={kbdIndex === i}
                    kbdIndex={i}
                    query={trimmedQuery}
                    dotColors={added ? dotColorsFor(c.id, ind) : EMPTY_DOT_COLORS}
                    onSelect={() => setSelected(c.id)}
                    action={added
                      ? { kind: 'remove', label: `${c.label} 삭제`, onClick: () => removeFor(c.id)?.() }
                      : { kind: 'add', label: `${c.label} 추가`, onClick: () => addFor(c.id) }}
                  />
                </Fragment>
              );
            })}
          </div>
        </nav>
        {/* 모드 전환 — "추가" 는 카탈로그를 열고, 카탈로그에서는 목록으로 돌아간다.
            둘을 한 화면에 섞지 않는 이유: 매일 여는 목록은 대개 「지금 쓰는 것」만
            보려고 여는 것이고, 「추가할 수 있는 것」은 가끔 찾으러 들어가는 곳이다.
            전환할 때 검색어는 지운다 — 한쪽에서 친 검색어가 다른 목록에 그대로
            걸려 있으면 "왜 비어 있지" 가 된다. */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'mine' ? 'catalog' : 'mine');
              setQuery('');
              setKbdIndex(-1);
            }}
            data-testid="indicator-panel-mode-toggle"
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
          >
            {mode === 'mine' ? '＋ 지표 추가' : '← 내 지표'}
          </button>
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
              <IndicatorPanelMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                resetLabel={`${currentTimeframeLabel} 지표 초기화`}
                confirmLabel={`${currentTimeframeLabel} 초기화?`}
                onReset={handleReset}
              />
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
              {/* 없으면 미리보기, 있으면 설정. 종전엔 아직 존재하지 않는 지표에도
                  **편집 가능한** 설정 폼이 떠서, 저 스위치를 만지면 무슨 일이 나는지가
                  화면에 없었다. 추가하면 이 자리가 그대로 폼이 된다(선택 불변). */}
              {!selectedAdded && (
                <IndicatorPreviewCard
                  glyph={INDICATOR_GLYPH[selectedId]}
                  placementLabel={PLACEMENT_LABEL[selectedCategory.placement]}
                  onAdd={() => addFor(selectedCategory.id)}
                />
              )}
              {selectedAdded && selectedId === 'moving-average' && <MovingAverageConfig />}
              {selectedAdded && selectedId === 'daily-moving-average' && <DailyMovingAverageConfig />}
              {selectedAdded && selectedId === 'volume' && <VolumeConfig />}
              {selectedAdded && (selectedId === 'foreign-net' || selectedId === 'institution-net') && <InvestorNetConfig />}
              {selectedAdded && selectedId === 'broker-late-entry' && <BrokerLateEntryConfig />}
              {selectedAdded && selectedId === 'peak-walls' && <PeakWallsConfig />}
              {selectedAdded && selectedId === 'trade-volume-poc' && <TradeVolumePocConfig />}
              {selectedAdded && selectedId === 'depth-heatmap' && <DepthHeatmapConfig />}
              {selectedAdded && selectedId === 'wall-surge' && <WallSurgeConfig />}
              {selectedAdded && selectedId === 'volume-distribution' && (
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
              {selectedAdded && selectedId === 'quote-totals' && <QuoteTotalsConfig />}
              {selectedAdded && selectedId === 'ratio' && <RatioConfig />}
              {selectedAdded && selectedId === 'fill-strength' && <FillStrengthConfig />}
              {selected === 'program-trade' && <ProgramTradeConfig />}
          </section>
        </div>
      </div>
    </ModalShell>
  );
}
