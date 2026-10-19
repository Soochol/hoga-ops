import { memo } from 'react';
import type { useQuoteColumns } from './useQuoteColumns';
import './QuoteColumns.css';

/** Same data font, sizes and normal/active weights as QuoteRow. Pseudo content
 * keeps measurement samples out of text queries and the accessibility tree. */
export const QuoteColumnProbe = memo(function QuoteColumnProbe({ probe, samples }: Pick<ReturnType<typeof useQuoteColumns>, 'probe' | 'samples'>) {
  return <span ref={probe} className="quote-column-probe font-data tabular-nums" aria-hidden="true">
    {(['price', 'percent', 'rank', 'detail'] as const).flatMap(column => [400, 500].flatMap(weight =>
      samples[column].map(value => <span key={`${column}:${weight}:${value}`} data-quote-measure={column} data-figure={value}
        className={`${column === 'price' ? 'text-sm' : 'text-xs'} leading-tight`} style={{ fontWeight: weight }} />),
    ))}
  </span>;
});
