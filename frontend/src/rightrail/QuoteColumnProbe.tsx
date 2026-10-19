import { memo } from 'react';
import type { useQuoteColumns } from './useQuoteColumns';
import './QuoteColumns.css';

/** Same data font, sizes and normal/active weights as QuoteRow. Pseudo content
 * keeps measurement samples out of text queries and the accessibility tree. */
export const QuoteColumnProbe = memo(function QuoteColumnProbe({ probe, samples }: Pick<ReturnType<typeof useQuoteColumns>, 'probe' | 'samples'>) {
  return <span ref={probe} className="quote-column-probe font-data tabular-nums" aria-hidden="true">
    {[400, 500].flatMap(weight => samples.price.map(value => <span key={`${weight}:${value}`} data-quote-measure="price" data-figure={value} className="text-sm leading-tight" style={{ fontWeight: weight }} />))}
    {[400, 500].flatMap(weight => samples.percent.map(value => <span key={`${weight}:${value}`} data-quote-measure="percent" data-figure={value} className="text-xs leading-tight" style={{ fontWeight: weight }} />))}
  </span>;
});
