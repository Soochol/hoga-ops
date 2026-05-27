export function formatMs(ms: number): string {
  if (ms < 950) return `${Math.floor(ms)} ms`;
  // Round to nearest 0.1 s explicitly — `(0.95).toFixed(1)` returns "0.9"
  // on some engines due to IEEE-754 representation, but the 950 ms cutoff
  // is meant to display as "1.0 s".
  const tenths = Math.round(ms / 100) / 10;
  return `${tenths.toFixed(1)} s`;
}

export function formatPercent(p: number): string {
  return `${p.toFixed(1)} %`;
}

const COUNT_FMT = new Intl.NumberFormat('ko-KR');

export function formatEventCount(n: number): string {
  return COUNT_FMT.format(n);
}
