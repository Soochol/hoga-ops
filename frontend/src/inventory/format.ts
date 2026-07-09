export function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtShortDate(d: string): string {
  return `${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** HH:MM in KST — used by the gap panel to show a gap's start/end wall-clock. */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Whole-minute duration between two Unix-ms instants, e.g. "19분". */
export function fmtGapDuration(startMs: number, endMs: number): string {
  const mins = Math.round((endMs - startMs) / 60_000);
  return `${mins}분`;
}

export function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtOHLC(open: number, close: number): string {
  const dir = close >= open ? '↑' : '↓';
  return `${close.toLocaleString('ko-KR')} ${dir}`;
}

export function fmtVolume(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
