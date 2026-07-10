import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import { quoteSortModeDescription } from '../rightrail/quoteSortDescription';
import { toQuoteSortMode, type SortMode } from './heat';

/** 단일 아이콘 정렬 버튼 — 관심종목 정렬 버튼 계약을 미러: 클릭할 때마다 기본→내림→오름
 *  순환(nextSort), 아이콘(QuoteSortIcon)은 방향만, title/aria 는 현재 상태+다음 동작을 설명한다.
 *  라벨(종목/그룹)은 정렬 *키*(등락률)의 축을 알린다. 활성(desc/asc)=accent, 기본=dim.
 *  /heatmap 페이지와 우측 레일 드로어가 공유(단일 출처). */
export function SortCycleButton({ label, mode, onCycle }: {
  label: string; mode: SortMode; onCycle: () => void;
}) {
  const qm = toQuoteSortMode(mode);
  return (
    <button type="button" aria-label={`${label} 정렬`} title={quoteSortModeDescription(qm)}
      onClick={onCycle}
      className={`flex items-center gap-1 px-1 py-0.5 leading-none rounded hover:bg-bg-input-hover ${
        mode === 'manual' ? 'text-fg-dimmer' : 'text-accent'
      }`}>
      <span className="text-[11px]">{label}</span>
      <QuoteSortIcon mode={qm} className="w-[1em] h-[1em]" />
    </button>
  );
}
