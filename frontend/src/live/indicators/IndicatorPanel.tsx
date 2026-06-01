import { useLivePageStore } from '../../state/livePage';
import MovingAverageConfig from './MovingAverageConfig';
import { ModalShell } from '../../ui/ModalShell';

type CategoryId = 'moving-average' | 'ichimoku' | 'bollinger' | 'supertrend' | 'volume-profile' | 'envelope' | 'williams';

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; active: boolean }> = [
  { id: 'moving-average', label: '이동평균선',  active: true  },
  { id: 'ichimoku',       label: '일목균형표',  active: false },
  { id: 'bollinger',      label: '볼린저밴드',  active: false },
  { id: 'supertrend',     label: '슈퍼트렌드',  active: false },
  { id: 'volume-profile', label: '매물대분석',  active: false },
  { id: 'envelope',       label: '엔벨로프',    active: false },
  { id: 'williams',       label: '윌리엄스 프랙탈', active: false },
];

/** Filled-circle check icon — used by the active category to show
 *  "applied" state. Disabled categories render a hollow gray ring. */
function CheckIcon({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="var(--accent)" />
        <path
          d="M7.5 12.5l3 3 6-6"
          stroke="var(--accent-fg, #0A0A12)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="var(--fg-dimmer)"
        strokeWidth="1.5"
      />
      <path
        d="M7.5 12.5l3 3 6-6"
        stroke="var(--fg-dimmer)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

type Props = {
  onClose: () => void;
};

export default function IndicatorPanel({ onClose }: Props) {
  const maEnabled = useLivePageStore((s) => s.movingAverageEnabled);
  const setMaEnabled = useLivePageStore((s) => s.setMovingAverageEnabled);

  return (
    <ModalShell ariaLabel="지표" title="지표" onClose={onClose}>
      <div className="flex">
        <nav className="w-[200px] py-2 border-r border-border" aria-label="지표 카테고리">
          <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">상단 지표</div>
          {CATEGORIES.map((c) => {
            // Active row = a checkbox that toggles `movingAverageEnabled`.
            // Inactive rows are placeholders for indicators we haven't shipped
            // yet — they show a hollow check ring and don't respond to clicks.
            const isMA = c.id === 'moving-average';
            const checked = isMA ? maEnabled : false;
            const rowBase =
              'flex w-full items-center justify-between px-4 py-2 text-sm';
            return (
              <button
                key={c.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={c.label}
                disabled={!c.active}
                onClick={() => {
                  if (isMA) setMaEnabled(!maEnabled);
                }}
                className={
                  c.active
                    ? `${rowBase} text-fg hover:bg-bg-input cursor-pointer`
                    : `${rowBase} text-fg-dimmer opacity-50 cursor-not-allowed`
                }
                title={c.active ? undefined : '추후 지원 예정'}
              >
                <span>{c.label}</span>
                <CheckIcon filled={isMA && checked} />
              </button>
            );
          })}
        </nav>
        <div className="flex-1 px-5 py-4">
          <MovingAverageConfig />
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
