import { useId } from 'react';
import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import type { ScreenerResultSortMode } from './sortResults';

interface Props {
  mode: ScreenerResultSortMode;
  onChange: (mode: ScreenerResultSortMode) => void;
  disabled?: boolean;
}

const NEXT_MODE: Record<ScreenerResultSortMode, ScreenerResultSortMode> = {
  default: 'change_pct_asc',
  change_pct_asc: 'change_pct_desc',
  change_pct_desc: 'default',
};

function sortDescription(mode: ScreenerResultSortMode): string {
  if (mode === 'change_pct_asc') return '현재 등락률 낮은 순, 클릭하면 등락률 높은 순';
  if (mode === 'change_pct_desc') return '현재 등락률 높은 순, 클릭하면 기본 순서';
  return '현재 기본 순서, 클릭하면 등락률 낮은 순';
}

export function ScreenerResultSortControl({ mode, onChange, disabled = false }: Props) {
  const descriptionId = useId();
  const description = sortDescription(mode);

  return (
    <button
      type="button"
      aria-label="스크리너 결과 정렬"
      aria-describedby={descriptionId}
      title={description}
      disabled={disabled}
      onClick={() => onChange(NEXT_MODE[mode])}
      className={`grid h-6 w-6 place-items-center rounded-md border border-border bg-bg-input disabled:cursor-not-allowed disabled:opacity-50 ${
        mode === 'default' ? 'text-fg-dim hover:bg-bg-input-hover hover:text-fg' : 'bg-tint-selection text-accent'
      }`}
    >
      <QuoteSortIcon mode={mode} />
      <span
        id={descriptionId}
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
      >
        {description}
      </span>
    </button>
  );
}
