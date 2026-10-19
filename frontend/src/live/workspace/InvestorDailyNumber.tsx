/** Keep a decimal slot even for integer amounts, without inventing a visible .0. */
export function InvestorDailyNumber({ text, amount }: { text: string; amount: boolean }) {
  if (!amount || text === '—') return <>{text}</>;
  const dot = text.indexOf('.');
  return <span className="inline-grid grid-cols-[auto_1em] text-right tabular-nums" aria-label={text}>
    {dot < 0 ? text : text.slice(0, dot)}
    <span className="text-left" aria-hidden="true">{dot < 0 ? '' : text.slice(dot)}</span>
  </span>;
}
