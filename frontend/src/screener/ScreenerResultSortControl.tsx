import { SortCycleButton } from '../ui/SortCycleButton';
import type { SortDirection } from '../ui/SortDirectionIcon';
import type { ScreenerResultSortMode } from './sortResults';

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

function sortDirection(mode: ScreenerResultSortMode): SortDirection {
  if (!isChangePctMode(mode)) return 'none';
  return mode.direction === 'asc' ? 'asc' : 'desc';
}

function sortDescription(mode: ScreenerResultSortMode): string {
  if (isChangePctMode(mode) && mode.direction === 'desc') return '현재 등락률 높은 순, 클릭하면 등락률 낮은 순';
  if (isChangePctMode(mode) && mode.direction === 'asc') return '현재 등락률 낮은 순, 클릭하면 기본 순서';
  return '현재 기본 순서, 클릭하면 등락률 높은 순';
}

export function ScreenerResultSortControl({ mode, onChange, disabled = false }: Props) {
  return (
    <SortCycleButton
      direction={sortDirection(mode)}
      label="스크리너 결과 정렬"
      description={sortDescription(mode)}
      disabled={disabled}
      onClick={() => onChange(nextMode(mode))}
    />
  );
}
