import { useState } from 'react';
import { useLivePageStore } from '../../state/livePage';
import MovingAverageConfig from './MovingAverageConfig';
import VolumeConfig from './VolumeConfig';
import InvestorNetConfig from './InvestorNetConfig';
import AskPeakConfig from './AskPeakConfig';
import { ModalShell } from '../../ui/ModalShell';
import { CheckIcon } from '../../ui/CheckIcon';

type CategoryId =
  | 'moving-average'
  | 'volume'
  | 'foreign-net'
  | 'institution-net'
  | 'ask-peak'
  | 'ichimoku'
  | 'bollinger'
  | 'supertrend'
  | 'volume-profile'
  | 'envelope'
  | 'williams';

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; active: boolean }> = [
  { id: 'moving-average',  label: '이동평균선',       active: true  },
  { id: 'volume',          label: '거래량',           active: true  },
  { id: 'foreign-net',     label: '외국인 순매수량',  active: true  },
  { id: 'institution-net', label: '기관 순매수량',    active: true  },
  { id: 'ask-peak',        label: '당일 매도 최대벽', active: true  },
  { id: 'ichimoku',       label: '일목균형표',  active: false },
  { id: 'bollinger',      label: '볼린저밴드',  active: false },
  { id: 'supertrend',     label: '슈퍼트렌드',  active: false },
  { id: 'volume-profile', label: '매물대분석',  active: false },
  { id: 'envelope',       label: '엔벨로프',    active: false },
  { id: 'williams',       label: '윌리엄스 프랙탈', active: false },
];

type Props = {
  onClose: () => void;
};

export default function IndicatorPanel({ onClose }: Props) {
  const maEnabled = useLivePageStore((s) => s.movingAverageEnabled);
  const setMaEnabled = useLivePageStore((s) => s.setMovingAverageEnabled);
  const foreignNet = useLivePageStore((s) => s.foreignNetEnabled);
  const setForeignNet = useLivePageStore((s) => s.setForeignNetEnabled);
  const institutionNet = useLivePageStore((s) => s.institutionNetEnabled);
  const setInstitutionNet = useLivePageStore((s) => s.setInstitutionNetEnabled);
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);
  const setVolumeEnabled = useLivePageStore((s) => s.setVolumeEnabled);
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const setAskPeakEnabled = useLivePageStore((s) => s.setAskPeakEnabled);

  // Which category's detail pane shows on the right. Clicking a category label
  // navigates here; the checkbox icon toggles its master switch separately.
  const [selected, setSelected] = useState<CategoryId>('moving-average');

  // Each active category maps to a master on/off toggle. Investor bars carry no
  // per-slot config (sign-colored, daily), so the left checkbox is the whole
  // control — the same popover "형식" as the MA category, just without a right
  // detail pane.
  const checkedFor = (id: CategoryId): boolean => {
    switch (id) {
      case 'moving-average': return maEnabled;
      case 'foreign-net': return foreignNet;
      case 'institution-net': return institutionNet;
      case 'volume': return volumeEnabled;
      case 'ask-peak': return askPeakEnabled;
      default: return false;
    }
  };
  const toggleFor = (id: CategoryId): (() => void) | null => {
    switch (id) {
      case 'moving-average': return () => setMaEnabled(!maEnabled);
      case 'foreign-net': return () => setForeignNet(!foreignNet);
      case 'institution-net': return () => setInstitutionNet(!institutionNet);
      case 'volume': return () => setVolumeEnabled(!volumeEnabled);
      case 'ask-peak': return () => setAskPeakEnabled(!askPeakEnabled);
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
          <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">상단 지표</div>
          {CATEGORIES.map((c) => {
            // Each active row splits into a label button (navigates to that
            // indicator's detail pane) and a checkbox icon (toggles its master
            // switch). Inactive rows are placeholders for indicators we haven't
            // shipped yet — disabled, no select, no toggle.
            const checked = checkedFor(c.id);
            const onToggle = toggleFor(c.id);
            const isSelected = selected === c.id;
            const rowBase =
              'flex w-full items-center justify-between pl-4 pr-2 text-sm';
            return (
              <div
                key={c.id}
                className={
                  c.active
                    ? `${rowBase} ${isSelected ? 'bg-bg-input' : 'hover:bg-bg-input'}`
                    : `${rowBase} opacity-50`
                }
              >
                <button
                  type="button"
                  disabled={!c.active}
                  onClick={() => c.active && setSelected(c.id)}
                  aria-current={isSelected ? 'true' : undefined}
                  className={
                    c.active
                      ? 'flex-1 text-left py-2 text-fg cursor-pointer'
                      : 'flex-1 text-left py-2 text-fg-dimmer cursor-not-allowed'
                  }
                  title={c.active ? undefined : '추후 지원 예정'}
                >
                  {c.label}
                </button>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={c.label}
                  disabled={!c.active}
                  onClick={() => { onToggle?.(); if (c.active) setSelected(c.id); }}
                  className={c.active ? 'p-2 cursor-pointer' : 'p-2 cursor-not-allowed'}
                  title={c.active ? undefined : '추후 지원 예정'}
                >
                  <CheckIcon filled={c.active && checked} />
                </button>
              </div>
            );
          })}
        </nav>
        <div className="flex-1 px-5 py-4">
          {selected === 'moving-average' && <MovingAverageConfig />}
          {selected === 'volume' && <VolumeConfig />}
          {selected === 'foreign-net' && <InvestorNetConfig which="foreign" />}
          {selected === 'institution-net' && <InvestorNetConfig which="institution" />}
          {selected === 'ask-peak' && <AskPeakConfig />}
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
