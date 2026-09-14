/** Saved periods are shown in KST, including intraday times for minute charts. */
export function studyTimeframeLabel(timeframe: string): string {
  return timeframe.endsWith('m') ? `${timeframe.slice(0, -1)}분봉` : ({ D: '일봉', W: '주봉', M: '월봉' }[timeframe] ?? timeframe);
}
export function studyViewPeriod(range: { from_date: string; to_date: string; from_ms?: number; to_ms?: number }, timeframe: string): string {
  const date = (value: string) => /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  if (timeframe.endsWith('m') && range.from_ms != null && range.to_ms != null) {
    const time = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 19);
    return `${date(range.from_date)} ${time(range.from_ms)}–${range.from_date === range.to_date ? '' : date(range.to_date) + ' '}${time(range.to_ms)} KST`;
  }
  if (range.from_date === range.to_date) return date(range.from_date);
  return `${date(range.from_date)}–${range.from_date.slice(0, 4) === range.to_date.slice(0, 4) ? date(range.to_date).slice(5) : date(range.to_date)}`;
}

/** Compact list dates use KST's current year; full precision remains in the tooltip. */
export function shortStudyDate(value: string, currentYear = new Date(Date.now() + 9 * 3600_000).getUTCFullYear()): string {
  const date = value.replaceAll('-', '');
  return `${Number(date.slice(0, 4)) === currentYear ? '' : date.slice(2, 4) + '.'}${date.slice(4, 6)}.${date.slice(6, 8)}`;
}

export function compactStudyViewName(label: string, toDate: string): string {
  return `${label} · ${shortStudyDate(toDate)}`;
}

export function compactStudyViewPeriod(range: { from_date: string; to_date: string; from_ms?: number; to_ms?: number }, timeframe: string): string {
  const from = shortStudyDate(range.from_date);
  if (range.from_date !== range.to_date) return `${from}–${shortStudyDate(range.to_date)}`;
  if (timeframe.endsWith('m') && range.from_ms != null && range.to_ms != null) {
    const time = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);
    return `${from} ${time(range.from_ms)}–${time(range.to_ms)}`;
  }
  return from;
}
