import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import type { ScreenerResultSortMode } from './sortResults';

interface Props {
  mode: ScreenerResultSortMode;
  onChange: (mode: ScreenerResultSortMode) => void;
  disabled?: boolean;
}

const OPTIONS: Array<{ mode: ScreenerResultSortMode; label: string }> = [
  { mode: 'default', label: '기본 순서' },
  { mode: 'change_pct_asc', label: '등락률 낮은 순' },
  { mode: 'change_pct_desc', label: '등락률 높은 순' },
];

export function ScreenerResultSortControl({ mode, onChange, disabled = false }: Props) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg-input" role="group" aria-label="스크리너 결과 정렬">
      {OPTIONS.map((option) => {
        const active = mode === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={`grid h-6 w-6 place-items-center border-r border-border last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50 ${
              active ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            <QuoteSortIcon mode={option.mode} />
          </button>
        );
      })}
    </div>
  );
}

