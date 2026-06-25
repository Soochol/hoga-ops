import { useState, Fragment } from 'react';
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
import { ModalShell } from '../../ui/ModalShell';
import { CheckIcon } from '../../ui/CheckIcon';
import { STOCK_CAPABILITIES, type LiveInstrumentCapabilities } from '../liveInstrumentCapabilities';

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
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker'  },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker'  },
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
  const programTrade = useLivePageStore((s) => s.programTradeEnabled);
  const setProgramTrade = useLivePageStore((s) => s.setProgramTradeEnabled);

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');

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
      case 'program-trade': return () => setProgramTrade(!programTrade);
      default: return null;
    }
  };

  // Merge note: origin/main added Volume + InvestorNet categories with a
  // navigate-to-detail-pane nav; this branch migrated the modal chrome to the
  // shared ModalShell (backdrop/Escape/title/✕). Both are kept — ModalShell
  // wraps the richer nav + detail panes + footer.
  return (
    <ModalShell ariaLabel="지표" title="지표" onClose={onClose}>
      <div className="flex">
        <nav className="w-[200px] py-2 border-r border-border" aria-label="지표 카테고리">
          {categories.map((c, i) => {
            const checked = checkedFor(c.id);
            const onToggle = toggleFor(c.id);
            const isSelected = selected === c.id;
            const showHeader = i === 0 || categories[i - 1].group !== c.group;
            const rowBase = 'flex w-full items-center justify-between pl-4 pr-2 text-sm';
            return (
              <Fragment key={c.id}>
                {showHeader && (
                  <div className={`text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2${i !== 0 ? ' pt-2' : ''}`}>
                    {GROUP_LABEL[c.group]}
                  </div>
                )}
                <div className={`${rowBase} ${isSelected ? 'bg-bg-input' : 'hover:bg-bg-input'}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className="flex-1 text-left py-2 text-fg cursor-pointer"
                  >
                    {c.label}
                  </button>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={c.label}
                    onClick={() => { onToggle?.(); setSelected(c.id); }}
                    className="p-2 cursor-pointer"
                  >
                    <CheckIcon filled={checked} />
                  </button>
                </div>
              </Fragment>
            );
          })}
        </nav>
        <div className="flex-1 px-5 py-4">
          {selected === 'moving-average' && <MovingAverageConfig />}
          {selected === 'daily-moving-average' && <DailyMovingAverageConfig />}
          {selected === 'volume' && <VolumeConfig />}
          {selected === 'foreign-net' && <InvestorNetConfig which="foreign" />}
          {selected === 'institution-net' && <InvestorNetConfig which="institution" />}
          {selected === 'ask-peak' && <AskPeakConfig />}
          {selected === 'bid-peak' && <BidPeakConfig />}
          {selected === 'trade-volume-poc' && <TradeVolumePocConfig />}
          {selected === 'volume-distribution' && (
            <div>
              <h3 className="text-fg text-base font-medium pb-1">연속체결 매물대 분포</h3>
              <p className="text-fg-dim text-xs mb-3">
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
                    className="w-[84px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
                    value={volumeDistributionRangeCount}
                    onChange={(event) => setVolumeDistributionRangeCount(Number(event.currentTarget.value))}
                  />
                </label>
              </div>
              <div className="mb-3">
                <div className="text-xs text-fg-dim mb-1.5">색상</div>
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
              <div className="text-xs text-fg-dim leading-5">
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
        </div>
      </div>
      {/* Footer — mirrors SettingsModal pattern for cross-modal visual
          consistency. Top-right ✕ alone is not sufficient: users trained
          on the /replay 설정 modal expect a footer-anchored 닫기 button. */}
      <div className="flex justify-end px-4 py-3 border-t border-border">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
        >
          닫기
        </button>
      </div>
    </ModalShell>
  );
}
