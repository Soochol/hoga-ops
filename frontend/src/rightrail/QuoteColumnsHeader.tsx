import type { CSSProperties } from 'react';

/** Shares the measured widths with rows and scrolls horizontally with the list. */
export function QuoteColumnsHeader({ layout }: { layout: CSSProperties }) {
  return <div role="group" aria-label="종목 목록 열" data-testid="quote-columns-header" style={layout}
    className="quote-columns-header quote-row-fluid quote-row-flow-layout flex items-center pl-10 pr-md border-b border-border bg-bg text-xs text-fg-dim">
    <span className="quote-row-name flex-1 min-w-0">종목명</span>
    <span className="quote-row-price flex-none text-right">가격</span>
    <span className="quote-row-percent flex-none text-right">등락률</span>
    <span className="quote-row-flow flex-none text-center">흐름</span>
  </div>;
}
