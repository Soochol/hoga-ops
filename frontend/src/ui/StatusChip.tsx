import type { HTMLAttributes } from 'react';
import { noticeStyle, type NoticeTone } from './noticeTone';

export function StatusChip({ tone = 'neutral', size = 'default', className = '', style, ...props }: HTMLAttributes<HTMLSpanElement> & {
  tone?: NoticeTone;
  size?: 'default' | 'compact';
}) {
  return <span {...props} style={{ ...noticeStyle(tone), ...style }}
    className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border font-data text-xs tabular-nums ${size === 'compact' ? 'px-1' : 'px-1.5 py-0.5'} ${className}`.trim()} />;
}
