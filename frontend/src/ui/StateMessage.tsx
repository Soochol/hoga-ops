import type { HTMLAttributes } from 'react';
import { noticeStyle } from './noticeTone';

/** Area failures keep their context; page and rail wrappers share the same surface. */
export function StateMessage({ tone = 'neutral', className = '', style, ...props }: HTMLAttributes<HTMLDivElement> & {
  tone?: 'neutral' | 'error' | 'warn';
}) {
  return <div role={tone === 'error' ? 'alert' : 'status'} {...props}
    className={`p-md text-sm ${tone === 'neutral' ? 'text-fg-dim' : 'rounded-md border'} ${className}`.trim()}
    style={{ ...(tone === 'neutral' ? {} : noticeStyle(tone)), ...style }} />;
}
