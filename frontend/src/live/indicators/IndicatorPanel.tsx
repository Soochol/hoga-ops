import { useEffect, useState, Fragment } from 'react';
import { useLivePageStore } from '../../state/livePage';
import MovingAverageConfig from './MovingAverageConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import InvestorNetConfig from './InvestorNetConfig';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';
import TradeVolumePocConfig from './TradeVolumePocConfig';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import FillStrengthConfig from './FillStrengthConfig';
import { MA_COLOR_ROWS } from './MAStylePicker';
import ProgramTradeConfig from './ProgramTradeConfig';
import BrokerLateEntryConfig from './BrokerLateEntryConfig';
import ToggleRow from '../settings/ToggleRow';
import { CheckIcon } from '../../ui/CheckIcon';
import { STOCK_CAPABILITIES, type LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';
import { DataSection, ListRow } from '../../ui/DataSurface';

type CategoryId =
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'ask-peak'
  | 'bid-peak'
  | 'trade-volume-poc'
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
  { id: 'ask-peak',        label: '당일 매도 최대벽', group: 'hoga' },
  { id: 'bid-peak',        label: '당일 매수 최대벽', group: 'hoga' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker'  },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker'  },
  { id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker' },
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program' },
];

type Props = {
  onClose: () => void;
  capabilities?: LiveInstrumentCapabilities;
};

export default function IndicatorPanel({ onClose, capabilities = STOCK_CAPABILITIES }: Props) {
  const maEnabled = useLivePageStore((s) => s.movingAverageEnabled);
  const setMaEnabled = useLivePageStore((s) => s.setMovingAverageEnabled);
  const dailyMaEnabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const setDailyMaEnabled = useLivePageStore((s) => s.setDailyMovingAverageEnabled);
  const foreignNet = useLivePageStore((s) => s.foreignNetEnabled);
  const setForeignNet = useLivePageStore((s) => s.setForeignNetEnabled);
  const institutionNet = useLivePageStore((s) => s.institutionNetEnabled);
  const setInstitutionNet = useLivePageStore((s) => s.setInstitutionNetEnabled);
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);
  const setVolumeEnabled = useLivePageStore((s) => s.setVolumeEnabled);
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const setAskPeakEnabled = useLivePageStore((s) => s.setAskPeakEnabled);
  const bidPeakEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const setBidPeakEnabled = useLivePageStore((s) => s.setBidPeakEnabled);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const setTradeVolumePocEnabled = useLivePageStore((s) => s.setTradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const setVolumeDistributionEnabled = useLivePageStore((s) => s.setVolumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const setVolumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.setVolumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const setVolumeDistributionRangeCount = useLivePageStore((s) => s.setVolumeDistributionRangeCount);
  const setVolumeDistributionStyle = useLivePageStore((s) => s.setVolumeDistributionStyle);
  const quoteTotals = useLivePageStore((s) => s.quoteTotalsEnabled);
  const setQuoteTotals = useLivePageStore((s) => s.setQuoteTotalsEnabled);
  const ratio = useLivePageStore((s) => s.ratioEnabled);
  const setRatio = useLivePageStore((s) => s.setRatioEnabled);
  const fillStrength = useLivePageStore((s) => s.fillStrengthEnabled);
  const setFillStrength = useLivePageStore((s) => s.setFillStrengthEnabled);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const setBrokerLateEntryEnabled = useLivePageStore((s) => s.setBrokerLateEntryEnabled);
  const programTrade = useLivePageStore((s) => s.programTradeEnabled);
  const setProgramTrade = useLivePageStore((s) => s.setProgramTradeEnabled);

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = CATEGORIES.filter((c) => {
    if (c.group === 'hoga' || c.group === 'program') return capabilities.hogaPanes;
    if ((c.id === 'foreign-net' || c.id === 'institution-net') && capabilities.investorNet === 'none') {
      return false;
    }
    return true;
  });

  // Each category maps to a master on/off toggle. Investor bars have an
  // informational detail pane (legend + daily note) but no per-slot config,
  // so the left checkbox is the whole control for them.
  const checkedFor = (id: CategoryId): boolean => {
    switch (id) {
      case 'moving-average': return maEnabled;
      case 'daily-moving-average': return dailyMaEnabled;
      case 'foreign-net': return foreignNet;
      case 'institution-net': return institutionNet;
      case 'volume': return volumeEnabled;
      case 'ask-peak': return askPeakEnabled;
      case 'bid-peak': return bidPeakEnabled;
      case 'trade-volume-poc': return tradeVolumePocEnabled;
      case 'volume-distribution': return volumeDistributionEnabled;
      case 'quote-totals': return quoteTotals;
      case 'ratio': return ratio;
      case 'fill-strength': return fillStrength;
      case 'broker-late-entry': return brokerLateEntryEnabled;
      case 'program-trade': return programTrade;
      default: return false;
    }
  };
  const toggleFor = (id: CategoryId): (() => void) | null => {
    switch (id) {
      case 'moving-average': return () => setMaEnabled(!maEnabled);
      case 'daily-moving-average': return () => setDailyMaEnabled(!dailyMaEnabled);
      case 'foreign-net': return () => setForeignNet(!foreignNet);
      case 'institution-net': return () => setInstitutionNet(!institutionNet);
      case 'volume': return () => setVolumeEnabled(!volumeEnabled);
      case 'ask-peak': return () => setAskPeakEnabled(!askPeakEnabled);
      case 'bid-peak': return () => setBidPeakEnabled(!bidPeakEnabled);
      case 'trade-volume-poc': return () => setTradeVolumePocEnabled(!tradeVolumePocEnabled);
      case 'volume-distribution': return () => setVolumeDistributionEnabled(!volumeDistributionEnabled);
      case 'quote-totals': return () => setQuoteTotals(!quoteTotals);
      case 'ratio': return () => setRatio(!ratio);
      case 'fill-strength': return () => setFillStrength(!fillStrength);
      case 'broker-late-entry': return () => setBrokerLateEntryEnabled(!brokerLateEntryEnabled);
      case 'program-trade': return () => setProgramTrade(!programTrade);
      default: return null;
    }
  };

  const selectedCategory = categories.find((category) => category.id === selected) ?? categories[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="지표"
      onClick={onClose}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/45"
    >
      <div
        data-testid="indicator-panel-shell"
        onClick={(event) => event.stopPropagation()}
        className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-fg">지표</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="text-lg leading-none text-fg-dim hover:text-fg">
            ✕
          </button>
        </div>
        <div className="grid min-h-0 grid-cols-[200px_minmax(0,1fr)]">
          <nav className="overflow-y-auto py-2 border-r border-border bg-bg-card" aria-label="지표 카테고리">
          {categories.map((c, i) => {
            const checked = checkedFor(c.id);
            const onToggle = toggleFor(c.id);
            const isSelected = selected === c.id;
            const showHeader = i === 0 || categories[i - 1].group !== c.group;
            return (
              <Fragment key={c.id}>
                {showHeader && (
                  <div className={`px-4 pb-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer${i !== 0 ? ' pt-3' : ''}`}>
                    {GROUP_LABEL[c.group]}
                  </div>
                )}
                <ListRow
                  className={`flex w-full items-center justify-between rounded-none border-l-2 px-4 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'border-accent bg-tint-selection text-fg'
                      : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`flex-1 text-left cursor-pointer ${isSelected ? 'text-fg' : 'text-inherit'}`}
                  >
                    {c.label}
                  </button>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={c.label}
                    onClick={() => { onToggle?.(); setSelected(c.id); }}
                    className="ml-3 p-1.5 cursor-pointer"
                  >
                    <CheckIcon filled={checked} />
                  </button>
                </ListRow>
              </Fragment>
            );
          })}
          </nav>
          <div className="min-h-0 overflow-y-auto">
            <DataSection title={GROUP_LABEL[selectedCategory.group]} contentClassName="space-y-3 p-4">
              {selected === 'moving-average' && <MovingAverageConfig />}
              {selected === 'daily-moving-average' && <DailyMovingAverageConfig />}
              {selected === 'volume' && <VolumeConfig />}
              {selected === 'foreign-net' && <InvestorNetConfig which="foreign" />}
              {selected === 'institution-net' && <InvestorNetConfig which="institution" />}
              {selected === 'broker-late-entry' && <BrokerLateEntryConfig />}
              {selected === 'ask-peak' && <AskPeakConfig />}
              {selected === 'bid-peak' && <BidPeakConfig />}
              {selected === 'trade-volume-poc' && <TradeVolumePocConfig />}
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
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2">
                        <div
                          aria-hidden="true"
                          className="h-6 w-10 rounded border border-border-subtle"
                          style={{ backgroundColor: volumeDistributionColor, borderColor: volumeDistributionColor }}
                        />
                        <div className="flex flex-col gap-1">
                          {MA_COLOR_ROWS.map((row, rowIndex) => (
                            <div key={`volume-distribution-color-row-${rowIndex}`} className="grid grid-cols-8 gap-1">
                              {row.map((candidate) => {
                                const selected = candidate.toLowerCase() === volumeDistributionColor.toLowerCase();
                                return (
                                  <button
                                    key={candidate}
                                    type="button"
                                    aria-label={`연속체결 매물대 분포 색상 ${candidate}`}
                                    aria-pressed={selected}
                                    className="h-5 w-5 rounded-full"
                                    style={{
                                      backgroundColor: candidate,
                                      outline: selected ? '2px solid var(--fg)' : 'none',
                                      outlineOffset: 2,
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                    onClick={() => setVolumeDistributionStyle({ color: candidate })}
                                  />
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          aria-hidden="true"
                          className="h-6 w-10 rounded border border-border-subtle"
                          style={{ backgroundColor: volumeDistributionMaxColor, borderColor: volumeDistributionMaxColor }}
                        />
                        <div className="flex flex-col gap-1">
                          {MA_COLOR_ROWS.map((row, rowIndex) => (
                            <div key={`volume-distribution-max-color-row-${rowIndex}`} className="grid grid-cols-8 gap-1">
                              {row.map((candidate) => {
                                const selected = candidate.toLowerCase() === volumeDistributionMaxColor.toLowerCase();
                                return (
                                  <button
                                    key={candidate}
                                    type="button"
                                    aria-label={`연속체결 매물대 분포 최대 구간 색상 ${candidate}`}
                                    aria-pressed={selected}
                                    className="h-5 w-5 rounded-full"
                                    style={{
                                      backgroundColor: candidate,
                                      outline: selected ? '2px solid var(--fg)' : 'none',
                                      outlineOffset: 2,
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                    onClick={() => setVolumeDistributionStyle({ maxColor: candidate })}
                                  />
                                );
                              })}
                            </div>
                          ))}
                        </div>
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
            </DataSection>
          </div>
        </div>
        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-bg-input px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
