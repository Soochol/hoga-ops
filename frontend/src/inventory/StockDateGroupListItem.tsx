import { fmtSize } from './format';
import type { StockDateGroup } from './types';

type Props = {
  group: StockDateGroup;
  active: boolean;
  onClick: (code: string) => void;
};

export function StockDateGroupListItem({ group, active, onClick }: Props) {
  const n = group.dates.length;
  const last = lastCapturedShort(group.lastCapturedAt);
  return (
    <div
      onClick={() => onClick(group.code)}
      className={[
        'px-3 py-2 cursor-pointer rounded select-none',
        active ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover',
      ].join(' ')}
    >
      <div className="flex justify-between items-baseline">
        <span>
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </span>
        <span className="font-mono tabular-nums text-sm">{n} {n === 1 ? 'date' : 'dates'}</span>
      </div>
      <div className="flex justify-between text-xs text-fg-dim mt-1">
        <span>최근 {last}</span>
        <span className="font-mono tabular-nums">{fmtSize(group.totalSizeBytes)}</span>
      </div>
    </div>
  );
}

function lastCapturedShort(ms: number): string {
  // captured_at는 절대 시각 → KST 기준 MM-DD
  const kst = new Date(ms).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
  });
  // ko-KR: "05. 22." → "05-22"
  return kst.replace(/\.\s?/g, '-').replace(/-$/, '');
}
