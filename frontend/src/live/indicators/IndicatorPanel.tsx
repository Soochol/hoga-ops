import { useState, Fragment } from 'react';
import { useLivePageStore } from '../../state/livePage';
import MovingAverageConfig from './MovingAverageConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import InvestorNetConfig from './InvestorNetConfig';
import AskPeakConfig from './AskPeakConfig';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import FillStrengthConfig from './FillStrengthConfig';
import { ModalShell } from '../../ui/ModalShell';
import { CheckIcon } from '../../ui/CheckIcon';

type CategoryId =
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'ask-peak'
  | 'quote-totals'
  | 'ratio'
  | 'fill-strength';

type GroupId = 'top' | 'hoga';
const GROUP_LABEL: Record<GroupId, string> = { top: '상단 지표', hoga: '호가 지표' };

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; group: GroupId }> = [
  { id: 'moving-average',  label: '이동평균선',       group: 'top'  },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top'  },
  { id: 'volume',          label: '거래량',           group: 'top'  },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'top'  },
  { id: 'institution-net', label: '기관 순매수량',    group: 'top'  },
  { id: 'quote-totals',    label: '총잔량',           group: 'hoga' },
  { id: 'ratio',           label: '호가비',           group: 'hoga' },
  { id: 'fill-strength',   label: '체결강도',         group: 'hoga' },
  { id: 'ask-peak',        label: '당일 매도 최대벽', group: 'hoga' },
];

type Props = {
  onClose: () => void;
};

export default function IndicatorPanel({ onClose }: Props) {
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
  const quoteTotals = useLivePageStore((s) => s.quoteTotalsEnabled);
  const setQuoteTotals = useLivePageStore((s) => s.setQuoteTotalsEnabled);
  const ratio = useLivePageStore((s) => s.ratioEnabled);
  const setRatio = useLivePageStore((s) => s.setRatioEnabled);
  const fillStrength = useLivePageStore((s) => s.fillStrengthEnabled);
  const setFillStrength = useLivePageStore((s) => s.setFillStrengthEnabled);

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');

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
      case 'quote-totals': return quoteTotals;
      case 'ratio': return ratio;
      case 'fill-strength': return fillStrength;
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
      case 'quote-totals': return () => setQuoteTotals(!quoteTotals);
      case 'ratio': return () => setRatio(!ratio);
      case 'fill-strength': return () => setFillStrength(!fillStrength);
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
          {CATEGORIES.map((c, i) => {
            const checked = checkedFor(c.id);
            const onToggle = toggleFor(c.id);
            const isSelected = selected === c.id;
            const showHeader = i === 0 || CATEGORIES[i - 1].group !== c.group;
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
          {selected === 'quote-totals' && <QuoteTotalsConfig />}
          {selected === 'ratio' && <RatioConfig />}
          {selected === 'fill-strength' && <FillStrengthConfig />}
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
