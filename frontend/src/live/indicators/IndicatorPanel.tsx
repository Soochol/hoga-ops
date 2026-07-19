import { useState, Fragment } from 'react';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import MovingAverageConfig from './MovingAverageConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import InvestorNetConfig from './InvestorNetConfig';
import PeakWallsConfig from './PeakWallsConfig';
import TradeVolumePocConfig from './TradeVolumePocConfig';
import DepthHeatmapConfig from './DepthHeatmapConfig';
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
import { ToggleSwitch } from '../settings/SettingsRow';
import { CheckIcon } from '../../ui/CheckIcon';
import { STOCK_CAPABILITIES, type LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';
import { ListRow } from '../../ui/DataSurface';
import { ModalShell } from '../../ui/ModalShell';
import { WORKSPACE_DRAWER_WIDTH_CLASS, WORKSPACE_DRAWER_SHELL_CLASS } from '../workspaceDrawer';
import type { LiveTimeframe } from '../../state/livePage';

type CategoryId =
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'peak-walls'
  | 'trade-volume-poc'
  | 'depth-heatmap'
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

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; group: GroupId }> = [
  { id: 'moving-average',  label: '이동평균선',       group: 'top'  },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top'  },
  { id: 'volume',          label: '거래량',           group: 'top'  },
  { id: 'quote-totals',    label: '총잔량',           group: 'hoga' },
  { id: 'ratio',           label: '호가비',           group: 'hoga' },
  { id: 'fill-strength',   label: '체결강도',         group: 'hoga' },
  { id: 'volume-distribution', label: '연속체결 매물대 분포', group: 'hoga' },
  { id: 'trade-volume-poc', label: '당일 최대 매물대', group: 'hoga' },
  { id: 'peak-walls',      label: '당일 최대벽',     group: 'hoga' },
  { id: 'depth-heatmap',   label: '호가 잔량 히트맵', group: 'hoga' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker'  },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker'  },
  { id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker' },
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program' },
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

type Props = {
  onClose: () => void;
  capabilities?: LiveInstrumentCapabilities;
  timeframe: LiveTimeframe;
  /** 멀티창 대상 창 표시(#712) — "종목명" 등. 없으면 기존 단일 뷰 헤더. */
  targetLabel?: string;
};

export default function IndicatorPanel({ onClose, capabilities = STOCK_CAPABILITIES, timeframe, targetLabel }: Props) {
  // 창-스코프 절단(ADR-0119 C2c-2a): 읽기=대상 창의 resolve 된 설정, 쓰기=창 봉
  // 버킷. Provider 밖(/study·플립 전 /live)에서는 둘 다 전역 스토어로 폴백.
  const ind = useWindowIndicators();
  const actions = useIndicatorActions();
  const maEnabled = ind.movingAverageEnabled;
  const setMaEnabled = actions.setMovingAverageEnabled;
  const dailyMaEnabled = ind.dailyMovingAverageEnabled;
  const setDailyMaEnabled = actions.setDailyMovingAverageEnabled;
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
  const brokerLateEntryEnabled = ind.brokerLateEntryEnabled;
  const setBrokerLateEntryEnabled = actions.setBrokerLateEntryEnabled;
  const depthHeatmapEnabled = ind.depthHeatmapEnabled;
  const setDepthHeatmapEnabled = actions.setDepthHeatmapEnabled;
  const paneIndicators: PanePrefsIndicatorSource = {
    volumeEnabled: ind.volumeEnabled,
    quoteTotalsEnabled: ind.quoteTotalsEnabled,
    ratioEnabled: ind.ratioEnabled,
    fillStrengthEnabled: ind.fillStrengthEnabled,
    programTradeEnabled: ind.programTradeEnabled,
    foreignNetEnabled: ind.foreignNetEnabled,
    institutionNetEnabled: ind.institutionNetEnabled,
  };
  const setPanePrefForTimeframe = actions.setPanePrefForTimeframe;

  const resetIndicators = actions.resetIndicators;
  // chartPrefs 는 전역 유지(#712 — 창 소유는 지표만). 창 대상 리셋과의 비대칭은
  // 문서화된 수용(스펙 ⑤): 지표는 대상 창만, indicator-modal chartPrefs 는 전역.
  const resetChartPrefsBucket = useChartPrefsStore((s) => s.resetIndicatorModalBucket);

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');
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
      case 'broker-late-entry': return brokerLateEntryEnabled;
      default: return false;
    }
  };
  const toggleFor = (id: CategoryId): (() => void) | null => {
    const paneKey = PANE_CATEGORY_TO_KEY[id];
    if (paneKey) {
      return () => setPanePrefForTimeframe(
        timeframe,
        paneKey,
        !selectedPanePrefs[paneKey],
      );
    }
    switch (id) {
      case 'moving-average': return () => setMaEnabled(!maEnabled);
      case 'daily-moving-average': return () => setDailyMaEnabled(!dailyMaEnabled);
      case 'peak-walls': return () => {
        // 한쪽이라도 켜져 있으면 둘 다 끄고, 모두 꺼져 있으면 둘 다 켠다.
        const next = !(askPeakEnabled || bidPeakEnabled);
        setAskPeakEnabled(next);
        setBidPeakEnabled(next);
      };
      case 'trade-volume-poc': return () => setTradeVolumePocEnabled(!tradeVolumePocEnabled);
      case 'volume-distribution': return () => setVolumeDistributionEnabled(!volumeDistributionEnabled);
      case 'depth-heatmap': return () => setDepthHeatmapEnabled(!depthHeatmapEnabled);
      case 'broker-late-entry': return () => setBrokerLateEntryEnabled(!brokerLateEntryEnabled);
      default: return null;
    }
  };

  const selectedCategory = categories.find((category) => category.id === selected) ?? categories[0];
  const selectedChecked = checkedFor(selectedCategory.id);
  const selectedToggle = toggleFor(selectedCategory.id);
  const currentTimeframeLabel = timeframeLabel(timeframe);

  return (
    // 우측 드로어(side='right', ADR-0116): 왼쪽에 차트가 반투명 딤 너머로 남아 즉시
    // 적용이 실시간 반영된다. 마스터-디테일(240 nav + 디테일)을 유지하되 폭을 760px로
    // 좁혀 넓은 화면에서 좌측 차트를 살린다. 높이는 드로어라 항상 전체(=height 무시).
    <ModalShell
      ariaLabel="지표"
      side="right"
      width={WORKSPACE_DRAWER_WIDTH_CLASS}
      onClose={onClose}
    >
      <div
        data-testid="indicator-panel-shell"
        className={WORKSPACE_DRAWER_SHELL_CLASS}
      >
        {/* nav↔콘텐츠 분리는 border-r가 아니라 bg-subtle↔bg-card 톤 스텝이 담당(2026-07-15
            borderless 규칙). 선택은 좌측 accent 보더 대신 둥근 pill. 리셋 푸터는
            스크롤과 무관하게 하단 고정 — nav는 flex-1로 스크롤. */}
      <div className="flex min-h-0 flex-col bg-bg-subtle">
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="지표 카테고리">
          {categories.map((c, i) => {
            const checked = checkedFor(c.id);
            const onToggle = toggleFor(c.id);
            const isSelected = selected === c.id;
            const showHeader = i === 0 || categories[i - 1].group !== c.group;
            return (
              <Fragment key={c.id}>
                {showHeader && (
                  <div className={`px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer${i !== 0 ? ' pt-3' : ''}`}>
                    {GROUP_LABEL[c.group]}
                  </div>
                )}
                <ListRow
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-tint-selection font-medium text-fg'
                      : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`min-w-0 flex-1 cursor-pointer whitespace-nowrap text-left ${isSelected ? 'text-fg' : 'text-inherit'}`}
                  >
                    {c.label}
                  </button>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={c.label}
                    onClick={() => onToggle?.()}
                    className="ml-3 p-1.5 cursor-pointer"
                  >
                    <CheckIcon filled={checked} />
                  </button>
                </ListRow>
              </Fragment>
            );
          })}
        </nav>
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
              <div className="text-xs font-medium uppercase tracking-[0.08em] text-fg-dimmer">
                {GROUP_LABEL[selectedCategory.group]}
              </div>
              <h2 className="truncate text-lg font-semibold text-fg">{selectedCategory.label}</h2>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/* 모든 지표 설정은 현재 보는 봉 버킷에 저장된다(#699). 읽기전용 배지
                  하나로 스코프를 알린다 — 봉 전환 시 timeframe prop 으로 자동 갱신. */}
              <span
                title={targetLabel
                  ? '이 드로어는 포커스된 차트 창의 지표 설정을 편집합니다. 지표 설정은 창×봉마다 따로 저장됩니다.'
                  : '지표 설정은 현재 보는 봉(분·일·주·월)마다 따로 저장됩니다.'}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-dim"
                data-testid="indicator-panel-scope-badge"
              >
                {targetLabel ? `${targetLabel} · ${currentTimeframeLabel}` : `현재: ${currentTimeframeLabel}`}
              </span>
              {selectedToggle && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-dim">{selectedChecked ? '표시' : '숨김'}</span>
                  <ToggleSwitch
                    label={`${selectedCategory.label} 표시`}
                    checked={selectedChecked}
                    onClick={() => selectedToggle()}
                  />
                </div>
              )}
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
            className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5 transition-opacity ${
              selectedToggle && !selectedChecked ? 'opacity-55' : ''
            }`}
          >
              {selected === 'moving-average' && <MovingAverageConfig />}
              {selected === 'daily-moving-average' && <DailyMovingAverageConfig />}
              {selected === 'volume' && <VolumeConfig />}
              {selected === 'foreign-net' && <InvestorNetConfig which="foreign" />}
              {selected === 'institution-net' && <InvestorNetConfig which="institution" />}
              {selected === 'broker-late-entry' && <BrokerLateEntryConfig />}
              {selected === 'peak-walls' && <PeakWallsConfig />}
              {selected === 'trade-volume-poc' && <TradeVolumePocConfig />}
              {selected === 'depth-heatmap' && <DepthHeatmapConfig />}
              {selected === 'volume-distribution' && (
                <div>
                  <h3 className="pb-1 text-base font-medium text-fg">연속체결 매물대 분포</h3>
                  <p className="mb-3 text-xs text-fg-dim">
                    정규장 연속매매 체결만 집계한 가격대별 체결량 분포를 거래일 단위로 표시합니다. 가격 구간은 각 Stock-Date 캔들 저가-고가 범위를 기준으로 나눕니다.
                  </p>
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
