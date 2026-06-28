import { useId } from 'react';
import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import type { ScreenerResultSortMode } from './sortResults';
import type { QuoteSortMode } from '../rightrail/quoteSort';

interface Props {
  mode: ScreenerResultSortMode;
  onChange: (mode: ScreenerResultSortMode) => void;
  disabled?: boolean;
}

type ActiveSortMode = Exclude<ScreenerResultSortMode, 'default'>;

function isChangePctMode(mode: ScreenerResultSortMode): mode is ActiveSortMode & { field: 'change_pct' } {
  return mode !== 'default' && mode.field === 'change_pct';
}

function nextMode(mode: ScreenerResultSortMode): ScreenerResultSortMode {
  if (!isChangePctMode(mode)) return { field: 'change_pct', direction: 'desc' };
  if (mode.direction === 'desc') return { field: 'change_pct', direction: 'asc' };
  return 'default';
}

function iconMode(mode: ScreenerResultSortMode): QuoteSortMode {
  if (!isChangePctMode(mode)) return 'default';
  return mode.direction === 'asc' ? 'change_pct_asc' : 'change_pct_desc';
}

function sortDescription(mode: ScreenerResultSortMode): string {
  if (isChangePctMode(mode) && mode.direction === 'desc') return '현재 등락률 높은 순, 클릭하면 등락률 낮은 순';
  if (isChangePctMode(mode) && mode.direction === 'asc') return '현재 등락률 낮은 순, 클릭하면 기본 순서';
  return '현재 기본 순서, 클릭하면 등락률 높은 순';
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
      onClick={() => onChange(nextMode(mode))}
      className={`grid h-6 w-6 place-items-center rounded-md border border-border bg-bg-input disabled:cursor-not-allowed disabled:opacity-50 ${
        iconMode(mode) === 'default' ? 'text-fg-dim hover:bg-bg-input-hover hover:text-fg' : 'bg-tint-selection text-accent'
      }`}
    >
      <QuoteSortIcon mode={iconMode(mode)} />
      <span
        id={descriptionId}
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
      >
        {description}
      </span>
    </button>
  );
}
